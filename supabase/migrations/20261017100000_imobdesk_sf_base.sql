-- Solicitações Financeiras, Fase 1: estrutura (docs/Solicitacoes-financeiras/CONTEXTO.md; mockup aprovado em 17/10/2026).
-- Reembolso, Fundo fixo e Adiantamento de numerário. A cadeia de aprovação é do SETOR da pessoa (decisão do Wagner,
-- 17/10/2026): colunas sf_* em at_setores e aprovadores em sf_setor_aprovador (no lugar de equipe/equipe_aprovador do PRD).
-- Padrão do portal: RLS ligada, nada liberado a anon/authenticated; leitura e escrita só por RPC security definer.
-- Status só muda por RPC (Fases 2 a 5). Só aditiva: tabelas e colunas novas; nada existente é alterado.

-- ---------- Setor: configuração da aprovação financeira ----------
alter table imobdesk.at_setores add column if not exists sf_setor_obra boolean not null default false;
alter table imobdesk.at_setores add column if not exists sf_financeiro boolean not null default false;
alter table imobdesk.at_setores add column if not exists sf_modo_aprovacao text not null default 'sequencial'
  check (sf_modo_aprovacao in ('sequencial', 'paralelo', 'qualquer_um'));
alter table imobdesk.at_setores add column if not exists sf_prazo_horas int not null default 48 check (sf_prazo_horas between 1 and 720);
alter table imobdesk.at_setores add column if not exists sf_acao_prazo_vencido text not null default 'escalar'
  check (sf_acao_prazo_vencido in ('lembrar', 'escalar'));
alter table imobdesk.at_setores add column if not exists sf_centro_custo_padrao text check (length(sf_centro_custo_padrao) <= 60);
alter table imobdesk.at_setores add column if not exists sf_prazo_comprovacao_dias int not null default 30 check (sf_prazo_comprovacao_dias between 1 and 365);
alter table imobdesk.at_setores add column if not exists sf_acao_comprovacao_vencida text not null default 'avisar_bloquear'
  check (sf_acao_comprovacao_vencida in ('avisar', 'avisar_bloquear'));
-- [LIMITE] do PRD: nulo = ainda não definido (sem limite).
alter table imobdesk.at_setores add column if not exists sf_limite_adiantamentos_abertos int check (sf_limite_adiantamentos_abertos between 1 and 99);
alter table imobdesk.at_setores add column if not exists sf_atualizado_em timestamptz;
alter table imobdesk.at_setores add column if not exists sf_atualizado_por uuid;

-- Aprovadores por setor. Reembolso/fundo fixo: entra quem tem alçada mínima <= total. Adiantamento: 4 níveis fixos
-- (planejamento só em setor de obra, gerente sempre, diretor e presidente acima da alçada).
create table if not exists imobdesk.sf_setor_aprovador (
  id                bigint        generated always as identity primary key,
  setor_id          bigint        not null references imobdesk.at_setores (id) on delete cascade,
  tipo_solicitacao  text          not null check (tipo_solicitacao in ('reembolso_fundo_fixo', 'adiantamento')),
  ordem             int           not null check (ordem between 1 and 20),
  papel             text          not null check (length(btrim(papel)) between 2 and 40),
  aprovador_id      uuid          not null references imobdesk.usuarios (id) on delete cascade,
  substituto_id     uuid          references imobdesk.usuarios (id) on delete set null,
  condicao          text          not null default 'sempre' check (condicao in ('sempre', 'obra', 'valor_acima')),
  alcada_minima     numeric(14,2) check (alcada_minima >= 0),
  ativo             boolean       not null default true,
  criado_em         timestamptz   not null default now(),
  atualizado_em     timestamptz   not null default now(),
  atualizado_por    uuid,
  unique (setor_id, tipo_solicitacao, ordem),
  check (substituto_id is distinct from aprovador_id),
  check (tipo_solicitacao <> 'adiantamento' or papel in ('planejamento', 'gerente', 'diretor', 'presidente'))
);
create index if not exists sf_setor_aprovador_aprovador_idx on imobdesk.sf_setor_aprovador (aprovador_id);
create index if not exists sf_setor_aprovador_substituto_idx on imobdesk.sf_setor_aprovador (substituto_id) where substituto_id is not null;

-- ---------- Cadastros ----------
create table if not exists imobdesk.sf_fundo_fixo (
  id              bigint        generated always as identity primary key,
  usuario_id      uuid          not null references imobdesk.usuarios (id) on delete cascade,
  valor           numeric(14,2) not null check (valor > 0),
  vigente_desde   date          not null default current_date,
  ativo           boolean       not null default true,
  criado_em       timestamptz   not null default now(),
  atualizado_em   timestamptz   not null default now(),
  atualizado_por  uuid
);
-- Um valor vigente por colaborador.
create unique index if not exists sf_fundo_fixo_ativo_uq on imobdesk.sf_fundo_fixo (usuario_id) where ativo;

create table if not exists imobdesk.sf_categoria_motivo (
  id              bigint        generated always as identity primary key,
  nome            text          not null check (length(btrim(nome)) between 2 and 60),
  descricao       text          check (length(descricao) <= 300),
  palavras_chave  text[]        not null default '{}',
  teto_valor      numeric(14,2) check (teto_valor > 0),
  ordem           int           not null default 0,
  ativo           boolean       not null default true,
  criado_em       timestamptz   not null default now(),
  atualizado_em   timestamptz   not null default now(),
  atualizado_por  uuid
);
create unique index if not exists sf_categoria_motivo_nome_uq on imobdesk.sf_categoria_motivo (lower(btrim(nome)));

-- Regras de aceitação (R01–R10 e A01–A07). Parâmetros editáveis pelo admin; [PRAZO], tolerância etc. ficam aqui.
create table if not exists imobdesk.sf_regra (
  codigo          text          primary key check (codigo ~ '^[RA][0-9]{2}$'),
  nome            text          not null,
  descricao       text          not null,
  aplica_a        text          not null check (aplica_a in ('reembolso_fundo_fixo', 'adiantamento')),
  severidade      text          not null check (severidade in ('alerta', 'bloqueio')),
  ativo           boolean       not null default true,
  parametros      jsonb         not null default '{}',
  atualizado_em   timestamptz   not null default now(),
  atualizado_por  uuid
);

-- ---------- Solicitação ----------
-- Número SF-AAAA-NNNN: contador por ano.
create table if not exists imobdesk.sf_numerador (
  ano     int primary key,
  ultimo  int not null default 0
);

create table if not exists imobdesk.sf_solicitacao (
  id                     bigint        generated always as identity primary key,
  numero                 text          not null unique,
  tipo                   text          not null check (tipo in ('reembolso', 'fundo_fixo', 'adiantamento')),
  solicitante_id         uuid          not null references imobdesk.usuarios (id),
  pessoa_id              bigint        references imobdesk.at_pessoas (id) on delete set null,
  setor_id               bigint        references imobdesk.at_setores (id) on delete set null,
  status                 text          not null default 'rascunho' check (status in (
                           'rascunho', 'em_aprovacao', 'devolvida', 'reprovada', 'cancelada', 'em_conferencia', 'pendencia_solicitante',
                           'lancamento_gerado', 'pagamento_programado', 'paga', 'comprovacao_pendente', 'comprovacao_em_conferencia',
                           'devolucao_pendente', 'encerrada')),
  ciclo                  int           not null default 1 check (ciclo >= 1),
  etapa_atual            int,
  -- Competência (reembolso e fundo fixo)
  centro_custo           text          check (length(centro_custo) <= 60),
  competencia            date          check (competencia is null or extract(day from competencia) = 1),
  periodo_de             date,
  periodo_ate            date          check (periodo_ate is null or periodo_de is null or periodo_ate >= periodo_de),
  -- Totais
  valor_fundo_fixo       numeric(14,2),
  saldo_inicial          numeric(14,2),
  total_despesas         numeric(14,2) not null default 0,
  saldo_final            numeric(14,2),
  valor_glosado          numeric(14,2) not null default 0 check (valor_glosado >= 0),
  valor_a_pagar          numeric(14,2),
  -- Aceite eletrônico (substitui as assinaturas)
  aceite_em              timestamptz,
  aceite_ip              text,
  aceite_user_agent      text,
  -- Prazos e integração
  enviado_em             timestamptz,
  ultima_aprovacao_em    timestamptz,
  pagar_ate              date,
  sienge_lancamento_id   text,
  -- Adiantamento de numerário (modelo padrão)
  valor_adiantamento     numeric(14,2) check (valor_adiantamento > 0),
  obra                   text          check (length(obra) <= 160),
  conta_caixa            text          check (length(conta_caixa) <= 40),
  conta_pagamento        text          check (length(conta_pagamento) <= 120),
  centro_apuracao        text          check (length(centro_apuracao) <= 60),
  favorecido             text          check (length(favorecido) <= 160),
  favorecido_doc         text          check (favorecido_doc ~ '^\d{11}$|^\d{14}$'),
  finalidade             text          check (length(finalidade) <= 500),
  forma_pagamento        text          check (forma_pagamento in ('deposito', 'boleto', 'cheque', 'dinheiro')),
  banco                  text          check (length(banco) <= 60),
  agencia                text          check (length(agencia) <= 20),
  conta                  text          check (length(conta) <= 30),
  tipo_conta             text          check (tipo_conta in ('corrente', 'poupanca')),
  vencimento             date,
  prazo_comprovacao      date,
  pedido_numero          text          check (length(pedido_numero) <= 40),
  pedido_valor           numeric(14,2) check (pedido_valor > 0),
  pedido_percentual      numeric(5,2)  check (pedido_percentual > 0 and pedido_percentual <= 100),
  status_comprovacao     text          check (status_comprovacao in ('pendente', 'enviada', 'aceita', 'devolucao', 'vencida')),
  criado_em              timestamptz   not null default now(),
  atualizado_em          timestamptz   not null default now()
);
create index if not exists sf_solicitacao_solicitante_idx on imobdesk.sf_solicitacao (solicitante_id, criado_em desc);
create index if not exists sf_solicitacao_status_idx on imobdesk.sf_solicitacao (status);
create index if not exists sf_solicitacao_setor_idx on imobdesk.sf_solicitacao (setor_id);

create or replace function imobdesk.sf_solicitacao_numerar()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ano int := extract(year from now())::int;
  v_n int;
begin
  if new.numero is null or new.numero = '' then
    insert into imobdesk.sf_numerador as n (ano, ultimo) values (v_ano, 1)
    on conflict (ano) do update set ultimo = n.ultimo + 1
    returning ultimo into v_n;
    new.numero := format('SF-%s-%s', v_ano, lpad(v_n::text, 4, '0'));
  end if;
  return new;
end;
$$;
revoke execute on function imobdesk.sf_solicitacao_numerar() from public, anon, authenticated;
drop trigger if exists sf_solicitacao_numerar on imobdesk.sf_solicitacao;
create trigger sf_solicitacao_numerar before insert on imobdesk.sf_solicitacao
  for each row execute function imobdesk.sf_solicitacao_numerar();

create table if not exists imobdesk.sf_item (
  id                     bigint        generated always as identity primary key,
  solicitacao_id         bigint        not null references imobdesk.sf_solicitacao (id) on delete cascade,
  ordem                  int           not null default 1,
  data                   date,
  valor                  numeric(14,2) check (valor >= 0),
  descricao_favorecido   text          check (length(descricao_favorecido) <= 200),
  motivo                 text          check (length(motivo) <= 200),
  categoria_id           bigint        references imobdesk.sf_categoria_motivo (id) on delete set null,
  origem                 text          not null default 'manual' check (origem in ('manual', 'ocr_confirmado', 'ocr_editado')),
  status_conferencia     text          not null default 'pendente' check (status_conferencia in ('pendente', 'aceito', 'ajuste', 'glosado')),
  valor_glosado          numeric(14,2) not null default 0 check (valor_glosado >= 0),
  obs_conferente         text          check (length(obs_conferente) <= 1000),
  criado_em              timestamptz   not null default now(),
  atualizado_em          timestamptz   not null default now()
);
create index if not exists sf_item_solicitacao_idx on imobdesk.sf_item (solicitacao_id, ordem);

create table if not exists imobdesk.sf_anexo (
  id              bigint        generated always as identity primary key,
  solicitacao_id  bigint        not null references imobdesk.sf_solicitacao (id) on delete cascade,
  item_id         bigint        references imobdesk.sf_item (id) on delete set null,
  finalidade      text          not null default 'comprovante' check (finalidade in ('comprovante', 'documento_origem', 'comprovacao')),
  storage_path    text          not null,
  nome_arquivo    text          not null check (length(nome_arquivo) <= 200),
  mime            text          not null,
  tamanho         bigint        not null check (tamanho between 1 and 10485760),
  sha256          text          not null check (sha256 ~ '^[0-9a-f]{64}$'),
  ocr_status      text          not null default 'fila' check (ocr_status in ('fila', 'lendo', 'lido', 'ilegivel', 'erro')),
  ocr_json        jsonb,
  ocr_confianca   numeric(4,3)  check (ocr_confianca between 0 and 1),
  chave_acesso    text          check (chave_acesso ~ '^\d{44}$'),
  criado_em       timestamptz   not null default now(),
  criado_por      uuid
);
create index if not exists sf_anexo_solicitacao_idx on imobdesk.sf_anexo (solicitacao_id);
create index if not exists sf_anexo_item_idx on imobdesk.sf_anexo (item_id) where item_id is not null;
create index if not exists sf_anexo_sha_idx on imobdesk.sf_anexo (sha256);

create table if not exists imobdesk.sf_regra_resultado (
  id              bigint      generated always as identity primary key,
  solicitacao_id  bigint      not null references imobdesk.sf_solicitacao (id) on delete cascade,
  item_id         bigint      references imobdesk.sf_item (id) on delete cascade,
  regra_codigo    text        not null references imobdesk.sf_regra (codigo),
  resultado       text        not null check (resultado in ('ok', 'alerta', 'bloqueio')),
  detalhe         text,
  avaliado_em     timestamptz not null default now()
);
create index if not exists sf_regra_resultado_sol_idx on imobdesk.sf_regra_resultado (solicitacao_id, item_id);

-- Etapas congeladas no envio (ciclo recomeça do nível 1 após devolução).
create table if not exists imobdesk.sf_aprovacao (
  id              bigint      generated always as identity primary key,
  solicitacao_id  bigint      not null references imobdesk.sf_solicitacao (id) on delete cascade,
  ciclo           int         not null,
  nivel           int         not null,
  papel           text        not null,
  aprovador_id    uuid        references imobdesk.usuarios (id),
  substituto_id   uuid        references imobdesk.usuarios (id),
  status          text        not null default 'pendente' check (status in ('pendente', 'aguardando', 'aprovado', 'devolvido', 'reprovado', 'pulado', 'nao_exigido')),
  comentario      text        check (length(comentario) <= 2000),
  prazo_em        timestamptz,
  lembrete_em     timestamptz,
  escalado_em     timestamptz,
  decidido_em     timestamptz,
  decidido_por    uuid        references imobdesk.usuarios (id),
  unique (solicitacao_id, ciclo, nivel)
);
create index if not exists sf_aprovacao_aprovador_idx on imobdesk.sf_aprovacao (aprovador_id, status);
create index if not exists sf_aprovacao_substituto_idx on imobdesk.sf_aprovacao (substituto_id) where substituto_id is not null;

-- Log imutável de tudo o que aconteceu (a timeline sai daqui e de sf_aprovacao).
create table if not exists imobdesk.sf_evento (
  id              bigint      generated always as identity primary key,
  solicitacao_id  bigint      not null references imobdesk.sf_solicitacao (id) on delete cascade,
  tipo            text        not null check (length(tipo) between 2 and 60),
  ator_id         uuid,
  payload         jsonb       not null default '{}',
  ip              text,
  user_agent      text,
  criado_em       timestamptz not null default now()
);
create index if not exists sf_evento_sol_idx on imobdesk.sf_evento (solicitacao_id, criado_em);

create or replace function imobdesk.sf_evento_imutavel()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- A exclusão em cascata da solicitação (só service_role) continua possível.
  if tg_op = 'UPDATE' then
    raise exception 'sf_evento é imutável';
  end if;
  return old;
end;
$$;
revoke execute on function imobdesk.sf_evento_imutavel() from public, anon, authenticated;
drop trigger if exists sf_evento_imutavel on imobdesk.sf_evento;
create trigger sf_evento_imutavel before update on imobdesk.sf_evento
  for each row execute function imobdesk.sf_evento_imutavel();

create table if not exists imobdesk.sf_rateio (
  id              bigint        generated always as identity primary key,
  solicitacao_id  bigint        not null references imobdesk.sf_solicitacao (id) on delete cascade,
  tarefa          text          not null check (length(btrim(tarefa)) between 1 and 40),
  porcentagem     numeric(5,2)  not null check (porcentagem > 0 and porcentagem <= 100),
  valor           numeric(14,2) not null check (valor >= 0)
);
create index if not exists sf_rateio_sol_idx on imobdesk.sf_rateio (solicitacao_id);

create table if not exists imobdesk.sf_comprovacao (
  id              bigint        generated always as identity primary key,
  solicitacao_id  bigint        not null references imobdesk.sf_solicitacao (id) on delete cascade,
  anexo_id        bigint        references imobdesk.sf_anexo (id) on delete set null,
  tipo_documento  text          check (tipo_documento in ('nfe', 'nfce', 'cupom', 'recibo', 'outro')),
  emitente_doc    text          check (emitente_doc ~ '^\d{11}$|^\d{14}$'),
  emissao         date,
  valor           numeric(14,2) check (valor >= 0),
  saldo_devolver  numeric(14,2) not null default 0 check (saldo_devolver >= 0),
  saldo_pagar     numeric(14,2) not null default 0 check (saldo_pagar >= 0),
  conferida_por   uuid          references imobdesk.usuarios (id),
  conferida_em    timestamptz,
  criado_em       timestamptz   not null default now()
);
create index if not exists sf_comprovacao_sol_idx on imobdesk.sf_comprovacao (solicitacao_id);

-- ---------- Acesso: tudo fechado, só RPC ----------
do $$
declare
  t text;
begin
  foreach t in array array['sf_setor_aprovador', 'sf_fundo_fixo', 'sf_categoria_motivo', 'sf_regra', 'sf_numerador', 'sf_solicitacao', 'sf_item',
                           'sf_anexo', 'sf_regra_resultado', 'sf_aprovacao', 'sf_evento', 'sf_rateio', 'sf_comprovacao'] loop
    execute format('alter table imobdesk.%I enable row level security', t);
    execute format('revoke all on imobdesk.%I from anon, public, authenticated', t);
    execute format('grant all on imobdesk.%I to service_role', t);
  end loop;
end;
$$;

-- Bucket privado dos comprovantes (políticas e upload na Fase 2; URLs assinadas de 5 min).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('imobdesk-sf-comprovantes', 'imobdesk-sf-comprovantes', false, 10485760,
        array['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp', 'application/pdf'])
on conflict (id) do nothing;
