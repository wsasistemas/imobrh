-- ImobRH · 0001 · Fundação do schema app_imobrh (Fase 0 do docs/PLANO-fase0.md).
--
-- Aplicar pelo SQL Editor do ikvj (projeto compartilhado: nunca `supabase db push`). Aditiva: não altera nem
-- apaga nada fora do schema app_imobrh; no imobdesk só lê (empresa_atual, sessao_confiavel, usuarios).
--
-- Como a segurança funciona:
--  * multiempresa: toda tabela tem tenant_id = imobdesk.empresas.id (a empresa vem de imobdesk.empresa_atual(),
--    a mesma regra do imobdesk; service_role informa a empresa no cabeçalho x-empresa-id);
--  * RLS forçada em todas as tabelas: policy RESTRITIVA app_imobrh_tenant + policies por papel;
--  * tabelas e funções são do papel app_imobrh_dono (sem BYPASSRLS), então a RLS de empresa vale também dentro
--    das funções security definer. Ficam com o postgres só as que leem o auth ou o imobdesk, ou gravam no Vault;
--    essas filtram a empresa de forma explícita (lista v_do_postgres em aplicar_multiempresa);
--  * login: a sessão precisa ser confiável para o imobdesk (aberta pelo gateway imobdesk-auth), ver app_imobrh.uid().
--
-- Migration que criar tabela ou função no schema termina com: select app_imobrh.aplicar_multiempresa();

create schema if not exists app_imobrh;
comment on schema app_imobrh is 'ImobRH: pedidos e casos de RH, Console do RH. Fonte: docs/PRD-imobRH-v2.md.';

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_imobrh_dono') then
    create role app_imobrh_dono nologin nobypassrls;
  end if;
end;
$$;
grant app_imobrh_dono to postgres;

revoke all on schema app_imobrh from public;
grant usage on schema app_imobrh to authenticated, service_role, app_imobrh_dono;
grant create on schema app_imobrh to app_imobrh_dono;

-- O dono chama auth.uid()/auth.jwt() e as funções de empresa do imobdesk. Um grant por comando: no Supabase,
-- um grant sem GRANT OPTION só avisa e pularia o resto (Cerebro: supabase-multiempresa-retrofit…).
do $$
declare
  v_cmd text;
begin
  foreach v_cmd in array array[
    'grant usage on schema auth to app_imobrh_dono',
    'grant usage on schema imobdesk to app_imobrh_dono'
  ] loop
    begin
      execute v_cmd;
    exception when others then
      raise notice 'app_imobrh: % (%)', v_cmd, sqlerrm;
    end;
  end loop;
  if not has_schema_privilege('app_imobrh_dono', 'auth', 'usage') then
    execute 'grant authenticated to app_imobrh_dono';
  end if;
end;
$$;

-- ============================================================================================
-- Funções de base (do postgres: leem o imobdesk e o JWT)
-- ============================================================================================

/** Erro de regra: o front e as Edge Functions leem detail = código e hint = campo. */
create or replace function app_imobrh.erro(p_codigo text, p_mensagem text, p_campo text default null)
returns void
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = 'P0001', message = p_mensagem, detail = p_codigo, hint = coalesce(p_campo, '');
end;
$$;

/** Empresa da requisição: a mesma regra do imobdesk (contexto do servidor, x-empresa-id ou o login). */
create or replace function app_imobrh.empresa_atual()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select imobdesk.empresa_atual();
$$;

/** Usuário logado, só se a sessão for confiável para o imobdesk (aberta pelo gateway de login). */
create or replace function app_imobrh.uid()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select case when imobdesk.sessao_confiavel() then (select auth.uid()) end;
$$;

/** Os 8 papéis do PRD v2. colaborador e gestor normalmente vêm do RM (vínculo e hierarquia). */
create or replace function app_imobrh.papeis_validos()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['admin', 'rh_dp', 'rh_dp_restrita', 'recrutamento', 'compliance', 'diretoria', 'gestor', 'colaborador'];
$$;

/** Papéis que entram no Console do RH (os outros usam o app do imobdesk). */
create or replace function app_imobrh.papeis_console()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['admin', 'rh_dp', 'rh_dp_restrita', 'recrutamento', 'compliance'];
$$;

create or replace function app_imobrh.definir_atualizado_em()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ============================================================================================
-- Tabelas
-- ============================================================================================

-- Identidade: login (auth.users) ↔ funcionário do RM (coligada + chapa), pelo CPF.
create table if not exists app_imobrh.colaborador_vinculo (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default app_imobrh.empresa_atual() references imobdesk.empresas (id),
  user_id uuid not null references auth.users (id) on delete cascade,
  cpf text check (cpf ~ '^[0-9]{11}$'),
  coligada integer,
  chapa text check (chapa is null or length(btrim(chapa)) between 1 and 20),
  nome text,
  situacao text,
  secao_codigo text,
  secao_nome text,
  funcao text,
  data_admissao date,
  gestor_chapa text,
  status text not null default 'pendente' check (status in ('vinculado', 'pendente', 'divergente')),
  motivo text,
  fonte text not null default 'rm' check (fonte in ('rm', 'mock')),
  sincronizado_em timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, user_id),
  unique (tenant_id, coligada, chapa),
  check ((status = 'vinculado') = (coligada is not null and chapa is not null))
);
comment on table app_imobrh.colaborador_vinculo is 'Vínculo do login com o funcionário do RM. Sem chapa = vínculo pendente.';

create table if not exists app_imobrh.papel_usuario (
  tenant_id uuid not null default app_imobrh.empresa_atual() references imobdesk.empresas (id),
  user_id uuid not null references auth.users (id) on delete cascade,
  papel text not null check (papel = any (app_imobrh.papeis_validos())),
  origem text not null default 'manual' check (origem in ('manual', 'rm')),
  concedido_por uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id, papel)
);
comment on table app_imobrh.papel_usuario is 'Papéis de cada login. Um usuário acumula papéis; concedido_por registra quem deu.';

-- Aprovador ausente: as pendências vão para o substituto no período.
create table if not exists app_imobrh.substituicao (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default app_imobrh.empresa_atual() references imobdesk.empresas (id),
  titular_id uuid not null references auth.users (id) on delete cascade,
  substituto_id uuid not null references auth.users (id) on delete cascade,
  inicio date not null,
  fim date not null,
  motivo text,
  criado_por uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  check (fim >= inicio),
  check (titular_id <> substituto_id)
);
create index if not exists substituicao_titular on app_imobrh.substituicao (tenant_id, titular_id, inicio, fim);

-- Quem leu ou alterou o quê. Só INSERT (gatilho abaixo e grants).
create table if not exists app_imobrh.auditoria (
  id bigint generated always as identity primary key,
  tenant_id uuid not null default app_imobrh.empresa_atual() references imobdesk.empresas (id),
  ocorrido_em timestamptz not null default now(),
  ator_id uuid,
  ator_nome text,
  modulo text not null check (length(modulo) between 2 and 40),
  acao text not null check (length(acao) between 2 and 40),
  entidade text,
  entidade_id text,
  descricao text not null,
  origem text not null default 'console',
  antes jsonb,
  depois jsonb
);
create index if not exists auditoria_recentes on app_imobrh.auditoria (tenant_id, ocorrido_em desc);
comment on table app_imobrh.auditoria is 'Trilha imutável (só INSERT): leituras de dado sensível e toda alteração.';

-- Menus do Console liberados para cada papel (o admin tem tudo e não é editável).
create table if not exists app_imobrh.papel_permissao (
  tenant_id uuid not null default app_imobrh.empresa_atual() references imobdesk.empresas (id),
  papel text not null check (papel = any (app_imobrh.papeis_validos()) and papel <> 'admin'),
  permission_id text not null check (permission_id ~ '^[a-z0-9_]{2,60}$'),
  enabled boolean not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, papel, permission_id)
);

-- Conexão com o TOTVS RM: a senha do usuário de integração fica no Vault (segredo_id).
create table if not exists app_imobrh.integracao_rm (
  tenant_id uuid primary key default app_imobrh.empresa_atual() references imobdesk.empresas (id),
  base_url text not null default '',
  usuario text not null default '',
  segredo_id uuid,
  senha_definida_em timestamptz,
  senha_definida_por text,
  ativo boolean not null default false,
  ultimo_teste jsonb,
  updated_at timestamptz not null default now()
);

-- Catálogo das Consultas SQL do RM usadas pelo ImobRH (padrão API.{módulo}.{id}).
create table if not exists app_imobrh.consulta_rm (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default app_imobrh.empresa_atual() references imobdesk.empresas (id),
  codigo text not null check (codigo ~ '^[A-Za-z0-9._/-]{3,80}$'),
  nome text not null check (length(btrim(nome)) between 2 and 80),
  descricao text,
  tipo text not null default 'outra' check (tipo in ('funcionario', 'hierarquia', 'ferias', 'holerite', 'feriados', 'outra')),
  ativa boolean not null default true,
  ordem integer not null default 0,
  parametros_teste text,
  cache_segundos integer not null default 3600 check (cache_segundos >= 0),
  usada_por text,
  ultimo_teste jsonb,
  updated_at timestamptz not null default now(),
  unique (tenant_id, codigo)
);

-- Cache das leituras do RM (as Edge Functions gravam e leem pelo service_role).
create table if not exists app_imobrh.rm_cache (
  tenant_id uuid not null default app_imobrh.empresa_atual() references imobdesk.empresas (id),
  chave text not null check (length(chave) between 3 and 300),
  valor jsonb not null,
  lido_em timestamptz not null default now(),
  expira_em timestamptz not null,
  primary key (tenant_id, chave)
);

drop trigger if exists colaborador_vinculo_atualizado_em on app_imobrh.colaborador_vinculo;
create trigger colaborador_vinculo_atualizado_em before update on app_imobrh.colaborador_vinculo
  for each row execute function app_imobrh.definir_atualizado_em();
drop trigger if exists integracao_rm_atualizado_em on app_imobrh.integracao_rm;
create trigger integracao_rm_atualizado_em before update on app_imobrh.integracao_rm
  for each row execute function app_imobrh.definir_atualizado_em();
drop trigger if exists consulta_rm_atualizado_em on app_imobrh.consulta_rm;
create trigger consulta_rm_atualizado_em before update on app_imobrh.consulta_rm
  for each row execute function app_imobrh.definir_atualizado_em();

/** caso_evento e auditoria: só INSERT, nem o dono altera ou apaga. */
create or replace function app_imobrh.somente_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = 'P0001', message = format('%s é só INSERT: não pode ser alterada nem apagada.', tg_table_name),
    detail = 'ESTADO_INVALIDO';
end;
$$;
drop trigger if exists auditoria_somente_insert on app_imobrh.auditoria;
create trigger auditoria_somente_insert before update or delete on app_imobrh.auditoria
  for each statement execute function app_imobrh.somente_insert();

-- ============================================================================================
-- Funções de acesso (do dono: a RLS de empresa vale dentro delas)
-- ============================================================================================

create or replace function app_imobrh.papeis_de(p_usuario uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(p.papel order by array_position(app_imobrh.papeis_validos(), p.papel)), '{}')
    from app_imobrh.papel_usuario p
   where p.user_id = p_usuario;
$$;

create or replace function app_imobrh.meus_papeis()
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select app_imobrh.papeis_de(app_imobrh.uid());
$$;

create or replace function app_imobrh.tem_papel(p_papeis text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from app_imobrh.papel_usuario p where p.user_id = app_imobrh.uid() and p.papel = any (p_papeis));
$$;

/**
 * Matriz padrão de menus por papel (Console do RH). A tabela papel_permissao guarda só o que a empresa mudou;
 * sem linha na tabela, vale o padrão. O admin tem tudo e não entra aqui.
 */
create or replace function app_imobrh.permissoes_padrao()
returns table (papel text, permission_id text)
language sql
immutable
set search_path = ''
as $$
  values
    ('rh_dp', 'caixa_rh'), ('rh_dp', 'meus_casos'), ('rh_dp', 'prazos_legais'), ('rh_dp', 'config_vinculos'),
    ('rh_dp_restrita', 'caixa_rh'), ('rh_dp_restrita', 'meus_casos'), ('rh_dp_restrita', 'prazos_legais'),
    ('recrutamento', 'caixa_rh'), ('recrutamento', 'meus_casos'),
    ('compliance', 'meus_casos'), ('compliance', 'view_audit_logs');
$$;

/** Regras efetivas de um papel na empresa: o padrão com as alterações da tabela por cima. */
create or replace function app_imobrh.regras_do_papel(p_papel text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(r.permission_id, r.enabled), '{}'::jsonb)
    from (
      select d.permission_id, true as enabled
        from app_imobrh.permissoes_padrao() d
       where d.papel = p_papel
         and not exists (select 1 from app_imobrh.papel_permissao m where m.papel = p_papel and m.permission_id = d.permission_id)
      union all
      select m.permission_id, m.enabled from app_imobrh.papel_permissao m where m.papel = p_papel
    ) r;
$$;

/** Permissão de um login num menu do Console: admin tem tudo; os outros, pela matriz do papel. */
create or replace function app_imobrh.pode_usuario(p_usuario uuid, p_permissao text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_usuario is not null and exists (
    select 1
      from app_imobrh.papel_usuario p
     where p.user_id = p_usuario
       and (p.papel = 'admin' or coalesce(app_imobrh.regras_do_papel(p.papel) ->> p_permissao, 'false')::boolean)
  );
$$;

create or replace function app_imobrh.pode(p_permissao text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app_imobrh.pode_usuario(app_imobrh.uid(), p_permissao);
$$;

/** Barra a RPC sem a permissão do menu. */
create or replace function app_imobrh.exigir(p_permissao text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := app_imobrh.uid();
begin
  if v_uid is null then
    perform app_imobrh.erro('NAO_AUTENTICADO', 'Sua sessão expirou. Entre novamente.');
  end if;
  if not app_imobrh.pode_usuario(v_uid, p_permissao) then
    perform app_imobrh.erro('SEM_PERMISSAO', 'Você não tem permissão para esta ação.');
  end if;
  return v_uid;
end;
$$;

/** Grava na auditoria. Ator: o usuário logado (ou o informado pela Edge Function). */
create or replace function app_imobrh.registrar_auditoria(
  p_modulo text, p_acao text, p_descricao text,
  p_entidade text default null, p_entidade_id text default null,
  p_antes jsonb default null, p_depois jsonb default null,
  p_ator uuid default null, p_origem text default 'console'
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into app_imobrh.auditoria (ator_id, ator_nome, modulo, acao, descricao, entidade, entidade_id, antes, depois, origem)
  values (
    coalesce(p_ator, app_imobrh.uid()),
    coalesce(nullif(auth.jwt() ->> 'email', ''), case when p_ator is null then null else 'Edge Function' end),
    p_modulo, p_acao, p_descricao, p_entidade, p_entidade_id, p_antes, p_depois, p_origem
  );
$$;

-- ============================================================================================
-- Configurações do Console: papéis e permissões (dono)
-- ============================================================================================

create or replace function app_imobrh.salvar_permissoes_perfil(p_perfil text, p_alteracoes jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item jsonb;
  v_id text;
begin
  perform app_imobrh.exigir('manage_permissions');
  if p_perfil = 'admin' then
    perform app_imobrh.erro('ESTADO_INVALIDO', 'O papel Administrador tem acesso total e não é editável.');
  end if;
  if not (p_perfil = any (app_imobrh.papeis_validos())) then
    perform app_imobrh.erro('VALIDACAO', 'Papel inválido.', 'role');
  end if;
  if jsonb_typeof(p_alteracoes) is distinct from 'array' then
    perform app_imobrh.erro('VALIDACAO', 'Alterações inválidas.');
  end if;

  for v_item in select * from jsonb_array_elements(p_alteracoes) loop
    v_id := v_item ->> 'id';
    if v_id is null or v_id !~ '^[a-z0-9_]{2,60}$' or jsonb_typeof(v_item -> 'enabled') <> 'boolean' then
      perform app_imobrh.erro('VALIDACAO', 'Permissão inválida.');
    end if;
    insert into app_imobrh.papel_permissao (papel, permission_id, enabled)
    values (p_perfil, v_id, (v_item ->> 'enabled')::boolean)
    on conflict (tenant_id, papel, permission_id) do update set enabled = excluded.enabled, updated_at = now();
  end loop;

  perform app_imobrh.registrar_auditoria('permissoes', 'permission',
    format('Permissões do papel %s alteradas (%s itens)', p_perfil, jsonb_array_length(p_alteracoes)),
    'papel', p_perfil, null, p_alteracoes);
end;
$$;

-- ============================================================================================
-- Integração TOTVS RM: catálogo de Consultas SQL (dono)
-- ============================================================================================

/** As consultas do PRD entram na primeira leitura de cada empresa. */
create or replace function app_imobrh.garantir_consultas_padrao()
returns void
language sql
security definer
set search_path = ''
as $$
  insert into app_imobrh.consulta_rm (codigo, nome, descricao, tipo, ordem, parametros_teste, cache_segundos, usada_por)
  values
    ('API.RH.FUNCIONARIO', 'Funcionário', 'Vínculo CPF ↔ coligada + chapa, situação, seção, função e admissão.', 'funcionario', 1, 'CODCOLIGADA=1;CPF=;CHAPA=', 3600, 'rm-funcionario'),
    ('API.RH.HIERARQUIA', 'Hierarquia de chefia', 'Chefe de cada seção, para rotear aprovações.', 'hierarquia', 2, 'CODCOLIGADA=1;CODSECAO=', 3600, 'rm-hierarquia'),
    ('API.RH.FERIAS_SALDO', 'Saldo de férias', 'Períodos aquisitivos, saldo e vencimento (fase 1).', 'ferias', 3, 'CODCOLIGADA=1;CHAPA=', 900, null),
    ('API.RH.FERIAS_PROGRAMADAS', 'Férias programadas', 'Férias já programadas na seção (fase 1).', 'ferias', 4, 'CODCOLIGADA=1;CODSECAO=', 900, null),
    ('API.RH.HOLERITE', 'Holerite', 'Envelope de pagamento da competência (fase 3).', 'holerite', 5, 'CODCOLIGADA=1;CHAPA=;COMPETENCIA=', 0, null),
    ('API.RH.FERIADOS', 'Feriados', 'Calendário da coligada (fase 1).', 'feriados', 6, 'CODCOLIGADA=1', 86400, null)
  on conflict (tenant_id, codigo) do nothing;
$$;

create or replace function app_imobrh.listar_consultas_sql()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app_imobrh.exigir('configure_integrations');
  perform app_imobrh.garantir_consultas_padrao();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', c.id, 'code', c.codigo, 'name', c.nome, 'description', c.descricao, 'type', c.tipo, 'active', c.ativa,
      'order', c.ordem, 'testParams', c.parametros_teste, 'usedBy', c.usada_por, 'lastTest', c.ultimo_teste
    ) order by c.ordem, c.codigo)
      from app_imobrh.consulta_rm c
  ), '[]'::jsonb);
end;
$$;

create or replace function app_imobrh.salvar_consulta_sql(
  p_id uuid, p_codigo text, p_nome text, p_descricao text, p_tipo text, p_ativa boolean, p_parametros_teste text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_codigo text := btrim(coalesce(p_codigo, ''));
  v_antigo app_imobrh.consulta_rm;
begin
  perform app_imobrh.exigir('configure_integrations');
  if v_codigo !~ '^[A-Za-z0-9._/-]{3,80}$' then
    perform app_imobrh.erro('VALIDACAO', 'Código inválido. Use o padrão API.RH.NOME.', 'code');
  end if;
  if length(btrim(coalesce(p_nome, ''))) < 2 then
    perform app_imobrh.erro('VALIDACAO', 'Informe o nome da consulta.', 'name');
  end if;
  if exists (select 1 from app_imobrh.consulta_rm c where c.codigo = v_codigo and c.id is distinct from p_id) then
    perform app_imobrh.erro('VALIDACAO', 'Já existe uma consulta com este código.', 'code');
  end if;

  if p_id is null then
    insert into app_imobrh.consulta_rm (codigo, nome, descricao, tipo, ativa, parametros_teste, ordem)
    values (v_codigo, btrim(p_nome), nullif(btrim(coalesce(p_descricao, '')), ''), p_tipo, coalesce(p_ativa, true),
            nullif(btrim(coalesce(p_parametros_teste, '')), ''),
            coalesce((select max(c.ordem) + 1 from app_imobrh.consulta_rm c), 1))
    returning id into v_id;
    perform app_imobrh.registrar_auditoria('integracoes', 'create', format('Consulta %s criada', v_codigo), 'consultas_sql', v_id::text);
  else
    select * into v_antigo from app_imobrh.consulta_rm c where c.id = p_id;
    if v_antigo.id is null then
      perform app_imobrh.erro('VALIDACAO', 'Consulta não encontrada.');
    end if;
    if v_antigo.usada_por is not null and v_antigo.codigo <> v_codigo then
      perform app_imobrh.erro('ESTADO_INVALIDO', format('O código não muda: a consulta é usada por %s.', v_antigo.usada_por), 'code');
    end if;
    update app_imobrh.consulta_rm
       set codigo = v_codigo, nome = btrim(p_nome), descricao = nullif(btrim(coalesce(p_descricao, '')), ''), tipo = p_tipo,
           ativa = coalesce(p_ativa, true), parametros_teste = nullif(btrim(coalesce(p_parametros_teste, '')), '')
     where id = p_id
    returning id into v_id;
    perform app_imobrh.registrar_auditoria('integracoes', 'update', format('Consulta %s alterada', v_codigo), 'consultas_sql', v_id::text,
      jsonb_build_object('codigo', v_antigo.codigo, 'nome', v_antigo.nome, 'ativa', v_antigo.ativa),
      jsonb_build_object('codigo', v_codigo, 'nome', btrim(p_nome), 'ativa', coalesce(p_ativa, true)));
  end if;
  return v_id;
end;
$$;

create or replace function app_imobrh.definir_consulta_sql_ativa(p_id uuid, p_ativa boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app_imobrh.exigir('configure_integrations');
  update app_imobrh.consulta_rm set ativa = p_ativa where id = p_id;
  if not found then
    perform app_imobrh.erro('VALIDACAO', 'Consulta não encontrada.');
  end if;
  perform app_imobrh.registrar_auditoria('integracoes', case when p_ativa then 'activate' else 'deactivate' end,
    format('Consulta %s', case when p_ativa then 'ativada' else 'desativada' end), 'consultas_sql', p_id::text);
end;
$$;

create or replace function app_imobrh.mover_consulta_sql(p_id uuid, p_direcao text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_atual app_imobrh.consulta_rm;
  v_vizinha app_imobrh.consulta_rm;
begin
  perform app_imobrh.exigir('configure_integrations');
  select * into v_atual from app_imobrh.consulta_rm where id = p_id;
  if v_atual.id is null then
    perform app_imobrh.erro('VALIDACAO', 'Consulta não encontrada.');
  end if;
  if p_direcao = 'up' then
    select * into v_vizinha from app_imobrh.consulta_rm where ordem < v_atual.ordem order by ordem desc limit 1;
  else
    select * into v_vizinha from app_imobrh.consulta_rm where ordem > v_atual.ordem order by ordem limit 1;
  end if;
  if v_vizinha.id is null then
    return;
  end if;
  update app_imobrh.consulta_rm set ordem = v_vizinha.ordem where id = v_atual.id;
  update app_imobrh.consulta_rm set ordem = v_atual.ordem where id = v_vizinha.id;
end;
$$;

create or replace function app_imobrh.excluir_consulta_sql(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_consulta app_imobrh.consulta_rm;
begin
  perform app_imobrh.exigir('configure_integrations');
  select * into v_consulta from app_imobrh.consulta_rm where id = p_id;
  if v_consulta.id is null then
    perform app_imobrh.erro('VALIDACAO', 'Consulta não encontrada.');
  end if;
  if v_consulta.usada_por is not null then
    perform app_imobrh.erro('ESTADO_INVALIDO', format('A consulta é usada por %s e não pode ser excluída.', v_consulta.usada_por));
  end if;
  delete from app_imobrh.consulta_rm where id = p_id;
  perform app_imobrh.registrar_auditoria('integracoes', 'delete', format('Consulta %s excluída', v_consulta.codigo), 'consultas_sql', p_id::text);
end;
$$;

-- Só service_role (Edge Functions): consulta por código ou id, gravação do teste e cache.

create or replace function app_imobrh.consulta_rm_por_codigo(p_codigo text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app_imobrh.garantir_consultas_padrao();
  return (select jsonb_build_object('id', c.id, 'codigo', c.codigo, 'ativa', c.ativa, 'cache_segundos', c.cache_segundos)
            from app_imobrh.consulta_rm c where c.codigo = p_codigo);
end;
$$;

create or replace function app_imobrh.obter_consulta_para_teste(p_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select c.codigo from app_imobrh.consulta_rm c where c.id = p_id;
$$;

create or replace function app_imobrh.registrar_teste_consulta_sql(p_ator uuid, p_id uuid, p_ok boolean, p_mensagem text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_teste jsonb := jsonb_build_object('at', now(), 'ok', p_ok, 'message', left(p_mensagem, 500));
begin
  update app_imobrh.consulta_rm set ultimo_teste = v_teste where id = p_id;
  perform app_imobrh.registrar_auditoria('integracoes', 'test', format('Teste da consulta: %s', left(p_mensagem, 200)),
    'consultas_sql', p_id::text, null, null, p_ator, 'edge');
  return v_teste;
end;
$$;

create or replace function app_imobrh.registrar_teste_totvs(p_ator uuid, p_ok boolean, p_mensagem text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_teste jsonb := jsonb_build_object('at', now(), 'ok', p_ok, 'message', left(p_mensagem, 500), 'proposalId', null);
begin
  insert into app_imobrh.integracao_rm (ultimo_teste) values (v_teste)
  on conflict (tenant_id) do update set ultimo_teste = excluded.ultimo_teste;
  perform app_imobrh.registrar_auditoria('integracoes', 'test', format('Teste da conexão TOTVS RM: %s', left(p_mensagem, 200)),
    'totvs_rm', null, null, null, p_ator, 'edge');
  return v_teste;
end;
$$;

create or replace function app_imobrh.cache_rm_ler(p_chave text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('valor', c.valor, 'lido_em', c.lido_em)
    from app_imobrh.rm_cache c
   where c.chave = p_chave and c.expira_em > now();
$$;

/** Último valor lido, mesmo vencido: o app mostra com a data da leitura quando o RM está fora. */
create or replace function app_imobrh.cache_rm_ultimo(p_chave text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('valor', c.valor, 'lido_em', c.lido_em) from app_imobrh.rm_cache c where c.chave = p_chave;
$$;

create or replace function app_imobrh.cache_rm_gravar(p_chave text, p_valor jsonb, p_segundos integer)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into app_imobrh.rm_cache (chave, valor, lido_em, expira_em)
  values (p_chave, p_valor, now(), now() + make_interval(secs => greatest(p_segundos, 0)))
  on conflict (tenant_id, chave) do update set valor = excluded.valor, lido_em = excluded.lido_em, expira_em = excluded.expira_em;
$$;

/** Vínculo do login com o RM (Edge Function rm-funcionario / rh-me). Aceita vínculo pendente (sem chapa). */
create or replace function app_imobrh.registrar_vinculo(p_usuario uuid, p_dados jsonb, p_ator uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_antes jsonb;
  v_linha app_imobrh.colaborador_vinculo;
  v_chapa text := nullif(btrim(coalesce(p_dados ->> 'chapa', '')), '');
  v_coligada integer := nullif(p_dados ->> 'coligada', '')::integer;
begin
  select to_jsonb(v) into v_antes from app_imobrh.colaborador_vinculo v where v.user_id = p_usuario;
  if v_chapa is not null and exists (
    select 1 from app_imobrh.colaborador_vinculo v where v.coligada = v_coligada and v.chapa = v_chapa and v.user_id <> p_usuario
  ) then
    perform app_imobrh.erro('ESTADO_INVALIDO', format('A chapa %s já está vinculada a outro login.', v_chapa), 'cpf');
  end if;

  insert into app_imobrh.colaborador_vinculo as v (
    user_id, cpf, coligada, chapa, nome, situacao, secao_codigo, secao_nome, funcao, data_admissao, gestor_chapa,
    status, motivo, fonte, sincronizado_em
  ) values (
    p_usuario, nullif(p_dados ->> 'cpf', ''), v_coligada, v_chapa, p_dados ->> 'nome', p_dados ->> 'situacao',
    p_dados ->> 'secao_codigo', p_dados ->> 'secao_nome', p_dados ->> 'funcao', nullif(p_dados ->> 'data_admissao', '')::date,
    p_dados ->> 'gestor_chapa', case when v_chapa is null then coalesce(p_dados ->> 'status', 'pendente') else 'vinculado' end,
    p_dados ->> 'motivo', coalesce(p_dados ->> 'fonte', 'rm'), now()
  )
  on conflict (tenant_id, user_id) do update set
    cpf = coalesce(excluded.cpf, v.cpf), coligada = excluded.coligada, chapa = excluded.chapa, nome = excluded.nome,
    situacao = excluded.situacao, secao_codigo = excluded.secao_codigo, secao_nome = excluded.secao_nome,
    funcao = excluded.funcao, data_admissao = excluded.data_admissao, gestor_chapa = excluded.gestor_chapa,
    status = excluded.status, motivo = excluded.motivo, fonte = excluded.fonte, sincronizado_em = excluded.sincronizado_em
  returning * into v_linha;

  -- O papel colaborador acompanha o vínculo (origem rm).
  if v_linha.status = 'vinculado' then
    insert into app_imobrh.papel_usuario (user_id, papel, origem) values (p_usuario, 'colaborador', 'rm')
    on conflict do nothing;
  end if;

  if v_antes is distinct from to_jsonb(v_linha) then
    perform app_imobrh.registrar_auditoria('vinculos', case when v_antes is null then 'create' else 'update' end,
      format('Vínculo com o RM: %s', case when v_linha.status = 'vinculado' then 'chapa ' || v_linha.chapa else v_linha.status end),
      'colaborador_vinculo', p_usuario::text,
      case when v_antes is null then null else jsonb_build_object('status', v_antes ->> 'status', 'chapa', v_antes ->> 'chapa') end,
      jsonb_build_object('status', v_linha.status, 'chapa', v_linha.chapa), p_ator, 'edge');
  end if;
  return to_jsonb(v_linha);
end;
$$;

/** Papéis que vêm do RM (colaborador e gestor): a Edge Function sincroniza a cada leitura de /rh/me. */
create or replace function app_imobrh.sincronizar_papeis_rm(p_usuario uuid, p_colaborador boolean, p_gestor boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_colaborador then
    insert into app_imobrh.papel_usuario (user_id, papel, origem) values (p_usuario, 'colaborador', 'rm') on conflict do nothing;
  else
    delete from app_imobrh.papel_usuario where user_id = p_usuario and papel = 'colaborador' and origem = 'rm';
  end if;
  if p_gestor then
    insert into app_imobrh.papel_usuario (user_id, papel, origem) values (p_usuario, 'gestor', 'rm') on conflict do nothing;
  else
    delete from app_imobrh.papel_usuario where user_id = p_usuario and papel = 'gestor' and origem = 'rm';
  end if;
end;
$$;

/** Itens do menu RH do app do imobdesk (GET /rh/me). Regra no backend: o app só desenha. */
create or replace function app_imobrh.menu_app(p_papeis text[], p_substituto_ativo boolean default false)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array_remove(array[
    case when p_papeis && array['colaborador', 'gestor'] then 'rh_novo_pedido' end,
    case when p_papeis && array['colaborador', 'gestor'] then 'rh_meus_pedidos' end,
    case when p_papeis && array['gestor', 'diretoria'] or p_substituto_ativo then 'rh_aprovacoes' end,
    case when p_papeis && array['gestor'] then 'rh_requisicao_pessoal' end,
    'rh_canal_confidencial',
    case when p_papeis && app_imobrh.papeis_console() then 'rh_console' end
  ], null);
$$;

/** O login é o gestor (chapa do chefe) do funcionário informado? Fora da policy para não recursar na tabela. */
create or replace function app_imobrh.eh_meu_liderado(p_coligada integer, p_gestor_chapa text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_gestor_chapa is not null and exists (
    select 1 from app_imobrh.colaborador_vinculo g
     where g.user_id = app_imobrh.uid() and g.status = 'vinculado' and g.coligada = p_coligada and g.chapa = p_gestor_chapa
  );
$$;

create or replace function app_imobrh.substituto_ativo(p_usuario uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from app_imobrh.substituicao s where s.substituto_id = p_usuario and current_date between s.inicio and s.fim);
$$;

-- ============================================================================================
-- Funções do postgres: leem o imobdesk/auth ou gravam no Vault. Filtram a empresa explicitamente.
-- ============================================================================================

/** Acesso do login ao Console: papéis, regras de cada papel e o vínculo. */
create or replace function app_imobrh.meu_acesso()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := app_imobrh.uid();
  v_empresa uuid := app_imobrh.empresa_atual();
  v_papeis text[];
begin
  if v_uid is null then
    perform app_imobrh.erro('NAO_AUTENTICADO', 'Sua sessão expirou. Entre novamente.');
  end if;
  select coalesce(array_agg(p.papel order by array_position(app_imobrh.papeis_validos(), p.papel)), '{}') into v_papeis
    from app_imobrh.papel_usuario p where p.tenant_id = v_empresa and p.user_id = v_uid;

  return jsonb_build_object(
    'user', (
      select jsonb_build_object(
        'id', a.id, 'email', a.email,
        'nome', coalesce(u.nome, a.raw_user_meta_data ->> 'name', a.raw_user_meta_data ->> 'full_name', split_part(a.email, '@', 1)),
        'last_access_at', a.last_sign_in_at)
        from auth.users a
        left join imobdesk.usuarios u on u.id = a.id and u.tenant_id = v_empresa
       where a.id = v_uid),
    'papeis', to_jsonb(v_papeis),
    'regras', coalesce((select jsonb_object_agg(p, app_imobrh.regras_do_papel(p)) from unnest(v_papeis) p where p <> 'admin'),
                       '{}'::jsonb),
    'vinculo', (select jsonb_build_object('status', v.status, 'chapa', v.chapa, 'coligada', v.coligada, 'nome', v.nome)
                  from app_imobrh.colaborador_vinculo v where v.tenant_id = v_empresa and v.user_id = v_uid)
  );
end;
$$;

/** Os 8 papéis com contagens, no formato da tela Perfis e permissões. */
create or replace function app_imobrh.listar_perfis()
returns table (key text, label text, description text, user_count integer, connected_count integer, locked boolean,
               assignable boolean, manageable boolean, can_place_below boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_empresa uuid := app_imobrh.empresa_atual();
  v_admin boolean;
begin
  if app_imobrh.uid() is null or not app_imobrh.tem_papel(app_imobrh.papeis_console()) then
    perform app_imobrh.erro('SEM_PERMISSAO', 'Você não tem permissão para esta ação.');
  end if;
  v_admin := app_imobrh.tem_papel(array['admin']);
  return query
    select d.chave, d.nome, d.descricao,
           (select count(*)::integer from app_imobrh.papel_usuario p where p.tenant_id = v_empresa and p.papel = d.chave),
           (select count(distinct s.user_id)::integer
              from auth.sessions s join app_imobrh.papel_usuario p on p.user_id = s.user_id and p.tenant_id = v_empresa
             where p.papel = d.chave and (s.not_after is null or s.not_after > now())),
           d.chave = 'admin',
           v_admin or d.chave not in ('admin', 'compliance'),
           false,
           false
      from (values
        (1, 'admin', 'Administrador', 'Acesso total ao Console do RH, inclusive papéis e integrações.'),
        (2, 'rh_dp', 'RH / Departamento Pessoal', 'Atende as filas do DP: férias, documentos, dúvidas de folha e admissão.'),
        (3, 'rh_dp_restrita', 'DP restrita', 'Fila restrita: atestados e desligamentos.'),
        (4, 'recrutamento', 'Recrutamento', 'Recebe a requisição aprovada e conduz a vaga até a admissão.'),
        (5, 'compliance', 'Comitê de compliance', 'Únicos que veem casos sensíveis.'),
        (6, 'diretoria', 'Diretoria', 'Aprova requisição de pessoal e desligamento conforme a alçada (app).'),
        (7, 'gestor', 'Gestor', 'Chefe de seção no RM: aprova férias da equipe (app).'),
        (8, 'colaborador', 'Colaborador', 'Funcionário ativo no RM: abre pedidos no app.')
      ) as d (ordem, chave, nome, descricao)
     order by d.ordem;
end;
$$;

/** Logins da empresa (cadastro do imobdesk) com os papéis no ImobRH e a situação do vínculo. */
create or replace function app_imobrh.listar_usuarios_rh()
returns table (id uuid, nome text, email text, status text, papeis text[], vinculo_status text, chapa text,
               last_access_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_empresa uuid := app_imobrh.empresa_atual();
begin
  perform app_imobrh.exigir('manage_users');
  return query
    select u.id, u.nome, u.email, u.status,
           coalesce((select array_agg(p.papel order by array_position(app_imobrh.papeis_validos(), p.papel))
                       from app_imobrh.papel_usuario p where p.tenant_id = v_empresa and p.user_id = u.id), '{}'),
           coalesce(v.status, 'sem_registro'), v.chapa, a.last_sign_in_at
      from imobdesk.usuarios u
      join auth.users a on a.id = u.id
      left join app_imobrh.colaborador_vinculo v on v.tenant_id = v_empresa and v.user_id = u.id
     where u.tenant_id = v_empresa
     order by u.nome;
end;
$$;

/** Troca os papéis manuais de um login (os de origem rm ficam). Só admin concede admin e compliance. */
create or replace function app_imobrh.definir_papeis_usuario(p_usuario uuid, p_papeis text[])
returns text[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := app_imobrh.exigir('manage_users');
  v_empresa uuid := app_imobrh.empresa_atual();
  v_admin boolean := app_imobrh.tem_papel(array['admin']);
  v_antes text[];
  v_novos text[] := coalesce(p_papeis, '{}');
  v_papel text;
begin
  if not exists (select 1 from imobdesk.usuarios u where u.tenant_id = v_empresa and u.id = p_usuario) then
    perform app_imobrh.erro('VALIDACAO', 'Usuário não encontrado nesta empresa.');
  end if;
  if not (v_novos <@ app_imobrh.papeis_validos()) then
    perform app_imobrh.erro('VALIDACAO', 'Papel inválido.', 'roles');
  end if;
  select coalesce(array_agg(p.papel), '{}') into v_antes
    from app_imobrh.papel_usuario p where p.tenant_id = v_empresa and p.user_id = p_usuario and p.origem = 'manual';

  foreach v_papel in array array['admin', 'compliance'] loop
    if not v_admin and ((v_papel = any (v_novos)) <> (v_papel = any (v_antes))) then
      perform app_imobrh.erro('SEM_PERMISSAO', 'Só o Administrador concede ou retira os papéis Administrador e Compliance.', 'roles');
    end if;
  end loop;
  if p_usuario = v_uid and 'admin' = any (v_antes) and not ('admin' = any (v_novos)) then
    perform app_imobrh.erro('ESTADO_INVALIDO', 'Você não pode retirar o seu próprio papel de Administrador.', 'roles');
  end if;

  delete from app_imobrh.papel_usuario p
   where p.tenant_id = v_empresa and p.user_id = p_usuario and p.origem = 'manual' and not (p.papel = any (v_novos));
  insert into app_imobrh.papel_usuario (tenant_id, user_id, papel, origem, concedido_por)
  select v_empresa, p_usuario, n, 'manual', v_uid from unnest(v_novos) n
  on conflict (tenant_id, user_id, papel) do update set origem = 'manual', concedido_por = excluded.concedido_por
    where app_imobrh.papel_usuario.origem = 'rm';

  if v_antes is distinct from v_novos then
    insert into app_imobrh.auditoria (tenant_id, ator_id, ator_nome, modulo, acao, descricao, entidade, entidade_id, antes, depois)
    values (v_empresa, v_uid, auth.jwt() ->> 'email', 'usuarios', 'update',
            format('Papéis alterados: %s', coalesce(nullif(array_to_string(v_novos, ', '), ''), 'nenhum')),
            'papel_usuario', p_usuario::text, jsonb_build_object('papeis', v_antes), jsonb_build_object('papeis', v_novos));
  end if;
  return app_imobrh.papeis_de(p_usuario);
end;
$$;

/** Logins da empresa sem chapa no RM (nunca vinculados, pendentes ou divergentes). */
create or replace function app_imobrh.listar_vinculos_pendentes()
returns table (user_id uuid, nome text, email text, usuario_status text, status text, motivo text, cpf text,
               atualizado_em timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_empresa uuid := app_imobrh.empresa_atual();
begin
  perform app_imobrh.exigir('config_vinculos');
  return query
    select u.id, u.nome, u.email, u.status, coalesce(v.status, 'sem_registro'), v.motivo,
           case when v.cpf is null then null else '***.' || substr(v.cpf, 4, 3) || '.***-' || substr(v.cpf, 10, 2) end,
           coalesce(v.updated_at, u.created_at)
      from imobdesk.usuarios u
      left join app_imobrh.colaborador_vinculo v on v.tenant_id = v_empresa and v.user_id = u.id
     where u.tenant_id = v_empresa and u.status <> 'inactive' and (v.id is null or v.status <> 'vinculado')
     order by case coalesce(v.status, 'sem_registro') when 'divergente' then 0 when 'pendente' then 1 else 2 end, u.nome;
end;
$$;

/** Sessões ativas dos logins com papel no Console (o login é o compartilhado com o imobdesk). */
create or replace function app_imobrh.listar_sessoes()
returns table (id uuid, user_id uuid, nome text, email text, user_agent text, ip text, iniciada_em timestamptz,
               ultima_atividade timestamptz, atual boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_empresa uuid := app_imobrh.empresa_atual();
  v_sessao text := auth.jwt() ->> 'session_id';
begin
  perform app_imobrh.exigir('manage_sessions');
  return query
    select s.id, s.user_id, coalesce(u.nome, a.email), a.email, s.user_agent, host(s.ip), s.created_at,
           coalesce(s.refreshed_at::timestamptz, s.updated_at, s.created_at), s.id::text = v_sessao
      from auth.sessions s
      join auth.users a on a.id = s.user_id
      left join imobdesk.usuarios u on u.id = s.user_id and u.tenant_id = v_empresa
     where (s.not_after is null or s.not_after > now())
       and exists (select 1 from app_imobrh.papel_usuario p
                    where p.tenant_id = v_empresa and p.user_id = s.user_id and p.papel = any (app_imobrh.papeis_console()))
     order by 8 desc;
end;
$$;

create or replace function app_imobrh.encerrar_sessao(p_sessao uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := app_imobrh.exigir('manage_sessions');
  v_empresa uuid := app_imobrh.empresa_atual();
  v_dono uuid;
begin
  select s.user_id into v_dono
    from auth.sessions s
   where s.id = p_sessao
     and exists (select 1 from app_imobrh.papel_usuario p where p.tenant_id = v_empresa and p.user_id = s.user_id);
  if v_dono is null then
    perform app_imobrh.erro('VALIDACAO', 'Sessão não encontrada.');
  end if;
  delete from auth.sessions where id = p_sessao;
  insert into app_imobrh.auditoria (tenant_id, ator_id, ator_nome, modulo, acao, descricao, entidade, entidade_id)
  values (v_empresa, v_uid, auth.jwt() ->> 'email', 'sessoes', 'session_revoked', 'Sessão encerrada pelo Console do RH',
          'sessao', p_sessao::text);
end;
$$;

/** Conexão TOTVS RM, sem a senha (só a máscara). */
create or replace function app_imobrh.obter_conexao_totvs()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_linha app_imobrh.integracao_rm;
begin
  perform app_imobrh.exigir('configure_integrations');
  select * into v_linha from app_imobrh.integracao_rm i where i.tenant_id = app_imobrh.empresa_atual();
  return jsonb_build_object(
    'url', coalesce(v_linha.base_url, ''), 'user', coalesce(v_linha.usuario, ''), 'active', coalesce(v_linha.ativo, false),
    'passwordMasked', case when v_linha.segredo_id is null then null else '••••••••' end,
    'passwordSetAt', v_linha.senha_definida_em, 'passwordSetBy', v_linha.senha_definida_por,
    'lastTest', v_linha.ultimo_teste
  );
end;
$$;

create or replace function app_imobrh.salvar_conexao_totvs(p_url text, p_usuario text, p_senha text, p_ativo boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := app_imobrh.exigir('configure_integrations');
  v_empresa uuid := app_imobrh.empresa_atual();
  v_url text := btrim(coalesce(p_url, ''));
  v_segredo uuid;
  v_nome text := 'app_imobrh_rm_senha_' || v_empresa::text;
begin
  if v_url !~ '^https?://[^ ]+$' then
    perform app_imobrh.erro('VALIDACAO', 'Informe a URL da API do RM (http:// ou https://).', 'url');
  end if;
  if length(btrim(coalesce(p_usuario, ''))) = 0 then
    perform app_imobrh.erro('VALIDACAO', 'Informe o usuário de integração do RM.', 'user');
  end if;

  insert into app_imobrh.integracao_rm (tenant_id) values (v_empresa) on conflict (tenant_id) do nothing;
  select i.segredo_id into v_segredo from app_imobrh.integracao_rm i where i.tenant_id = v_empresa;

  if length(coalesce(p_senha, '')) > 0 then
    if v_segredo is null then
      v_segredo := vault.create_secret(p_senha, v_nome, 'Senha do usuário de integração do TOTVS RM (ImobRH)');
    else
      perform vault.update_secret(v_segredo, p_senha);
    end if;
    update app_imobrh.integracao_rm
       set segredo_id = v_segredo, senha_definida_em = now(), senha_definida_por = auth.jwt() ->> 'email'
     where tenant_id = v_empresa;
  elsif v_segredo is null and p_ativo then
    perform app_imobrh.erro('VALIDACAO', 'Informe a senha para ativar a integração.', 'password');
  end if;

  update app_imobrh.integracao_rm set base_url = v_url, usuario = btrim(p_usuario), ativo = coalesce(p_ativo, false)
   where tenant_id = v_empresa;

  insert into app_imobrh.auditoria (tenant_id, ator_id, ator_nome, modulo, acao, descricao, entidade, entidade_id, depois)
  values (v_empresa, v_uid, auth.jwt() ->> 'email', 'integracoes',
          case when length(coalesce(p_senha, '')) > 0 then 'secret' else 'config' end,
          'Conexão TOTVS RM salva' || case when length(coalesce(p_senha, '')) > 0 then ' (senha trocada)' else '' end,
          'totvs_rm', 'totvs_rm', jsonb_build_object('url', v_url, 'usuario', btrim(p_usuario), 'ativo', coalesce(p_ativo, false)));
end;
$$;

/** Só service_role: credencial para a Edge Function (a senha sai do Vault só aqui). */
create or replace function app_imobrh.ler_credencial_rm()
returns table (url text, usuario text, senha text, ativo boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select i.base_url, i.usuario, s.decrypted_secret, i.ativo
    from app_imobrh.integracao_rm i
    left join vault.decrypted_secrets s on s.id = i.segredo_id
   where i.tenant_id = app_imobrh.empresa_atual();
$$;

-- ============================================================================================
-- RLS, dono e grants (rodam de novo em toda migration futura)
-- ============================================================================================

create or replace function app_imobrh.aplicar_multiempresa()
returns text
language plpgsql
set search_path = ''
as $$
declare
  -- Funções que ficam com o postgres: leem auth/imobdesk ou gravam no Vault (filtram a empresa por conta própria).
  v_do_postgres constant text[] := array['erro', 'empresa_atual', 'uid', 'aplicar_multiempresa', 'meu_acesso', 'listar_perfis',
    'listar_usuarios_rh', 'definir_papeis_usuario', 'listar_vinculos_pendentes', 'listar_sessoes', 'encerrar_sessao',
    'obter_conexao_totvs', 'salvar_conexao_totvs', 'ler_credencial_rm'];
  t record;
  f record;
  v_tabelas int := 0;
begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'app_imobrh' and c.relkind = 'r' loop
    execute format('alter table app_imobrh.%I enable row level security', t.relname);
    execute format('alter table app_imobrh.%I force row level security', t.relname);
    execute format('drop policy if exists app_imobrh_tenant on app_imobrh.%I', t.relname);
    execute format('create policy app_imobrh_tenant on app_imobrh.%I as restrictive for all to public
                      using (tenant_id = (select app_imobrh.empresa_atual()))
                      with check (tenant_id = (select app_imobrh.empresa_atual()))', t.relname);
    execute format('drop policy if exists app_imobrh_dono on app_imobrh.%I', t.relname);
    execute format('create policy app_imobrh_dono on app_imobrh.%I for all to app_imobrh_dono using (true) with check (true)', t.relname);
    execute format('alter table app_imobrh.%I owner to app_imobrh_dono', t.relname);
    -- Só public/anon: os grants do authenticated ficam (rodar de novo não pode apagá-los).
    execute format('revoke all on app_imobrh.%I from public, anon', t.relname);
    v_tabelas := v_tabelas + 1;
  end loop;

  for f in select p.oid::regprocedure as assinatura, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'app_imobrh' loop
    if f.proname = any (v_do_postgres) then
      execute format('alter function %s owner to postgres', f.assinatura);
    else
      execute format('alter function %s owner to app_imobrh_dono', f.assinatura);
    end if;
    execute format('revoke all on function %s from public, anon', f.assinatura);
    execute format('grant execute on function %s to app_imobrh_dono, service_role', f.assinatura);
  end loop;

  -- Sequências das identidades (auditoria.id).
  execute 'grant usage on all sequences in schema app_imobrh to app_imobrh_dono, service_role';
  return format('app_imobrh: %s tabelas com RLS de empresa', v_tabelas);
end;
$$;

select app_imobrh.aplicar_multiempresa();

-- Funções do imobdesk que o dono chama.
grant execute on function imobdesk.empresa_atual() to app_imobrh_dono;
grant execute on function imobdesk.sessao_confiavel() to app_imobrh_dono;

-- service_role (Edge Functions) lê e grava as tabelas; a RLS de empresa não vale para ele, que filtra por tenant_id.
grant select, insert, update, delete on all tables in schema app_imobrh to service_role;
revoke update, delete on app_imobrh.auditoria from service_role;

revoke all on app_imobrh.integracao_rm, app_imobrh.consulta_rm, app_imobrh.rm_cache from authenticated;

-- Leitura direta pelo Console (RLS por papel abaixo).
grant select on app_imobrh.colaborador_vinculo, app_imobrh.papel_usuario, app_imobrh.substituicao,
  app_imobrh.auditoria, app_imobrh.papel_permissao to authenticated;

-- Policies por papel (permissivas; somam com a restritiva de empresa). Sem policy de escrita para authenticated:
-- toda gravação passa por função.
drop policy if exists vinculo_leitura on app_imobrh.colaborador_vinculo;
create policy vinculo_leitura on app_imobrh.colaborador_vinculo for select to authenticated
  using (
    user_id = (select app_imobrh.uid())
    or (select app_imobrh.tem_papel(array['admin', 'rh_dp', 'rh_dp_restrita', 'recrutamento']))
    -- Gestor: só quem está abaixo dele na hierarquia do RM (gestor_chapa = a chapa do próprio gestor).
    or app_imobrh.eh_meu_liderado(coligada, gestor_chapa)
  );

drop policy if exists papel_leitura on app_imobrh.papel_usuario;
create policy papel_leitura on app_imobrh.papel_usuario for select to authenticated
  using (user_id = (select app_imobrh.uid()) or (select app_imobrh.pode('manage_users')));

drop policy if exists substituicao_leitura on app_imobrh.substituicao;
create policy substituicao_leitura on app_imobrh.substituicao for select to authenticated
  using ((select app_imobrh.uid()) in (titular_id, substituto_id) or (select app_imobrh.tem_papel(array['admin', 'rh_dp'])));

drop policy if exists auditoria_leitura on app_imobrh.auditoria;
create policy auditoria_leitura on app_imobrh.auditoria for select to authenticated
  using ((select app_imobrh.pode('view_audit_logs')));

drop policy if exists permissao_leitura on app_imobrh.papel_permissao;
create policy permissao_leitura on app_imobrh.papel_permissao for select to authenticated
  using ((select app_imobrh.tem_papel(app_imobrh.papeis_console())));

-- integracao_rm, consulta_rm e rm_cache: sem acesso direto do authenticated (só pelas funções acima).

-- RPCs do Console (authenticated). As demais ficam só para service_role e o dono.
grant execute on function
  app_imobrh.meu_acesso(), app_imobrh.meus_papeis(), app_imobrh.pode(text), app_imobrh.listar_perfis(),
  app_imobrh.regras_do_papel(text), app_imobrh.permissoes_padrao(),
  app_imobrh.salvar_permissoes_perfil(text, jsonb), app_imobrh.listar_usuarios_rh(),
  app_imobrh.definir_papeis_usuario(uuid, text[]), app_imobrh.listar_vinculos_pendentes(),
  app_imobrh.listar_sessoes(), app_imobrh.encerrar_sessao(uuid), app_imobrh.obter_conexao_totvs(),
  app_imobrh.salvar_conexao_totvs(text, text, text, boolean), app_imobrh.listar_consultas_sql(),
  app_imobrh.salvar_consulta_sql(uuid, text, text, text, text, boolean, text),
  app_imobrh.definir_consulta_sql_ativa(uuid, boolean), app_imobrh.mover_consulta_sql(uuid, text),
  app_imobrh.excluir_consulta_sql(uuid),
  -- Usadas dentro das policies (avaliadas como o próprio usuário).
  app_imobrh.uid(), app_imobrh.empresa_atual(), app_imobrh.tem_papel(text[]), app_imobrh.papeis_console(),
  app_imobrh.eh_meu_liderado(integer, text),
  app_imobrh.papeis_validos()
to authenticated;

-- Expõe o schema na API: ACRESCENTA à lista gravada no banco (nunca grava uma lista fixa: o projeto é compartilhado).
do $$
declare
  v_atual text;
begin
  select split_part(c, '=', 2) into v_atual
    from pg_roles r, unnest(r.rolconfig) c
   where r.rolname = 'authenticator' and c like 'pgrst.db_schemas=%';
  if v_atual is null then
    raise notice 'app_imobrh: sem pgrst.db_schemas no banco; marque app_imobrh em Data API › Exposed schemas no painel.';
  elsif not ('app_imobrh' = any (string_to_array(replace(v_atual, ' ', ''), ','))) then
    execute format('alter role authenticator set pgrst.db_schemas = %L', v_atual || ', app_imobrh');
  end if;
end;
$$;
notify pgrst, 'reload config';
notify pgrst, 'reload schema';
