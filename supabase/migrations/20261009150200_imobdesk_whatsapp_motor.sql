-- Motor do chat do WhatsApp (docs/PLANO-conversas-whatsapp-openwa.md, Fase 2; mockup aprovado em 09/10/2026).
-- Uma entrada só para a Zenvia e o OpenWA (at_whatsapp_receber), identificação do colaborador no 1º contato,
-- fila com roleta, um ticket por atendimento (abre ao entrar na fila), ações do atendente (at_conversa_acao) e o
-- ciclo do pg_cron (at_whatsapp_ciclo). Tudo o que sai fica pendente (at_mensagens / at_repasses) e a Edge
-- imobdesk-whatsapp envia pelo canal do número. Só aditiva.

-- ======================================================================= estrutura

-- Número: canal de envio. OpenWA = sessão do número do sistema + grupo interno só de atendentes (opção A).
alter table imobdesk.at_numeros add column if not exists canal text not null default 'zenvia';
alter table imobdesk.at_numeros drop constraint if exists at_numeros_canal_check;
alter table imobdesk.at_numeros add constraint at_numeros_canal_check check (canal in ('zenvia', 'openwa'));
alter table imobdesk.at_numeros add column if not exists openwa_sessao text;
alter table imobdesk.at_numeros add column if not exists grupo_interno text;          -- id do grupo (…@g.us)
alter table imobdesk.at_numeros add column if not exists grupo_interno_nome text;
create unique index if not exists at_numeros_openwa_sessao_uidx on imobdesk.at_numeros (openwa_sessao) where openwa_sessao is not null and ativo;

-- Setor: identificação do colaborador e "só linha corporativa".
alter table imobdesk.at_setores add column if not exists wa_identificar boolean not null default false;
alter table imobdesk.at_setores add column if not exists wa_so_corporativo boolean not null default false;
alter table imobdesk.at_setores add column if not exists msg_nao_corporativo text not null
  default 'Este canal atende apenas linhas corporativas da empresa. Envie sua solicitação por e-mail.'
  check (length(msg_nao_corporativo) between 1 and 1000);

-- Atendente: WhatsApp pessoal (identifica quem responde no grupo interno).
alter table imobdesk.at_atendentes add column if not exists whatsapp text check (whatsapp ~ '^\d{10,15}$');
alter table imobdesk.at_atendentes add column if not exists grupo_dica_em timestamptz;
create unique index if not exists at_atendentes_whatsapp_uidx on imobdesk.at_atendentes (whatsapp) where whatsapp is not null;

-- Domínios aceitos no e-mail informado na identificação.
alter table imobdesk.at_config add column if not exists dominios_corporativos text[] not null default '{}';

-- Linhas (números de WhatsApp) conhecidas: corporativas (planilha da operadora) e as confirmadas no 1º contato.
create table if not exists imobdesk.at_linhas (
  numero          text        primary key check (numero ~ '^\d{10,15}$'),
  pessoa_id       bigint      references imobdesk.at_pessoas (id) on delete set null,
  corporativa     boolean     not null default true,
  confirmado_em   timestamptz,                              -- o colaborador confirmou nome e e-mail
  observacao      text        check (length(observacao) <= 200),
  criado_em       timestamptz not null default now(),
  atualizado_em   timestamptz not null default now(),
  atualizado_por  uuid
);
create index if not exists at_linhas_pessoa_idx on imobdesk.at_linhas (pessoa_id);

-- Conversa: estado da identificação (modo 'robo') e controle do aviso "não é linha corporativa".
alter table imobdesk.at_conversas add column if not exists ident jsonb;
alter table imobdesk.at_conversas add column if not exists aviso_nao_corporativo_em timestamptz;

-- Atendimento ↔ ticket (um ticket por atendimento; o mesmo ticket continua se ainda estiver aberto).
alter table imobdesk.at_atendimentos add column if not exists ticket_id bigint references imobdesk.ch_tickets (id) on delete set null;
create index if not exists at_atendimentos_ticket_idx on imobdesk.at_atendimentos (ticket_id);

-- Mensagem: id no OpenWA e controle de envio (reserva contra envio duplo e tentativas).
alter table imobdesk.at_mensagens add column if not exists externo_id text;
alter table imobdesk.at_mensagens add column if not exists envio_tentativas int not null default 0;
alter table imobdesk.at_mensagens add column if not exists envio_reservado_ate timestamptz;
create unique index if not exists at_mensagens_externo_uidx on imobdesk.at_mensagens (externo_id) where externo_id is not null;
create index if not exists at_mensagens_pendentes_idx on imobdesk.at_mensagens (criado_em) where status = 'pendente';

-- Repasses para o grupo interno dos atendentes (OpenWA). A resposta que CITA um repasse vai para o colaborador.
create table if not exists imobdesk.at_repasses (
  id                   bigint      generated always as identity primary key,
  numero_id            bigint      not null references imobdesk.at_numeros (id),
  conversa_id          bigint      references imobdesk.at_conversas (id) on delete set null,
  ticket_id            bigint      references imobdesk.ch_tickets (id) on delete set null,
  tipo                 text        not null check (tipo in ('novo', 'mensagem', 'enviado', 'aviso')),
  texto                text        not null check (length(texto) between 1 and 4000),
  citar_externo_id     text,
  status               text        not null default 'pendente' check (status in ('pendente', 'enviada', 'falhou')),
  externo_id           text,
  envio_tentativas     int         not null default 0,
  envio_reservado_ate  timestamptz,
  erro                 text,
  criado_em            timestamptz not null default now()
);
create index if not exists at_repasses_pendentes_idx on imobdesk.at_repasses (criado_em) where status = 'pendente';
create index if not exists at_repasses_externo_idx on imobdesk.at_repasses (externo_id) where externo_id is not null;
create index if not exists at_repasses_conversa_idx on imobdesk.at_repasses (conversa_id);

do $$
declare
  t text;
begin
  foreach t in array array['at_linhas', 'at_repasses'] loop
    execute format('alter table imobdesk.%I enable row level security', t);
    execute format('revoke all on imobdesk.%I from anon, public, authenticated', t);
    execute format('grant all on imobdesk.%I to service_role', t);
  end loop;
end;
$$;

-- ======================================================================= utilitários

/** Status de ticket por categoria; para 'andamento', prefere o nome dado (ex.: 'Em atendimento', 'Reaberto'). */
create or replace function imobdesk.ch_status_de(p_categoria text, p_nome text default null)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select s.id from imobdesk.ch_status s
  where s.categoria = p_categoria and s.ativo
  order by (p_nome is not null and lower(s.nome) = lower(p_nome)) desc, (lower(s.nome) = 'reaberto'), s.ordem
  limit 1;
$$;

/** Setor aberto agora (horário do setor, fuso de Brasília). */
create or replace function imobdesk.at_dentro_horario(p_setor bigint)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select h.aberto and (now() at time zone 'America/Sao_Paulo')::time >= h.abre and (now() at time zone 'America/Sao_Paulo')::time < h.fecha
    from imobdesk.at_horarios h
    where h.setor_id = p_setor and h.dia = extract(dow from now() at time zone 'America/Sao_Paulo')::int
  ), false);
$$;

/** Respostas automáticas valem para este telefone? (Zenvia › "ligado" e trava do piloto.) */
create or replace function imobdesk.at_auto_permitido(p_telefone text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select c.ligado and (not c.trava_piloto or p_telefone = any (c.telefones_piloto)) from imobdesk.at_config c where c.id), false);
$$;

/** Primeiro nome para as mensagens ("Vinicius Jose De Almeida Carvalho" → "Vinicius"). */
create or replace function imobdesk.at_primeiro_nome(p_nome text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(split_part(btrim(coalesce(p_nome, '')), ' ', 1), '');
$$;

/** Mensagem de sistema na conversa (linha do tempo do chat; não sai para o cliente). */
create or replace function imobdesk.at_evento(p_conversa bigint, p_texto text)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into imobdesk.at_mensagens (conversa_id, atendimento_id, direcao, autor, tipo, texto, status)
  select c.id, c.atendimento_id, 'interna', 'sistema', 'evento', left(p_texto, 1000), 'recebida'
  from imobdesk.at_conversas c where c.id = p_conversa;
$$;

/** Resposta automática pendente (sai pelo despachante). Respeita "ligado" e a trava do piloto. */
create or replace function imobdesk.at_auto(p_conversa bigint, p_texto text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  c imobdesk.at_conversas;
  v_id bigint;
begin
  select * into c from imobdesk.at_conversas x where x.id = p_conversa;
  if c.id is null or nullif(btrim(p_texto), '') is null or not imobdesk.at_auto_permitido(c.telefone) then
    return null;
  end if;
  insert into imobdesk.at_mensagens (conversa_id, atendimento_id, direcao, autor, tipo, texto, status)
  values (c.id, c.atendimento_id, 'saida', 'auto', 'texto', left(p_texto, 4000), 'pendente')
  returning id into v_id;
  return v_id;
end;
$$;

/** Repasse para o grupo interno do número (só OpenWA com grupo configurado). */
create or replace function imobdesk.at_repassar(p_conversa bigint, p_ticket bigint, p_tipo text, p_texto text, p_citar text default null)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into imobdesk.at_repasses (numero_id, conversa_id, ticket_id, tipo, texto, citar_externo_id)
  select n.id, c.id, p_ticket, p_tipo, left(p_texto, 4000), p_citar
  from imobdesk.at_conversas c
  join imobdesk.at_numeros n on n.id = c.numero_id
  where c.id = p_conversa and n.canal = 'openwa' and n.grupo_interno is not null;
$$;

/** Nome de quem fala na conversa: pessoa identificada, nome do WhatsApp ou o telefone. */
create or replace function imobdesk.at_nome_da_conversa(c imobdesk.at_conversas)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select p.nome from imobdesk.at_pessoas p where p.id = c.pessoa_id), nullif(btrim(c.nome_contato), ''), '+' || c.telefone);
$$;

/** Ticket do atendimento atual da conversa. */
create or replace function imobdesk.at_ticket_da_conversa(p_conversa bigint)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select a.ticket_id from imobdesk.at_conversas c
  join imobdesk.at_atendimentos a on a.id = c.atendimento_id
  where c.id = p_conversa;
$$;

/** Ação no ticket ligada a uma mensagem do WhatsApp (entrada do colaborador ou resposta do atendente). */
create or replace function imobdesk.at_ticket_acao(p_ticket bigint, p_direcao text, p_autor uuid, p_autor_nome text, p_texto text, p_mensagem bigint, p_envio text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_num int;
begin
  if p_ticket is null then return; end if;
  perform 1 from imobdesk.ch_tickets x where x.id = p_ticket for update;
  v_num := coalesce((select max(a.numero) from imobdesk.ch_ticket_acoes a where a.ticket_id = p_ticket), 0) + 1;
  insert into imobdesk.ch_ticket_acoes (ticket_id, numero, tipo, canal, direcao, autor_id, autor_nome, texto, envio_status, mensagem_id)
  values (p_ticket, v_num, 'publica', 'whatsapp', p_direcao, p_autor, left(coalesce(p_autor_nome, 'WhatsApp'), 160), left(coalesce(p_texto, ''), 100000), p_envio, p_mensagem);
  if p_direcao = 'saida' then
    update imobdesk.ch_tickets set primeira_resposta_em = now() where id = p_ticket and primeira_resposta_em is null;
  end if;
end;
$$;

-- ======================================================================= fila e ticket

/**
 * Conversa entra na fila: abre o atendimento, cria o ticket (ou continua o aberto da conversa), grava o pedido
 * como 1ª ação, manda boas-vindas (ou fora do horário) e repassa ao grupo interno. p_prefixo vai antes da
 * mensagem automática ("Obrigado, Vinicius!").
 */
create or replace function imobdesk.at_entrar_fila(p_conversa bigint, p_pedido text[], p_prefixo text default null, p_forcar_novo boolean default false)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  c imobdesk.at_conversas;
  s imobdesk.at_setores;
  n imobdesk.at_numeros;
  v_atend bigint;
  v_ticket bigint;
  v_cat text;
  v_nome text;
  v_pedido text := nullif(btrim(array_to_string(coalesce(p_pedido, '{}'), E'\n')), '');
  v_aberto boolean;
  v_msg text;
  v_novo boolean := false;
begin
  select * into c from imobdesk.at_conversas x where x.id = p_conversa for update;
  select * into s from imobdesk.at_setores x where x.id = c.setor_id;
  select * into n from imobdesk.at_numeros x where x.id = c.numero_id;
  v_nome := imobdesk.at_nome_da_conversa(c);
  v_aberto := imobdesk.at_dentro_horario(c.setor_id);

  -- Voltou em até 24 h depois do último encerramento: conta como reaberto (indicador do Monitor).
  update imobdesk.at_atendimentos a set reaberto_em_24h = true
  where a.id = (select x.id from imobdesk.at_atendimentos x where x.conversa_id = c.id order by x.id desc limit 1)
    and a.encerrado_em is not null and a.encerrado_em > now() - interval '24 hours';

  -- Ticket aberto desta conversa continua (fechou com "não resolvido" ou ainda pendente).
  if not p_forcar_novo then
    select t.id, st.categoria into v_ticket, v_cat
    from imobdesk.ch_tickets t join imobdesk.ch_status st on st.id = t.status_id
    where t.conversa_id = c.id and t.excluido_em is null and t.mesclado_em_id is null and st.categoria in ('novo', 'andamento', 'pendente')
    order by t.id desc limit 1;
  end if;

  if v_ticket is null then
    insert into imobdesk.ch_tickets (assunto, origem, recebido_em, solicitante_pessoa_id, solicitante_nome, solicitante_contato, numero_id, conversa_id,
                                               setor_id, categoria_id, urgencia_id, status_id)
    values (left(coalesce(nullif(btrim(split_part(coalesce(v_pedido, ''), E'\n', 1)), ''), 'WhatsApp de ' || v_nome), 300), 'whatsapp',
            left('WhatsApp +' || n.numero, 160), c.pessoa_id, left(v_nome, 160), '+' || c.telefone, n.id, c.id, c.setor_id,
            (select x.id from imobdesk.ch_categorias x where x.padrao and x.ativa limit 1),
            coalesce((select u.id from imobdesk.ch_urgencias u where u.padrao and u.ativa limit 1), (select min(u.id) from imobdesk.ch_urgencias u)),
            coalesce(imobdesk.ch_status_de('novo'), 1))
    returning id into v_ticket;
    v_novo := true;
  elsif v_cat = 'pendente' then
    update imobdesk.ch_tickets set status_id = imobdesk.ch_status_de('andamento', 'Em atendimento'), justificativa_id = null where id = v_ticket;
  end if;

  -- Atendimento anterior ainda aberto (o colaborador pediu "novo"): fecha antes de abrir outro.
  update imobdesk.at_atendimentos set encerrado_em = now(), encerramento = 'sistema'
  where id = c.atendimento_id and encerrado_em is null;

  insert into imobdesk.at_atendimentos (conversa_id, setor_id, entrou_fila_em, fora_horario, ticket_id)
  values (c.id, c.setor_id, now(),
          not v_aberto or not exists (select 1 from imobdesk.at_atendentes a where a.setor_id = c.setor_id and a.apto and not a.pausa and a.online_em > now() - interval '3 minutes'),
          v_ticket)
  returning id into v_atend;

  update imobdesk.at_conversas set modo = 'fila', ident = null, atendente_id = null, atendente_desde = null, fila_desde = now(), atendimento_id = v_atend, atualizado_em = now()
  where id = c.id;
  -- Mensagens deste ciclo ficam no atendimento novo.
  update imobdesk.at_mensagens set atendimento_id = v_atend where conversa_id = c.id and atendimento_id is null;

  if v_pedido is not null then
    perform imobdesk.at_ticket_acao(v_ticket, 'entrada', null, v_nome, v_pedido, null, 'nao_se_aplica');
  end if;
  perform imobdesk.at_evento(c.id, format('Na fila do setor %s · ticket #%s%s', s.nome, v_ticket, case when v_novo then ' aberto' else ' (continua)' end));

  v_msg := case when v_aberto then s.msg_boas_vindas else s.msg_fora_horario end;
  v_msg := replace(replace(v_msg, '{nome}', coalesce(imobdesk.at_primeiro_nome(v_nome), '')), '{ticket}', '#' || v_ticket);
  -- Com prefixo ("Obrigado, Vinicius!"), tira a saudação do início da mensagem do setor para não repetir.
  if nullif(btrim(p_prefixo), '') is not null then
    v_msg := regexp_replace(v_msg, '^\s*(olá|ola|oi)\s*[!,.]?\s*', '', 'i');
  end if;
  perform imobdesk.at_auto(c.id, concat_ws(' ', nullif(btrim(p_prefixo), ''), v_msg));

  perform imobdesk.at_repassar(c.id, v_ticket, 'novo',
    format(E'🆕 *#%s* · %s%s\n"%s"', v_ticket, v_nome, case when v_novo then '' else ' (continua)' end, left(coalesce(v_pedido, '(sem texto)'), 600))
    || E'\n\n_Responda citando esta mensagem para falar com o colaborador._');
  return v_ticket;
end;
$$;

-- ======================================================================= entrada

/**
 * Mensagem recebida (Zenvia ou OpenWA, service role). p:
 *   {canal: 'zenvia'|'openwa', para?: número de destino (Zenvia), sessao?: sessão do OpenWA, de: telefone,
 *    nome?, texto?, tipo?: texto|imagem|arquivo|audio|video, arquivo?: {nome, url?, mime}, externoId}
 * Devolve {estado, conversaId?, ticketId?}. Idempotente pelo externoId.
 */
create or replace function imobdesk.at_whatsapp_receber(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_canal text := coalesce(p ->> 'canal', 'zenvia');
  v_de text := regexp_replace(coalesce(p ->> 'de', ''), '\D', '', 'g');
  v_texto text := left(btrim(coalesce(p ->> 'texto', '')), 4000);
  v_tipo text := coalesce(nullif(p ->> 'tipo', ''), 'texto');
  v_ext text := nullif(p ->> 'externoId', '');
  n imobdesk.at_numeros;
  s imobdesk.at_setores;
  c imobdesk.at_conversas;
  l imobdesk.at_linhas;
  v_msg bigint;
  v_ticket bigint;
  v_nome text;
  v_cat text;
  v_t text;
  v_ident jsonb;
  v_tent int;
  v_pessoa bigint;
  v_email text;
begin
  if v_de !~ '^\d{10,15}$' then return jsonb_build_object('estado', 'ignorado', 'motivo', 'telefone inválido'); end if;
  if v_tipo not in ('texto', 'arquivo', 'imagem', 'audio', 'video') then v_tipo := 'arquivo'; end if;

  if v_canal = 'openwa' then
    select * into n from imobdesk.at_numeros x where x.canal = 'openwa' and x.openwa_sessao = p ->> 'sessao' and x.ativo;
  else
    select * into n from imobdesk.at_numeros x where x.numero = regexp_replace(coalesce(p ->> 'para', ''), '\D', '', 'g') and x.ativo;
  end if;
  if n.id is null then return jsonb_build_object('estado', 'ignorado', 'motivo', 'número sem setor'); end if;
  if v_ext is not null and exists (select 1 from imobdesk.at_mensagens m where m.externo_id = v_ext or m.zenvia_id = v_ext) then
    return jsonb_build_object('estado', 'duplicado');
  end if;
  select * into s from imobdesk.at_setores x where x.id = n.setor_id;

  -- Conversa (uma por número + telefone). Duas mensagens juntas: a segunda espera a primeira (for update).
  insert into imobdesk.at_conversas (setor_id, numero_id, telefone, nome_contato, modo)
  values (n.setor_id, n.id, v_de, nullif(left(btrim(p ->> 'nome'), 80), ''), 'encerrada')
  on conflict (numero_id, telefone) do nothing;
  select * into c from imobdesk.at_conversas x where x.numero_id = n.id and x.telefone = v_de for update;

  insert into imobdesk.at_mensagens (conversa_id, atendimento_id, direcao, autor, tipo, texto, arquivo, status, zenvia_id, externo_id)
  values (c.id, case when c.modo in ('fila', 'atendente') then c.atendimento_id end, 'entrada', 'cliente', v_tipo, nullif(v_texto, ''),
          case when v_tipo <> 'texto' then p -> 'arquivo' end, 'recebida',
          case when v_canal = 'zenvia' then v_ext end, case when v_canal = 'openwa' then v_ext end)
  returning id into v_msg;
  update imobdesk.at_conversas set
    nome_contato = coalesce(nome_contato, nullif(left(btrim(p ->> 'nome'), 80), '')),
    ultima_msg_cliente_em = now(), ultima_msg_em = now(), nao_lidas = nao_lidas + 1,
    ultima_previa = left(coalesce(nullif(v_texto, ''), '[' || v_tipo || ']'), 200), atualizado_em = now()
  where id = c.id
  returning * into c;
  v_texto := coalesce(nullif(v_texto, ''), '[' || v_tipo || ']');
  v_t := lower(btrim(v_texto));

  -- ---------- Em atendimento (fila ou atendente): mensagem entra no ticket ----------
  if c.modo in ('fila', 'atendente') then
    v_ticket := imobdesk.at_ticket_da_conversa(c.id);
    v_nome := imobdesk.at_nome_da_conversa(c);
    if v_t = 'novo' then
      v_ticket := imobdesk.at_entrar_fila(c.id, '{}', 'Certo, abri um ticket novo. Conte o que você precisa.', true);
      return jsonb_build_object('estado', 'ticket_novo', 'conversaId', c.id, 'ticketId', v_ticket);
    end if;
    perform imobdesk.at_ticket_acao(v_ticket, 'entrada', null, v_nome, v_texto, v_msg, 'nao_se_aplica');
    select st.categoria into v_cat from imobdesk.ch_tickets t join imobdesk.ch_status st on st.id = t.status_id where t.id = v_ticket;
    if v_cat in ('pendente', 'resolvido') then
      update imobdesk.ch_tickets
         set status_id = imobdesk.ch_status_de('andamento', case when v_cat = 'resolvido' then 'Reaberto' else 'Em atendimento' end), justificativa_id = null
       where id = v_ticket;
    end if;
    perform imobdesk.at_repassar(c.id, v_ticket, 'mensagem', format(E'💬 *#%s* · %s:\n"%s"', v_ticket, v_nome, left(v_texto, 1500)));
    return jsonb_build_object('estado', 'mensagem', 'conversaId', c.id, 'ticketId', v_ticket);
  end if;

  -- ---------- Identificando (modo robo) ----------
  if c.modo = 'robo' then
    v_ident := coalesce(c.ident, '{}');
    v_tent := coalesce((v_ident ->> 'tentativas')::int, 0);
    select * into l from imobdesk.at_linhas x where x.numero = v_de;

    if v_ident ->> 'passo' = 'confirmar' then
      if v_t ~ '^(1|1\.|sim|s|sou|sou eu|isso|confirmo|correto|yes)$' then
        update imobdesk.at_linhas set confirmado_em = now(), atualizado_em = now() where numero = v_de;
        update imobdesk.at_conversas set pessoa_id = l.pessoa_id, nome_contato = (select left(pe.nome, 80) from imobdesk.at_pessoas pe where pe.id = l.pessoa_id)
        where id = c.id returning * into c;
        perform imobdesk.at_evento(c.id, 'Contato confirmado pelo colaborador');
        v_ticket := imobdesk.at_entrar_fila(c.id, array(select jsonb_array_elements_text(coalesce(v_ident -> 'pedido', '[]'))),
                                                     format('Obrigado, %s!', imobdesk.at_primeiro_nome(imobdesk.at_nome_da_conversa(c))));
        return jsonb_build_object('estado', 'fila', 'conversaId', c.id, 'ticketId', v_ticket);
      elsif v_t ~ '^(2|2\.|n|nao|não|no|errado|não sou|nao sou)$' then
        update imobdesk.at_conversas set ident = v_ident || jsonb_build_object('passo', 'nome', 'tentativas', 0) where id = c.id;
        perform imobdesk.at_auto(c.id, 'Sem problemas! Para agilizar seus próximos atendimentos, qual é o seu nome completo?');
        return jsonb_build_object('estado', 'identificando', 'conversaId', c.id);
      end if;
    elsif v_ident ->> 'passo' = 'nome' then
      if length(v_texto) between 3 and 80 and v_texto ~ '[[:alpha:]]{2}' and v_texto !~ '@' then
        update imobdesk.at_conversas set ident = v_ident || jsonb_build_object('passo', 'email', 'tentativas', 0, 'nome', btrim(v_texto)) where id = c.id;
        perform imobdesk.at_auto(c.id, format('Obrigado, %s. Qual é o seu e-mail corporativo?', imobdesk.at_primeiro_nome(v_texto)));
        return jsonb_build_object('estado', 'identificando', 'conversaId', c.id);
      end if;
    elsif v_ident ->> 'passo' = 'email' then
      v_email := lower(btrim(v_texto));
      if v_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
         and split_part(v_email, '@', 2) = any (coalesce((select x.dominios_corporativos from imobdesk.at_config x where x.id), '{}')::text[]) then
        select pc.pessoa_id into v_pessoa from imobdesk.at_pessoa_contatos pc where pc.tipo = 'email' and pc.valor = v_email limit 1;
        if v_pessoa is null then
          v_pessoa := imobdesk.at_pessoa_identificar('email', v_email, v_ident ->> 'nome', 'WhatsApp ' || s.nome);
        end if;
        -- O número passa a ser desta pessoa (se estava em outra, muda).
        insert into imobdesk.at_pessoa_contatos (pessoa_id, tipo, valor, principal)
        values (v_pessoa, 'whatsapp', v_de, not exists (select 1 from imobdesk.at_pessoa_contatos x where x.pessoa_id = v_pessoa and x.tipo = 'whatsapp'))
        on conflict (tipo, valor) do update set pessoa_id = excluded.pessoa_id;
        insert into imobdesk.at_linhas (numero, pessoa_id, corporativa, confirmado_em)
        values (v_de, v_pessoa, false, now())
        on conflict (numero) do update set pessoa_id = excluded.pessoa_id, confirmado_em = now(), atualizado_em = now();
        update imobdesk.at_conversas set pessoa_id = v_pessoa, nome_contato = left(coalesce(v_ident ->> 'nome', nome_contato), 80)
        where id = c.id returning * into c;
        perform imobdesk.at_evento(c.id, format('Colaborador identificado: %s (%s)', imobdesk.at_nome_da_conversa(c), v_email));
        v_ticket := imobdesk.at_entrar_fila(c.id, array(select jsonb_array_elements_text(coalesce(v_ident -> 'pedido', '[]'))),
                                                     'Pronto! Da próxima vez eu já te reconheço.');
        return jsonb_build_object('estado', 'fila', 'conversaId', c.id, 'ticketId', v_ticket);
      end if;
      v_tent := v_tent + 1;
      if v_tent >= 2 then
        if s.wa_so_corporativo then
          -- Linha corporativa (já conferida): segue para a fila sem identificação; o atendente completa.
          perform imobdesk.at_evento(c.id, 'Identificação não concluída (e-mail inválido): segue para a fila');
          v_ticket := imobdesk.at_entrar_fila(c.id, array(select jsonb_array_elements_text(coalesce(v_ident -> 'pedido', '[]'))));
          return jsonb_build_object('estado', 'fila', 'conversaId', c.id, 'ticketId', v_ticket);
        end if;
        perform imobdesk.at_auto(c.id, s.msg_nao_corporativo);
        update imobdesk.at_conversas set modo = 'encerrada', ident = null, aviso_nao_corporativo_em = now() where id = c.id;
        perform imobdesk.at_evento(c.id, 'Não é colaborador (e-mail fora do domínio): nenhum ticket aberto');
        return jsonb_build_object('estado', 'nao_colaborador', 'conversaId', c.id);
      end if;
      update imobdesk.at_conversas set ident = v_ident || jsonb_build_object('tentativas', v_tent) where id = c.id;
      perform imobdesk.at_auto(c.id, format('Esse e-mail não é de um domínio da empresa (%s). Qual é o seu e-mail corporativo?',
        (select array_to_string(array(select '@' || d from unnest(x.dominios_corporativos) d), ', ') from imobdesk.at_config x where x.id)));
      return jsonb_build_object('estado', 'identificando', 'conversaId', c.id);
    end if;

    -- Resposta que não serve para o passo: repete a pergunta (3 vezes; depois segue para a fila).
    v_tent := v_tent + 1;
    if v_tent >= 3 then
      if l.pessoa_id is not null then update imobdesk.at_conversas set pessoa_id = l.pessoa_id where id = c.id; end if;
      perform imobdesk.at_evento(c.id, 'Identificação não concluída: segue para a fila');
      v_ticket := imobdesk.at_entrar_fila(c.id, array(select jsonb_array_elements_text(coalesce(v_ident -> 'pedido', '[]'))) || v_texto);
      return jsonb_build_object('estado', 'fila', 'conversaId', c.id, 'ticketId', v_ticket);
    end if;
    update imobdesk.at_conversas set ident = v_ident || jsonb_build_object('tentativas', v_tent) where id = c.id;
    perform imobdesk.at_auto(c.id, case v_ident ->> 'passo'
      when 'confirmar' then 'Não entendi. Responda 1 para Sim ou 2 para Não.'
      when 'nome' then 'Qual é o seu nome completo?'
      else 'Qual é o seu e-mail corporativo?' end);
    return jsonb_build_object('estado', 'identificando', 'conversaId', c.id);
  end if;

  -- ---------- Conversa nova ou encerrada: começa um atendimento ----------
  select * into l from imobdesk.at_linhas x where x.numero = v_de;
  if s.wa_so_corporativo and not coalesce(l.corporativa, false) then
    if c.aviso_nao_corporativo_em is null or c.aviso_nao_corporativo_em < now() - interval '24 hours' then
      perform imobdesk.at_auto(c.id, s.msg_nao_corporativo);
      update imobdesk.at_conversas set aviso_nao_corporativo_em = now() where id = c.id;
      perform imobdesk.at_evento(c.id, 'Número fora das linhas corporativas: nenhum ticket aberto');
    end if;
    return jsonb_build_object('estado', 'nao_corporativo', 'conversaId', c.id);
  end if;

  -- Linha já confirmada (ou da planilha com pessoa, se a identificação estiver desligada): vincula a pessoa.
  if l.pessoa_id is not null and (l.confirmado_em is not null or not s.wa_identificar) then
    update imobdesk.at_conversas set pessoa_id = l.pessoa_id where id = c.id returning * into c;
  end if;

  if s.wa_identificar and (l.confirmado_em is null or l.pessoa_id is null) and imobdesk.at_auto_permitido(v_de) then
    if l.pessoa_id is not null then
      update imobdesk.at_conversas set modo = 'robo', ident = jsonb_build_object('passo', 'confirmar', 'tentativas', 0, 'desde', now(), 'pedido', jsonb_build_array(v_texto))
      where id = c.id;
      perform imobdesk.at_auto(c.id, format('Olá! Você é %s (%s)? Responda 1 para Sim ou 2 para Não.',
        (select pe.nome from imobdesk.at_pessoas pe where pe.id = l.pessoa_id),
        coalesce((select pc.valor from imobdesk.at_pessoa_contatos pc where pc.pessoa_id = l.pessoa_id and pc.tipo = 'email' order by pc.principal desc, pc.id limit 1), 'sem e-mail')));
      return jsonb_build_object('estado', 'identificando', 'conversaId', c.id);
    else
      update imobdesk.at_conversas set modo = 'robo', ident = jsonb_build_object('passo', 'nome', 'tentativas', 0, 'desde', now(), 'pedido', jsonb_build_array(v_texto))
      where id = c.id;
      perform imobdesk.at_auto(c.id, 'Olá! Para agilizar seus próximos atendimentos, qual é o seu nome completo?');
      return jsonb_build_object('estado', 'identificando', 'conversaId', c.id);
    end if;
  elsif not s.wa_identificar and c.pessoa_id is null then
    -- Setor sem identificação: autocadastro pelo número (como antes).
    update imobdesk.at_conversas
       set pessoa_id = imobdesk.at_pessoa_identificar('whatsapp', v_de, p ->> 'nome', 'WhatsApp ' || s.nome)
     where id = c.id;
  end if;

  v_ticket := imobdesk.at_entrar_fila(c.id, array[v_texto]);
  return jsonb_build_object('estado', 'fila', 'conversaId', c.id, 'ticketId', v_ticket);
end;
$$;

-- ======================================================================= ações do atendente

/**
 * Ação na conversa por um usuário (interna: a pública at_conversa_acao confere quem chama).
 * p: {acao: assumir|devolver|transferir|enviar|encerrar, texto?, para?, resolvido?, origem?: 'portal'|'grupo'|'roleta'|'sistema'}
 */
create or replace function imobdesk.at_conversa_executar(p_conversa bigint, p_usuario uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c imobdesk.at_conversas;
  s imobdesk.at_setores;
  v_acao text := coalesce(p ->> 'acao', '');
  v_origem text := coalesce(p ->> 'origem', 'portal');
  v_nome text := imobdesk.ch_nome_usuario(p_usuario);
  v_ticket bigint;
  v_texto text;
  v_msg bigint;
  v_para uuid;
  v_cat text;
  v_resolvido boolean := coalesce((p ->> 'resolvido')::boolean, false);
begin
  select * into c from imobdesk.at_conversas x where x.id = p_conversa for update;
  if c.id is null then perform imobdesk.erro('NOT_FOUND', 'Conversa não encontrada.'); end if;
  select * into s from imobdesk.at_setores x where x.id = c.setor_id;
  v_ticket := imobdesk.at_ticket_da_conversa(c.id);
  if c.modo in ('encerrada', 'robo') and v_acao <> 'enviar' then
    perform imobdesk.erro('INVALID_INPUT', case when c.modo = 'robo' then 'O colaborador ainda está se identificando.' else 'Conversa encerrada. Ela reabre quando o cliente escrever de novo.' end);
  end if;

  if v_acao in ('assumir', 'transferir') then
    v_para := case when v_acao = 'transferir' then nullif(p ->> 'para', '')::uuid else p_usuario end;
    if v_acao = 'transferir' and not exists (select 1 from imobdesk.at_atendentes a where a.usuario_id = v_para and a.setor_id = c.setor_id) then
      perform imobdesk.erro('INVALID_INPUT', 'Escolha um atendente do mesmo setor.', 'para');
    end if;
    if c.atendente_id is not distinct from v_para then return jsonb_build_object('ok', true); end if;
    update imobdesk.at_conversas set modo = 'atendente', atendente_id = v_para, atendente_desde = now(), ultimo_atendente_id = v_para,
           nao_lidas = case when v_origem = 'portal' and v_acao = 'assumir' then 0 else nao_lidas end, atualizado_em = now()
    where id = c.id;
    update imobdesk.at_atendimentos set atendente_id = v_para, assumido_em = coalesce(assumido_em, now()),
           transferencias = transferencias + case when c.atendente_id is not null then 1 else 0 end
    where id = c.atendimento_id;
    if v_origem = 'roleta' then
      update imobdesk.at_atendentes set ultimo_recebido_em = now() where usuario_id = v_para;
    end if;
    -- Ticket: responsável = quem atende; sai de "Novo" para "Em atendimento".
    select st.categoria into v_cat from imobdesk.ch_tickets t join imobdesk.ch_status st on st.id = t.status_id where t.id = v_ticket;
    update imobdesk.ch_tickets set responsavel_id = v_para,
           status_id = case when v_cat in ('novo', 'pendente') then imobdesk.ch_status_de('andamento', 'Em atendimento') else status_id end,
           assumido_em = coalesce(assumido_em, now())
    where id = v_ticket;
    perform imobdesk.at_evento(c.id, case
      when v_origem = 'roleta' then format('Distribuída pela roleta para %s', imobdesk.ch_nome_usuario(v_para))
      when v_acao = 'transferir' then format('Conversa transferida para %s por %s', imobdesk.ch_nome_usuario(v_para), v_nome)
      when c.atendente_id is not null then format('Conversa transferida de %s para %s', imobdesk.ch_nome_usuario(c.atendente_id), v_nome)
      when v_origem = 'grupo' then format('%s assumiu ao responder pelo WhatsApp', v_nome)
      else format('%s assumiu a conversa', v_nome) end);
    return jsonb_build_object('ok', true);
  end if;

  if v_acao = 'devolver' then
    update imobdesk.at_conversas set modo = 'fila', atendente_id = null, atendente_desde = null, fila_desde = now(), atualizado_em = now() where id = c.id;
    update imobdesk.at_atendimentos set devolvido_fila = true where id = c.atendimento_id;
    perform imobdesk.at_evento(c.id, case when v_origem = 'sistema' then format('Voltou à fila: %s sem responder há %s min', coalesce(imobdesk.ch_nome_usuario(c.atendente_id), 'atendente'), s.atendente_sem_resposta_min)
                                                    else format('%s devolveu a conversa à fila', v_nome) end);
    return jsonb_build_object('ok', true);
  end if;

  if v_acao = 'enviar' then
    v_texto := left(btrim(coalesce(p ->> 'texto', '')), 4000);
    if v_texto = '' then perform imobdesk.erro('INVALID_INPUT', 'Escreva a mensagem.', 'texto'); end if;
    if c.modo in ('encerrada', 'robo') then
      perform imobdesk.erro('INVALID_INPUT', 'Conversa encerrada. Responda pelo ticket ou espere o cliente escrever.');
    end if;
    if c.modo = 'fila' or c.atendente_id is distinct from p_usuario then
      if c.modo = 'atendente' and c.atendente_id is distinct from p_usuario and not coalesce((p ->> 'podeTomar')::boolean, false) then
        perform imobdesk.erro('FORBIDDEN', format('Esta conversa está com %s.', imobdesk.ch_nome_usuario(c.atendente_id)));
      end if;
      perform imobdesk.at_conversa_executar(c.id, p_usuario, jsonb_build_object('acao', 'assumir', 'origem', v_origem));
    end if;
    insert into imobdesk.at_mensagens (conversa_id, atendimento_id, direcao, autor, autor_id, tipo, texto, status)
    values (c.id, c.atendimento_id, 'saida', 'atendente', p_usuario, 'texto', v_texto, 'pendente')
    returning id into v_msg;
    perform imobdesk.at_ticket_acao(v_ticket, 'saida', p_usuario, v_nome, v_texto, v_msg, 'pendente');
    update imobdesk.at_conversas set ultima_msg_atendente_em = now(), ultima_msg_em = now(), ultima_previa = left('Você: ' || v_texto, 200), nao_lidas = 0, atualizado_em = now()
    where id = c.id;
    update imobdesk.at_atendimentos set primeira_resposta_em = coalesce(primeira_resposta_em, now()) where id = c.atendimento_id;
    if v_origem = 'portal' then
      perform imobdesk.at_repassar(c.id, v_ticket, 'enviado', format('✔ %s respondeu *#%s* pelo sistema:%s"%s"', v_nome, v_ticket, E'\n', left(v_texto, 500)));
    end if;
    return jsonb_build_object('ok', true, 'mensagemId', v_msg);
  end if;

  if v_acao = 'encerrar' then
    -- Ticket: resolvido (a RPC pública já validou e gravou a solução) ou continua "Em atendimento".
    if not v_resolvido then
      select st.categoria into v_cat from imobdesk.ch_tickets t join imobdesk.ch_status st on st.id = t.status_id where t.id = v_ticket;
      if v_cat in ('novo', 'pendente', 'andamento') then
        update imobdesk.ch_tickets set status_id = imobdesk.ch_status_de('andamento', 'Em atendimento'), justificativa_id = null where id = v_ticket;
      end if;
    end if;
    perform imobdesk.at_auto(c.id, s.msg_encerramento);
    update imobdesk.at_conversas set modo = 'encerrada', ultimo_atendente_id = coalesce(c.atendente_id, p_usuario, ultimo_atendente_id), atendente_id = null,
           ultima_previa = 'Atendimento encerrado', atualizado_em = now()
    where id = c.id;
    update imobdesk.at_atendimentos set encerrado_em = now(), encerrado_por = p_usuario,
           encerramento = case when v_origem = 'sistema' then 'inatividade' else 'atendente' end
    where id = c.atendimento_id;
    perform imobdesk.at_evento(c.id, case when v_origem = 'sistema' then format('Encerrada por inatividade (%s h sem mensagem do cliente) · ticket #%s em atendimento', s.encerrar_apos_horas, v_ticket)
      else format('%s encerrou a conversa · ticket #%s %s', v_nome, v_ticket, case when v_resolvido then 'resolvido' else 'continua em atendimento' end) end);
    perform imobdesk.at_repassar(c.id, v_ticket, 'aviso', format('✅ *#%s* encerrado%s · %s', v_ticket,
      case when v_origem = 'sistema' then ' por inatividade' else ' por ' || v_nome end, case when v_resolvido then 'resolvido' else 'continua em atendimento' end));
    return jsonb_build_object('ok', true, 'ticketId', v_ticket);
  end if;

  perform imobdesk.erro('INVALID_INPUT', 'Ação inválida.');
end;
$$;

/**
 * Ação do atendente pelo portal (Conversas, tela do ticket). Confere quem pode:
 *   assumir/enviar: atendente do setor (conversa na fila ou dele) ou gestão do setor;
 *   devolver: quem está com a conversa ou a gestão; transferir: só a gestão;
 *   encerrar: quem está com a conversa ou a gestão. Com {resolvido: true, solucao, servicoId?, categoriaId?}
 *   o ticket vai para Resolvido (as regras de resolver do ticket valem: serviço, solução e obrigatórios).
 */
create or replace function imobdesk.at_conversa_acao(p_conversa bigint, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_eu uuid := auth.uid();
  c imobdesk.at_conversas;
  v_acao text := coalesce(p ->> 'acao', '');
  v_gestor boolean;
  v_ticket bigint;
  v_upd jsonb;
begin
  select * into c from imobdesk.at_conversas x where x.id = p_conversa;
  if v_eu is null or c.id is null or not (imobdesk.at_supervisor()
       or imobdesk.at_ve_conversa(c.setor_id, c.atendente_id, case when c.modo = 'encerrada' then c.ultimo_atendente_id end)) then
    perform imobdesk.erro('NOT_FOUND', 'Conversa não encontrada.');
  end if;
  v_gestor := imobdesk.at_gestor_de(c.setor_id);
  if v_acao = 'transferir' and not v_gestor then perform imobdesk.erro('FORBIDDEN', 'Só a gestão do setor transfere conversas.'); end if;
  if v_acao in ('devolver', 'encerrar') and c.atendente_id is distinct from v_eu and not v_gestor then
    perform imobdesk.erro('FORBIDDEN', 'Só quem está com a conversa ou a gestão do setor faz isso.');
  end if;
  if v_acao = 'assumir' and c.modo = 'atendente' and c.atendente_id is distinct from v_eu and not v_gestor then
    perform imobdesk.erro('FORBIDDEN', 'Outro atendente está com esta conversa.');
  end if;
  if v_acao in ('assumir', 'enviar') and not v_gestor
     and not exists (select 1 from imobdesk.at_atendentes a where a.usuario_id = v_eu and a.setor_id = c.setor_id) then
    perform imobdesk.erro('FORBIDDEN', 'Entre na equipe do setor em Fila e horários para atender.');
  end if;

  if v_acao = 'encerrar' and coalesce((p ->> 'resolvido')::boolean, false) then
    v_ticket := imobdesk.at_ticket_da_conversa(c.id);
    if v_ticket is null then perform imobdesk.erro('INVALID_INPUT', 'Esta conversa não tem ticket.'); end if;
    v_upd := jsonb_build_object('statusId', imobdesk.ch_status_de('resolvido'), 'solucaoAplicada', p ->> 'solucao')
             || case when p ? 'servicoId' then jsonb_build_object('servicoId', p -> 'servicoId') else '{}' end
             || case when p ? 'categoriaId' then jsonb_build_object('categoriaId', p -> 'categoriaId') else '{}' end
             || case when (select t.responsavel_id from imobdesk.ch_tickets t where t.id = v_ticket) is null then jsonb_build_object('responsavelId', v_eu) else '{}' end;
    -- Valida e grava como o próprio usuário (mesmas regras do botão Resolver do ticket).
    perform imobdesk.ch_ticket_atualizar(v_ticket, v_upd);
  end if;
  return imobdesk.at_conversa_executar(c.id, v_eu, (p - 'origem' - 'podeTomar') || jsonb_build_object('origem', 'portal', 'podeTomar', v_gestor));
end;
$$;

-- ======================================================================= ticket → WhatsApp

-- Resposta pública no ticket de WhatsApp (tela do ticket): vira mensagem pendente na conversa do ticket.
create or replace function imobdesk.ch_acao_para_whatsapp()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  t imobdesk.ch_tickets;
  c imobdesk.at_conversas;
  v_msg bigint;
begin
  if new.canal <> 'whatsapp' or new.tipo <> 'publica' or new.direcao <> 'saida' or new.mensagem_id is not null or new.envio_status is distinct from 'pendente' then
    return null;
  end if;
  select * into t from imobdesk.ch_tickets x where x.id = new.ticket_id;
  select * into c from imobdesk.at_conversas x where x.id = t.conversa_id;
  if c.id is null then
    update imobdesk.ch_ticket_acoes set envio_status = 'falhou', envio_erro = 'Ticket sem conversa de WhatsApp.' where id = new.id;
    return null;
  end if;
  insert into imobdesk.at_mensagens (conversa_id, atendimento_id, direcao, autor, autor_id, tipo, texto, status)
  values (c.id, c.atendimento_id, 'saida', 'atendente', new.autor_id, 'texto', left(new.texto, 4000), 'pendente')
  returning id into v_msg;
  update imobdesk.ch_ticket_acoes set mensagem_id = v_msg where id = new.id;
  update imobdesk.at_conversas set ultima_msg_atendente_em = now(), ultima_msg_em = now(), ultima_previa = left('Você: ' || new.texto, 200), atualizado_em = now()
  where id = c.id;
  perform imobdesk.at_repassar(c.id, t.id, 'enviado', format('✔ %s respondeu *#%s* pelo ticket:%s"%s"', new.autor_nome, t.id, E'\n', left(new.texto, 500)));
  return null;
end;
$$;
drop trigger if exists ch_acoes_whatsapp on imobdesk.ch_ticket_acoes;
create trigger ch_acoes_whatsapp after insert on imobdesk.ch_ticket_acoes
for each row execute function imobdesk.ch_acao_para_whatsapp();

-- Status do envio da mensagem volta para a ação do ticket.
create or replace function imobdesk.at_mensagem_status_para_acao()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status is distinct from old.status and new.direcao = 'saida' then
    update imobdesk.ch_ticket_acoes
       set envio_status = case when new.status in ('enviada', 'entregue', 'lida') then 'enviado' when new.status = 'falhou' then 'falhou' else envio_status end,
           envio_erro = case when new.status = 'falhou' then left(new.erro, 1000) else null end
     where mensagem_id = new.id and envio_status is distinct from case when new.status in ('enviada', 'entregue', 'lida') then 'enviado' when new.status = 'falhou' then 'falhou' else envio_status end;
  end if;
  return null;
end;
$$;
drop trigger if exists at_mensagens_status_acao on imobdesk.at_mensagens;
create trigger at_mensagens_status_acao after update of status on imobdesk.at_mensagens
for each row execute function imobdesk.at_mensagem_status_para_acao();

-- ======================================================================= envio (despachante)

/**
 * Reserva o que está pendente para enviar (2 min; quem não confirmar libera de novo). p_conversa limita a uma
 * conversa (envio na hora, depois de uma ação). Devolve {mensagens: [...], repasses: [...]}.
 */
create or replace function imobdesk.at_whatsapp_reservar(p_limite int default 30, p_conversa bigint default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_msgs jsonb;
  v_reps jsonb;
begin
  with alvo as (
    select m.id from imobdesk.at_mensagens m
    where m.status = 'pendente' and m.direcao = 'saida' and m.envio_tentativas < 3
      and (m.envio_reservado_ate is null or m.envio_reservado_ate < now())
      and (p_conversa is null or m.conversa_id = p_conversa)
    order by m.id limit greatest(1, least(coalesce(p_limite, 30), 100))
    for update skip locked
  ), res as (
    update imobdesk.at_mensagens m set envio_reservado_ate = now() + interval '2 minutes' from alvo where m.id = alvo.id returning m.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id, 'texto', r.texto, 'autor', r.autor, 'autorNome', imobdesk.ch_nome_usuario(r.autor_id),
    'telefone', c.telefone, 'canal', n.canal, 'numero', n.numero, 'sessao', n.openwa_sessao, 'setor', s.nome,
    'arquivo', r.arquivo, 'tipo', r.tipo
  ) order by r.id), '[]') into v_msgs
  from res r
  join imobdesk.at_conversas c on c.id = r.conversa_id
  join imobdesk.at_numeros n on n.id = c.numero_id
  join imobdesk.at_setores s on s.id = c.setor_id;

  with alvo as (
    select x.id from imobdesk.at_repasses x
    where x.status = 'pendente' and x.envio_tentativas < 3 and (x.envio_reservado_ate is null or x.envio_reservado_ate < now())
      and (p_conversa is null or x.conversa_id = p_conversa)
    order by x.id limit greatest(1, least(coalesce(p_limite, 30), 100))
    for update skip locked
  ), res as (
    update imobdesk.at_repasses x set envio_reservado_ate = now() + interval '2 minutes' from alvo where x.id = alvo.id returning x.*
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'texto', r.texto, 'citar', r.citar_externo_id, 'sessao', n.openwa_sessao, 'grupo', n.grupo_interno) order by r.id), '[]')
  into v_reps
  from res r join imobdesk.at_numeros n on n.id = r.numero_id;

  return jsonb_build_object('mensagens', v_msgs, 'repasses', v_reps);
end;
$$;

/** Resultado do envio. p: {tipo: 'mensagem'|'repasse', id, ok, externoId?, erro?}. 3 falhas = falhou de vez. */
create or replace function imobdesk.at_whatsapp_envio_resultado(p jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint := (p ->> 'id')::bigint;
  v_ok boolean := coalesce((p ->> 'ok')::boolean, false);
begin
  if p ->> 'tipo' = 'repasse' then
    update imobdesk.at_repasses set
      envio_tentativas = envio_tentativas + 1, envio_reservado_ate = null,
      status = case when v_ok then 'enviada' when envio_tentativas + 1 >= 3 then 'falhou' else 'pendente' end,
      externo_id = case when v_ok then nullif(p ->> 'externoId', '') else externo_id end,
      erro = case when v_ok then null else left(p ->> 'erro', 1000) end
    where id = v_id;
  else
    update imobdesk.at_mensagens set
      envio_tentativas = envio_tentativas + 1, envio_reservado_ate = null,
      status = case when v_ok then 'enviada' when envio_tentativas + 1 >= 3 then 'falhou' else 'pendente' end,
      zenvia_id = case when v_ok and p ->> 'canal' = 'zenvia' then coalesce(nullif(p ->> 'externoId', ''), zenvia_id) else zenvia_id end,
      externo_id = case when v_ok and p ->> 'canal' = 'openwa' then coalesce(nullif(p ->> 'externoId', ''), externo_id) else externo_id end,
      erro = case when v_ok then null else left(p ->> 'erro', 1000) end
    where id = v_id;
  end if;
end;
$$;

-- ======================================================================= ciclo (pg_cron)

/** Roleta, inatividade e identificação parada. Chamado pela Edge a cada 1 min (service role). */
create or replace function imobdesk.at_whatsapp_ciclo()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_usr uuid;
  v_ident int := 0;
  v_devolvidas int := 0;
  v_encerradas int := 0;
  v_roleta int := 0;
begin
  -- Identificação parada há 10 min: segue para a fila sem identificação.
  for r in select c.id, c.ident from imobdesk.at_conversas c
           where c.modo = 'robo' and coalesce((c.ident ->> 'desde')::timestamptz, c.atualizado_em) < now() - interval '10 minutes'
           order by c.id limit 50 loop
    perform imobdesk.at_evento(r.id, 'Sem resposta na identificação: segue para a fila');
    perform imobdesk.at_entrar_fila(r.id, array(select jsonb_array_elements_text(coalesce(r.ident -> 'pedido', '[]'))));
    v_ident := v_ident + 1;
  end loop;

  -- Cliente sem mensagem há N horas (setor): encerra; o ticket continua "Em atendimento".
  for r in select c.id from imobdesk.at_conversas c join imobdesk.at_setores s on s.id = c.setor_id
           where c.modo in ('fila', 'atendente') and coalesce(c.ultima_msg_cliente_em, c.fila_desde) < now() - make_interval(hours => s.encerrar_apos_horas)
           order by c.id limit 50 loop
    perform imobdesk.at_conversa_executar(r.id, null, jsonb_build_object('acao', 'encerrar', 'origem', 'sistema', 'resolvido', false));
    v_encerradas := v_encerradas + 1;
  end loop;

  -- Atendente sem responder ao cliente há N min (setor): volta para a fila.
  for r in select c.id from imobdesk.at_conversas c join imobdesk.at_setores s on s.id = c.setor_id
           where c.modo = 'atendente' and c.ultima_msg_cliente_em > coalesce(c.ultima_msg_atendente_em, c.atendente_desde, '-infinity')
             and c.ultima_msg_cliente_em < now() - make_interval(mins => s.atendente_sem_resposta_min)
             and coalesce(c.atendente_desde, '-infinity') < now() - make_interval(mins => s.atendente_sem_resposta_min)
           order by c.id limit 50 loop
    perform imobdesk.at_conversa_executar(r.id, null, jsonb_build_object('acao', 'devolver', 'origem', 'sistema'));
    v_devolvidas := v_devolvidas + 1;
  end loop;

  -- Roleta: dentro do horário, a fila (ordem de chegada) vai para quem está apto, online, sem pausa e abaixo do limite,
  -- começando por quem recebeu há mais tempo.
  for r in select c.id, c.setor_id from imobdesk.at_conversas c
           where c.modo = 'fila' and c.atendente_id is null and imobdesk.at_dentro_horario(c.setor_id)
           order by c.fila_desde nulls first, c.id limit 50 loop
    v_usr := null;
    select ate.usuario_id into v_usr
    from imobdesk.at_atendentes ate
    join imobdesk.at_setores s on s.id = ate.setor_id
    where ate.setor_id = r.setor_id and ate.apto and not ate.pausa and ate.online_em > now() - interval '3 minutes'
      and (select count(*) from imobdesk.at_conversas x where x.atendente_id = ate.usuario_id and x.modo = 'atendente') < s.limite_simultaneo
    order by ate.ultimo_recebido_em nulls first, ate.usuario_id
    limit 1;
    continue when v_usr is null;
    perform imobdesk.at_conversa_executar(r.id, v_usr, jsonb_build_object('acao', 'assumir', 'origem', 'roleta'));
    v_roleta := v_roleta + 1;
  end loop;

  return jsonb_build_object('identificacao', v_ident, 'encerradas', v_encerradas, 'devolvidas', v_devolvidas, 'roleta', v_roleta);
end;
$$;

-- ======================================================================= telas

-- Lista da Central: "ticket" passa a ser o ticket da Gestão de Chamados (antes era o nº do atendimento).
create or replace function imobdesk.at_conversas_lista(p_limite int default 300)
returns table (
  id bigint, setor_id bigint, numero text, telefone text, nome_contato text, modo text,
  atendente_id uuid, atendente_nome text, atendente_desde timestamptz, fila_desde timestamptz,
  ticket bigint, ultima_msg_cliente_em timestamptz, ultima_msg_atendente_em timestamptz, ultima_msg_em timestamptz,
  ultima_previa text, nao_lidas int, nota_interna text, cliente_desde timestamptz, total_atendimentos bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  select c.id, c.setor_id, n.numero, c.telefone,
         coalesce((select pe.nome from imobdesk.at_pessoas pe where pe.id = c.pessoa_id), c.nome_contato), c.modo,
         c.atendente_id, coalesce(ua.nome, uu.nome), c.atendente_desde, c.fila_desde,
         (select a.ticket_id from imobdesk.at_atendimentos a where a.id = c.atendimento_id),
         c.ultima_msg_cliente_em, c.ultima_msg_atendente_em, c.ultima_msg_em,
         c.ultima_previa, c.nao_lidas, c.nota_interna, c.criado_em,
         (select count(*) from imobdesk.at_atendimentos t where t.conversa_id = c.id)
  from imobdesk.at_conversas c
  join imobdesk.at_numeros n on n.id = c.numero_id
  left join imobdesk.usuarios ua on ua.id = c.atendente_id
  left join imobdesk.usuarios uu on uu.id = c.ultimo_atendente_id
  order by c.ultima_msg_em desc nulls last
  limit least(greatest(coalesce(p_limite, 300), 1), 1000);
$$;

create or replace function imobdesk.at_monitor_conversas(p_setor bigint default null)
returns table (
  conversa_id bigint, ticket bigint, setor_id bigint, setor_nome text, nome_contato text, telefone text, numero text,
  modo text, ultima_previa text, fila_desde timestamptz, atendente_id uuid, atendente_nome text, atendente_desde timestamptz,
  ultima_msg_cliente_em timestamptz, ultima_msg_atendente_em timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_setores bigint[] := imobdesk.at_monitor_setores(p_setor);
begin
  return query
    select c.id, (select a.ticket_id from imobdesk.at_atendimentos a where a.id = c.atendimento_id), c.setor_id, s.nome,
           coalesce((select pe.nome from imobdesk.at_pessoas pe where pe.id = c.pessoa_id), c.nome_contato), c.telefone, n.numero,
           c.modo, c.ultima_previa, c.fila_desde, c.atendente_id, u.nome, c.atendente_desde,
           c.ultima_msg_cliente_em, c.ultima_msg_atendente_em
    from imobdesk.at_conversas c
    join imobdesk.at_setores s on s.id = c.setor_id
    join imobdesk.at_numeros n on n.id = c.numero_id
    left join imobdesk.usuarios u on u.id = c.atendente_id
    where c.setor_id = any (v_setores) and c.modo in ('fila', 'atendente')
    order by c.modo, coalesce(c.fila_desde, c.atendente_desde);
end;
$$;

-- ======================================================================= permissões e agendamento

do $$
declare
  f text;
begin
  foreach f in array array[
    'ch_status_de(text, text)', 'at_dentro_horario(bigint)', 'at_auto_permitido(text)', 'at_evento(bigint, text)', 'at_auto(bigint, text)',
    'at_repassar(bigint, bigint, text, text, text)', 'at_nome_da_conversa(imobdesk.at_conversas)', 'at_ticket_da_conversa(bigint)',
    'at_ticket_acao(bigint, text, uuid, text, text, bigint, text)', 'at_entrar_fila(bigint, text[], text, boolean)', 'at_whatsapp_receber(jsonb)',
    'at_conversa_executar(bigint, uuid, jsonb)', 'at_whatsapp_reservar(int, bigint)', 'at_whatsapp_envio_resultado(jsonb)', 'at_whatsapp_ciclo()',
    'ch_acao_para_whatsapp()', 'at_mensagem_status_para_acao()'
  ] loop
    execute format('revoke execute on function imobdesk.%s from public, anon, authenticated', f);
    execute format('grant execute on function imobdesk.%s to service_role', f);
  end loop;
  revoke execute on function imobdesk.at_conversa_acao(bigint, jsonb) from public, anon;
  grant execute on function imobdesk.at_conversa_acao(bigint, jsonb) to authenticated, service_role;
  revoke execute on function imobdesk.at_primeiro_nome(text) from public, anon;
  grant execute on function imobdesk.at_primeiro_nome(text) to authenticated, service_role;
end;
$$;

-- Chave do pg_cron para a Edge imobdesk-whatsapp (ciclo + envio a cada 1 min).
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'imobdesk_whatsapp_cron') then
    perform vault.create_secret(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'imobdesk_whatsapp_cron',
      'Chave do pg_cron para a Edge imobdesk-whatsapp (Imobdesk)');
  end if;
end;
$$;

create or replace function imobdesk.at_whatsapp_cron_chave()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select d.decrypted_secret from vault.decrypted_secrets d where d.name = 'imobdesk_whatsapp_cron';
$$;
revoke execute on function imobdesk.at_whatsapp_cron_chave() from public, anon, authenticated;
grant execute on function imobdesk.at_whatsapp_cron_chave() to service_role;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'imobdesk-whatsapp-1min') then
    perform cron.unschedule('imobdesk-whatsapp-1min');
  end if;
  perform cron.schedule('imobdesk-whatsapp-1min', '* * * * *', $job$
    select net.http_post(
      url := 'https://ikvjaowvpvxojvcfwnct.supabase.co/functions/v1/imobdesk-whatsapp',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-atendimento-chave', imobdesk.at_whatsapp_cron_chave()),
      body := '{"acao": "ciclo"}'::jsonb,
      timeout_milliseconds := 55000
    );
  $job$);
end;
$$;
