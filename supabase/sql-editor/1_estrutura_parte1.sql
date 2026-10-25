-- Imobdesk · parte 1 de 4 (20261006141699_imobdesk_00_empresas.sql … 20261007170000_imobdesk_cadastros_ticket.sql).
-- Cole no SQL Editor do ikvj e rode. Tudo numa transação.
begin;

-- ======================================== 20261006141699_imobdesk_00_empresas.sql
-- Imobdesk (WSA Sistemas) no Supabase ikvj: empresas clientes e a empresa de cada requisição.
-- Vem antes das migrations convertidas do portal (ver scripts/gerar-migrations-imobdesk.mjs).
-- A separação por empresa (empresa_id em todas as tabelas, RLS forçada) entra na wsa_90.
-- Aditiva: só cria.

create schema if not exists imobdesk;

-- Dono das tabelas e das funções do app. Sem BYPASSRLS: dentro das funções security definer a RLS
-- continua valendo, e a policy restritiva de empresa filtra tudo sem reescrever função por função.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'imobdesk_dono') then
    create role imobdesk_dono nologin nobypassrls;
  end if;
end;
$$;
grant imobdesk_dono to postgres;
grant usage on schema imobdesk to imobdesk_dono;

-- Empresa modelo: guarda a configuração inicial (status, categorias, perfis...) que toda empresa nova copia.
create table if not exists imobdesk.empresas (
  id uuid primary key default gen_random_uuid(),
  nome text not null check (length(btrim(nome)) between 2 and 80),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  -- Domínios de e-mail da empresa: quem tem login com um deles é solicitante (App do solicitante).
  dominios_email text[] not null default '{}',
  ativa boolean not null default true,
  modelo boolean not null default false,
  criado_por uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists empresas_um_modelo on imobdesk.empresas (modelo) where modelo;

insert into imobdesk.empresas (id, nome, slug, modelo)
values ('00000000-0000-0000-0000-000000000001', 'Modelo', 'modelo', true)
on conflict (id) do nothing;

-- Super admin da WSA: cria empresas e entra em qualquer uma (decisão P2 de 23/10/2026).
create table if not exists imobdesk.admins_wsa (
  usuario_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- Preferências do login (valem em todas as empresas): empresa aberta por último e aparência.
create table if not exists imobdesk.usuario_preferencias (
  usuario_id uuid primary key references auth.users (id) on delete cascade,
  empresa_id uuid references imobdesk.empresas (id) on delete set null,
  tema text not null default 'claro' check (tema in ('claro', 'escuro', 'auto')),
  updated_at timestamptz not null default now()
);

alter table imobdesk.empresas enable row level security;
alter table imobdesk.admins_wsa enable row level security;
alter table imobdesk.usuario_preferencias enable row level security;
revoke all on imobdesk.empresas, imobdesk.admins_wsa, imobdesk.usuario_preferencias from anon, authenticated;

create or replace function imobdesk.eh_admin_wsa()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from imobdesk.admins_wsa a where a.usuario_id = (select auth.uid()));
$$;

/**
 * Empresa da requisição. Ordem:
 *  1. contexto do servidor: imobdesk.empresa_id (set_config feito só por funções do banco, como o
 *     agendamento por empresa e a cópia da empresa Modelo; o cliente da API não define essa variável);
 *  2. service_role (Edge Functions): o cabeçalho x-empresa-id;
 *  3. usuário logado: a empresa escolhida no topo, se ainda for cadastro ativo dele; senão o primeiro
 *     cadastro ativo; senão a empresa do domínio do e-mail (solicitante sem cadastro).
 * Fica com o postgres (fora do imobdesk_dono) porque lê usuarios por cima da RLS de empresa.
 */
create or replace function imobdesk.empresa_atual()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_papel text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
                           nullif(current_setting('request.jwt.claim.role', true), ''));
  v_uid uuid := (select auth.uid());
  v_empresa uuid;
  v_email text;
begin
  v_empresa := nullif(current_setting('imobdesk.empresa_id', true), '')::uuid;
  if v_empresa is not null or v_papel is null then
    return v_empresa;
  end if;
  if v_papel = 'service_role' then
    return nullif(nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-empresa-id', '')::uuid;
  end if;
  if v_uid is null then
    return null;
  end if;

  select p.empresa_id into v_empresa
    from imobdesk.usuario_preferencias p
    join imobdesk.empresas e on e.id = p.empresa_id and e.ativa and not e.modelo
   where p.usuario_id = v_uid
     and (exists (select 1 from imobdesk.usuarios u
                   where u.tenant_id = p.empresa_id and u.id = v_uid and u.status <> 'inactive')
          or imobdesk.eh_admin_wsa());
  if v_empresa is not null then
    return v_empresa;
  end if;

  select u.tenant_id into v_empresa
    from imobdesk.usuarios u
    join imobdesk.empresas e on e.id = u.tenant_id and e.ativa and not e.modelo
   where u.id = v_uid and u.status <> 'inactive'
   order by u.created_at
   limit 1;
  if v_empresa is not null then
    return v_empresa;
  end if;

  select lower(u.email) into v_email from auth.users u where u.id = v_uid;
  select e.id into v_empresa
    from imobdesk.empresas e
   where e.ativa and not e.modelo and split_part(v_email, '@', 2) = any (e.dominios_email)
   order by e.created_at
   limit 1;
  return v_empresa;
end;
$$;

/** Quem pode entrar como solicitante: cadastro ativo em alguma empresa ou e-mail de um domínio de empresa. */
create or replace function imobdesk.dominio_permitido(p_email text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
begin
  if v_email = '' then
    return false;
  end if;
  return exists (select 1 from imobdesk.empresas e
                  where e.ativa and not e.modelo and split_part(v_email, '@', 2) = any (e.dominios_email))
      or exists (select 1 from imobdesk.usuarios u where u.email = v_email and u.status <> 'inactive');
end;
$$;

revoke all on function imobdesk.eh_admin_wsa(), imobdesk.empresa_atual(), imobdesk.dominio_permitido(text) from public, anon;
grant execute on function imobdesk.eh_admin_wsa(), imobdesk.empresa_atual(), imobdesk.dominio_permitido(text)
  to authenticated, service_role, imobdesk_dono;

-- ======================================== 20261006141700_imobdesk_base.sql
-- Base do schema do aplicativo no Supabase compartilhado da WSA (ikvj).
-- Tabelas-base do app, já sem as policies abertas demais. Aditiva: só cria.

create schema if not exists imobdesk;
comment on schema imobdesk is 'Aplicativo Imobdesk (modelo Vs_Projeto_Modelo).';

-- Acesso pela API: só login (authenticated) e servidor (service_role). O anon não entra (ver 02).
grant usage on schema imobdesk to authenticated, service_role;
alter default privileges in schema imobdesk grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema imobdesk grant all on tables to service_role;
alter default privileges in schema imobdesk grant usage, select on sequences to authenticated, service_role;
alter default privileges in schema imobdesk grant execute on functions to authenticated, service_role;

do $$
begin
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where n.nspname = 'imobdesk' and t.typname = 'app_role') then
    create type imobdesk.app_role as enum ('super_admin', 'admin', 'analyst', 'user', 'operador', 'coordenador', 'ti', 'contratos');
  end if;
end;
$$;

-- ---------- api_queries ----------
create table if not exists imobdesk.api_queries (
  id uuid default gen_random_uuid() not null,
  code text not null,
  name text not null,
  description text,
  query_type text not null,
  integration_id uuid,
  display_order integer default 0 not null,
  is_active boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  ultimo_teste jsonb,
  atualizado_por uuid,
  parametros_teste text,
  constraint api_queries_query_type_check CHECK ((query_type = ANY (ARRAY['resumo'::text, 'componentes'::text, 'kpis'::text, 'grafico'::text, 'detalhes'::text, 'status'::text]))),
  constraint api_queries_pkey PRIMARY KEY (id)
);
CREATE UNIQUE INDEX api_queries_integracao_codigo_key ON imobdesk.api_queries USING btree (integration_id, upper(code));
alter table imobdesk.api_queries enable row level security;

-- ---------- audit_logs ----------
create table if not exists imobdesk.audit_logs (
  id uuid default gen_random_uuid() not null,
  created_at timestamp with time zone default now(),
  action_type text,
  menu_module text,
  description text,
  entity_id text,
  entity_type text,
  user_id uuid,
  user_email text,
  old_values jsonb,
  new_values jsonb,
  ator_nome text,
  origem text default 'Portal web'::text not null,
  constraint audit_logs_pkey PRIMARY KEY (id)
);
CREATE INDEX audit_logs_recentes ON imobdesk.audit_logs USING btree (created_at DESC);
alter table imobdesk.audit_logs enable row level security;

-- ---------- integration_settings ----------
create table if not exists imobdesk.integration_settings (
  id uuid default gen_random_uuid() not null,
  name text default 'TOTVS RM'::text not null,
  api_base_url text default ''::text not null,
  api_user text default ''::text not null,
  api_password text,
  is_active boolean default false not null,
  created_by uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  segredo_id uuid,
  senha_mascara text,
  senha_definida_em timestamp with time zone,
  senha_definida_por text,
  ultimo_teste jsonb,
  atualizado_por uuid,
  constraint integration_settings_pkey PRIMARY KEY (id)
);
CREATE UNIQUE INDEX integration_settings_name_key ON imobdesk.integration_settings USING btree (name);
alter table imobdesk.integration_settings enable row level security;

-- ---------- profile_permissions ----------
create table if not exists imobdesk.profile_permissions (
  id uuid default gen_random_uuid() not null,
  role text not null,
  permission_id text not null,
  enabled boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  constraint profile_permissions_pkey PRIMARY KEY (id)
);
alter table imobdesk.profile_permissions enable row level security;

-- ---------- user_roles ----------
create table if not exists imobdesk.user_roles (
  id uuid default gen_random_uuid() not null,
  user_id uuid not null,
  role imobdesk.app_role default 'user'::imobdesk.app_role not null,
  created_at timestamp with time zone default now(),
  created_by uuid,
  constraint user_roles_pkey PRIMARY KEY (id)
);
alter table imobdesk.user_roles enable row level security;

CREATE OR REPLACE FUNCTION imobdesk.has_role(_user_id uuid, _role imobdesk.app_role)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$

  SELECT EXISTS (

    SELECT 1 FROM imobdesk.user_roles

    WHERE user_id = _user_id AND role = _role

  )

$function$
;

CREATE OR REPLACE FUNCTION imobdesk.is_dominio_permitido(_email text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$

  SELECT imobdesk.dominio_permitido(_email)

$function$
;

-- Policies da base (as do portal entram na 05).
create policy "Service role full access api_queries" on imobdesk.api_queries as permissive for all to service_role using (true) with check (true);
create policy "Service role full access integration_settings" on imobdesk.integration_settings as permissive for all to service_role using (true) with check (true);
create policy "Service role full access profile_permissions" on imobdesk.profile_permissions as permissive for all to service_role using (true) with check (true);
create policy "Service role full access user_roles" on imobdesk.user_roles as permissive for all to service_role using (true) with check (true);
create policy "Super admin manage roles" on imobdesk.user_roles as permissive for all to authenticated using (imobdesk.has_role(auth.uid(), 'super_admin'::imobdesk.app_role)) with check (imobdesk.has_role(auth.uid(), 'super_admin'::imobdesk.app_role));
create policy "Users view own role" on imobdesk.user_roles as permissive for select to authenticated using ((user_id = auth.uid()));

grant all on all tables in schema imobdesk to service_role;
grant select, insert, update, delete on all tables in schema imobdesk to authenticated;

-- ======================================== 20261006141701_imobdesk_revoga_anon.sql
-- Fase 1 da conexão do Imobdesk ao schema `imobdesk` (projeto compartilhado da WSA (ikvj)).
--
-- O papel `anon` (requisição sem login) tinha SELECT/INSERT/UPDATE/DELETE em todas as tabelas do
-- schema, protegido só pela RLS. Antes de expor `imobdesk` na API, o anon perde qualquer acesso.
-- Só remove permissões: nenhuma tabela, coluna ou dado é alterado. Os papéis `authenticated` e
-- `service_role` continuam como estão (as policies deles são refeitas na fase 2).

revoke usage on schema imobdesk from anon;

revoke all on all tables in schema imobdesk from anon;
revoke all on all sequences in schema imobdesk from anon;
revoke all on all functions in schema imobdesk from anon;

-- Objetos criados no futuro neste schema também nascem sem acesso para o anon.
alter default privileges in schema imobdesk revoke all on tables from anon;
alter default privileges in schema imobdesk revoke all on sequences from anon;
alter default privileges in schema imobdesk revoke all on functions from anon;

-- ======================================== 20261006141702_imobdesk_expoe_schema.sql
-- Expõe o schema do aplicativo na API (PostgREST) do projeto compartilhado.
--
-- O papel `authenticator` tem `pgrst.db_schemas` gravado no próprio banco, e esse valor tem
-- prioridade sobre o painel (Settings → Data API). Aqui o schema é ACRESCENTADO à lista atual:
-- nunca sobrescreva a lista com um valor fixo, porque ela atende todos os sistemas da WSA.

do $$
declare
  v_atual text;
begin
  select split_part(c, '=', 2) into v_atual
  from pg_roles r, unnest(r.rolconfig) c
  where r.rolname = 'authenticator' and c like 'pgrst.db_schemas=%';
  v_atual := coalesce(nullif(btrim(v_atual), ''), 'public');
  if not ('imobdesk' = any (string_to_array(replace(v_atual, ' ', ''), ','))) then
    execute format('alter role authenticator set pgrst.db_schemas = %L', v_atual || ', imobdesk');
  end if;
end;
$$;

notify pgrst, 'reload config';

-- ======================================== 20261006141703_imobdesk_perfis_usuarios.sql
-- Fase 2 (1/4): estrutura de acesso do Imobdesk no schema `imobdesk`.
--
-- Tudo aditivo: tabelas novas (`perfis`, `usuarios`, `integracoes`), colunas novas em `audit_logs`
-- e índice/FK em `profile_permissions` (vazia hoje). Nada é apagado.
-- Não há trigger em auth.users: essa tabela é compartilhada com os outros sistemas da WSA.

-- ---------- Funções utilitárias ----------

create or replace function imobdesk.definir_atualizado_em()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------- Perfis (catálogo dinâmico com hierarquia) ----------

create table if not exists imobdesk.perfis (
  key text primary key check (key ~ '^[a-z0-9_]{2,60}$'),
  label text not null check (length(trim(label)) between 2 and 40),
  description text not null default '' check (length(description) <= 120),
  -- Posição na hierarquia: 0 é o mais alto. Quem tem um perfil só atribui perfis de ordem >= à sua.
  ordem integer not null,
  -- Perfil do sistema: a chave não muda e ele não pode ser excluído.
  is_system boolean not null default false,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint perfis_ordem_unica unique (ordem) deferrable initially deferred
);

comment on table imobdesk.perfis is 'Perfis de acesso do Imobdesk, em ordem de hierarquia (0 = mais alto).';

create unique index if not exists perfis_label_unico on imobdesk.perfis (lower(label));

drop trigger if exists perfis_atualizado_em on imobdesk.perfis;
create trigger perfis_atualizado_em
  before update on imobdesk.perfis
  for each row execute function imobdesk.definir_atualizado_em();

create or replace function imobdesk.proteger_perfil_sistema()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.is_system then
      raise exception 'O perfil % é do sistema e não pode ser excluído.', old.label using errcode = 'P0001';
    end if;
    return old;
  end if;
  if old.key <> new.key then
    raise exception 'A chave de um perfil não muda.' using errcode = 'P0001';
  end if;
  if old.key = 'super_admin' and new.ordem <> 0 then
    raise exception 'O perfil Super admin é sempre o primeiro da hierarquia.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists perfis_protecao on imobdesk.perfis;
create trigger perfis_protecao
  before update or delete on imobdesk.perfis
  for each row execute function imobdesk.proteger_perfil_sistema();

insert into imobdesk.perfis (key, label, description, ordem, is_system) values
  ('super_admin', 'Super admin', 'Acesso total ao sistema.', 0, true),
  ('admin', 'Admin', 'Administra usuários, perfis e permissões.', 1, true),
  ('ti', 'TI', 'Suporte técnico, auditoria e sessões.', 2, false),
  ('financeiro', 'Financeiro', 'Equipe financeira.', 3, false),
  ('operador', 'Operador', 'Operação do dia a dia.', 4, false)
on conflict (key) do nothing;

-- ---------- Usuários do portal ----------

create table if not exists imobdesk.usuarios (
  -- Mesmo id do auth.users: a conta de login é a do projeto compartilhado.
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null unique check (email = lower(email)),
  nome text not null check (length(trim(nome)) >= 3),
  perfil_key text references imobdesk.perfis (key) on update cascade on delete restrict,
  status text not null default 'pending' check (status in ('active', 'inactive', 'pending')),
  -- Dono do portal: sempre Super admin, ativo e protegido (ver trigger abaixo).
  is_owner boolean not null default false,
  must_change_password boolean not null default false,
  last_access_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table imobdesk.usuarios is 'Quem pode entrar no Imobdesk e com qual perfil.';

create unique index if not exists usuarios_um_proprietario on imobdesk.usuarios (is_owner) where is_owner;
create index if not exists usuarios_perfil on imobdesk.usuarios (perfil_key);

drop trigger if exists usuarios_atualizado_em on imobdesk.usuarios;
create trigger usuarios_atualizado_em
  before update on imobdesk.usuarios
  for each row execute function imobdesk.definir_atualizado_em();

-- Defesa no banco, valendo até para o service_role: o proprietário não sai de Super admin ativo.
create or replace function imobdesk.proteger_proprietario()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.is_owner then
      raise exception 'A conta proprietária do portal não pode ser excluída.' using errcode = 'P0001';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' and old.is_owner and (
    not new.is_owner or new.perfil_key is distinct from 'super_admin' or new.status <> 'active' or new.email <> old.email
  ) then
    raise exception 'A conta proprietária do portal não pode ser rebaixada, inativada nem ter o e-mail trocado.' using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' and new.is_owner and not old.is_owner then
    raise exception 'O proprietário do portal só é definido por migration.' using errcode = 'P0001';
  end if;
  if new.is_owner and (new.perfil_key is distinct from 'super_admin' or new.status <> 'active') then
    raise exception 'O proprietário do portal precisa ser Super admin ativo.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists usuarios_protecao_proprietario on imobdesk.usuarios;
create trigger usuarios_protecao_proprietario
  before insert or update or delete on imobdesk.usuarios
  for each row execute function imobdesk.proteger_proprietario();

-- ---------- Permissões por perfil (tabela existente, vazia) ----------

create unique index if not exists profile_permissions_perfil_menu on imobdesk.profile_permissions (role, permission_id);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profile_permissions_role_perfis_fk') then
    alter table imobdesk.profile_permissions
      add constraint profile_permissions_role_perfis_fk
      foreign key (role) references imobdesk.perfis (key) on update cascade on delete cascade;
  end if;
end;
$$;

-- ---------- Auditoria (tabela existente): quem e de onde ----------

alter table imobdesk.audit_logs add column if not exists ator_nome text;
alter table imobdesk.audit_logs add column if not exists origem text not null default 'Portal web';
create index if not exists audit_logs_recentes on imobdesk.audit_logs (created_at desc);

-- ---------- Integrações do portal ----------

create table if not exists imobdesk.integracoes (
  key text primary key check (key ~ '^[a-z0-9_]{2,40}$'),
  nome text not null,
  descricao text not null default '',
  ativo boolean not null default false,
  remetente text not null default '',
  enviar_emails_auth boolean not null default true,
  -- A chave de API fica no Vault (vault.secrets); aqui só a referência e a máscara.
  segredo_id uuid,
  segredo_mascara text,
  segredo_definido_em timestamptz,
  segredo_definido_por text,
  ultimo_teste jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table imobdesk.integracoes is 'Integrações do Imobdesk. O segredo nunca fica aqui: só a referência ao Vault.';

drop trigger if exists integracoes_atualizado_em on imobdesk.integracoes;
create trigger integracoes_atualizado_em
  before update on imobdesk.integracoes
  for each row execute function imobdesk.definir_atualizado_em();

insert into imobdesk.integracoes (key, nome, descricao, ativo, remetente)
values ('resend', 'E-mail transacional', 'Resend · convites, redefinição de senha e avisos do sistema.', false,
        'Imobdesk <nao-responda@imobsystems.com.br>')
on conflict (key) do nothing;

-- ---------- Permissões de tabela (a RLS vem na migration 3/4) ----------

revoke all on imobdesk.perfis, imobdesk.usuarios, imobdesk.integracoes from anon, authenticated;
grant select on imobdesk.perfis, imobdesk.usuarios to authenticated;
-- Integrações: o segredo_id não é lido pelo front.
grant select (key, nome, descricao, ativo, remetente, enviar_emails_auth, segredo_mascara, segredo_definido_em,
              segredo_definido_por, ultimo_teste, created_at, updated_at)
  on imobdesk.integracoes to authenticated;
grant all on imobdesk.perfis, imobdesk.usuarios, imobdesk.integracoes to service_role;

-- ======================================== 20261006141704_imobdesk_funcoes_acesso.sql
-- Fase 2 (2/4): funções de apoio às policies do Imobdesk.
--
-- SECURITY DEFINER + search_path vazio: leem `usuarios`/`profile_permissions` sem disparar a RLS
-- dessas tabelas (evita recursão) e sem risco de sequestro de search_path.
-- A regra é a mesma do front (policy.ts): super admin tem tudo; os demais, só o que estiver liberado.

create or replace function imobdesk.perfil_usuario_atual()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select u.perfil_key
  from imobdesk.usuarios u
  where u.id = (select auth.uid())
    and u.status <> 'inactive';
$$;

comment on function imobdesk.perfil_usuario_atual() is 'Perfil do usuário logado no portal; null se não for usuário ativo do portal.';

create or replace function imobdesk.usuario_portal_ativo()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select imobdesk.perfil_usuario_atual() is not null;
$$;

create or replace function imobdesk.eh_super_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(imobdesk.perfil_usuario_atual() = 'super_admin', false);
$$;

create or replace function imobdesk.tem_permissao(p_permissao text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when imobdesk.perfil_usuario_atual() is null then false
    when imobdesk.perfil_usuario_atual() = 'super_admin' then true
    else exists (
      select 1
      from imobdesk.profile_permissions pp
      where pp.role = imobdesk.perfil_usuario_atual()
        and pp.permission_id = p_permissao
        and pp.enabled
    )
  end;
$$;

comment on function imobdesk.tem_permissao(text) is 'Mesma regra do menuRegistry/policy.ts: super admin tem tudo; sem regra = negado.';

-- Só quem está logado usa as funções; o anon não executa nada.
revoke all on function imobdesk.perfil_usuario_atual(), imobdesk.usuario_portal_ativo(),
  imobdesk.eh_super_admin(), imobdesk.tem_permissao(text) from public, anon;
grant execute on function imobdesk.perfil_usuario_atual(), imobdesk.usuario_portal_ativo(),
  imobdesk.eh_super_admin(), imobdesk.tem_permissao(text) to authenticated, service_role;

-- ======================================== 20261006141705_imobdesk_policies_acesso.sql
-- Fase 2 (3/4): RLS das tabelas de acesso do Imobdesk + correções de segurança aprovadas.
--
-- Regra geral: só usuário ativo do portal na empresa lê; escrita só por RPC/Edge
-- Function (fase 3), nunca direto do front. O projeto é compartilhado: "authenticated" inclui
-- usuários de outros sistemas, por isso nenhuma policy aqui usa só `auth.uid() is not null`.
--
-- Policies antigas removidas (para desfazer, recrie com o SQL comentado ao lado):
--   profile_permissions  "Authenticated can select profile_permissions"  SELECT  (qualquer logado)
--   profile_permissions  "Auth insert perms"   INSERT  with check has_role(auth.uid(), 'super_admin')
--   profile_permissions  "Auth update perms"   UPDATE  using has_role(auth.uid(), 'super_admin')
--   user_roles           "Authenticated can select user_roles"  SELECT  (qualquer logado)
--   integration_settings "Authenticated can select integration_settings"  SELECT  (qualquer logado)
--   integration_settings "Auth insert integration"  INSERT  with check auth.uid() is not null
--   integration_settings "Auth update integration"  UPDATE  using auth.uid() is not null

-- ---------- Tabelas novas ----------

alter table imobdesk.perfis enable row level security;
alter table imobdesk.usuarios enable row level security;
alter table imobdesk.integracoes enable row level security;

drop policy if exists "Portal: usuários ativos leem perfis" on imobdesk.perfis;
create policy "Portal: usuários ativos leem perfis"
  on imobdesk.perfis for select to authenticated
  using ((select imobdesk.usuario_portal_ativo()));

drop policy if exists "Portal: próprio registro ou gestão de usuários" on imobdesk.usuarios;
create policy "Portal: próprio registro ou gestão de usuários"
  on imobdesk.usuarios for select to authenticated
  using (id = (select auth.uid()) or (select imobdesk.tem_permissao('manage_users')));

drop policy if exists "Portal: integrações só para super admin" on imobdesk.integracoes;
create policy "Portal: integrações só para super admin"
  on imobdesk.integracoes for select to authenticated
  using ((select imobdesk.eh_super_admin()));

-- ---------- profile_permissions: leitura só do portal, escrita só por RPC ----------

drop policy if exists "Authenticated can select profile_permissions" on imobdesk.profile_permissions;
drop policy if exists "Auth insert perms" on imobdesk.profile_permissions;
drop policy if exists "Auth update perms" on imobdesk.profile_permissions;

drop policy if exists "Portal: usuários ativos leem permissões" on imobdesk.profile_permissions;
create policy "Portal: usuários ativos leem permissões"
  on imobdesk.profile_permissions for select to authenticated
  using ((select imobdesk.usuario_portal_ativo()));

revoke insert, update, delete, truncate on imobdesk.profile_permissions from authenticated;

-- ---------- user_roles (legado): cada um vê só o próprio papel ----------

drop policy if exists "Authenticated can select user_roles" on imobdesk.user_roles;

-- ---------- integration_settings (legado): senha em texto puro fora do alcance do front ----------

drop policy if exists "Authenticated can select integration_settings" on imobdesk.integration_settings;
drop policy if exists "Auth insert integration" on imobdesk.integration_settings;
drop policy if exists "Auth update integration" on imobdesk.integration_settings;

drop policy if exists "Portal: integration_settings só para super admin" on imobdesk.integration_settings;
create policy "Portal: integration_settings só para super admin"
  on imobdesk.integration_settings for select to authenticated
  using ((select imobdesk.eh_super_admin()));

revoke all on imobdesk.integration_settings from authenticated;
-- A coluna api_password nunca é legível pelo front.
grant select (id, name, api_base_url, api_user, is_active, created_by, created_at, updated_at)
  on imobdesk.integration_settings to authenticated;

-- ---------- audit_logs: somente leitura para quem tem a permissão (regra 10) ----------

drop policy if exists "Portal: auditoria para quem tem permissão" on imobdesk.audit_logs;
create policy "Portal: auditoria para quem tem permissão"
  on imobdesk.audit_logs for select to authenticated
  using ((select imobdesk.tem_permissao('view_audit_logs')));

revoke insert, update, delete, truncate on imobdesk.audit_logs from authenticated;

-- ======================================== 20261006141706_imobdesk_seed_proprietario.sql
-- Fase 2 (4/4): dono do portal e permissões padrão dos perfis.
--

-- imobdesk: o 1º admin de cada empresa entra pelo script sql-editor (não há proprietário fixo).

-- Permissões padrão (as mesmas do modo simulado). Super admin não tem linhas: tem acesso total.
-- configure_integrations e manage_app_access são só do super admin.
insert into imobdesk.profile_permissions (role, permission_id, enabled)
select role, permission_id, enabled
from (values
  ('admin', 'modulo_exemplo', true), ('admin', 'modulo_exemplo_lista', true), ('admin', 'modulo_exemplo_exportar', true),
  ('admin', 'manage_users', true), ('admin', 'manage_permissions', true),
  ('admin', 'view_audit_logs', true), ('admin', 'manage_sessions', true),

  ('ti', 'modulo_exemplo', true), ('ti', 'modulo_exemplo_lista', true),
  ('ti', 'manage_users', false), ('ti', 'manage_permissions', false),
  ('ti', 'view_audit_logs', true), ('ti', 'manage_sessions', true),

  ('financeiro', 'modulo_exemplo', true), ('financeiro', 'modulo_exemplo_lista', true),
  ('financeiro', 'manage_users', false), ('financeiro', 'manage_permissions', false),
  ('financeiro', 'view_audit_logs', false), ('financeiro', 'manage_sessions', false),

  ('operador', 'modulo_exemplo', true),
  ('operador', 'manage_users', false), ('operador', 'manage_permissions', false),
  ('operador', 'view_audit_logs', false), ('operador', 'manage_sessions', false)
) as padrao (role, permission_id, enabled)
on conflict (role, permission_id) do nothing;

notify pgrst, 'reload schema';

-- ======================================== 20261006141707_imobdesk_rpcs_base.sql
-- Fase 3 (1/3): base das RPCs do Imobdesk — erro padronizado, regras de hierarquia e auditoria.
--
-- Erros de regra saem com errcode P0001: message = texto para a tela, detail = código
-- (mesmo ServiceErrorCode do front), hint = campo do formulário. O PostgREST devolve isso como
-- { code, message, details, hint } e o serviço Supabase do front converte em ServiceError.
-- Funções "de ator" recebem o usuário explicitamente: as RPCs passam auth.uid(); as Edge Functions,
-- que rodam com service_role (sem auth.uid()), passam o id do JWT verificado.

create or replace function imobdesk.erro(p_codigo text, p_mensagem text, p_campo text default null)
returns void
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = 'P0001', message = p_mensagem, detail = p_codigo, hint = coalesce(p_campo, '');
end;
$$;

-- ---------- Perfil e permissão de um usuário qualquer ----------

create or replace function imobdesk.perfil_de(p_usuario uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select u.perfil_key
  from imobdesk.usuarios u
  where u.id = p_usuario and u.status <> 'inactive';
$$;

create or replace function imobdesk.tem_permissao_de(p_usuario uuid, p_permissao text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when imobdesk.perfil_de(p_usuario) is null then false
    when imobdesk.perfil_de(p_usuario) = 'super_admin' then true
    else exists (
      select 1 from imobdesk.profile_permissions pp
      where pp.role = imobdesk.perfil_de(p_usuario) and pp.permission_id = p_permissao and pp.enabled
    )
  end;
$$;

-- A versão usada nas policies passa a delegar para a de ator (mesma regra num lugar só).
create or replace function imobdesk.tem_permissao(p_permissao text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select imobdesk.tem_permissao_de((select auth.uid()), p_permissao);
$$;

-- ---------- Hierarquia ----------

/** Nível do perfil (0 = mais alto). Perfil inexistente ou nulo fica abaixo de todos. */
create or replace function imobdesk.nivel_perfil(p_perfil text)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select p.ordem from imobdesk.perfis p where p.key = p_perfil), 2147483647);
$$;

/** Regra 3: atribui-se só o próprio nível e os abaixo dele. */
create or replace function imobdesk.pode_atribuir(p_ator uuid, p_perfil text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select imobdesk.perfil_de(p_ator) is not null
     and exists (select 1 from imobdesk.perfis p where p.key = p_perfil)
     and imobdesk.nivel_perfil(p_perfil) >= imobdesk.nivel_perfil(imobdesk.perfil_de(p_ator));
$$;

/** Cadastro de perfis: só Super admin e Admin com a permissão de perfis. */
create or replace function imobdesk.eh_gestor_perfis(p_ator uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(imobdesk.perfil_de(p_ator) in ('super_admin', 'admin'), false)
     and imobdesk.tem_permissao_de(p_ator, 'manage_permissions');
$$;

/** Super admin gerencia todos os perfis (menos o próprio Super admin); Admin, só os abaixo dele. */
create or replace function imobdesk.pode_gerenciar_perfil(p_ator uuid, p_perfil text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select imobdesk.eh_gestor_perfis(p_ator)
     and p_perfil <> 'super_admin'
     and (
       imobdesk.perfil_de(p_ator) = 'super_admin'
       or imobdesk.nivel_perfil(p_perfil) > imobdesk.nivel_perfil(imobdesk.perfil_de(p_ator))
     );
$$;

create or replace function imobdesk.pode_posicionar_abaixo(p_ator uuid, p_perfil text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select imobdesk.eh_gestor_perfis(p_ator)
     and exists (select 1 from imobdesk.perfis p where p.key = p_perfil)
     and imobdesk.nivel_perfil(p_perfil) >= imobdesk.nivel_perfil(imobdesk.perfil_de(p_ator));
$$;

-- ---------- Auditoria (só funções do portal gravam; o front nunca) ----------

create or replace function imobdesk.registrar_auditoria(
  p_ator uuid,
  p_modulo text,
  p_acao text,
  p_descricao text,
  p_antes jsonb default null,
  p_depois jsonb default null,
  p_alvo text default null
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into imobdesk.audit_logs
    (action_type, menu_module, description, entity_type, entity_id, user_id, user_email, ator_nome, old_values, new_values, origem)
  select p_acao, p_modulo, p_descricao, p_modulo, p_alvo, p_ator, u.email, coalesce(u.nome, 'Sistema'), p_antes, p_depois, 'Portal web'
  from (select 1) as uma_linha
  left join imobdesk.usuarios u on u.id = p_ator;
$$;

-- Chave estável a partir do nome (ex.: "Supervisor de vendas" → "supervisor_de_vendas").
create or replace function imobdesk.gerar_chave_perfil(p_label text)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_base text;
  v_chave text;
  v_sufixo integer := 2;
begin
  v_base := translate(lower(trim(p_label)), 'áàâãäéèêëíìîïóòôõöúùûüçñ', 'aaaaaeeeeiiiiooooouuuucn');
  v_base := trim(both '_' from regexp_replace(v_base, '[^a-z0-9]+', '_', 'g'));
  v_base := left(coalesce(nullif(v_base, ''), 'perfil'), 50);
  if length(v_base) < 2 then
    v_base := 'perfil_' || v_base;
  end if;
  v_chave := v_base;
  while exists (select 1 from imobdesk.perfis p where p.key = v_chave) loop
    v_chave := v_base || '_' || v_sufixo;
    v_sufixo := v_sufixo + 1;
  end loop;
  return v_chave;
end;
$$;

-- Nenhuma destas é chamada direto pelo front: são peças das RPCs e das Edge Functions.
revoke all on function
  imobdesk.erro(text, text, text),
  imobdesk.perfil_de(uuid),
  imobdesk.tem_permissao_de(uuid, text),
  imobdesk.nivel_perfil(text),
  imobdesk.pode_atribuir(uuid, text),
  imobdesk.eh_gestor_perfis(uuid),
  imobdesk.pode_gerenciar_perfil(uuid, text),
  imobdesk.pode_posicionar_abaixo(uuid, text),
  imobdesk.registrar_auditoria(uuid, text, text, text, jsonb, jsonb, text),
  imobdesk.gerar_chave_perfil(text)
from public, anon, authenticated;

grant execute on function
  imobdesk.perfil_de(uuid),
  imobdesk.tem_permissao_de(uuid, text),
  imobdesk.nivel_perfil(text),
  imobdesk.pode_atribuir(uuid, text),
  imobdesk.eh_gestor_perfis(uuid),
  imobdesk.pode_gerenciar_perfil(uuid, text),
  imobdesk.pode_posicionar_abaixo(uuid, text),
  imobdesk.registrar_auditoria(uuid, text, text, text, jsonb, jsonb, text)
to service_role;

-- ======================================== 20261006141708_imobdesk_rpcs_portal.sql
-- Fase 3 (2/3): RPCs chamadas pelo front do Imobdesk (papel authenticated).
--
-- Cada RPC: confere a permissão de quem chama (auth.uid()), aplica as regras do portal (as mesmas
-- do mock), grava e registra a auditoria na mesma transação. O front não escreve direto em tabela.

-- ============================================================================================
-- Permissões por perfil (regras 7 e 8)
-- ============================================================================================

-- p_alteracoes: [{"id": "modulo_2", "enabled": true, "label": "Módulo 2"}, ...]  (label só para a auditoria)
create or replace function imobdesk.salvar_permissoes_perfil(p_perfil text, p_alteracoes jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := (select auth.uid());
  v_label text := (select p.label from imobdesk.perfis p where p.key = p_perfil);
  v_item record;
  v_anterior boolean;
begin
  if not imobdesk.tem_permissao_de(v_ator, 'manage_permissions') then
    perform imobdesk.erro('FORBIDDEN', 'Você não tem permissão para esta ação.');
  end if;
  if v_label is null then
    perform imobdesk.erro('NOT_FOUND', 'Perfil não encontrado.');
  end if;
  if p_perfil = 'super_admin' then
    perform imobdesk.erro('LOCKED_PERMISSION', 'O perfil Super admin tem acesso total e não é editável.');
  end if;
  if jsonb_typeof(p_alteracoes) <> 'array' then
    perform imobdesk.erro('INVALID_INPUT', 'Lista de alterações inválida.');
  end if;

  -- Valida o lote inteiro antes de gravar: ou salva tudo, ou nada.
  for v_item in select * from jsonb_to_recordset(p_alteracoes) as x(id text, enabled boolean, label text) loop
    if v_item.id is null or v_item.id !~ '^[a-z0-9_]{2,60}$' or v_item.enabled is null then
      perform imobdesk.erro('INVALID_INPUT', 'Lista de alterações inválida.');
    end if;
    -- Espelha o menuRegistry: "home" é sempre visível e "configure_integrations" é só do super admin.
    if v_item.id in ('home', 'configure_integrations') then
      perform imobdesk.erro('LOCKED_PERMISSION', format('O menu %s não pode ser alterado por perfil.', coalesce(v_item.label, v_item.id)));
    end if;
  end loop;

  for v_item in select * from jsonb_to_recordset(p_alteracoes) as x(id text, enabled boolean, label text) loop
    v_anterior := (select pp.enabled from imobdesk.profile_permissions pp where pp.role = p_perfil and pp.permission_id = v_item.id);
    continue when v_anterior is not distinct from v_item.enabled;

    insert into imobdesk.profile_permissions (role, permission_id, enabled)
    values (p_perfil, v_item.id, v_item.enabled)
    on conflict (role, permission_id) do update set enabled = excluded.enabled, updated_at = now();

    perform imobdesk.registrar_auditoria(
      v_ator, 'permissoes', 'permission',
      format('Perfil %s: %s %s', v_label, coalesce(v_item.label, v_item.id), case when v_item.enabled then 'liberado' else 'negado' end),
      jsonb_build_object('enabled', v_anterior), jsonb_build_object('enabled', v_item.enabled), p_perfil
    );
  end loop;
end;
$$;

-- ============================================================================================
-- Cadastro de perfis
-- ============================================================================================

create or replace function imobdesk.criar_perfil(p_label text, p_descricao text, p_abaixo_de text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := (select auth.uid());
  v_label text := trim(coalesce(p_label, ''));
  v_descricao text := trim(coalesce(p_descricao, ''));
  v_chave text;
  v_ordem integer;
begin
  if not imobdesk.eh_gestor_perfis(v_ator) then
    perform imobdesk.erro('FORBIDDEN', 'Somente Super admin e Admin podem cadastrar perfis.');
  end if;
  if length(v_label) not between 2 and 40 then
    perform imobdesk.erro('INVALID_INPUT', 'O nome precisa ter entre 2 e 40 caracteres.', 'label');
  end if;
  if length(v_descricao) > 120 then
    perform imobdesk.erro('INVALID_INPUT', 'Use no máximo 120 caracteres.', 'description');
  end if;
  if exists (select 1 from imobdesk.perfis p where lower(p.label) = lower(v_label)) then
    perform imobdesk.erro('ROLE_EXISTS', 'Já existe um perfil com este nome.', 'label');
  end if;
  if not imobdesk.pode_posicionar_abaixo(v_ator, p_abaixo_de) then
    perform imobdesk.erro('ROLE_NOT_ALLOWED', 'Escolha uma posição no seu nível ou abaixo dele.', 'placeAfter');
  end if;

  v_chave := imobdesk.gerar_chave_perfil(v_label);
  v_ordem := imobdesk.nivel_perfil(p_abaixo_de) + 1;
  -- Abre espaço na hierarquia (a unicidade de "ordem" é conferida só no fim da transação).
  update imobdesk.perfis set ordem = ordem + 1 where ordem >= v_ordem;
  insert into imobdesk.perfis (key, label, description, ordem, created_by)
  values (v_chave, v_label, v_descricao, v_ordem, v_ator);

  perform imobdesk.registrar_auditoria(
    v_ator, 'permissoes', 'create', format('Perfil %s criado', v_label),
    null, jsonb_build_object('key', v_chave, 'label', v_label, 'abaixo_de', p_abaixo_de), v_chave
  );
  return v_chave;
end;
$$;

create or replace function imobdesk.editar_perfil(p_key text, p_label text, p_descricao text, p_abaixo_de text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := (select auth.uid());
  v_atual imobdesk.perfis;
  v_label text := trim(coalesce(p_label, ''));
  v_descricao text := trim(coalesce(p_descricao, ''));
  v_acima text;
  v_nova_ordem integer;
  v_antes jsonb := '{}'::jsonb;
  v_depois jsonb := '{}'::jsonb;
begin
  select * into v_atual from imobdesk.perfis p where p.key = p_key;
  if v_atual.key is null then
    perform imobdesk.erro('NOT_FOUND', 'Perfil não encontrado.');
  end if;
  if not imobdesk.pode_gerenciar_perfil(v_ator, p_key) then
    perform imobdesk.erro('FORBIDDEN', case when p_key = 'super_admin'
      then 'O perfil Super admin não pode ser alterado.'
      else 'Você só pode alterar perfis abaixo do seu na hierarquia.' end);
  end if;
  if length(v_label) not between 2 and 40 then
    perform imobdesk.erro('INVALID_INPUT', 'O nome precisa ter entre 2 e 40 caracteres.', 'label');
  end if;
  if length(v_descricao) > 120 then
    perform imobdesk.erro('INVALID_INPUT', 'Use no máximo 120 caracteres.', 'description');
  end if;
  if exists (select 1 from imobdesk.perfis p where lower(p.label) = lower(v_label) and p.key <> p_key) then
    perform imobdesk.erro('ROLE_EXISTS', 'Já existe um perfil com este nome.', 'label');
  end if;
  if p_abaixo_de = p_key or not imobdesk.pode_posicionar_abaixo(v_ator, p_abaixo_de) then
    perform imobdesk.erro('ROLE_NOT_ALLOWED', 'Escolha uma posição no seu nível ou abaixo dele.', 'placeAfter');
  end if;

  v_acima := (select p.key from imobdesk.perfis p where p.ordem < v_atual.ordem order by p.ordem desc limit 1);
  if p_abaixo_de is distinct from v_acima then
    -- Tira da posição atual, fecha o buraco e reabre logo abaixo do perfil escolhido.
    update imobdesk.perfis set ordem = ordem - 1 where ordem > v_atual.ordem;
    v_nova_ordem := imobdesk.nivel_perfil(p_abaixo_de) + 1;
    update imobdesk.perfis set ordem = ordem + 1 where ordem >= v_nova_ordem and key <> p_key;
    update imobdesk.perfis set ordem = v_nova_ordem where key = p_key;
    v_antes := v_antes || jsonb_build_object('abaixo_de', v_acima);
    v_depois := v_depois || jsonb_build_object('abaixo_de', p_abaixo_de);
  end if;

  if v_label <> v_atual.label then
    v_antes := v_antes || jsonb_build_object('label', v_atual.label);
    v_depois := v_depois || jsonb_build_object('label', v_label);
  end if;
  if v_descricao <> v_atual.description then
    v_antes := v_antes || jsonb_build_object('description', v_atual.description);
    v_depois := v_depois || jsonb_build_object('description', v_descricao);
  end if;

  update imobdesk.perfis set label = v_label, description = v_descricao where key = p_key;

  if v_depois <> '{}'::jsonb then
    perform imobdesk.registrar_auditoria(v_ator, 'permissoes', 'update', format('Perfil %s alterado', v_label), v_antes, v_depois, p_key);
  end if;
end;
$$;

create or replace function imobdesk.excluir_perfil(p_key text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := (select auth.uid());
  v_atual imobdesk.perfis;
  v_membros integer;
begin
  select * into v_atual from imobdesk.perfis p where p.key = p_key;
  if v_atual.key is null then
    perform imobdesk.erro('NOT_FOUND', 'Perfil não encontrado.');
  end if;
  if not imobdesk.pode_gerenciar_perfil(v_ator, p_key) then
    perform imobdesk.erro('FORBIDDEN', 'Você só pode excluir perfis abaixo do seu na hierarquia.');
  end if;
  if v_atual.is_system then
    perform imobdesk.erro('FORBIDDEN', format('O perfil %s é do sistema e não pode ser excluído.', v_atual.label));
  end if;
  v_membros := (select count(*) from imobdesk.usuarios u where u.perfil_key = p_key);
  if v_membros > 0 then
    perform imobdesk.erro('ROLE_IN_USE', format('O perfil %s tem %s %s. Mude o perfil %s antes de excluir.',
      v_atual.label, v_membros, case when v_membros = 1 then 'usuário' else 'usuários' end,
      case when v_membros = 1 then 'dele' else 'deles' end));
  end if;

  delete from imobdesk.perfis where key = p_key;  -- as permissões saem junto (FK em cascata)
  update imobdesk.perfis set ordem = ordem - 1 where ordem > v_atual.ordem;

  perform imobdesk.registrar_auditoria(v_ator, 'permissoes', 'delete', format('Perfil %s excluído', v_atual.label),
    jsonb_build_object('key', v_atual.key, 'label', v_atual.label), null, p_key);
end;
$$;

-- ============================================================================================
-- Usuários (o que não precisa da API de administração do Auth)
-- ============================================================================================

/** Regras 4 e 5 + proprietário: ninguém mexe no dono, super admin só por super admin, ninguém em si mesmo. */
create or replace function imobdesk.carregar_alvo_usuario(p_ator uuid, p_alvo uuid, p_mensagem_propria text)
returns imobdesk.usuarios
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_alvo imobdesk.usuarios;
begin
  if not imobdesk.tem_permissao_de(p_ator, 'manage_users') then
    perform imobdesk.erro('FORBIDDEN', 'Você não tem permissão para esta ação.');
  end if;
  select * into v_alvo from imobdesk.usuarios u where u.id = p_alvo;
  if v_alvo.id is null then
    perform imobdesk.erro('NOT_FOUND', 'Usuário não encontrado.');
  end if;
  if v_alvo.is_owner and v_alvo.id <> p_ator then
    perform imobdesk.erro('PROTECTED_USER', 'A conta proprietária do portal não pode ser alterada por aqui.');
  end if;
  if v_alvo.perfil_key = 'super_admin' and imobdesk.perfil_de(p_ator) is distinct from 'super_admin' then
    perform imobdesk.erro('PROTECTED_USER', 'Somente um super admin pode alterar outro super admin.');
  end if;
  if p_mensagem_propria is not null and v_alvo.id = p_ator then
    perform imobdesk.erro('SELF_ACTION', p_mensagem_propria);
  end if;
  return v_alvo;
end;
$$;

create or replace function imobdesk.atualizar_usuario(p_id uuid, p_nome text, p_perfil text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := (select auth.uid());
  v_alvo imobdesk.usuarios := imobdesk.carregar_alvo_usuario(v_ator, p_id, null);
  v_nome text := trim(coalesce(p_nome, ''));
  v_antes jsonb := '{}'::jsonb;
  v_depois jsonb := '{}'::jsonb;
begin
  if length(v_nome) < 3 then
    perform imobdesk.erro('INVALID_INPUT', 'Informe o nome completo.', 'name');
  end if;
  if p_perfil is distinct from v_alvo.perfil_key then
    if v_alvo.id = v_ator then
      perform imobdesk.erro('SELF_ACTION', 'Você não pode alterar o seu próprio perfil.', 'role');
    end if;
    if not imobdesk.pode_atribuir(v_ator, p_perfil) then
      perform imobdesk.erro('ROLE_NOT_ALLOWED', 'Você só pode atribuir perfis do seu nível para baixo.', 'role');
    end if;
    v_antes := v_antes || jsonb_build_object('role', v_alvo.perfil_key);
    v_depois := v_depois || jsonb_build_object('role', p_perfil);
  end if;
  if v_nome <> v_alvo.nome then
    v_antes := v_antes || jsonb_build_object('name', v_alvo.nome);
    v_depois := v_depois || jsonb_build_object('name', v_nome);
  end if;
  if v_depois = '{}'::jsonb then
    return;
  end if;

  update imobdesk.usuarios set nome = v_nome, perfil_key = p_perfil where id = p_id;
  perform imobdesk.registrar_auditoria(v_ator, 'usuarios', 'update', format('Dados de %s alterados', v_nome), v_antes, v_depois, p_id::text);
end;
$$;

-- Inativar bloqueia o acesso ao portal na hora (as policies exigem usuário ativo). As sessões de login
-- não são apagadas: a conta é compartilhada com outros sistemas da WSA, que continuam funcionando.
create or replace function imobdesk.definir_status_usuario(p_id uuid, p_ativo boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := (select auth.uid());
  v_alvo imobdesk.usuarios := imobdesk.carregar_alvo_usuario(v_ator, p_id,
    case when p_ativo then null else 'Você não pode inativar a sua própria conta.' end);
  v_novo text;
begin
  v_novo := case when not p_ativo then 'inactive' when v_alvo.last_access_at is null then 'pending' else 'active' end;
  if v_novo = v_alvo.status then
    return;
  end if;
  update imobdesk.usuarios set status = v_novo where id = p_id;
  perform imobdesk.registrar_auditoria(
    v_ator, 'usuarios', case when p_ativo then 'activate' else 'deactivate' end,
    case when p_ativo then format('Conta de %s reativada', v_alvo.nome)
         else format('Conta de %s inativada e acesso ao portal bloqueado', v_alvo.nome) end,
    jsonb_build_object('status', v_alvo.status), jsonb_build_object('status', v_novo), p_id::text
  );
end;
$$;

-- Tira o acesso ao portal. A conta de login (auth.users) fica: ela é compartilhada com outros sistemas.
create or replace function imobdesk.excluir_usuario(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := (select auth.uid());
  v_alvo imobdesk.usuarios := imobdesk.carregar_alvo_usuario(v_ator, p_id, 'Você não pode excluir a sua própria conta.');
begin
  delete from imobdesk.usuarios where id = p_id;
  perform imobdesk.registrar_auditoria(v_ator, 'usuarios', 'delete', format('Conta de %s excluída do portal', v_alvo.nome),
    jsonb_build_object('name', v_alvo.nome, 'email', v_alvo.email, 'role', v_alvo.perfil_key), null, p_id::text);
end;
$$;

-- Confere a permissão e registra; o front então pede o e-mail ao Supabase Auth (resetPasswordForEmail).
create or replace function imobdesk.registrar_redefinicao_senha(p_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := (select auth.uid());
  v_alvo imobdesk.usuarios := imobdesk.carregar_alvo_usuario(v_ator, p_id, null);
begin
  perform imobdesk.registrar_auditoria(v_ator, 'usuarios', 'password_reset',
    format('Link de redefinição de senha enviado para %s', v_alvo.email), null, null, p_id::text);
  return v_alvo.email;
end;
$$;

-- ============================================================================================
-- Sessão do próprio usuário
-- ============================================================================================

-- Chamado depois do login: marca o último acesso e conclui o convite de quem já tinha senha.
create or replace function imobdesk.registrar_acesso()
returns void
language sql
security definer
set search_path = ''
as $$
  update imobdesk.usuarios
  set last_access_at = now(),
      status = case when status = 'pending' and not must_change_password then 'active' else status end
  where id = (select auth.uid()) and status <> 'inactive';
$$;

-- Chamado depois do supabase.auth.updateUser({ password }): libera o acesso de quem tinha troca obrigatória.
create or replace function imobdesk.concluir_troca_senha()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := (select auth.uid());
  v_alvo imobdesk.usuarios := (select u from imobdesk.usuarios u where u.id = v_ator);
begin
  if v_alvo.id is null or v_alvo.status = 'inactive' then
    perform imobdesk.erro('NO_PORTAL_ACCESS', 'Seu e-mail ainda não está autorizado no portal.');
  end if;
  update imobdesk.usuarios
  set must_change_password = false,
      status = case when status = 'pending' then 'active' else status end,
      last_access_at = now()
  where id = v_ator;
  perform imobdesk.registrar_auditoria(v_ator, 'autenticacao', 'password_change',
    format('%s definiu uma senha pessoal', v_alvo.nome), null, null, v_ator::text);
end;
$$;

-- ============================================================================================
-- Integrações (regra 9: segredo só de escrita, guardado no Vault)
-- ============================================================================================

create or replace function imobdesk.atualizar_integracao(p_key text, p_remetente text, p_enviar_emails_auth boolean, p_ativo boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := (select auth.uid());
  v_atual imobdesk.integracoes;
  v_remetente text := trim(coalesce(p_remetente, ''));
  v_antes jsonb := '{}'::jsonb;
  v_depois jsonb := '{}'::jsonb;
begin
  if imobdesk.perfil_de(v_ator) is distinct from 'super_admin' then
    perform imobdesk.erro('FORBIDDEN', 'Somente super admin pode configurar integrações.');
  end if;
  select * into v_atual from imobdesk.integracoes i where i.key = p_key;
  if v_atual.key is null then
    perform imobdesk.erro('NOT_FOUND', 'Integração não encontrada.');
  end if;
  if v_remetente !~ '^([^<>]+<[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+>|[^@\s]+@[^@\s]+\.[^@\s]+)$' then
    perform imobdesk.erro('INVALID_INPUT', 'Use o formato Nome <email@dominio.com.br>.', 'sender');
  end if;

  if v_remetente <> v_atual.remetente then
    v_antes := v_antes || jsonb_build_object('sender', v_atual.remetente);
    v_depois := v_depois || jsonb_build_object('sender', v_remetente);
  end if;
  if p_enviar_emails_auth is distinct from v_atual.enviar_emails_auth then
    v_antes := v_antes || jsonb_build_object('sendAuthEmails', v_atual.enviar_emails_auth);
    v_depois := v_depois || jsonb_build_object('sendAuthEmails', p_enviar_emails_auth);
  end if;
  if p_ativo is distinct from v_atual.ativo then
    v_antes := v_antes || jsonb_build_object('active', v_atual.ativo);
    v_depois := v_depois || jsonb_build_object('active', p_ativo);
  end if;
  if v_depois = '{}'::jsonb then
    return;
  end if;

  update imobdesk.integracoes
  set remetente = v_remetente, enviar_emails_auth = p_enviar_emails_auth, ativo = p_ativo
  where key = p_key;
  perform imobdesk.registrar_auditoria(v_ator, 'integracoes', 'config', 'Configuração da integração alterada', v_antes, v_depois, p_key);
end;
$$;

create or replace function imobdesk.substituir_segredo_integracao(p_key text, p_segredo text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := (select auth.uid());
  v_atual imobdesk.integracoes;
  v_segredo text := trim(coalesce(p_segredo, ''));
  v_nome_vault text := 'imobdesk_integracao_' || p_key || '_' || imobdesk.empresa_atual();
  v_id uuid;
begin
  if imobdesk.perfil_de(v_ator) is distinct from 'super_admin' then
    perform imobdesk.erro('FORBIDDEN', 'Somente super admin pode configurar integrações.');
  end if;
  select * into v_atual from imobdesk.integracoes i where i.key = p_key;
  if v_atual.key is null then
    perform imobdesk.erro('NOT_FOUND', 'Integração não encontrada.');
  end if;
  if length(v_segredo) < 8 then
    perform imobdesk.erro('INVALID_INPUT', 'Informe a nova chave completa.', 'secret');
  end if;

  v_id := coalesce(v_atual.segredo_id, (select s.id from vault.secrets s where s.name = v_nome_vault));
  if v_id is null then
    v_id := vault.create_secret(v_segredo, v_nome_vault, format('Chave de API da integração %s do Imobdesk', p_key));
  else
    perform vault.update_secret(v_id, v_segredo);
  end if;

  update imobdesk.integracoes
  set segredo_id = v_id,
      segredo_mascara = left(v_segredo, 3) || '••••',
      segredo_definido_em = now(),
      segredo_definido_por = (select u.nome from imobdesk.usuarios u where u.id = v_ator)
  where key = p_key;
  -- O valor da chave nunca vai para a auditoria.
  perform imobdesk.registrar_auditoria(v_ator, 'integracoes', 'secret', 'Chave de API substituída', null, null, p_key);
end;
$$;

-- ============================================================================================
-- Sessões ativas (regra 11)
-- ============================================================================================

create or replace function imobdesk.listar_sessoes()
returns table (
  id uuid,
  user_id uuid,
  nome text,
  email text,
  user_agent text,
  ip text,
  iniciada_em timestamptz,
  ultima_atividade timestamptz,
  atual boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not imobdesk.tem_permissao_de((select auth.uid()), 'manage_sessions') then
    perform imobdesk.erro('FORBIDDEN', 'Você não tem permissão para esta ação.');
  end if;
  return query
    select s.id, s.user_id, u.nome, u.email, s.user_agent, host(s.ip),
           s.created_at, coalesce(s.refreshed_at at time zone 'UTC', s.updated_at, s.created_at),
           s.id::text = (select auth.jwt() ->> 'session_id')
    from auth.sessions s
    join imobdesk.usuarios u on u.id = s.user_id
    where s.not_after is null or s.not_after > now()
    order by 8 desc;
end;
$$;

-- Encerra uma sessão de login. Atenção: a conta é compartilhada, então a sessão pode ser de outro sistema da WSA.
create or replace function imobdesk.encerrar_sessao(p_sessao uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := (select auth.uid());
  v_sessao record;
begin
  if not imobdesk.tem_permissao_de(v_ator, 'manage_sessions') then
    perform imobdesk.erro('FORBIDDEN', 'Você não tem permissão para esta ação.');
  end if;
  select s.id, s.user_agent, u.nome into v_sessao
  from auth.sessions s join imobdesk.usuarios u on u.id = s.user_id
  where s.id = p_sessao;
  if v_sessao.id is null then
    perform imobdesk.erro('NOT_FOUND', 'Sessão não encontrada ou já encerrada.');
  end if;
  if p_sessao::text = (select auth.jwt() ->> 'session_id') then
    perform imobdesk.erro('SELF_ACTION', 'Você não pode encerrar a sua própria sessão por aqui.');
  end if;

  delete from auth.sessions where id = p_sessao;  -- os refresh tokens saem junto (FK em cascata)
  perform imobdesk.registrar_auditoria(v_ator, 'sessoes', 'session_revoked',
    format('Sessão de %s encerrada (%s)', v_sessao.nome, coalesce(v_sessao.user_agent, 'dispositivo desconhecido')), null, null, p_sessao::text);
end;
$$;

-- ============================================================================================
-- Permissões de execução: só usuários logados; o anon não executa nada.
-- ============================================================================================

revoke all on function
  imobdesk.salvar_permissoes_perfil(text, jsonb),
  imobdesk.criar_perfil(text, text, text),
  imobdesk.editar_perfil(text, text, text, text),
  imobdesk.excluir_perfil(text),
  imobdesk.carregar_alvo_usuario(uuid, uuid, text),
  imobdesk.atualizar_usuario(uuid, text, text),
  imobdesk.definir_status_usuario(uuid, boolean),
  imobdesk.excluir_usuario(uuid),
  imobdesk.registrar_redefinicao_senha(uuid),
  imobdesk.registrar_acesso(),
  imobdesk.concluir_troca_senha(),
  imobdesk.atualizar_integracao(text, text, boolean, boolean),
  imobdesk.substituir_segredo_integracao(text, text),
  imobdesk.listar_sessoes(),
  imobdesk.encerrar_sessao(uuid)
from public, anon;

grant execute on function
  imobdesk.salvar_permissoes_perfil(text, jsonb),
  imobdesk.criar_perfil(text, text, text),
  imobdesk.editar_perfil(text, text, text, text),
  imobdesk.excluir_perfil(text),
  imobdesk.atualizar_usuario(uuid, text, text),
  imobdesk.definir_status_usuario(uuid, boolean),
  imobdesk.excluir_usuario(uuid),
  imobdesk.registrar_redefinicao_senha(uuid),
  imobdesk.registrar_acesso(),
  imobdesk.concluir_troca_senha(),
  imobdesk.atualizar_integracao(text, text, boolean, boolean),
  imobdesk.substituir_segredo_integracao(text, text),
  imobdesk.listar_sessoes(),
  imobdesk.encerrar_sessao(uuid)
to authenticated, service_role;

-- carregar_alvo_usuario é peça interna das RPCs acima.
revoke execute on function imobdesk.carregar_alvo_usuario(uuid, uuid, text) from authenticated;

-- ======================================== 20261006141709_imobdesk_rpcs_edge.sql
-- Fase 3 (3/3): funções usadas só pelas Edge Functions do portal (papel service_role).
--
-- As Edge Functions verificam o JWT de quem chamou e passam o id dele como p_ator. O front não
-- executa nada daqui (revoke de authenticated e anon no fim).

-- Conta de login já existente no auth compartilhado (ex.: usada em outros sistemas da WSA).
create or replace function imobdesk.buscar_usuario_auth(p_email text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select u.id from auth.users u where lower(u.email) = lower(trim(p_email)) limit 1;
$$;

-- Validações do cadastro, antes de mexer no auth (regras 1 e 3 + domínio).
create or replace function imobdesk.validar_cadastro_usuario(p_ator uuid, p_email text, p_perfil text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
begin
  if not imobdesk.tem_permissao_de(p_ator, 'manage_users') then
    perform imobdesk.erro('FORBIDDEN', 'Você não tem permissão para esta ação.');
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    perform imobdesk.erro('EMAIL_DOMAIN_NOT_ALLOWED', 'Informe um e-mail válido.', 'email');
  end if;
  if exists (select 1 from imobdesk.usuarios u where u.email = v_email) then
    perform imobdesk.erro('EMAIL_EXISTS',
      'Este e-mail já pertence a um usuário. Para mudar senha ou perfil, edite o usuário existente.', 'email');
  end if;
  if not imobdesk.pode_atribuir(p_ator, p_perfil) then
    perform imobdesk.erro('ROLE_NOT_ALLOWED', 'Você só pode atribuir perfis do seu nível para baixo.', 'role');
  end if;
end;
$$;

-- p_forma: 'convite' (conta nova convidada), 'senha' (conta nova com senha temporária),
--          'existente' (conta que já existia no auth compartilhado: só libera o acesso ao portal).
create or replace function imobdesk.cadastrar_usuario_portal(
  p_ator uuid, p_id uuid, p_email text, p_nome text, p_perfil text, p_forma text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(trim(p_email));
  v_nome text := trim(coalesce(p_nome, ''));
  v_perfil_label text;
begin
  perform imobdesk.validar_cadastro_usuario(p_ator, v_email, p_perfil);
  if length(v_nome) < 3 then
    perform imobdesk.erro('INVALID_INPUT', 'Informe o nome completo.', 'name');
  end if;
  if p_forma not in ('convite', 'senha', 'existente') then
    perform imobdesk.erro('INVALID_INPUT', 'Forma de acesso inválida.');
  end if;

  insert into imobdesk.usuarios (id, email, nome, perfil_key, status, must_change_password, created_by)
  values (
    p_id, v_email, v_nome, p_perfil,
    case when p_forma = 'senha' then 'active' else 'pending' end,
    p_forma in ('convite', 'senha'),
    p_ator
  );

  v_perfil_label := (select p.label from imobdesk.perfis p where p.key = p_perfil);
  perform imobdesk.registrar_auditoria(
    p_ator, 'usuarios', 'create',
    case p_forma
      when 'convite' then format('Convite enviado para %s (%s)', v_nome, v_perfil_label)
      when 'senha' then format('Conta de %s criada com senha temporária (%s)', v_nome, v_perfil_label)
      else format('Acesso ao portal liberado para %s (%s), que já tinha login em outro sistema WSA', v_nome, v_perfil_label)
    end,
    null, jsonb_build_object('name', v_nome, 'email', v_email, 'role', p_perfil, 'forma', p_forma), p_id::text
  );
end;
$$;

-- Leitura do segredo para a Edge Function de teste de e-mail.
create or replace function imobdesk.ler_segredo_integracao(p_key text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select d.decrypted_secret
  from imobdesk.integracoes i
  join vault.decrypted_secrets d on d.id = i.segredo_id
  where i.key = p_key;
$$;

create or replace function imobdesk.registrar_teste_integracao(p_ator uuid, p_key text, p_ok boolean, p_mensagem text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_resultado jsonb := jsonb_build_object('at', now(), 'ok', p_ok, 'message', p_mensagem);
begin
  if imobdesk.perfil_de(p_ator) is distinct from 'super_admin' then
    perform imobdesk.erro('FORBIDDEN', 'Somente super admin pode configurar integrações.');
  end if;
  update imobdesk.integracoes set ultimo_teste = v_resultado where key = p_key;
  perform imobdesk.registrar_auditoria(p_ator, 'integracoes', 'test',
    case when p_ok then 'E-mail de teste enviado com sucesso' else 'Falha no envio do e-mail de teste' end,
    null, jsonb_build_object('ok', p_ok, 'message', p_mensagem), p_key);
  return v_resultado;
end;
$$;

revoke all on function
  imobdesk.buscar_usuario_auth(text),
  imobdesk.validar_cadastro_usuario(uuid, text, text),
  imobdesk.cadastrar_usuario_portal(uuid, uuid, text, text, text, text),
  imobdesk.ler_segredo_integracao(text),
  imobdesk.registrar_teste_integracao(uuid, text, boolean, text)
from public, anon, authenticated;

grant execute on function
  imobdesk.buscar_usuario_auth(text),
  imobdesk.validar_cadastro_usuario(uuid, text, text),
  imobdesk.cadastrar_usuario_portal(uuid, uuid, text, text, text, text),
  imobdesk.ler_segredo_integracao(text),
  imobdesk.registrar_teste_integracao(uuid, text, boolean, text)
to service_role;

notify pgrst, 'reload schema';

-- ======================================== 20261006141710_imobdesk_funcoes_sem_anon.sql
-- Fase 3: fecha para o anon as funções do schema `imobdesk` que ainda tinham o EXECUTE padrão (PUBLIC).
--
-- - Funções de trigger (definir_atualizado_em, proteger_*): o trigger dispara sem depender de EXECUTE,
--   então ninguém precisa executá-las direto.
-- - Funções legadas (has_role, is_*): usadas pelas policies das tabelas de negócio, que são avaliadas
--   como `authenticated`. Por isso o authenticated recebe o EXECUTE explícito antes de o PUBLIC sair.

grant execute on function
  imobdesk.has_role(uuid, imobdesk.app_role),
  imobdesk.is_dominio_permitido(text)
to authenticated, service_role;

do $$
declare
  v_funcao regprocedure;
begin
  -- is_broker_profile_owner / is_document_owner: assinaturas legadas lidas do catálogo.
  for v_funcao in
    select p.oid::regprocedure
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'imobdesk' and p.proname in ('is_broker_profile_owner', 'is_document_owner')
  loop
    execute format('grant execute on function %s to authenticated, service_role', v_funcao);
    execute format('revoke execute on function %s from public, anon', v_funcao);
  end loop;
end;
$$;

revoke execute on function
  imobdesk.has_role(uuid, imobdesk.app_role),
  imobdesk.is_dominio_permitido(text)
from public, anon;

revoke execute on function
  imobdesk.definir_atualizado_em(),
  imobdesk.proteger_perfil_sistema(),
  imobdesk.proteger_proprietario()
from public, anon, authenticated;

-- ======================================== 20261006141711_imobdesk_listar_perfis.sql
-- Fase 4: lista de perfis para as telas (Usuários e Perfis e permissões).
--
-- Contagens e "o que o usuário logado pode fazer em cada perfil" são calculados aqui, com as mesmas
-- funções de hierarquia das RPCs. Pela RLS de `usuarios`, quem não tem manage_users só enxerga a
-- própria linha, então contar do lado do front daria números errados.

create or replace function imobdesk.listar_perfis()
returns table (
  key text,
  label text,
  description text,
  ordem integer,
  user_count integer,
  connected_count integer,
  locked boolean,
  assignable boolean,
  manageable boolean,
  can_place_below boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ator uuid := (select auth.uid());
begin
  if not (imobdesk.tem_permissao_de(v_ator, 'manage_users') or imobdesk.tem_permissao_de(v_ator, 'manage_permissions')) then
    perform imobdesk.erro('FORBIDDEN', 'Você não tem permissão para esta ação.');
  end if;

  return query
    select
      p.key,
      p.label,
      p.description,
      p.ordem,
      (select count(*)::integer from imobdesk.usuarios u where u.perfil_key = p.key),
      (select count(distinct s.user_id)::integer
         from auth.sessions s
         join imobdesk.usuarios u on u.id = s.user_id
        where u.perfil_key = p.key and (s.not_after is null or s.not_after > now())),
      p.key = 'super_admin',
      imobdesk.pode_atribuir(v_ator, p.key),
      imobdesk.pode_gerenciar_perfil(v_ator, p.key),
      imobdesk.pode_posicionar_abaixo(v_ator, p.key)
    from imobdesk.perfis p
    order by p.ordem;
end;
$$;

revoke all on function imobdesk.listar_perfis() from public, anon;
grant execute on function imobdesk.listar_perfis() to authenticated, service_role;

notify pgrst, 'reload schema';

-- ======================================== 20261006141712_imobdesk_totvs_conexao.sql
-- Fase 5 (2/2): conexão TOTVS RM do Imobdesk.
--
-- Usa a tabela que já existe (`integration_settings`, lida pelas rotinas de sync portadas na fase 8),
-- mas a senha passa a ficar no Vault: aqui só a referência (segredo_id) e a máscara.
-- A coluna legada `api_password` (texto puro) deixa de ser obrigatória e nunca é gravada pelo portal.
-- O front não lê a tabela: usa as RPCs abaixo, que nunca devolvem a senha.
-- Aditivo: colunas novas, índice novo, NOT NULL relaxado, uma linha nova. Nada é apagado.

alter table imobdesk.integration_settings
  add column if not exists segredo_id uuid,
  add column if not exists senha_mascara text,
  add column if not exists senha_definida_em timestamptz,
  add column if not exists senha_definida_por text,
  add column if not exists ultimo_teste jsonb,
  add column if not exists atualizado_por uuid;

alter table imobdesk.integration_settings alter column api_password drop not null;
alter table imobdesk.integration_settings alter column api_base_url set default '';
alter table imobdesk.integration_settings alter column api_user set default '';

comment on column imobdesk.integration_settings.api_password is
  'LEGADO, não usar: texto puro. A senha do portal fica no Vault (segredo_id).';
comment on column imobdesk.integration_settings.segredo_id is 'vault.secrets.id da senha da API TOTVS RM.';

-- Uma conexão por nome; o portal usa a linha "TOTVS RM".
create unique index if not exists integration_settings_name_key on imobdesk.integration_settings (name);

insert into imobdesk.integration_settings (name, api_base_url, api_user, is_active)
values ('TOTVS RM', '', '', false)
on conflict (name) do nothing;

create or replace trigger integration_settings_atualizado_em
  before update on imobdesk.integration_settings
  for each row execute function imobdesk.definir_atualizado_em();

-- ---------- Leitura para a tela (sem senha) ----------

create or replace function imobdesk.obter_conexao_totvs()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v imobdesk.integration_settings;
begin
  if imobdesk.perfil_de((select auth.uid())) is distinct from 'super_admin' then
    perform imobdesk.erro('FORBIDDEN', 'Somente super admin pode configurar integrações.');
  end if;
  select * into v from imobdesk.integration_settings s where s.name = 'TOTVS RM';
  if v.id is null then
    perform imobdesk.erro('NOT_FOUND', 'Conexão TOTVS RM não encontrada.');
  end if;
  return jsonb_build_object(
    'id', v.id,
    'url', v.api_base_url,
    'user', v.api_user,
    'active', v.is_active,
    'passwordMasked', v.senha_mascara,
    'passwordSetAt', v.senha_definida_em,
    'passwordSetBy', v.senha_definida_por,
    'lastTest', v.ultimo_teste,
    'updatedAt', v.updated_at
  );
end;
$$;

-- ---------- Gravação (senha opcional: vazia mantém a atual) ----------

create or replace function imobdesk.salvar_conexao_totvs(p_url text, p_usuario text, p_senha text, p_ativo boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := (select auth.uid());
  v_atual imobdesk.integration_settings;
  v_url text := regexp_replace(trim(coalesce(p_url, '')), '/+$', '');
  v_usuario text := trim(coalesce(p_usuario, ''));
  v_senha text := coalesce(p_senha, '');
  v_nome_vault text := ('imobdesk_totvs_rm_senha_' || imobdesk.empresa_atual());
  v_id uuid;
  v_antes jsonb := '{}'::jsonb;
  v_depois jsonb := '{}'::jsonb;
begin
  if imobdesk.perfil_de(v_ator) is distinct from 'super_admin' then
    perform imobdesk.erro('FORBIDDEN', 'Somente super admin pode configurar integrações.');
  end if;
  select * into v_atual from imobdesk.integration_settings s where s.name = 'TOTVS RM' for update;
  if v_atual.id is null then
    perform imobdesk.erro('NOT_FOUND', 'Conexão TOTVS RM não encontrada.');
  end if;

  if v_url !~* '^https?://[^\s/]+' or length(v_url) > 300 then
    perform imobdesk.erro('INVALID_INPUT', 'Informe a URL completa, começando com http:// ou https://.', 'url');
  end if;
  if length(v_usuario) not between 1 and 120 then
    perform imobdesk.erro('INVALID_INPUT', 'Informe o usuário de integração.', 'user');
  end if;
  if v_senha <> '' and length(v_senha) > 200 then
    perform imobdesk.erro('INVALID_INPUT', 'Senha longa demais.', 'password');
  end if;
  if v_senha = '' and v_atual.segredo_id is null then
    perform imobdesk.erro('INVALID_INPUT', 'Informe a senha da integração.', 'password');
  end if;

  if v_url is distinct from v_atual.api_base_url then
    v_antes := v_antes || jsonb_build_object('url', v_atual.api_base_url);
    v_depois := v_depois || jsonb_build_object('url', v_url);
  end if;
  if v_usuario is distinct from v_atual.api_user then
    v_antes := v_antes || jsonb_build_object('user', v_atual.api_user);
    v_depois := v_depois || jsonb_build_object('user', v_usuario);
  end if;
  if p_ativo is distinct from v_atual.is_active then
    v_antes := v_antes || jsonb_build_object('active', v_atual.is_active);
    v_depois := v_depois || jsonb_build_object('active', p_ativo);
  end if;

  if v_senha <> '' then
    v_id := coalesce(v_atual.segredo_id, (select s.id from vault.secrets s where s.name = v_nome_vault));
    if v_id is null then
      v_id := vault.create_secret(v_senha, v_nome_vault, 'Senha da API TOTVS RM do Imobdesk');
    else
      perform vault.update_secret(v_id, v_senha);
    end if;
    update imobdesk.integration_settings
    set segredo_id = v_id,
        senha_mascara = '••••••••',
        senha_definida_em = now(),
        senha_definida_por = (select u.nome from imobdesk.usuarios u where u.id = v_ator)
    where id = v_atual.id;
    -- O valor da senha nunca vai para a auditoria.
    perform imobdesk.registrar_auditoria(v_ator, 'integracoes', 'secret', 'Senha da API TOTVS RM substituída', null, null, 'totvs_rm');
  end if;

  if v_depois <> '{}'::jsonb then
    update imobdesk.integration_settings
    set api_base_url = v_url, api_user = v_usuario, is_active = p_ativo, atualizado_por = v_ator
    where id = v_atual.id;
    perform imobdesk.registrar_auditoria(v_ator, 'integracoes', 'config', 'Conexão TOTVS RM alterada', v_antes, v_depois, 'totvs_rm');
  end if;
end;
$$;

-- ---------- Só para Edge Functions (service_role) ----------

create or replace function imobdesk.ler_credencial_totvs()
returns table (url text, usuario text, senha text, ativo boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select s.api_base_url, s.api_user, d.decrypted_secret, s.is_active
  from imobdesk.integration_settings s
  left join vault.decrypted_secrets d on d.id = s.segredo_id
  where s.name = 'TOTVS RM';
$$;

create or replace function imobdesk.registrar_teste_totvs(p_ator uuid, p_ok boolean, p_mensagem text, p_proposta text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_resultado jsonb := jsonb_build_object('at', now(), 'ok', p_ok, 'message', p_mensagem, 'proposalId', p_proposta);
begin
  if imobdesk.perfil_de(p_ator) is distinct from 'super_admin' then
    perform imobdesk.erro('FORBIDDEN', 'Somente super admin pode configurar integrações.');
  end if;
  update imobdesk.integration_settings set ultimo_teste = v_resultado where name = 'TOTVS RM';
  perform imobdesk.registrar_auditoria(p_ator, 'integracoes', 'test',
    case when p_ok then 'Teste de conexão TOTVS RM com sucesso' else 'Falha no teste de conexão TOTVS RM' end,
    null, v_resultado, 'totvs_rm');
  return v_resultado;
end;
$$;

-- O front só passa pelas RPCs acima: nenhum acesso direto à tabela (nem leitura da coluna legada).
revoke all on table imobdesk.integration_settings from anon, authenticated;

revoke all on function
  imobdesk.obter_conexao_totvs(),
  imobdesk.salvar_conexao_totvs(text, text, text, boolean),
  imobdesk.ler_credencial_totvs(),
  imobdesk.registrar_teste_totvs(uuid, boolean, text, text)
from public, anon, authenticated;

grant execute on function
  imobdesk.obter_conexao_totvs(),
  imobdesk.salvar_conexao_totvs(text, text, text, boolean)
to authenticated;

grant execute on function
  imobdesk.ler_credencial_totvs(),
  imobdesk.registrar_teste_totvs(uuid, boolean, text, text)
to service_role;

notify pgrst, 'reload schema';

-- ======================================== 20261006141713_imobdesk_consultas_sql.sql
-- Fase 5B: aba Consultas SQL (Configurações > Integrações), somente super admin.
--
-- `api_queries` é o catálogo das consultas do TOTVS RM (RealizaConsulta/<código>). Ele também guia as
-- sincronizações (fase 8): cada rotina acha a sua consulta pelo CÓDIGO e só roda se ela estiver ativa.
-- Por isso as consultas usadas por uma sincronização não podem ser excluídas nem ter o código trocado.
--
-- Aditivo: colunas, índice, check e trigger novos; o acesso direto do front é revogado (as policies
-- antigas, abertas a qualquer logado, ficam sem efeito por falta de GRANT). Nada é apagado.

alter table imobdesk.api_queries
  add column if not exists ultimo_teste jsonb,
  add column if not exists atualizado_por uuid;

-- Tipos do cadastro original (o "status" é usado em produção, fora da lista antiga do front).
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'api_queries_query_type_check'
                 and conrelid = 'imobdesk.api_queries'::regclass) then
    alter table imobdesk.api_queries
      add constraint api_queries_query_type_check
      check (query_type in ('resumo', 'componentes', 'kpis', 'grafico', 'detalhes', 'status'));
  end if;
end $$;

create unique index if not exists api_queries_integracao_codigo_key
  on imobdesk.api_queries (integration_id, upper(code));

create or replace trigger api_queries_atualizado_em
  before update on imobdesk.api_queries
  for each row execute function imobdesk.definir_atualizado_em();

revoke all on table imobdesk.api_queries from anon, authenticated;

-- ---------- Uso pelas sincronizações (fonte única: tela e regras de exclusão leem daqui) ----------

create or replace function imobdesk.uso_consulta_sql(p_codigo text)
returns text
language sql
immutable
set search_path = ''
as $$
  -- Consulta usada por uma rotina do sistema (sincronização etc.): devolva o nome da rotina.
  -- Enquanto devolve null, qualquer consulta pode ser excluída ou ter o código trocado.
  -- Ex.: select case upper(split_part(coalesce(p_codigo, ''), '/', 1)) when 'API.00.00.000' then 'Sincronização X' end;
  select null::text where p_codigo is null or p_codigo is not null;
$$;

-- Código como a URL usa: maiúsculas, sem espaços e sem o sufixo padrão "/0/X" (acrescentado na chamada).
create or replace function imobdesk.normalizar_codigo_consulta(p_codigo text)
returns text
language sql
immutable
set search_path = ''
as $$
  select regexp_replace(upper(regexp_replace(coalesce(p_codigo, ''), '\s', '', 'g')), '/0/X$', '');
$$;

create or replace function imobdesk.id_integracao_totvs()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select s.id from imobdesk.integration_settings s where s.name = 'TOTVS RM';
$$;

create or replace function imobdesk.exigir_super_admin(p_ator uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if imobdesk.perfil_de(p_ator) is distinct from 'super_admin' then
    perform imobdesk.erro('FORBIDDEN', 'Somente super admin pode configurar integrações.');
  end if;
end;
$$;

-- ---------- Leitura ----------

create or replace function imobdesk.listar_consultas_sql()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform imobdesk.exigir_super_admin((select auth.uid()));
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', q.id,
      'code', q.code,
      'name', q.name,
      'description', q.description,
      'type', q.query_type,
      'active', q.is_active,
      'order', q.display_order,
      'usedBy', imobdesk.uso_consulta_sql(q.code),
      'lastTest', q.ultimo_teste
    ) order by q.display_order, q.created_at)
    from imobdesk.api_queries q
    where q.integration_id = imobdesk.id_integracao_totvs()
  ), '[]'::jsonb);
end;
$$;

-- ---------- Criar / editar ----------

create or replace function imobdesk.salvar_consulta_sql(
  p_id uuid, p_codigo text, p_nome text, p_descricao text, p_tipo text, p_ativa boolean
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := (select auth.uid());
  v_integracao uuid := imobdesk.id_integracao_totvs();
  v_codigo text := imobdesk.normalizar_codigo_consulta(p_codigo);
  v_nome text := trim(coalesce(p_nome, ''));
  v_descricao text := nullif(trim(coalesce(p_descricao, '')), '');
  v_atual imobdesk.api_queries;
  v_id uuid;
  v_antes jsonb := '{}'::jsonb;
  v_depois jsonb := '{}'::jsonb;
begin
  perform imobdesk.exigir_super_admin(v_ator);
  if v_integracao is null then
    perform imobdesk.erro('NOT_FOUND', 'Conexão TOTVS RM não encontrada.');
  end if;
  if v_codigo !~ '^[A-Z0-9][A-Z0-9._-]{2,59}(/[A-Z0-9?._-]+)*$' then
    perform imobdesk.erro('INVALID_INPUT', 'Use o código da consulta no RM, como API.00.02.001.', 'code');
  end if;
  if length(v_nome) not between 2 and 120 then
    perform imobdesk.erro('INVALID_INPUT', 'O nome precisa ter entre 2 e 120 caracteres.', 'name');
  end if;
  if length(coalesce(v_descricao, '')) > 300 then
    perform imobdesk.erro('INVALID_INPUT', 'Use no máximo 300 caracteres.', 'description');
  end if;
  if p_tipo is null or p_tipo not in ('resumo', 'componentes', 'kpis', 'grafico', 'detalhes', 'status') then
    perform imobdesk.erro('INVALID_INPUT', 'Escolha o tipo de dados.', 'type');
  end if;
  if exists (
    select 1 from imobdesk.api_queries q
    where q.integration_id = v_integracao and upper(q.code) = v_codigo and q.id is distinct from p_id
  ) then
    perform imobdesk.erro('QUERY_EXISTS', format('Já existe uma consulta com o código %s.', v_codigo), 'code');
  end if;

  if p_id is null then
    insert into imobdesk.api_queries (integration_id, code, name, description, query_type, is_active, display_order, atualizado_por)
    values (
      v_integracao, v_codigo, v_nome, v_descricao, p_tipo, coalesce(p_ativa, true),
      coalesce((select max(q.display_order) from imobdesk.api_queries q where q.integration_id = v_integracao), 0) + 1,
      v_ator
    )
    returning id into v_id;
    perform imobdesk.registrar_auditoria(v_ator, 'integracoes', 'create', format('Consulta SQL %s criada', v_codigo), null,
      jsonb_build_object('code', v_codigo, 'name', v_nome, 'type', p_tipo, 'active', coalesce(p_ativa, true)), 'consultas_sql');
    return v_id;
  end if;

  select * into v_atual from imobdesk.api_queries q where q.id = p_id and q.integration_id = v_integracao for update;
  if v_atual.id is null then
    perform imobdesk.erro('NOT_FOUND', 'Consulta não encontrada.');
  end if;
  if imobdesk.uso_consulta_sql(v_atual.code) is not null
     and split_part(v_codigo, '/', 1) <> upper(split_part(v_atual.code, '/', 1)) then
    perform imobdesk.erro('QUERY_IN_USE',
      format('O código não pode mudar: a consulta é usada na %s.', lower(imobdesk.uso_consulta_sql(v_atual.code))), 'code');
  end if;

  if v_codigo <> v_atual.code then v_antes := v_antes || jsonb_build_object('code', v_atual.code); v_depois := v_depois || jsonb_build_object('code', v_codigo); end if;
  if v_nome <> v_atual.name then v_antes := v_antes || jsonb_build_object('name', v_atual.name); v_depois := v_depois || jsonb_build_object('name', v_nome); end if;
  if v_descricao is distinct from v_atual.description then v_antes := v_antes || jsonb_build_object('description', v_atual.description); v_depois := v_depois || jsonb_build_object('description', v_descricao); end if;
  if p_tipo <> v_atual.query_type then v_antes := v_antes || jsonb_build_object('type', v_atual.query_type); v_depois := v_depois || jsonb_build_object('type', p_tipo); end if;
  if coalesce(p_ativa, v_atual.is_active) <> v_atual.is_active then v_antes := v_antes || jsonb_build_object('active', v_atual.is_active); v_depois := v_depois || jsonb_build_object('active', p_ativa); end if;

  if v_depois <> '{}'::jsonb then
    update imobdesk.api_queries
    set code = v_codigo, name = v_nome, description = v_descricao, query_type = p_tipo,
        is_active = coalesce(p_ativa, is_active), atualizado_por = v_ator
    where id = p_id;
    perform imobdesk.registrar_auditoria(v_ator, 'integracoes', 'update', format('Consulta SQL %s alterada', v_codigo), v_antes, v_depois, 'consultas_sql');
  end if;
  return p_id;
end;
$$;

-- ---------- Ativar / desativar ----------

create or replace function imobdesk.definir_consulta_sql_ativa(p_id uuid, p_ativa boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := (select auth.uid());
  v_atual imobdesk.api_queries;
begin
  perform imobdesk.exigir_super_admin(v_ator);
  select * into v_atual from imobdesk.api_queries q where q.id = p_id and q.integration_id = imobdesk.id_integracao_totvs() for update;
  if v_atual.id is null then
    perform imobdesk.erro('NOT_FOUND', 'Consulta não encontrada.');
  end if;
  if p_ativa is null or p_ativa = v_atual.is_active then
    return;
  end if;
  update imobdesk.api_queries set is_active = p_ativa, atualizado_por = v_ator where id = p_id;
  perform imobdesk.registrar_auditoria(v_ator, 'integracoes', case when p_ativa then 'activate' else 'deactivate' end,
    format('Consulta SQL %s %s', v_atual.code, case when p_ativa then 'ativada' else 'desativada' end),
    jsonb_build_object('active', v_atual.is_active), jsonb_build_object('active', p_ativa), 'consultas_sql');
end;
$$;

-- ---------- Reordenar (subir/descer uma posição) ----------

create or replace function imobdesk.mover_consulta_sql(p_id uuid, p_direcao text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := (select auth.uid());
  v_integracao uuid := imobdesk.id_integracao_totvs();
  v_atual imobdesk.api_queries;
  v_vizinho imobdesk.api_queries;
begin
  perform imobdesk.exigir_super_admin(v_ator);
  if p_direcao not in ('up', 'down') then
    perform imobdesk.erro('INVALID_INPUT', 'Direção inválida.');
  end if;

  -- Trava a lista e renumera 1..N (corrige empates e buracos antes de trocar).
  perform 1 from imobdesk.api_queries q where q.integration_id = v_integracao for update;
  update imobdesk.api_queries q set display_order = r.pos
  from (
    select id, row_number() over (order by display_order, created_at) as pos
    from imobdesk.api_queries where integration_id = v_integracao
  ) r
  where q.id = r.id and q.display_order is distinct from r.pos;

  select * into v_atual from imobdesk.api_queries q where q.id = p_id and q.integration_id = v_integracao;
  if v_atual.id is null then
    perform imobdesk.erro('NOT_FOUND', 'Consulta não encontrada.');
  end if;
  select * into v_vizinho from imobdesk.api_queries q
  where q.integration_id = v_integracao
    and q.display_order = v_atual.display_order + case when p_direcao = 'up' then -1 else 1 end;
  if v_vizinho.id is null then
    return; -- já está na ponta
  end if;

  update imobdesk.api_queries set display_order = v_vizinho.display_order, atualizado_por = v_ator where id = v_atual.id;
  update imobdesk.api_queries set display_order = v_atual.display_order where id = v_vizinho.id;
  perform imobdesk.registrar_auditoria(v_ator, 'integracoes', 'config',
    format('Consulta SQL %s movida para a posição %s', v_atual.code, v_vizinho.display_order),
    jsonb_build_object('order', v_atual.display_order), jsonb_build_object('order', v_vizinho.display_order), 'consultas_sql');
end;
$$;

-- ---------- Excluir ----------

create or replace function imobdesk.excluir_consulta_sql(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := (select auth.uid());
  v_atual imobdesk.api_queries;
begin
  perform imobdesk.exigir_super_admin(v_ator);
  select * into v_atual from imobdesk.api_queries q where q.id = p_id and q.integration_id = imobdesk.id_integracao_totvs() for update;
  if v_atual.id is null then
    perform imobdesk.erro('NOT_FOUND', 'Consulta não encontrada.');
  end if;
  if imobdesk.uso_consulta_sql(v_atual.code) is not null then
    perform imobdesk.erro('QUERY_IN_USE',
      format('Esta consulta é usada na %s. Desative em vez de excluir.', lower(imobdesk.uso_consulta_sql(v_atual.code))));
  end if;
  delete from imobdesk.api_queries where id = p_id;
  perform imobdesk.registrar_auditoria(v_ator, 'integracoes', 'delete', format('Consulta SQL %s excluída', v_atual.code),
    jsonb_build_object('code', v_atual.code, 'name', v_atual.name, 'type', v_atual.query_type, 'active', v_atual.is_active),
    null, 'consultas_sql');
end;
$$;

-- ---------- Teste (Edge Function imobdesk-totvs, service_role) ----------

create or replace function imobdesk.obter_consulta_para_teste(p_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select q.code from imobdesk.api_queries q where q.id = p_id and q.integration_id = imobdesk.id_integracao_totvs();
$$;

create or replace function imobdesk.registrar_teste_consulta_sql(p_ator uuid, p_id uuid, p_ok boolean, p_mensagem text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_resultado jsonb := jsonb_build_object('at', now(), 'ok', p_ok, 'message', p_mensagem);
  v_codigo text;
begin
  perform imobdesk.exigir_super_admin(p_ator);
  update imobdesk.api_queries set ultimo_teste = v_resultado where id = p_id returning code into v_codigo;
  perform imobdesk.registrar_auditoria(p_ator, 'integracoes', 'test',
    format('Teste da consulta SQL %s: %s', v_codigo, case when p_ok then 'sucesso' else 'falhou' end),
    null, jsonb_build_object('ok', p_ok, 'message', p_mensagem), 'consultas_sql');
  return v_resultado;
end;
$$;

-- Catálogo inicial: vazio. As consultas do sistema são cadastradas pela tela (Integrações › Consultas SQL).

-- ---------- Permissões de execução ----------

revoke all on function
  imobdesk.uso_consulta_sql(text),
  imobdesk.normalizar_codigo_consulta(text),
  imobdesk.id_integracao_totvs(),
  imobdesk.exigir_super_admin(uuid),
  imobdesk.listar_consultas_sql(),
  imobdesk.salvar_consulta_sql(uuid, text, text, text, text, boolean),
  imobdesk.definir_consulta_sql_ativa(uuid, boolean),
  imobdesk.mover_consulta_sql(uuid, text),
  imobdesk.excluir_consulta_sql(uuid),
  imobdesk.obter_consulta_para_teste(uuid),
  imobdesk.registrar_teste_consulta_sql(uuid, uuid, boolean, text)
from public, anon, authenticated;

grant execute on function
  imobdesk.listar_consultas_sql(),
  imobdesk.salvar_consulta_sql(uuid, text, text, text, text, boolean),
  imobdesk.definir_consulta_sql_ativa(uuid, boolean),
  imobdesk.mover_consulta_sql(uuid, text),
  imobdesk.excluir_consulta_sql(uuid)
to authenticated;

grant execute on function
  imobdesk.uso_consulta_sql(text),
  imobdesk.normalizar_codigo_consulta(text),
  imobdesk.id_integracao_totvs(),
  imobdesk.exigir_super_admin(uuid),
  imobdesk.obter_consulta_para_teste(uuid),
  imobdesk.registrar_teste_consulta_sql(uuid, uuid, boolean, text)
to service_role;

notify pgrst, 'reload schema';

-- ======================================== 20261006141714_imobdesk_consultas_parametros_teste.sql
-- Fase 5B (ajuste): parâmetros de teste por consulta.
--
-- Várias consultas do RM exigem parâmetros; sem eles o RM responde FE011 ("Quantidade de parâmetros
-- passados para o SQL não corresponde ao esperado"). O teste da aba Consultas SQL passa a abrir já
-- preenchido com estes valores (editáveis no cadastro e no próprio teste).
-- Valores conferidos no RM em 2026-09-27 (todos responderam HTTP 200 com dados).
-- Aditivo: coluna nova, função nova (a versão de 6 argumentos continua existindo e delega para ela).

alter table imobdesk.api_queries add column if not exists parametros_teste text;

comment on column imobdesk.api_queries.parametros_teste is
  'Parâmetros usados no teste da tela, no formato NOME=valor;NOME2=valor (ex.: CODEMPREENDIMENTO=229).';

update imobdesk.api_queries set parametros_teste = v.params
from (values
  ('API.00.02.003', 'PROPOSTA_ID=10707'),
  ('API.00.07.002', 'CODEMPREENDIMENTO=229'),
  ('API.00.07.003', 'CODEMPREENDIMENTO=229'),
  ('API.00.07.004', 'CODEMPREENDIMENTO=229'),
  ('API.00.07.006', 'CODCOLIGADA=126;CODEMPREENDIMENTO=221')
) as v(code, params)
where upper(imobdesk.api_queries.code) = v.code and imobdesk.api_queries.parametros_teste is null;

-- ---------- Leitura: inclui os parâmetros de teste ----------

create or replace function imobdesk.listar_consultas_sql()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform imobdesk.exigir_super_admin((select auth.uid()));
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', q.id,
      'code', q.code,
      'name', q.name,
      'description', q.description,
      'type', q.query_type,
      'active', q.is_active,
      'order', q.display_order,
      'testParams', q.parametros_teste,
      'usedBy', imobdesk.uso_consulta_sql(q.code),
      'lastTest', q.ultimo_teste
    ) order by q.display_order, q.created_at)
    from imobdesk.api_queries q
    where q.integration_id = imobdesk.id_integracao_totvs()
  ), '[]'::jsonb);
end;
$$;

-- ---------- Salvar com parâmetros de teste ----------

create or replace function imobdesk.salvar_consulta_sql(
  p_id uuid, p_codigo text, p_nome text, p_descricao text, p_tipo text, p_ativa boolean, p_parametros_teste text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := (select auth.uid());
  v_params text := nullif(regexp_replace(trim(coalesce(p_parametros_teste, '')), ';+$', ''), '');
  v_anterior text;
  v_id uuid;
begin
  perform imobdesk.exigir_super_admin(v_ator);
  if v_params is not null
     and v_params !~ '^[A-Za-z0-9_]{1,40}=[^;]{0,120}(\s*;\s*[A-Za-z0-9_]{1,40}=[^;]{0,120}){0,9}$' then
    perform imobdesk.erro('INVALID_INPUT', 'Use NOME=valor, separados por ponto e vírgula.', 'testParams');
  end if;
  if p_id is not null then
    select q.parametros_teste into v_anterior from imobdesk.api_queries q where q.id = p_id;
  end if;

  -- Regras, auditoria e gravação dos demais campos ficam na versão principal.
  v_id := imobdesk.salvar_consulta_sql(p_id, p_codigo, p_nome, p_descricao, p_tipo, p_ativa);

  if v_params is distinct from v_anterior then
    update imobdesk.api_queries set parametros_teste = v_params, atualizado_por = v_ator where id = v_id;
    if p_id is not null then
      perform imobdesk.registrar_auditoria(v_ator, 'integracoes', 'update',
        format('Parâmetros de teste da consulta SQL %s alterados', (select q.code from imobdesk.api_queries q where q.id = v_id)),
        jsonb_build_object('testParams', v_anterior), jsonb_build_object('testParams', v_params), 'consultas_sql');
    end if;
  end if;
  return v_id;
end;
$$;

revoke all on function imobdesk.salvar_consulta_sql(uuid, text, text, text, text, boolean, text) from public, anon, authenticated;
grant execute on function imobdesk.salvar_consulta_sql(uuid, text, text, text, text, boolean, text) to authenticated;

notify pgrst, 'reload schema';

-- ======================================== 20261006141715_imobdesk_usuarios_senha.sql
-- Senha de outro usuário pela tela de Usuários (aditiva: só cria funções).
--  - exigir_troca_senha: liga/desliga a troca obrigatória no próximo login, sem mexer na senha.
--  - preparar_senha_temporaria / registrar_senha_temporaria: usadas só pela Edge Function
--    imobdesk-usuarios (ação "set_password"), que troca a senha pela API de admin do Auth.
--    O login é compartilhado com os outros sistemas da WSA: a senha temporária vale em todos.
-- As três passam por carregar_alvo_usuario: permissão manage_users, proprietário protegido,
-- super admin só por super admin e nunca a própria conta.

create or replace function imobdesk.exigir_troca_senha(p_id uuid, p_exigir boolean default true)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := (select auth.uid());
  v_alvo imobdesk.usuarios := imobdesk.carregar_alvo_usuario(
    v_ator, p_id, 'Para a sua própria conta, use “Alterar senha”.');
begin
  if v_alvo.must_change_password = p_exigir then
    return;
  end if;
  update imobdesk.usuarios set must_change_password = p_exigir where id = p_id;
  perform imobdesk.registrar_auditoria(v_ator, 'usuarios', 'update',
    case when p_exigir
      then format('Troca de senha exigida no próximo login de %s', v_alvo.nome)
      else format('Exigência de troca de senha removida de %s', v_alvo.nome)
    end,
    jsonb_build_object('must_change_password', v_alvo.must_change_password),
    jsonb_build_object('must_change_password', p_exigir),
    p_id::text);
end;
$$;

-- Confere as regras antes de a Edge tocar no Auth; devolve o e-mail do alvo.
create or replace function imobdesk.preparar_senha_temporaria(p_ator uuid, p_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_alvo imobdesk.usuarios := imobdesk.carregar_alvo_usuario(
    p_ator, p_id, 'Para a sua própria conta, use “Alterar senha”.');
begin
  if not exists (select 1 from auth.users a where a.id = p_id) then
    perform imobdesk.erro('NOT_FOUND', 'A conta de login deste usuário não foi encontrada.');
  end if;
  return v_alvo.email;
end;
$$;

-- Depois que a Edge trocou a senha: troca obrigatória no próximo login + auditoria.
create or replace function imobdesk.registrar_senha_temporaria(p_ator uuid, p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_alvo imobdesk.usuarios := imobdesk.carregar_alvo_usuario(p_ator, p_id, null);
begin
  update imobdesk.usuarios set must_change_password = true where id = p_id;
  perform imobdesk.registrar_auditoria(p_ator, 'usuarios', 'password_reset',
    format('Senha temporária definida para %s (troca obrigatória no próximo login)', v_alvo.nome),
    null, jsonb_build_object('must_change_password', true), p_id::text);
end;
$$;

revoke all on function
  imobdesk.exigir_troca_senha(uuid, boolean),
  imobdesk.preparar_senha_temporaria(uuid, uuid),
  imobdesk.registrar_senha_temporaria(uuid, uuid)
from public, anon;

grant execute on function imobdesk.exigir_troca_senha(uuid, boolean) to authenticated, service_role;

-- Recebem o ator como parâmetro: só a Edge (service_role) pode chamar.
revoke execute on function
  imobdesk.preparar_senha_temporaria(uuid, uuid),
  imobdesk.registrar_senha_temporaria(uuid, uuid)
from authenticated;
grant execute on function
  imobdesk.preparar_senha_temporaria(uuid, uuid),
  imobdesk.registrar_senha_temporaria(uuid, uuid)
to service_role;

-- ======================================== 20261006141716_imobdesk_contrato_acesso.sql
-- Contrato de acesso da Central (schema acessos do ikvj).
-- A Central (schema acessos) reconhece o aplicativo e cadastra quem for liberado na tela
-- Permissões por aplicativo quando o schema tem:
--   <schema>.usuarios (id, email, nome, perfil, ativo)  e  <schema>.perfis (chave, nome, ordem).
-- As telas deste modelo usam perfil_key/status e key/label; as colunas do contrato ficam em
-- sincronia pelos gatilhos abaixo, nos dois sentidos. Aditiva: só cria colunas e funções.

-- Datas de atualização das tabelas-base (a função nasce na 03).
drop trigger if exists api_queries_atualizado_em on imobdesk.api_queries;
create trigger api_queries_atualizado_em before update on imobdesk.api_queries
  for each row execute function imobdesk.definir_atualizado_em();
drop trigger if exists integration_settings_atualizado_em on imobdesk.integration_settings;
create trigger integration_settings_atualizado_em before update on imobdesk.integration_settings
  for each row execute function imobdesk.definir_atualizado_em();

-- perfis: chave/nome espelham key/label (só leitura).
alter table imobdesk.perfis add column if not exists chave text generated always as (key) stored;
alter table imobdesk.perfis add column if not exists nome text generated always as (label) stored;

-- usuarios: perfil/ativo de verdade, sincronizados com perfil_key/status.
alter table imobdesk.usuarios add column if not exists perfil text;
alter table imobdesk.usuarios add column if not exists ativo boolean;
update imobdesk.usuarios set perfil = perfil_key, ativo = (status = 'active')
where perfil is distinct from perfil_key or ativo is distinct from (status = 'active');

create or replace function imobdesk.contrato_sincronizar_usuario()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    -- Cadastro pela Central chega com perfil/ativo; pelas telas, com perfil_key/status.
    new.perfil_key := coalesce(new.perfil_key, new.perfil);
    if new.ativo is not null and new.status is not distinct from 'pending' then
      new.status := case when new.ativo then 'active' else 'inactive' end;
    end if;
  else
    if new.perfil is distinct from old.perfil and new.perfil_key is not distinct from old.perfil_key then
      new.perfil_key := new.perfil;
    end if;
    if new.ativo is distinct from old.ativo and new.status is not distinct from old.status then
      new.status := case when new.ativo then 'active' else 'inactive' end;
    end if;
  end if;
  new.perfil := new.perfil_key;
  new.ativo := new.status = 'active';
  return new;
end;
$$;

revoke execute on function imobdesk.contrato_sincronizar_usuario() from public, anon, authenticated;

drop trigger if exists usuarios_contrato_acesso on imobdesk.usuarios;
-- "a_" para rodar antes da proteção do proprietário (ordem alfabética dos gatilhos BEFORE).
create trigger a_usuarios_contrato_acesso
  before insert or update on imobdesk.usuarios
  for each row execute function imobdesk.contrato_sincronizar_usuario();

notify pgrst, 'reload schema';

-- ======================================== 20261006170000_imobdesk_atendimento_setores.sql
-- Gestão de Atendimento — F2 (1/3): setores, números WhatsApp, equipe, horários e configuração do canal.
-- Tudo separado por setor (adendo de 06/10/2026): cada número pertence a um setor; cada atendente a um
-- setor; cada setor tem os seus gestores; horário, mensagens automáticas e regras da fila são do setor.
-- Só aditiva. Leitura pela RLS; escrita só pelas RPCs abaixo (security definer + auditoria).
--
-- Permissões (mesmos ids do src/config/menuRegistry.ts):
--   gestao_atendimento_central     seção Central de atendimento
--   gestao_atendimento_fila        seção Fila e horários
--   gestao_atendimento_setores     seção Setores e números
--   gestao_atendimento_monitor     ação: Monitor e gestão, só nos setores em que a pessoa é gestora
--   gestao_atendimento_supervisao  ação: supervisão geral (todos os setores)

-- ---------- Configuração do canal (linha única) ----------
create table if not exists imobdesk.at_config (
  id                boolean     primary key default true check (id),
  ligado            boolean     not null default false,      -- respostas automáticas ligadas
  trava_piloto      boolean     not null default true,       -- só os telefones do piloto recebem resposta automática
  telefones_piloto  text[]      not null default '{}',
  token_segredo_id  uuid,                                     -- token da Zenvia no Vault (F3)
  token_mascara     text,
  token_definido_em timestamptz,
  verificacao       jsonb,                                    -- último "testar conexão"
  atualizado_em     timestamptz not null default now(),
  atualizado_por    uuid
);
insert into imobdesk.at_config (id) values (true) on conflict (id) do nothing;

-- ---------- Setores ----------
create table if not exists imobdesk.at_setores (
  id                          bigint      generated always as identity primary key,
  nome                        text        not null check (length(btrim(nome)) between 2 and 60),
  ativo                       boolean     not null default true,
  msg_boas_vindas             text        not null default 'Olá! Recebemos sua mensagem e em instantes alguém da nossa equipe vai te atender. 🙂'
                                          check (length(msg_boas_vindas) between 1 and 1000),
  msg_fora_horario            text        not null default 'Recebemos sua mensagem! Estamos fora do horário de atendimento. Assim que abrirmos, falamos com você.'
                                          check (length(msg_fora_horario) between 1 and 1000),
  msg_encerramento            text        not null default 'Atendimento encerrado. Se precisar de algo, é só mandar uma nova mensagem. Obrigado!'
                                          check (length(msg_encerramento) between 1 and 1000),
  limite_simultaneo           int         not null default 5 check (limite_simultaneo between 1 and 50),
  atendente_sem_resposta_min  int         not null default 30 check (atendente_sem_resposta_min between 5 and 1440),
  encerrar_apos_horas         int         not null default 23 check (encerrar_apos_horas between 1 and 23),
  alerta_fila_min             int         not null default 15 check (alerta_fila_min between 1 and 240),
  alerta_cliente_min          int         not null default 5 check (alerta_cliente_min between 1 and 240),
  criado_em                   timestamptz not null default now(),
  atualizado_em               timestamptz not null default now(),
  atualizado_por              uuid
);
create unique index if not exists at_setores_nome_uidx on imobdesk.at_setores (lower(btrim(nome)));

-- Número WhatsApp (remetente na Zenvia). Um número é de um setor só; ao sair do setor fica inativo
-- (as conversas antigas continuam apontando para ele).
create table if not exists imobdesk.at_numeros (
  id          bigint      generated always as identity primary key,
  setor_id    bigint      not null references imobdesk.at_setores (id),
  numero      text        not null unique check (numero ~ '^\d{12,13}$'),
  ativo       boolean     not null default true,
  verificacao jsonb,                                   -- {em, naConta, erro} do último teste (F3)
  criado_em   timestamptz not null default now()
);
create index if not exists at_numeros_setor_idx on imobdesk.at_numeros (setor_id);

create table if not exists imobdesk.at_setor_gestores (
  setor_id   bigint not null references imobdesk.at_setores (id) on delete cascade,
  usuario_id uuid   not null references imobdesk.usuarios (id) on delete cascade,
  primary key (setor_id, usuario_id)
);
create index if not exists at_setor_gestores_usuario_idx on imobdesk.at_setor_gestores (usuario_id);

-- Atendente: pertence a um setor só.
create table if not exists imobdesk.at_atendentes (
  usuario_id          uuid        primary key references imobdesk.usuarios (id) on delete cascade,
  setor_id            bigint      not null references imobdesk.at_setores (id),
  apto                boolean     not null default true,   -- desligado na folga
  pausa               boolean     not null default false,  -- online, mas sem receber da fila
  online_em           timestamptz,                         -- último sinal da Central aberta
  ultimo_recebido_em  timestamptz,                         -- rodízio: recebe quem está há mais tempo sem receber
  criado_em           timestamptz not null default now()
);
create index if not exists at_atendentes_setor_idx on imobdesk.at_atendentes (setor_id);

-- Horário do setor (0 = domingo, como extract(dow)). Avaliado no fuso America/Sao_Paulo.
create table if not exists imobdesk.at_horarios (
  setor_id bigint  not null references imobdesk.at_setores (id) on delete cascade,
  dia      int     not null check (dia between 0 and 6),
  aberto   boolean not null default true,
  abre     time    not null default '08:00',
  fecha    time    not null default '18:00',
  primary key (setor_id, dia),
  check (fecha > abre)
);

-- Setor novo nasce com segunda a sexta, 8h às 18h; sábado e domingo fechados.
create or replace function imobdesk.at_setor_horarios_padrao()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into imobdesk.at_horarios (setor_id, dia, aberto, abre, fecha)
  select new.id, d, d between 1 and 5, '08:00', case when d = 6 then '13:00'::time else '18:00'::time end
  from generate_series(0, 6) d
  on conflict do nothing;
  return new;
end;
$$;
drop trigger if exists at_setores_horarios_padrao on imobdesk.at_setores;
create trigger at_setores_horarios_padrao after insert on imobdesk.at_setores
  for each row execute function imobdesk.at_setor_horarios_padrao();

-- ---------- Quem vê e quem gerencia cada setor ----------
create or replace function imobdesk.at_supervisor()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select imobdesk.tem_permissao('gestao_atendimento_supervisao');
$$;

create or replace function imobdesk.at_gestor_de(p_setor bigint)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select imobdesk.at_supervisor()
      or (imobdesk.tem_permissao('gestao_atendimento_monitor')
          and exists (select 1 from imobdesk.at_setor_gestores g where g.setor_id = p_setor and g.usuario_id = auth.uid()));
$$;

create or replace function imobdesk.at_membro_de(p_setor bigint)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select imobdesk.at_gestor_de(p_setor)
      or (imobdesk.tem_permissao('gestao_atendimento_central')
          and exists (select 1 from imobdesk.at_atendentes a where a.setor_id = p_setor and a.usuario_id = auth.uid()));
$$;

do $$
declare
  t text;
begin
  foreach t in array array['at_config', 'at_setores', 'at_numeros', 'at_setor_gestores', 'at_atendentes', 'at_horarios'] loop
    execute format('alter table imobdesk.%I enable row level security', t);
    execute format('revoke all on imobdesk.%I from anon, public', t);
    execute format('revoke insert, update, delete, truncate on imobdesk.%I from authenticated', t);
    execute format('grant select on imobdesk.%I to authenticated', t);
    execute format('grant all on imobdesk.%I to service_role', t);
  end loop;

  if not exists (select 1 from pg_policies where schemaname = 'imobdesk' and tablename = 'at_config' and policyname = 'Atendimento: config só super admin') then
    create policy "Atendimento: config só super admin" on imobdesk.at_config
      for select to authenticated using ((select imobdesk.eh_super_admin()));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'imobdesk' and tablename = 'at_setores' and policyname = 'Atendimento: setores do usuário') then
    create policy "Atendimento: setores do usuário" on imobdesk.at_setores
      for select to authenticated using ((select imobdesk.at_supervisor()) or imobdesk.at_membro_de(id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'imobdesk' and tablename = 'at_numeros' and policyname = 'Atendimento: números dos setores do usuário') then
    create policy "Atendimento: números dos setores do usuário" on imobdesk.at_numeros
      for select to authenticated using ((select imobdesk.at_supervisor()) or imobdesk.at_membro_de(setor_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'imobdesk' and tablename = 'at_setor_gestores' and policyname = 'Atendimento: gestores dos setores do usuário') then
    create policy "Atendimento: gestores dos setores do usuário" on imobdesk.at_setor_gestores
      for select to authenticated using ((select imobdesk.at_supervisor()) or imobdesk.at_membro_de(setor_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'imobdesk' and tablename = 'at_atendentes' and policyname = 'Atendimento: equipe dos setores do usuário') then
    create policy "Atendimento: equipe dos setores do usuário" on imobdesk.at_atendentes
      for select to authenticated using ((select imobdesk.at_supervisor()) or imobdesk.at_membro_de(setor_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'imobdesk' and tablename = 'at_horarios' and policyname = 'Atendimento: horários dos setores do usuário') then
    create policy "Atendimento: horários dos setores do usuário" on imobdesk.at_horarios
      for select to authenticated using ((select imobdesk.at_supervisor()) or imobdesk.at_membro_de(setor_id));
  end if;
end;
$$;

-- ---------- Contexto da tela (um JSON com tudo o que o usuário pode ver) ----------
create or replace function imobdesk.at_contexto()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with eu as (
    select auth.uid() as id, imobdesk.at_supervisor() as supervisor, imobdesk.eh_super_admin() as super_admin
  ),
  vis as (
    select s.*,
      case
        when (select supervisor from eu) then 'supervisor'
        when imobdesk.at_gestor_de(s.id) then 'gestor'
        else 'atendente'
      end as papel
    from imobdesk.at_setores s
    where (select supervisor from eu) or imobdesk.at_membro_de(s.id)
  )
  select jsonb_build_object(
    'eu', (select id from eu),
    'supervisor', (select supervisor from eu),
    'superAdmin', (select super_admin from eu),
    'souAtendente', exists (select 1 from imobdesk.at_atendentes a where a.usuario_id = (select id from eu)),
    'setores', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', v.id, 'nome', v.nome, 'ativo', v.ativo, 'papel', v.papel,
        'msgBoasVindas', v.msg_boas_vindas, 'msgForaHorario', v.msg_fora_horario, 'msgEncerramento', v.msg_encerramento,
        'limiteSimultaneo', v.limite_simultaneo, 'atendenteSemRespostaMin', v.atendente_sem_resposta_min,
        'encerrarAposHoras', v.encerrar_apos_horas, 'alertaFilaMin', v.alerta_fila_min, 'alertaClienteMin', v.alerta_cliente_min,
        'numeros', coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'numero', n.numero, 'verificacao', n.verificacao) order by n.id)
                             from imobdesk.at_numeros n where n.setor_id = v.id and n.ativo), '[]'),
        'gestores', coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'nome', u.nome, 'email', u.email) order by u.nome)
                              from imobdesk.at_setor_gestores g join imobdesk.usuarios u on u.id = g.usuario_id
                              where g.setor_id = v.id), '[]'),
        'atendentes', coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'nome', u.nome, 'email', u.email, 'apto', a.apto,
                                                                    'pausa', a.pausa, 'onlineEm', a.online_em) order by u.nome)
                                from imobdesk.at_atendentes a join imobdesk.usuarios u on u.id = a.usuario_id
                                where a.setor_id = v.id), '[]'),
        'horarios', coalesce((select jsonb_agg(jsonb_build_object('dia', h.dia, 'aberto', h.aberto, 'abre', to_char(h.abre, 'HH24:MI'),
                                                                  'fecha', to_char(h.fecha, 'HH24:MI')) order by h.dia)
                              from imobdesk.at_horarios h where h.setor_id = v.id), '[]')
      ) order by v.nome)
      from vis v
    ), '[]')
  );
$$;

-- Usuários ativos do portal que podem entrar numa equipe ou na gestão (para os seletores).
create or replace function imobdesk.at_candidatos()
returns table (id uuid, nome text, email text, setor_atendente bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (imobdesk.at_supervisor()
          or exists (select 1 from imobdesk.at_setor_gestores g where g.usuario_id = auth.uid()
                     and imobdesk.tem_permissao('gestao_atendimento_monitor'))) then
    perform imobdesk.erro('FORBIDDEN', 'Só a gestão do setor escolhe a equipe.');
  end if;
  return query
    select u.id, u.nome, u.email, a.setor_id
    from imobdesk.usuarios u
    left join imobdesk.at_atendentes a on a.usuario_id = u.id
    where u.status = 'active'
    order by u.nome;
end;
$$;

-- ---------- Setores e números (supervisão geral) ----------
-- p: {id?, nome, ativo, numeros: [texto], gestores: [uuid]}. Devolve o id do setor.
create or replace function imobdesk.at_setor_salvar(p jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := auth.uid();
  v_id bigint := nullif(p ->> 'id', '')::bigint;
  v_nome text := btrim(coalesce(p ->> 'nome', ''));
  v_antes jsonb;
  v_numeros text[];
  v_num text;
  v_outro text;
  v_gestores uuid[];
begin
  if v_ator is null or not imobdesk.at_supervisor() then
    perform imobdesk.erro('FORBIDDEN', 'Só a supervisão geral cadastra setores e números.');
  end if;
  if length(v_nome) not between 2 and 60 then
    perform imobdesk.erro('INVALID_INPUT', 'Informe o nome do setor (2 a 60 letras).', 'nome');
  end if;
  if exists (select 1 from imobdesk.at_setores s where lower(btrim(s.nome)) = lower(v_nome) and s.id is distinct from v_id) then
    perform imobdesk.erro('DUPLICATE', 'Já existe um setor com esse nome.', 'nome');
  end if;

  -- Números: só dígitos; com 10 ou 11 dígitos, assume o DDI 55.
  select coalesce(array_agg(distinct d), '{}') into v_numeros
  from (select case when length(x) in (10, 11) then '55' || x else x end d
        from (select regexp_replace(e, '\D', '', 'g') x from jsonb_array_elements_text(coalesce(p -> 'numeros', '[]')) e) a
        where x <> '') b;
  foreach v_num in array v_numeros loop
    if v_num !~ '^\d{12,13}$' then
      perform imobdesk.erro('INVALID_INPUT', format('Número inválido: %s. Use DDI + DDD + número (ex.: 5521999990002).', v_num), 'numeros');
    end if;
    select s.nome into v_outro from imobdesk.at_numeros n join imobdesk.at_setores s on s.id = n.setor_id
    where n.numero = v_num and n.ativo and n.setor_id is distinct from v_id;
    if v_outro is not null then
      perform imobdesk.erro('DUPLICATE', format('O número %s já pertence ao setor %s.', v_num, v_outro), 'numeros');
    end if;
  end loop;

  select coalesce(array_agg(distinct g::uuid), '{}') into v_gestores from jsonb_array_elements_text(coalesce(p -> 'gestores', '[]')) g;
  if exists (select 1 from unnest(v_gestores) g where not exists (select 1 from imobdesk.usuarios u where u.id = g and u.status = 'active')) then
    perform imobdesk.erro('INVALID_INPUT', 'Gestor precisa ser um usuário ativo do portal.', 'gestores');
  end if;

  if v_id is null then
    insert into imobdesk.at_setores (nome, ativo, atualizado_por)
    values (v_nome, coalesce((p ->> 'ativo')::boolean, true), v_ator) returning id into v_id;
  else
    select to_jsonb(s) into v_antes from imobdesk.at_setores s where s.id = v_id;
    if v_antes is null then
      perform imobdesk.erro('NOT_FOUND', 'Setor não encontrado.');
    end if;
    update imobdesk.at_setores
      set nome = v_nome, ativo = coalesce((p ->> 'ativo')::boolean, ativo), atualizado_em = now(), atualizado_por = v_ator
      where id = v_id;
  end if;

  update imobdesk.at_numeros set ativo = false where setor_id = v_id and ativo and not (numero = any (v_numeros));
  insert into imobdesk.at_numeros (setor_id, numero)
  select v_id, x from unnest(v_numeros) x
  on conflict (numero) do update set setor_id = excluded.setor_id, ativo = true, verificacao = null;

  delete from imobdesk.at_setor_gestores where setor_id = v_id and not (usuario_id = any (v_gestores));
  insert into imobdesk.at_setor_gestores (setor_id, usuario_id) select v_id, g from unnest(v_gestores) g on conflict do nothing;

  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', case when v_antes is null then 'create' else 'update' end,
    format('Setor de atendimento "%s" %s', v_nome, case when v_antes is null then 'criado' else 'alterado' end),
    v_antes, jsonb_build_object('nome', v_nome, 'ativo', coalesce((p ->> 'ativo')::boolean, true), 'numeros', to_jsonb(v_numeros), 'gestores', to_jsonb(v_gestores)),
    v_id::text);
  return v_id;
end;
$$;

-- ---------- Configuração do setor (gestão do setor) ----------
-- p: {setorId, msgBoasVindas, msgForaHorario, msgEncerramento, limiteSimultaneo, atendenteSemRespostaMin,
--     encerrarAposHoras, alertaFilaMin, alertaClienteMin, horarios: [{dia, aberto, abre, fecha}]}
create or replace function imobdesk.at_setor_config_salvar(p jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := auth.uid();
  v_setor bigint := (p ->> 'setorId')::bigint;
  v_antes jsonb;
  h jsonb;
begin
  if v_ator is null or v_setor is null or not imobdesk.at_gestor_de(v_setor) then
    perform imobdesk.erro('FORBIDDEN', 'Só a gestão do setor altera a fila e os horários.');
  end if;
  select to_jsonb(s) into v_antes from imobdesk.at_setores s where s.id = v_setor;
  if v_antes is null then
    perform imobdesk.erro('NOT_FOUND', 'Setor não encontrado.');
  end if;
  begin
    update imobdesk.at_setores s set
      msg_boas_vindas = coalesce(nullif(btrim(p ->> 'msgBoasVindas'), ''), s.msg_boas_vindas),
      msg_fora_horario = coalesce(nullif(btrim(p ->> 'msgForaHorario'), ''), s.msg_fora_horario),
      msg_encerramento = coalesce(nullif(btrim(p ->> 'msgEncerramento'), ''), s.msg_encerramento),
      limite_simultaneo = coalesce((p ->> 'limiteSimultaneo')::int, s.limite_simultaneo),
      atendente_sem_resposta_min = coalesce((p ->> 'atendenteSemRespostaMin')::int, s.atendente_sem_resposta_min),
      encerrar_apos_horas = coalesce((p ->> 'encerrarAposHoras')::int, s.encerrar_apos_horas),
      alerta_fila_min = coalesce((p ->> 'alertaFilaMin')::int, s.alerta_fila_min),
      alerta_cliente_min = coalesce((p ->> 'alertaClienteMin')::int, s.alerta_cliente_min),
      atualizado_em = now(), atualizado_por = v_ator
    where s.id = v_setor;
  exception when check_violation then
    perform imobdesk.erro('INVALID_INPUT', 'Valor fora do permitido: limite de 1 a 50, encerramento de 1 a 23 h, alertas de 1 a 240 min e mensagens de até 1.000 letras.');
  end;
  for h in select * from jsonb_array_elements(coalesce(p -> 'horarios', '[]')) loop
    if (h ->> 'aberto')::boolean and (h ->> 'fecha')::time <= (h ->> 'abre')::time then
      perform imobdesk.erro('INVALID_INPUT', 'O horário de fechar precisa ser depois do de abrir.', 'horarios');
    end if;
    update imobdesk.at_horarios set aberto = (h ->> 'aberto')::boolean,
      abre = coalesce((h ->> 'abre')::time, abre), fecha = coalesce((h ->> 'fecha')::time, fecha)
    where setor_id = v_setor and dia = (h ->> 'dia')::int;
  end loop;
  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', 'update', format('Fila e horários do setor "%s" alterados', v_antes ->> 'nome'),
    v_antes, (select to_jsonb(s) from imobdesk.at_setores s where s.id = v_setor), v_setor::text);
end;
$$;

-- ---------- Equipe do setor ----------
-- p: {usuarioId, setorId, apto?}. Atendente de outro setor só a supervisão geral pode mover.
create or replace function imobdesk.at_atendente_salvar(p jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := auth.uid();
  v_usuario uuid := (p ->> 'usuarioId')::uuid;
  v_setor bigint := (p ->> 'setorId')::bigint;
  v_atual bigint;
  v_nome text;
begin
  if v_ator is null or v_setor is null or not imobdesk.at_gestor_de(v_setor) then
    perform imobdesk.erro('FORBIDDEN', 'Só a gestão do setor altera a equipe.');
  end if;
  select u.nome into v_nome from imobdesk.usuarios u where u.id = v_usuario and u.status = 'active';
  if v_nome is null then
    perform imobdesk.erro('INVALID_INPUT', 'Escolha um usuário ativo do portal.', 'usuarioId');
  end if;
  select a.setor_id into v_atual from imobdesk.at_atendentes a where a.usuario_id = v_usuario;
  if v_atual is not null and v_atual <> v_setor and not imobdesk.at_supervisor() then
    perform imobdesk.erro('DUPLICATE', format('%s já é atendente de outro setor. Só a supervisão geral pode mudar de setor.', v_nome), 'usuarioId');
  end if;
  insert into imobdesk.at_atendentes (usuario_id, setor_id, apto)
  values (v_usuario, v_setor, coalesce((p ->> 'apto')::boolean, true))
  on conflict (usuario_id) do update set setor_id = excluded.setor_id, apto = coalesce((p ->> 'apto')::boolean, imobdesk.at_atendentes.apto);
  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', case when v_atual is null then 'create' else 'update' end,
    format('Atendente %s %s', v_nome, case when v_atual is null then 'incluído na equipe' when v_atual <> v_setor then 'mudou de setor' else 'alterado' end),
    case when v_atual is null then null else jsonb_build_object('setor', v_atual) end, p, v_usuario::text);
end;
$$;

create or replace function imobdesk.at_atendente_remover(p_usuario uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := auth.uid();
  v_setor bigint;
  v_nome text;
begin
  select a.setor_id, u.nome into v_setor, v_nome
  from imobdesk.at_atendentes a join imobdesk.usuarios u on u.id = a.usuario_id
  where a.usuario_id = p_usuario;
  if v_setor is null then
    perform imobdesk.erro('NOT_FOUND', 'Atendente não encontrado.');
  end if;
  if v_ator is null or not imobdesk.at_gestor_de(v_setor) then
    perform imobdesk.erro('FORBIDDEN', 'Só a gestão do setor altera a equipe.');
  end if;
  delete from imobdesk.at_atendentes where usuario_id = p_usuario;
  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', 'delete', format('Atendente %s removido da equipe', v_nome),
    jsonb_build_object('setor', v_setor), null, p_usuario::text);
end;
$$;

-- ---------- Do próprio atendente ----------
-- Sinal de presença da Central aberta (a cada minuto).
create or replace function imobdesk.at_ping()
returns boolean
language sql
security definer
set search_path = ''
as $$
  update imobdesk.at_atendentes set online_em = now() where usuario_id = auth.uid() returning true;
$$;

create or replace function imobdesk.at_minha_pausa(p_pausa boolean)
returns void
language sql
security definer
set search_path = ''
as $$
  update imobdesk.at_atendentes set pausa = coalesce(p_pausa, false), online_em = now() where usuario_id = auth.uid();
$$;

-- ---------- Configuração do canal (tela Zenvia, só super admin) ----------
-- p: {ligado?, travaPiloto?, telefonesPiloto?: [texto]}
create or replace function imobdesk.at_config_salvar(p jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := auth.uid();
  v_antes jsonb;
  v_tels text[];
begin
  if v_ator is null or not imobdesk.eh_super_admin() then
    perform imobdesk.erro('FORBIDDEN', 'Só o super admin altera a conexão do WhatsApp.');
  end if;
  select coalesce(array_agg(d) filter (where d ~ '^\d{12,13}$'), '{}') into v_tels
  from (select case when length(regexp_replace(x, '\D', '', 'g')) in (10, 11) then '55' else '' end || regexp_replace(x, '\D', '', 'g') d
        from jsonb_array_elements_text(coalesce(p -> 'telefonesPiloto', '[]')) x) s;
  select to_jsonb(c) - 'verificacao' - 'token_segredo_id' into v_antes from imobdesk.at_config c where c.id;
  update imobdesk.at_config c set
    ligado = coalesce((p ->> 'ligado')::boolean, c.ligado),
    trava_piloto = coalesce((p ->> 'travaPiloto')::boolean, c.trava_piloto),
    telefones_piloto = case when p ? 'telefonesPiloto' then v_tels else c.telefones_piloto end,
    atualizado_em = now(), atualizado_por = v_ator
  where c.id;
  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', 'update', 'Configuração do WhatsApp do atendimento alterada',
    v_antes, (select to_jsonb(c) - 'verificacao' - 'token_segredo_id' from imobdesk.at_config c where c.id), 'at_config');
end;
$$;

-- ---------- Execução: só logado; as funções internas não ficam expostas ao anon ----------
do $$
declare
  f text;
begin
  foreach f in array array[
    'imobdesk.at_setor_horarios_padrao()',
    'imobdesk.at_supervisor()', 'imobdesk.at_gestor_de(bigint)', 'imobdesk.at_membro_de(bigint)',
    'imobdesk.at_contexto()', 'imobdesk.at_candidatos()', 'imobdesk.at_setor_salvar(jsonb)',
    'imobdesk.at_setor_config_salvar(jsonb)', 'imobdesk.at_atendente_salvar(jsonb)',
    'imobdesk.at_atendente_remover(uuid)', 'imobdesk.at_ping()', 'imobdesk.at_minha_pausa(boolean)',
    'imobdesk.at_config_salvar(jsonb)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
  revoke execute on function imobdesk.at_setor_horarios_padrao() from authenticated;
end;
$$;

do $$
begin
  if to_regclass('acessos.aplicativos') is not null then
    if exists (select 1 from acessos.aplicativos a where a.schema_name = 'imobdesk' and a.controle_ativo) then
      perform acessos.aplicar_protecao('imobdesk', true);
    end if;
  end if;
end;
$$;

notify pgrst, 'reload schema';

-- ======================================== 20261006170100_imobdesk_atendimento_conversas.sql
-- Gestão de Atendimento — F2 (2/3): conversas, mensagens, tickets (um por atendimento) e eventos crus da
-- Zenvia. Só aditiva. Quem grava as mensagens é a Edge Function (service role) na fase do chat; a tela lê
-- pela RLS e mexe só pelas RPCs.
--
-- Visibilidade: supervisão geral vê tudo; gestor vê tudo do seu setor; atendente vê a fila do seu setor e
-- as conversas que estão com ele (as encerradas por ele também).

-- ---------- Conversas: uma por (número do setor, telefone do cliente) ----------
create table if not exists imobdesk.at_conversas (
  id                       bigint      generated always as identity primary key,
  setor_id                 bigint      not null references imobdesk.at_setores (id),
  numero_id                bigint      not null references imobdesk.at_numeros (id),   -- por onde responder
  telefone                 text        not null check (telefone ~ '^\d{10,15}$'),
  nome_contato             text,
  modo                     text        not null default 'fila' check (modo in ('fila', 'atendente', 'encerrada', 'robo')),  -- robo: reservado
  atendente_id             uuid        references imobdesk.usuarios (id) on delete set null,
  atendente_desde          timestamptz,
  ultimo_atendente_id      uuid        references imobdesk.usuarios (id) on delete set null,
  fila_desde               timestamptz,
  atendimento_id           bigint,                                  -- ticket em aberto (at_atendimentos)
  ultima_msg_cliente_em    timestamptz,
  ultima_msg_atendente_em  timestamptz,
  ultima_msg_em            timestamptz,
  ultima_previa            text,
  nao_lidas                int         not null default 0,
  nota_interna             text        check (length(nota_interna) <= 4000),
  criado_em                timestamptz not null default now(),
  atualizado_em            timestamptz not null default now(),
  unique (numero_id, telefone)
);
create index if not exists at_conversas_setor_idx on imobdesk.at_conversas (setor_id, modo);
create index if not exists at_conversas_lista_idx on imobdesk.at_conversas (ultima_msg_em desc);
create index if not exists at_conversas_atendente_idx on imobdesk.at_conversas (atendente_id) where atendente_id is not null;

-- ---------- Tickets: cada ciclo fila → atendimento → encerramento. Base dos indicadores do Monitor ----------
create table if not exists imobdesk.at_atendimentos (
  id                    bigint      generated by default as identity (start with 10000) primary key,
  conversa_id           bigint      not null references imobdesk.at_conversas (id),
  setor_id              bigint      not null references imobdesk.at_setores (id),
  entrou_fila_em        timestamptz not null default now(),
  fora_horario          boolean     not null default false,   -- chegou com o setor fechado ou sem atendente online
  assumido_em           timestamptz,
  atendente_id          uuid        references imobdesk.usuarios (id) on delete set null,
  primeira_resposta_em  timestamptz,
  encerrado_em          timestamptz,
  encerrado_por         uuid        references imobdesk.usuarios (id) on delete set null,
  encerramento          text        check (encerramento in ('atendente', 'inatividade', 'sistema')),
  transferencias        int         not null default 0,
  devolvido_fila        boolean     not null default false,
  reaberto_em_24h       boolean     not null default false,   -- o cliente voltou em até 24 h depois do encerramento
  criado_em             timestamptz not null default now()
);
create index if not exists at_atendimentos_setor_enc_idx on imobdesk.at_atendimentos (setor_id, encerrado_em);
create index if not exists at_atendimentos_setor_fila_idx on imobdesk.at_atendimentos (setor_id, entrou_fila_em);
create index if not exists at_atendimentos_conversa_idx on imobdesk.at_atendimentos (conversa_id, criado_em desc);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'at_conversas_atendimento_fk') then
    alter table imobdesk.at_conversas
      add constraint at_conversas_atendimento_fk foreign key (atendimento_id) references imobdesk.at_atendimentos (id);
  end if;
end;
$$;

-- ---------- Mensagens ----------
create table if not exists imobdesk.at_mensagens (
  id              bigint      generated always as identity primary key,
  conversa_id     bigint      not null references imobdesk.at_conversas (id),
  atendimento_id  bigint      references imobdesk.at_atendimentos (id),
  zenvia_id       text,
  direcao         text        not null check (direcao in ('entrada', 'saida', 'interna')),
  autor           text        not null check (autor in ('cliente', 'atendente', 'auto', 'sistema')),
  autor_id        uuid        references imobdesk.usuarios (id) on delete set null,
  tipo            text        not null default 'texto' check (tipo in ('texto', 'arquivo', 'imagem', 'audio', 'video', 'evento')),
  texto           text,
  arquivo         jsonb,                       -- {nome, url?, path?, mime}
  status          text        not null default 'recebida' check (status in ('recebida', 'pendente', 'enviada', 'entregue', 'lida', 'falhou')),
  erro            text,
  criado_em       timestamptz not null default now()
);
create unique index if not exists at_mensagens_zenvia_uidx on imobdesk.at_mensagens (zenvia_id) where zenvia_id is not null;
create index if not exists at_mensagens_conversa_idx on imobdesk.at_mensagens (conversa_id, criado_em);

-- ---------- Eventos crus do webhook (idempotência e diagnóstico) ----------
create table if not exists imobdesk.at_eventos_zenvia (
  id           bigint      generated always as identity primary key,
  recebido_em  timestamptz not null default now(),
  tipo         text,
  zenvia_id    text,
  para         text,                         -- número de destino (define o setor)
  payload      jsonb       not null,
  processado   boolean     not null default false,
  erro         text
);
create unique index if not exists at_eventos_zenvia_uidx on imobdesk.at_eventos_zenvia (tipo, zenvia_id) where zenvia_id is not null;
create index if not exists at_eventos_zenvia_recebido_idx on imobdesk.at_eventos_zenvia (recebido_em desc);

-- ---------- Segurança ----------
create or replace function imobdesk.at_ve_conversa(p_setor bigint, p_atendente uuid, p_ultimo uuid default null)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select imobdesk.at_gestor_de(p_setor)
      or (imobdesk.at_membro_de(p_setor)
          and (p_atendente = auth.uid() or (p_atendente is null and (p_ultimo is null or p_ultimo = auth.uid()))));
$$;

do $$
declare
  t text;
begin
  foreach t in array array['at_conversas', 'at_atendimentos', 'at_mensagens', 'at_eventos_zenvia'] loop
    execute format('alter table imobdesk.%I enable row level security', t);
    execute format('revoke all on imobdesk.%I from anon, public', t);
    execute format('revoke insert, update, delete, truncate on imobdesk.%I from authenticated', t);
    execute format('grant select on imobdesk.%I to authenticated', t);
    execute format('grant all on imobdesk.%I to service_role', t);
  end loop;

  -- Na fila (sem atendente) todos do setor veem; encerrada fica com quem atendeu por último.
  if not exists (select 1 from pg_policies where schemaname = 'imobdesk' and tablename = 'at_conversas' and policyname = 'Atendimento: conversas visíveis') then
    create policy "Atendimento: conversas visíveis" on imobdesk.at_conversas
      for select to authenticated using (
        (select imobdesk.at_supervisor())
        or imobdesk.at_ve_conversa(setor_id, atendente_id, case when modo = 'encerrada' then ultimo_atendente_id end)
      );
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'imobdesk' and tablename = 'at_mensagens' and policyname = 'Atendimento: mensagens das conversas visíveis') then
    create policy "Atendimento: mensagens das conversas visíveis" on imobdesk.at_mensagens
      for select to authenticated using (
        (select imobdesk.at_supervisor())
        or exists (select 1 from imobdesk.at_conversas c where c.id = conversa_id
                   and imobdesk.at_ve_conversa(c.setor_id, c.atendente_id, case when c.modo = 'encerrada' then c.ultimo_atendente_id end))
      );
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'imobdesk' and tablename = 'at_atendimentos' and policyname = 'Atendimento: tickets da gestão do setor') then
    create policy "Atendimento: tickets da gestão do setor" on imobdesk.at_atendimentos
      for select to authenticated using ((select imobdesk.at_supervisor()) or imobdesk.at_gestor_de(setor_id) or atendente_id = (select auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'imobdesk' and tablename = 'at_eventos_zenvia' and policyname = 'Atendimento: eventos só super admin') then
    create policy "Atendimento: eventos só super admin" on imobdesk.at_eventos_zenvia
      for select to authenticated using ((select imobdesk.eh_super_admin()));
  end if;
end;
$$;

-- Tempo real na Central e no Monitor (a RLS vale também para o Realtime).
do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['at_conversas', 'at_mensagens', 'at_atendentes'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'imobdesk' and tablename = t) then
        execute format('alter publication supabase_realtime add table imobdesk.%I', t);
      end if;
    end loop;
  end if;
end;
$$;

-- ---------- Lista da Central (com nomes; a RLS de at_conversas decide o que entra) ----------
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
  select c.id, c.setor_id, n.numero, c.telefone, c.nome_contato, c.modo,
         c.atendente_id, coalesce(ua.nome, uu.nome), c.atendente_desde, c.fila_desde,
         c.atendimento_id, c.ultima_msg_cliente_em, c.ultima_msg_atendente_em, c.ultima_msg_em,
         c.ultima_previa, c.nao_lidas, c.nota_interna, c.criado_em,
         (select count(*) from imobdesk.at_atendimentos t where t.conversa_id = c.id)
  from imobdesk.at_conversas c
  join imobdesk.at_numeros n on n.id = c.numero_id
  left join imobdesk.usuarios ua on ua.id = c.atendente_id
  left join imobdesk.usuarios uu on uu.id = c.ultimo_atendente_id
  order by c.ultima_msg_em desc nulls last
  limit least(greatest(coalesce(p_limite, 300), 1), 1000);
$$;

-- Zera o contador de não lidas de uma conversa visível para quem chama.
create or replace function imobdesk.at_marcar_lida(p_conversa bigint)
returns void
language sql
security definer
set search_path = ''
as $$
  update imobdesk.at_conversas c set nao_lidas = 0
  where c.id = p_conversa and c.nao_lidas > 0
    and (imobdesk.at_supervisor()
         or imobdesk.at_ve_conversa(c.setor_id, c.atendente_id, case when c.modo = 'encerrada' then c.ultimo_atendente_id end));
$$;

-- Nota interna e nome do contato (quem vê a conversa pode editar).
create or replace function imobdesk.at_conversa_editar(p_conversa bigint, p jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  c imobdesk.at_conversas;
begin
  select * into c from imobdesk.at_conversas where id = p_conversa;
  if c.id is null or not (imobdesk.at_supervisor()
                          or imobdesk.at_ve_conversa(c.setor_id, c.atendente_id, case when c.modo = 'encerrada' then c.ultimo_atendente_id end)) then
    perform imobdesk.erro('NOT_FOUND', 'Conversa não encontrada.');
  end if;
  if p ? 'nomeContato' and length(btrim(coalesce(p ->> 'nomeContato', ''))) > 80 then
    perform imobdesk.erro('INVALID_INPUT', 'Nome com até 80 letras.', 'nomeContato');
  end if;
  if p ? 'notaInterna' and length(coalesce(p ->> 'notaInterna', '')) > 4000 then
    perform imobdesk.erro('INVALID_INPUT', 'Nota com até 4.000 letras.', 'notaInterna');
  end if;
  update imobdesk.at_conversas set
    nome_contato = case when p ? 'nomeContato' then nullif(btrim(p ->> 'nomeContato'), '') else nome_contato end,
    nota_interna = case when p ? 'notaInterna' then nullif(p ->> 'notaInterna', '') else nota_interna end,
    atualizado_em = now()
  where id = p_conversa;
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'imobdesk.at_ve_conversa(bigint, uuid, uuid)', 'imobdesk.at_conversas_lista(int)',
    'imobdesk.at_marcar_lida(bigint)', 'imobdesk.at_conversa_editar(bigint, jsonb)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end;
$$;

do $$
begin
  if to_regclass('acessos.aplicativos') is not null then
    if exists (select 1 from acessos.aplicativos a where a.schema_name = 'imobdesk' and a.controle_ativo) then
      perform acessos.aplicar_protecao('imobdesk', true);
    end if;
  end if;
end;
$$;

notify pgrst, 'reload schema';

-- ======================================== 20261006170200_imobdesk_atendimento_monitor.sql
-- Gestão de Atendimento — F2 (3/3): Monitor do gestor. Indicadores do período (com o período anterior
-- equivalente), acompanhamento de atendentes e conversas abertas. Só para a supervisão geral (todos os
-- setores) e para o gestor (só os setores dele). Só aditiva.
--
-- Definições (aprovadas em 06/10/2026):
--   atendida          ticket encerrado no período que alguém assumiu
--   resolvida no 1º   atendida sem transferência, sem voltar à fila e sem o cliente voltar em 24 h
--   fora do horário   entrou na fila com o setor fechado ou sem atendente online
--   espera            da entrada na fila até alguém assumir
--   atendimento       de assumir até encerrar

-- Setores que quem chama pode monitorar (p_setor null = todos os permitidos).
create or replace function imobdesk.at_monitor_setores(p_setor bigint default null)
returns bigint[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v bigint[];
begin
  if imobdesk.at_supervisor() then
    select coalesce(array_agg(s.id), '{}') into v from imobdesk.at_setores s where p_setor is null or s.id = p_setor;
  elsif imobdesk.tem_permissao('gestao_atendimento_monitor') then
    select coalesce(array_agg(g.setor_id), '{}') into v from imobdesk.at_setor_gestores g
    where g.usuario_id = auth.uid() and (p_setor is null or g.setor_id = p_setor);
  else
    v := '{}';
  end if;
  if coalesce(cardinality(v), 0) = 0 then
    perform imobdesk.erro('FORBIDDEN', 'O Monitor é da gestão do setor e da supervisão geral.');
  end if;
  return v;
end;
$$;

-- Números de uma janela [ini, fim) (interna).
create or replace function imobdesk.at_indicadores_janela(p_ini timestamptz, p_fim timestamptz, p_setores bigint[])
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with t as (select * from imobdesk.at_atendimentos a where a.setor_id = any (p_setores)),
  enc as (select * from t where t.encerrado_em >= p_ini and t.encerrado_em < p_fim and t.assumido_em is not null)
  select jsonb_build_object(
    'atendidas', (select count(*) from enc),
    'resolvidas1o', (select count(*) from enc where enc.transferencias = 0 and not enc.devolvido_fila and not enc.reaberto_em_24h),
    'foraHorario', (select count(*) from t where t.entrou_fila_em >= p_ini and t.entrou_fila_em < p_fim and t.fora_horario),
    'esperaMediaSeg', (select round(avg(extract(epoch from (t.assumido_em - t.entrou_fila_em)))) from t
                       where t.assumido_em >= p_ini and t.assumido_em < p_fim),
    'atendimentoMedioSeg', (select round(avg(extract(epoch from (enc.encerrado_em - enc.assumido_em)))) from enc)
  );
$$;

-- p_periodo: hoje | semana | mes. O anterior é a mesma duração a partir do início do período anterior
-- (ex.: "este mês até agora" × "mês passado até o mesmo dia e hora").
create or replace function imobdesk.at_monitor_indicadores(p_periodo text, p_setor bigint default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_setores bigint[] := imobdesk.at_monitor_setores(p_setor);
  v_unidade text := case p_periodo when 'hoje' then 'day' when 'semana' then 'week' when 'mes' then 'month' end;
  v_tz text := 'America/Sao_Paulo';
  v_ini timestamptz;
  v_ini_ant timestamptz;
  v_dur interval;
begin
  if v_unidade is null then
    perform imobdesk.erro('INVALID_INPUT', 'Período inválido (hoje, semana ou mes).');
  end if;
  v_ini := date_trunc(v_unidade, now() at time zone v_tz) at time zone v_tz;
  v_dur := now() - v_ini;
  v_ini_ant := date_trunc(v_unidade, (v_ini - interval '1 second') at time zone v_tz) at time zone v_tz;
  return jsonb_build_object(
    'inicio', v_ini,
    'atual', imobdesk.at_indicadores_janela(v_ini, now(), v_setores),
    'anterior', imobdesk.at_indicadores_janela(v_ini_ant, v_ini_ant + v_dur, v_setores)
  );
end;
$$;

-- Acompanhamento de atendentes: online = sinal da Central nos últimos 3 min; disponível = apto, sem pausa,
-- online e abaixo do limite do setor.
create or replace function imobdesk.at_monitor_atendentes(p_setor bigint default null)
returns table (
  usuario_id uuid, nome text, setor_id bigint, setor_nome text, online boolean, apto boolean, pausa boolean,
  em_atendimento int, limite int, atendidas_hoje int, tempo_medio_seg numeric
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_setores bigint[] := imobdesk.at_monitor_setores(p_setor);
  v_hoje timestamptz := date_trunc('day', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo';
begin
  return query
    select a.usuario_id, u.nome, a.setor_id, s.nome,
           coalesce(a.online_em > now() - interval '3 minutes', false), a.apto, a.pausa,
           (select count(*)::int from imobdesk.at_conversas c where c.atendente_id = a.usuario_id and c.modo = 'atendente'),
           s.limite_simultaneo,
           (select count(*)::int from imobdesk.at_atendimentos t
             where t.atendente_id = a.usuario_id and t.encerrado_em >= v_hoje and t.assumido_em is not null),
           (select round(avg(extract(epoch from (t.encerrado_em - t.assumido_em)))) from imobdesk.at_atendimentos t
             where t.atendente_id = a.usuario_id and t.encerrado_em >= v_hoje and t.assumido_em is not null)
    from imobdesk.at_atendentes a
    join imobdesk.usuarios u on u.id = a.usuario_id
    join imobdesk.at_setores s on s.id = a.setor_id
    where a.setor_id = any (v_setores)
    order by s.nome, u.nome;
end;
$$;

-- Conversas aguardando (fila) e em atendimento, com o ticket e os tempos.
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
    select c.id, c.atendimento_id, c.setor_id, s.nome, c.nome_contato, c.telefone, n.numero,
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

do $$
declare
  f text;
begin
  foreach f in array array[
    'imobdesk.at_monitor_setores(bigint)', 'imobdesk.at_monitor_indicadores(text, bigint)',
    'imobdesk.at_monitor_atendentes(bigint)', 'imobdesk.at_monitor_conversas(bigint)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
  revoke execute on function imobdesk.at_indicadores_janela(timestamptz, timestamptz, bigint[]) from public, anon, authenticated;
  grant execute on function imobdesk.at_indicadores_janela(timestamptz, timestamptz, bigint[]) to service_role;
end;
$$;

notify pgrst, 'reload schema';

-- ======================================== 20261006170300_imobdesk_atendimento_zenvia.sql
-- Gestão de Atendimento — F3: credenciais da Zenvia no Vault. Uma conta (um token) para todos os números
-- dos setores. Só aditiva. O token nunca volta ao navegador: a tela vê só a máscara.

-- Chave que a Zenvia manda no cabeçalho do webhook (gerada uma vez; só a Edge Function lê).
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'imobdesk_zenvia_webhook') then
    perform vault.create_secret(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'imobdesk_zenvia_webhook',
      'Chave do webhook da Zenvia (Imobdesk)');
  end if;
end;
$$;

create or replace function imobdesk.at_zenvia_salvar_token(p_token text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := auth.uid();
  v_token text := btrim(coalesce(p_token, ''));
  v_id uuid;
begin
  if v_ator is null or not imobdesk.eh_super_admin() then
    perform imobdesk.erro('FORBIDDEN', 'Só o super admin altera a conexão do WhatsApp.');
  end if;
  if v_token !~ '^[A-Za-z0-9_-]{20,200}$' then
    perform imobdesk.erro('INVALID_INPUT', 'Token inválido: copie o token inteiro da Zenvia (Console › API).', 'token');
  end if;
  v_id := coalesce((select c.token_segredo_id from imobdesk.at_config c where c.id),
                   (select s.id from vault.secrets s where s.name = ('imobdesk_zenvia_token_' || imobdesk.empresa_atual())));
  if v_id is null then
    v_id := vault.create_secret(v_token, ('imobdesk_zenvia_token_' || imobdesk.empresa_atual()), 'Token da API Zenvia (Imobdesk)');
  else
    perform vault.update_secret(v_id, v_token);
  end if;
  update imobdesk.at_config set token_segredo_id = v_id, token_mascara = '••••••••' || right(v_token, 4),
    token_definido_em = now(), verificacao = null, atualizado_em = now(), atualizado_por = v_ator where id;
  update imobdesk.at_numeros set verificacao = null;
  -- O valor do token nunca vai para a auditoria.
  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', 'update', 'Token da API Zenvia substituído', null, null, 'at_config');
end;
$$;
revoke execute on function imobdesk.at_zenvia_salvar_token(text) from public, anon;
grant execute on function imobdesk.at_zenvia_salvar_token(text) to authenticated, service_role;

-- Só para as Edge Functions (service_role).
create or replace function imobdesk.at_ler_credencial_zenvia()
returns table (token text, webhook_chave text)
language sql
stable
security definer
set search_path = ''
as $$
  select (select d.decrypted_secret from vault.decrypted_secrets d join imobdesk.at_config c on c.token_segredo_id = d.id where c.id),
         (select d.decrypted_secret from vault.decrypted_secrets d where d.name = 'imobdesk_zenvia_webhook');
$$;
revoke execute on function imobdesk.at_ler_credencial_zenvia() from public, anon, authenticated;
grant execute on function imobdesk.at_ler_credencial_zenvia() to service_role;

notify pgrst, 'reload schema';

-- ======================================== 20261006180000_imobdesk_atendimento_email.sql
-- Gestão de Atendimento — Contas de e-mail (F2). Estrutura da Movidesk (Configurações › Contas de e-mail),
-- com a regra do portal: cada conta pertence a um setor (fila, equipe e horário do setor).
-- Decisões (Wagner, 06/10/2026): Google Workspace pela API do Gmail (conta de serviço com delegação no
-- domínio) e IMAP/SMTP com senha como alternativa; só a supervisão geral cadastra; sem POP3.
-- Só aditiva. Senhas e a chave do Google ficam no Vault; a tela nunca as recebe de volta.

-- ---------- Contas ----------
create table if not exists imobdesk.at_email_contas (
  id                   bigint      generated always as identity primary key,
  nome                 text        not null check (length(btrim(nome)) between 2 and 80),
  email                text        not null unique check (email = lower(btrim(email)) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  setor_id             bigint      not null references imobdesk.at_setores (id),
  nome_remetente       text        check (length(nome_remetente) <= 80),
  exibir_no_envio      boolean     not null default true,
  padrao_do_setor      boolean     not null default false,
  usar_logo            boolean     not null default false,
  logo_path            text,
  habilitada           boolean     not null default true,
  provedor             text        not null default 'google'
                                   check (provedor in ('google', 'outlook', 'exchange', 'yahoo', 'uol', 'bol', 'terra', 'ig', 'ibest', 'manual')),
  modo                 text        not null default 'api_google' check (modo in ('api_google', 'imap_smtp')),
  imap_host            text,
  imap_porta           int         not null default 993 check (imap_porta between 1 and 65535),
  imap_seguranca       text        not null default 'ssl' check (imap_seguranca in ('ssl', 'starttls')),
  smtp_host            text,
  -- O Supabase bloqueia a saída nas portas 25 e 587: SMTP só com SSL direto (465).
  smtp_porta           int         not null default 465 check (smtp_porta between 1 and 65535 and smtp_porta not in (25, 587)),
  usuario              text,
  senha_segredo_id     uuid,
  senha_mascara        text,
  pasta                text        not null default 'INBOX' check (length(btrim(pasta)) between 1 and 120),
  intervalo_min        int         not null default 1 check (intervalo_min in (1, 2, 5, 10, 15)),
  ler_desde            date        not null default current_date,
  marcar_lido          boolean     not null default true,
  mover_para           text,
  juntar_respostas     boolean     not null default true,
  ignorar_remetentes   text[]      not null default '{mailer-daemon@,noreply@,no-reply@}',
  responder_para       text,
  copia_oculta         text,
  assinatura           text        check (length(assinatura) <= 4000),
  status               text        not null default 'aguardando' check (status in ('conectado', 'falha', 'aguardando')),
  ultimo_erro          text,
  ultima_leitura_em    timestamptz,
  cursor               text,                                  -- historyId do Gmail ou UID do IMAP (F4)
  verificacao          jsonb,                                 -- último "Testar configurações"
  criado_em            timestamptz not null default now(),
  atualizado_em        timestamptz not null default now(),
  atualizado_por       uuid
);
create index if not exists at_email_contas_setor_idx on imobdesk.at_email_contas (setor_id);
-- Uma conta padrão de envio por setor.
create unique index if not exists at_email_contas_padrao_uidx on imobdesk.at_email_contas (setor_id) where padrao_do_setor;

-- ---------- E-mails recebidos (a "fila" da lista e a entrada do processo de ticket) ----------
create table if not exists imobdesk.at_email_recebidos (
  id            bigint      generated always as identity primary key,
  conta_id      bigint      not null references imobdesk.at_email_contas (id),
  message_id    text        not null,                         -- cabeçalho Message-ID (idempotência)
  provedor_id   text,                                         -- id da mensagem no Gmail / UID do IMAP
  thread_id     text,
  de            text        not null,
  de_nome       text,
  para          text[]      not null default '{}',
  cc            text[]      not null default '{}',
  assunto       text,
  texto         text,
  html          text,
  anexos        jsonb       not null default '[]',            -- [{nome, mime, tamanho, path}] no Storage
  in_reply_to   text,
  referencias   text,
  recebido_em   timestamptz not null,
  importado_em  timestamptz not null default now(),
  estado        text        not null default 'pendente' check (estado in ('pendente', 'virou_chamado', 'ignorado')),
  unique (conta_id, message_id)
);
create index if not exists at_email_recebidos_fila_idx on imobdesk.at_email_recebidos (conta_id) where estado = 'pendente';

-- ---------- Fila de envio ----------
create table if not exists imobdesk.at_email_saida (
  id            bigint      generated always as identity primary key,
  conta_id      bigint      not null references imobdesk.at_email_contas (id),
  para          text[]      not null,
  cc            text[]      not null default '{}',
  assunto       text        not null,
  texto         text,
  html          text,
  in_reply_to   text,
  referencias   text,
  estado        text        not null default 'pendente' check (estado in ('pendente', 'enviado', 'falhou')),
  tentativas    int         not null default 0,
  erro          text,
  provedor_id   text,
  criado_por    uuid,
  criado_em     timestamptz not null default now(),
  enviado_em    timestamptz
);
create index if not exists at_email_saida_pendente_idx on imobdesk.at_email_saida (criado_em) where estado = 'pendente';

-- ---------- Conta de serviço do Google Workspace (uma para o domínio) ----------
alter table imobdesk.at_config add column if not exists google_sa_segredo_id uuid;
alter table imobdesk.at_config add column if not exists google_sa_email text;
alter table imobdesk.at_config add column if not exists google_sa_definido_em timestamptz;
alter table imobdesk.at_config add column if not exists google_verificacao jsonb;

-- ---------- Segurança: leitura só por RPC/RLS; escrita só por RPC ----------
do $$
declare
  t text;
begin
  foreach t in array array['at_email_contas', 'at_email_recebidos', 'at_email_saida'] loop
    execute format('alter table imobdesk.%I enable row level security', t);
    execute format('revoke all on imobdesk.%I from anon, public', t);
    execute format('revoke insert, update, delete, truncate on imobdesk.%I from authenticated', t);
    execute format('grant all on imobdesk.%I to service_role', t);
  end loop;
  -- A tabela de contas tem o id do segredo: a tela lê pela RPC at_email_contas_lista, nunca direto.
  revoke select on imobdesk.at_email_contas from authenticated;
  grant select on imobdesk.at_email_recebidos, imobdesk.at_email_saida to authenticated;

  if not exists (select 1 from pg_policies where schemaname = 'imobdesk' and tablename = 'at_email_recebidos' and policyname = 'Atendimento: e-mails da gestão do setor') then
    create policy "Atendimento: e-mails da gestão do setor" on imobdesk.at_email_recebidos
      for select to authenticated using (
        (select imobdesk.at_supervisor())
        or exists (select 1 from imobdesk.at_email_contas c where c.id = conta_id and imobdesk.at_gestor_de(c.setor_id))
      );
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'imobdesk' and tablename = 'at_email_saida' and policyname = 'Atendimento: saída da gestão do setor') then
    create policy "Atendimento: saída da gestão do setor" on imobdesk.at_email_saida
      for select to authenticated using (
        (select imobdesk.at_supervisor())
        or exists (select 1 from imobdesk.at_email_contas c where c.id = conta_id and imobdesk.at_gestor_de(c.setor_id))
      );
  end if;
end;
$$;

-- ---------- Lista (supervisão: todas; gestor: as do seu setor). Sem segredo ----------
create or replace function imobdesk.at_email_contas_lista()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id, 'nome', c.nome, 'email', c.email, 'setorId', c.setor_id, 'setorNome', s.nome,
    'nomeRemetente', c.nome_remetente, 'exibirNoEnvio', c.exibir_no_envio, 'padraoDoSetor', c.padrao_do_setor,
    'usarLogo', c.usar_logo, 'logoPath', c.logo_path, 'habilitada', c.habilitada,
    'provedor', c.provedor, 'modo', c.modo,
    'imapHost', c.imap_host, 'imapPorta', c.imap_porta, 'imapSeguranca', c.imap_seguranca,
    'smtpHost', c.smtp_host, 'smtpPorta', c.smtp_porta, 'usuario', c.usuario,
    'senhaMascara', c.senha_mascara,
    'pasta', c.pasta, 'intervaloMin', c.intervalo_min, 'lerDesde', c.ler_desde,
    'marcarLido', c.marcar_lido, 'moverPara', c.mover_para, 'juntarRespostas', c.juntar_respostas,
    'ignorarRemetentes', to_jsonb(c.ignorar_remetentes),
    'responderPara', c.responder_para, 'copiaOculta', c.copia_oculta, 'assinatura', c.assinatura,
    'status', c.status, 'ultimoErro', c.ultimo_erro, 'ultimaLeituraEm', c.ultima_leitura_em, 'verificacao', c.verificacao,
    'naFila', (select count(*) from imobdesk.at_email_recebidos r where r.conta_id = c.id and r.estado = 'pendente')
  ) order by c.email), '[]')
  from imobdesk.at_email_contas c
  join imobdesk.at_setores s on s.id = c.setor_id
  where imobdesk.at_supervisor() or imobdesk.at_gestor_de(c.setor_id);
$$;

-- p: os campos da tela (camelCase). Devolve o id. Senha vai por at_email_conta_senha.
create or replace function imobdesk.at_email_conta_salvar(p jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := auth.uid();
  v_id bigint := nullif(p ->> 'id', '')::bigint;
  v_email text := lower(btrim(coalesce(p ->> 'email', '')));
  v_setor bigint := nullif(p ->> 'setorId', '')::bigint;
  v_modo text := coalesce(p ->> 'modo', 'api_google');
  v_antes jsonb;
  v_ignorar text[];
begin
  if v_ator is null or not imobdesk.at_supervisor() then
    perform imobdesk.erro('FORBIDDEN', 'Só a supervisão geral cadastra contas de e-mail.');
  end if;
  if length(btrim(coalesce(p ->> 'nome', ''))) not between 2 and 80 then
    perform imobdesk.erro('INVALID_INPUT', 'Informe o nome da conta (2 a 80 letras).', 'nome');
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    perform imobdesk.erro('INVALID_INPUT', 'Endereço de e-mail inválido.', 'email');
  end if;
  if exists (select 1 from imobdesk.at_email_contas c where c.email = v_email and c.id is distinct from v_id) then
    perform imobdesk.erro('DUPLICATE', 'Já existe uma conta com esse endereço.', 'email');
  end if;
  if v_setor is null or not exists (select 1 from imobdesk.at_setores s where s.id = v_setor) then
    perform imobdesk.erro('INVALID_INPUT', 'Escolha o setor que recebe os chamados desta conta.', 'setorId');
  end if;
  if v_modo = 'api_google' and coalesce(p ->> 'provedor', 'google') <> 'google' then
    perform imobdesk.erro('INVALID_INPUT', 'A conexão por API só existe para contas do Google Workspace.', 'modo');
  end if;
  if v_modo = 'imap_smtp' and (nullif(btrim(p ->> 'imapHost'), '') is null or nullif(btrim(p ->> 'smtpHost'), '') is null) then
    perform imobdesk.erro('INVALID_INPUT', 'Informe os servidores de entrada (IMAP) e de saída (SMTP).', 'imapHost');
  end if;
  if (p ->> 'smtpPorta')::int in (25, 587) then
    perform imobdesk.erro('INVALID_INPUT', 'Use a porta 465 (SSL): o servidor do portal bloqueia as portas 25 e 587.', 'smtpPorta');
  end if;
  select coalesce(array_agg(lower(btrim(x))) filter (where btrim(x) <> ''), '{}') into v_ignorar
  from jsonb_array_elements_text(coalesce(p -> 'ignorarRemetentes', '[]')) x;

  if (p ->> 'padraoDoSetor')::boolean then
    update imobdesk.at_email_contas set padrao_do_setor = false
    where setor_id = v_setor and padrao_do_setor and id is distinct from v_id;
  end if;

  begin
    if v_id is null then
      insert into imobdesk.at_email_contas (nome, email, setor_id, atualizado_por) values (btrim(p ->> 'nome'), v_email, v_setor, v_ator)
      returning id into v_id;
    else
      select to_jsonb(c) - 'senha_segredo_id' - 'cursor' into v_antes from imobdesk.at_email_contas c where c.id = v_id;
      if v_antes is null then
        perform imobdesk.erro('NOT_FOUND', 'Conta não encontrada.');
      end if;
    end if;
    update imobdesk.at_email_contas c set
      nome = btrim(p ->> 'nome'),
      email = v_email,
      setor_id = v_setor,
      nome_remetente = nullif(btrim(p ->> 'nomeRemetente'), ''),
      exibir_no_envio = coalesce((p ->> 'exibirNoEnvio')::boolean, c.exibir_no_envio),
      padrao_do_setor = coalesce((p ->> 'padraoDoSetor')::boolean, c.padrao_do_setor),
      usar_logo = coalesce((p ->> 'usarLogo')::boolean, c.usar_logo),
      habilitada = coalesce((p ->> 'habilitada')::boolean, c.habilitada),
      provedor = coalesce(p ->> 'provedor', c.provedor),
      modo = v_modo,
      imap_host = nullif(btrim(p ->> 'imapHost'), ''),
      imap_porta = coalesce((p ->> 'imapPorta')::int, c.imap_porta),
      imap_seguranca = coalesce(p ->> 'imapSeguranca', c.imap_seguranca),
      smtp_host = nullif(btrim(p ->> 'smtpHost'), ''),
      smtp_porta = coalesce((p ->> 'smtpPorta')::int, c.smtp_porta),
      usuario = nullif(btrim(p ->> 'usuario'), ''),
      pasta = coalesce(nullif(btrim(p ->> 'pasta'), ''), 'INBOX'),
      intervalo_min = coalesce((p ->> 'intervaloMin')::int, c.intervalo_min),
      ler_desde = coalesce((p ->> 'lerDesde')::date, c.ler_desde),
      marcar_lido = coalesce((p ->> 'marcarLido')::boolean, c.marcar_lido),
      mover_para = nullif(btrim(p ->> 'moverPara'), ''),
      juntar_respostas = coalesce((p ->> 'juntarRespostas')::boolean, c.juntar_respostas),
      ignorar_remetentes = v_ignorar,
      responder_para = nullif(lower(btrim(p ->> 'responderPara')), ''),
      copia_oculta = nullif(lower(btrim(p ->> 'copiaOculta')), ''),
      assinatura = nullif(p ->> 'assinatura', ''),
      -- Mudou a conexão: precisa testar de novo.
      status = case when v_antes is null or v_antes ->> 'modo' is distinct from v_modo
                         or v_antes ->> 'imap_host' is distinct from nullif(btrim(p ->> 'imapHost'), '')
                         or v_antes ->> 'email' is distinct from v_email then 'aguardando' else c.status end,
      atualizado_em = now(),
      atualizado_por = v_ator
    where c.id = v_id;
  exception when check_violation then
    perform imobdesk.erro('INVALID_INPUT', 'Algum valor está fora do permitido (porta, intervalo, provedor ou tamanho do texto).');
  end;

  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', case when v_antes is null then 'create' else 'update' end,
    format('Conta de e-mail %s %s', v_email, case when v_antes is null then 'criada' else 'alterada' end),
    v_antes, (select to_jsonb(c) - 'senha_segredo_id' - 'cursor' from imobdesk.at_email_contas c where c.id = v_id), v_id::text);
  return v_id;
end;
$$;

-- Senha (ou senha de app) da conta IMAP/SMTP: só no Vault.
create or replace function imobdesk.at_email_conta_senha(p_id bigint, p_senha text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := auth.uid();
  v_senha text := coalesce(p_senha, '');
  v_seg uuid;
  v_email text;
begin
  if v_ator is null or not imobdesk.at_supervisor() then
    perform imobdesk.erro('FORBIDDEN', 'Só a supervisão geral altera as contas de e-mail.');
  end if;
  select c.senha_segredo_id, c.email into v_seg, v_email from imobdesk.at_email_contas c where c.id = p_id;
  if v_email is null then
    perform imobdesk.erro('NOT_FOUND', 'Conta não encontrada.');
  end if;
  if length(v_senha) not between 4 and 200 then
    perform imobdesk.erro('INVALID_INPUT', 'Informe a senha da conta (ou a senha de app).', 'senha');
  end if;
  if v_seg is null then
    v_seg := vault.create_secret(v_senha, 'imobdesk_email_' || p_id, 'Senha da conta de e-mail ' || v_email || ' (Imobdesk)');
  else
    perform vault.update_secret(v_seg, v_senha);
  end if;
  update imobdesk.at_email_contas set senha_segredo_id = v_seg, senha_mascara = '••••••••' || right(v_senha, 2),
    status = 'aguardando', atualizado_em = now(), atualizado_por = v_ator where id = p_id;
  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', 'secret', format('Senha da conta de e-mail %s substituída', v_email), null, null, p_id::text);
end;
$$;

create or replace function imobdesk.at_email_conta_habilitar(p_ids bigint[], p_habilitada boolean)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := auth.uid();
  v_n int;
begin
  if v_ator is null or not imobdesk.at_supervisor() then
    perform imobdesk.erro('FORBIDDEN', 'Só a supervisão geral altera as contas de e-mail.');
  end if;
  update imobdesk.at_email_contas set habilitada = coalesce(p_habilitada, false), atualizado_em = now(), atualizado_por = v_ator
  where id = any (coalesce(p_ids, '{}'));
  get diagnostics v_n = row_count;
  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', case when p_habilitada then 'activate' else 'deactivate' end,
    format('%s conta(s) de e-mail %s', v_n, case when p_habilitada then 'habilitada(s)' else 'desabilitada(s)' end), null, to_jsonb(p_ids), null);
  return v_n;
end;
$$;

-- Excluir só conta sem histórico; com e-mails, desabilite (mantém os chamados).
create or replace function imobdesk.at_email_conta_excluir(p_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := auth.uid();
  c imobdesk.at_email_contas;
begin
  if v_ator is null or not imobdesk.at_supervisor() then
    perform imobdesk.erro('FORBIDDEN', 'Só a supervisão geral exclui contas de e-mail.');
  end if;
  select * into c from imobdesk.at_email_contas where id = p_id;
  if c.id is null then
    perform imobdesk.erro('NOT_FOUND', 'Conta não encontrada.');
  end if;
  if exists (select 1 from imobdesk.at_email_recebidos r where r.conta_id = p_id)
     or exists (select 1 from imobdesk.at_email_saida s where s.conta_id = p_id) then
    perform imobdesk.erro('INVALID_INPUT', 'Esta conta já tem e-mails no histórico. Desabilite em vez de excluir.');
  end if;
  delete from imobdesk.at_email_contas where id = p_id;
  if c.senha_segredo_id is not null then
    delete from vault.secrets where id = c.senha_segredo_id;
  end if;
  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', 'delete', format('Conta de e-mail %s excluída', c.email),
    to_jsonb(c) - 'senha_segredo_id' - 'cursor', null, p_id::text);
end;
$$;

-- ---------- Conta de serviço do Google (Integrações › Google Workspace, só super admin) ----------
create or replace function imobdesk.at_google_sa_salvar(p_json text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := auth.uid();
  j jsonb;
  v_id uuid;
begin
  if v_ator is null or not imobdesk.eh_super_admin() then
    perform imobdesk.erro('FORBIDDEN', 'Só o super admin configura o Google Workspace.');
  end if;
  begin
    j := p_json::jsonb;
  exception when others then
    perform imobdesk.erro('INVALID_INPUT', 'Arquivo inválido: envie o JSON da chave da conta de serviço do Google Cloud.', 'chave');
  end;
  if j ->> 'type' is distinct from 'service_account' or coalesce(j ->> 'client_email', '') = '' or coalesce(j ->> 'private_key', '') not like '-----BEGIN PRIVATE KEY-----%' then
    perform imobdesk.erro('INVALID_INPUT', 'O JSON precisa ser de uma conta de serviço (type, client_email e private_key).', 'chave');
  end if;
  v_id := coalesce((select c.google_sa_segredo_id from imobdesk.at_config c where c.id),
                   (select s.id from vault.secrets s where s.name = ('imobdesk_google_sa_' || imobdesk.empresa_atual())));
  if v_id is null then
    v_id := vault.create_secret(p_json, ('imobdesk_google_sa_' || imobdesk.empresa_atual()), 'Chave da conta de serviço do Google Workspace (Imobdesk)');
  else
    perform vault.update_secret(v_id, p_json);
  end if;
  update imobdesk.at_config set google_sa_segredo_id = v_id, google_sa_email = j ->> 'client_email',
    google_sa_definido_em = now(), google_verificacao = null, atualizado_em = now(), atualizado_por = v_ator where id;
  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', 'secret', 'Chave da conta de serviço do Google Workspace substituída',
    null, jsonb_build_object('client_email', j ->> 'client_email'), 'at_config');
end;
$$;

-- Só para as Edge Functions (service_role).
create or replace function imobdesk.at_email_credenciais(p_conta bigint)
returns table (senha text, google_sa text)
language sql
stable
security definer
set search_path = ''
as $$
  select (select d.decrypted_secret from vault.decrypted_secrets d join imobdesk.at_email_contas c on c.senha_segredo_id = d.id where c.id = p_conta),
         (select d.decrypted_secret from vault.decrypted_secrets d join imobdesk.at_config c on c.google_sa_segredo_id = d.id where c.id);
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'imobdesk.at_email_contas_lista()', 'imobdesk.at_email_conta_salvar(jsonb)',
    'imobdesk.at_email_conta_senha(bigint, text)', 'imobdesk.at_email_conta_habilitar(bigint[], boolean)',
    'imobdesk.at_email_conta_excluir(bigint)', 'imobdesk.at_google_sa_salvar(text)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
  revoke execute on function imobdesk.at_email_credenciais(bigint) from public, anon, authenticated;
  grant execute on function imobdesk.at_email_credenciais(bigint) to service_role;
end;
$$;

do $$
begin
  if to_regclass('acessos.aplicativos') is not null then
    if exists (select 1 from acessos.aplicativos a where a.schema_name = 'imobdesk' and a.controle_ativo) then
      perform acessos.aplicar_protecao('imobdesk', true);
    end if;
  end if;
end;
$$;

notify pgrst, 'reload schema';

-- ======================================== 20261006190000_imobdesk_equipes.sql
-- Configurações › Usuários › Equipes (pedido e decisões do Wagner, 06/10/2026).
-- Equipe = grupo de atendentes dentro de um setor (ou "sem setor", equipe interna); um usuário pode estar em
-- várias equipes; líder opcional. Servirá para direcionar o chamado no processo de ticket.
-- Permissões: seção `manage_users_equipes` (tela Equipes) e `manage_users` (campo Equipes no Editar usuário).
-- Só aditiva. Leitura e escrita só por RPC.

create table if not exists imobdesk.at_equipes (
  id              bigint      generated always as identity primary key,
  nome            text        not null check (length(btrim(nome)) between 2 and 60),
  setor_id        bigint      references imobdesk.at_setores (id) on delete set null,
  descricao       text        check (length(descricao) <= 500),
  lider_id        uuid        references imobdesk.usuarios (id) on delete set null,
  ativa           boolean     not null default true,
  criado_em       timestamptz not null default now(),
  atualizado_em   timestamptz not null default now(),
  atualizado_por  uuid
);
-- Nome único dentro do setor (e entre as equipes sem setor).
create unique index if not exists at_equipes_nome_uidx on imobdesk.at_equipes (coalesce(setor_id, 0), lower(btrim(nome)));

create table if not exists imobdesk.at_equipe_membros (
  equipe_id   bigint not null references imobdesk.at_equipes (id) on delete cascade,
  usuario_id  uuid   not null references imobdesk.usuarios (id) on delete cascade,
  primary key (equipe_id, usuario_id)
);
create index if not exists at_equipe_membros_usuario_idx on imobdesk.at_equipe_membros (usuario_id);

do $$
declare
  t text;
begin
  foreach t in array array['at_equipes', 'at_equipe_membros'] loop
    execute format('alter table imobdesk.%I enable row level security', t);
    execute format('revoke all on imobdesk.%I from anon, public, authenticated', t);
    execute format('grant all on imobdesk.%I to service_role', t);
  end loop;
end;
$$;

create or replace function imobdesk.at_pode_equipes()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select imobdesk.tem_permissao('manage_users_equipes') or imobdesk.tem_permissao('manage_users');
$$;

create or replace function imobdesk.at_exigir_equipes()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not imobdesk.at_pode_equipes() then
    perform imobdesk.erro('FORBIDDEN', 'Você não tem permissão para alterar equipes.');
  end if;
  return auth.uid();
end;
$$;

create or replace function imobdesk.at_equipes_lista()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform imobdesk.at_exigir_equipes();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', e.id, 'nome', e.nome, 'setorId', e.setor_id, 'setorNome', s.nome, 'descricao', e.descricao, 'ativa', e.ativa,
      'lider', case when l.id is null then null else jsonb_build_object('id', l.id, 'nome', l.nome, 'email', l.email) end,
      'membros', coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'nome', u.nome, 'email', u.email) order by u.nome)
                           from imobdesk.at_equipe_membros m join imobdesk.usuarios u on u.id = m.usuario_id
                           where m.equipe_id = e.id), '[]')
    ) order by e.ativa desc, s.nome nulls last, e.nome)
    from imobdesk.at_equipes e
    left join imobdesk.at_setores s on s.id = e.setor_id
    left join imobdesk.usuarios l on l.id = e.lider_id
  ), '[]');
end;
$$;

-- Usuários ativos para os seletores de membro e líder.
create or replace function imobdesk.at_equipes_candidatos()
returns table (id uuid, nome text, email text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform imobdesk.at_exigir_equipes();
  return query select u.id, u.nome, u.email from imobdesk.usuarios u where u.status = 'active' order by u.nome;
end;
$$;

-- p: {id?, nome, setorId?, descricao?, liderId?, ativa, membros: [uuid]}. O líder entra como membro.
create or replace function imobdesk.at_equipe_salvar(p jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := imobdesk.at_exigir_equipes();
  v_id bigint := nullif(p ->> 'id', '')::bigint;
  v_nome text := btrim(coalesce(p ->> 'nome', ''));
  v_setor bigint := nullif(p ->> 'setorId', '')::bigint;
  v_lider uuid := nullif(p ->> 'liderId', '')::uuid;
  v_membros uuid[];
  v_antes jsonb;
begin
  if length(v_nome) not between 2 and 60 then
    perform imobdesk.erro('INVALID_INPUT', 'Informe o nome da equipe (2 a 60 letras).', 'nome');
  end if;
  if v_setor is not null and not exists (select 1 from imobdesk.at_setores s where s.id = v_setor) then
    perform imobdesk.erro('INVALID_INPUT', 'Setor não encontrado.', 'setorId');
  end if;
  if exists (select 1 from imobdesk.at_equipes e
             where coalesce(e.setor_id, 0) = coalesce(v_setor, 0) and lower(btrim(e.nome)) = lower(v_nome) and e.id is distinct from v_id) then
    perform imobdesk.erro('DUPLICATE', 'Já existe uma equipe com esse nome neste setor.', 'nome');
  end if;
  select coalesce(array_agg(distinct x::uuid), '{}') into v_membros from jsonb_array_elements_text(coalesce(p -> 'membros', '[]')) x;
  if v_lider is not null and not (v_lider = any (v_membros)) then
    v_membros := v_membros || v_lider;
  end if;
  if exists (select 1 from unnest(v_membros) m where not exists (select 1 from imobdesk.usuarios u where u.id = m and u.status = 'active')) then
    perform imobdesk.erro('INVALID_INPUT', 'Membro precisa ser um usuário ativo do portal.', 'membros');
  end if;

  if v_id is null then
    insert into imobdesk.at_equipes (nome, setor_id, descricao, lider_id, ativa, atualizado_por)
    values (v_nome, v_setor, nullif(btrim(p ->> 'descricao'), ''), v_lider, coalesce((p ->> 'ativa')::boolean, true), v_ator)
    returning id into v_id;
  else
    select to_jsonb(e) || jsonb_build_object('membros', (select coalesce(jsonb_agg(m.usuario_id), '[]') from imobdesk.at_equipe_membros m where m.equipe_id = e.id))
      into v_antes from imobdesk.at_equipes e where e.id = v_id;
    if v_antes is null then
      perform imobdesk.erro('NOT_FOUND', 'Equipe não encontrada.');
    end if;
    update imobdesk.at_equipes set nome = v_nome, setor_id = v_setor, descricao = nullif(btrim(p ->> 'descricao'), ''),
      lider_id = v_lider, ativa = coalesce((p ->> 'ativa')::boolean, ativa), atualizado_em = now(), atualizado_por = v_ator
    where id = v_id;
  end if;
  delete from imobdesk.at_equipe_membros where equipe_id = v_id and not (usuario_id = any (v_membros));
  insert into imobdesk.at_equipe_membros (equipe_id, usuario_id) select v_id, m from unnest(v_membros) m on conflict do nothing;

  perform imobdesk.registrar_auditoria(v_ator, 'usuarios', case when v_antes is null then 'create' else 'update' end,
    format('Equipe "%s" %s', v_nome, case when v_antes is null then 'criada' else 'alterada' end), v_antes,
    jsonb_build_object('nome', v_nome, 'setor', v_setor, 'lider', v_lider, 'membros', to_jsonb(v_membros)), v_id::text);
  return v_id;
end;
$$;

create or replace function imobdesk.at_equipe_excluir(p_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := imobdesk.at_exigir_equipes();
  v_antes jsonb;
begin
  select to_jsonb(e) into v_antes from imobdesk.at_equipes e where e.id = p_id;
  if v_antes is null then
    perform imobdesk.erro('NOT_FOUND', 'Equipe não encontrada.');
  end if;
  delete from imobdesk.at_equipes where id = p_id;
  perform imobdesk.registrar_auditoria(v_ator, 'usuarios', 'delete', format('Equipe "%s" excluída', v_antes ->> 'nome'), v_antes, null, p_id::text);
end;
$$;

-- Campo "Equipes" no Editar usuário: as equipes de um usuário e a troca do conjunto inteiro.
create or replace function imobdesk.at_usuario_equipes(p_usuario uuid)
returns bigint[]
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform imobdesk.at_exigir_equipes();
  return coalesce((select array_agg(m.equipe_id order by m.equipe_id) from imobdesk.at_equipe_membros m where m.usuario_id = p_usuario), '{}');
end;
$$;

create or replace function imobdesk.at_usuario_equipes_salvar(p_usuario uuid, p_equipes bigint[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := imobdesk.at_exigir_equipes();
  v_antes bigint[];
  v_nome text;
begin
  select u.nome into v_nome from imobdesk.usuarios u where u.id = p_usuario;
  if v_nome is null then
    perform imobdesk.erro('NOT_FOUND', 'Usuário não encontrado.');
  end if;
  if exists (select 1 from unnest(coalesce(p_equipes, '{}')) x where not exists (select 1 from imobdesk.at_equipes e where e.id = x)) then
    perform imobdesk.erro('INVALID_INPUT', 'Equipe não encontrada.');
  end if;
  v_antes := coalesce((select array_agg(m.equipe_id order by m.equipe_id) from imobdesk.at_equipe_membros m where m.usuario_id = p_usuario), '{}');
  delete from imobdesk.at_equipe_membros where usuario_id = p_usuario and not (equipe_id = any (coalesce(p_equipes, '{}')));
  -- Quem sai da equipe deixa de ser o líder dela.
  update imobdesk.at_equipes set lider_id = null where lider_id = p_usuario and not (id = any (coalesce(p_equipes, '{}')));
  insert into imobdesk.at_equipe_membros (equipe_id, usuario_id) select x, p_usuario from unnest(coalesce(p_equipes, '{}')) x on conflict do nothing;
  perform imobdesk.registrar_auditoria(v_ator, 'usuarios', 'update', format('Equipes de %s alteradas', v_nome),
    jsonb_build_object('equipes', to_jsonb(v_antes)), jsonb_build_object('equipes', to_jsonb(coalesce(p_equipes, '{}'))), p_usuario::text);
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'imobdesk.at_pode_equipes()', 'imobdesk.at_exigir_equipes()', 'imobdesk.at_equipes_lista()',
    'imobdesk.at_equipes_candidatos()', 'imobdesk.at_equipe_salvar(jsonb)', 'imobdesk.at_equipe_excluir(bigint)',
    'imobdesk.at_usuario_equipes(uuid)', 'imobdesk.at_usuario_equipes_salvar(uuid, bigint[])'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end;
$$;

notify pgrst, 'reload schema';

-- ======================================== 20261006190100_imobdesk_pessoas.sql
-- Configurações › Pessoas (estrutura do cadastro de pessoas da Movidesk). Pessoas são os clientes que abrem
-- chamados; os agentes continuam sendo os Usuários. Decisões do Wagner (06/10/2026):
--   * autocadastro pelo e-mail E pelo WhatsApp (at_pessoa_identificar, só service role);
--   * contato (tipo + valor normalizado) identifica uma pessoa só;
--   * remetente de domínio de empresa cadastrada nasce ligado a ela (domínios públicos nunca ligam);
--   * portal do cliente (usuário/senha) fica para depois.
-- Permissão: `manage_pessoas` (menu Configurações › Pessoas). Só aditiva; leitura e escrita por RPC.

-- ---------- CPF/CNPJ ----------
create or replace function imobdesk.at_documento_valido(p text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  d text := regexp_replace(coalesce(p, ''), '\D', '', 'g');
  s int;
  r int;
  i int;
  pesos int[];
begin
  if length(d) = 11 then
    if d ~ '^(\d)\1{10}$' then return false; end if;
    s := 0; for i in 1..9 loop s := s + substr(d, i, 1)::int * (11 - i); end loop;
    r := (s * 10) % 11; if r = 10 then r := 0; end if;
    if r <> substr(d, 10, 1)::int then return false; end if;
    s := 0; for i in 1..10 loop s := s + substr(d, i, 1)::int * (12 - i); end loop;
    r := (s * 10) % 11; if r = 10 then r := 0; end if;
    return r = substr(d, 11, 1)::int;
  elsif length(d) = 14 then
    if d ~ '^(\d)\1{13}$' then return false; end if;
    pesos := array[5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    s := 0; for i in 1..12 loop s := s + substr(d, i, 1)::int * pesos[i]; end loop;
    r := s % 11; r := case when r < 2 then 0 else 11 - r end;
    if r <> substr(d, 13, 1)::int then return false; end if;
    pesos := array[6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    s := 0; for i in 1..13 loop s := s + substr(d, i, 1)::int * pesos[i]; end loop;
    r := s % 11; r := case when r < 2 then 0 else 11 - r end;
    return r = substr(d, 14, 1)::int;
  end if;
  return false;
end;
$$;

-- E-mail minúsculo; telefone só dígitos com DDI 55 quando vier com 10/11 dígitos.
create or replace function imobdesk.at_contato_normalizar(p_tipo text, p_valor text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_tipo = 'email' then lower(btrim(coalesce(p_valor, '')))
    else (select case when length(d) in (10, 11) then '55' || d else d end from (select regexp_replace(coalesce(p_valor, ''), '\D', '', 'g') d) x)
  end;
$$;

create or replace function imobdesk.at_dominio_publico(p_dominio text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select lower(coalesce(p_dominio, '')) = any (array[
    'gmail.com', 'googlemail.com', 'hotmail.com', 'hotmail.com.br', 'outlook.com', 'outlook.com.br', 'live.com', 'msn.com',
    'yahoo.com', 'yahoo.com.br', 'icloud.com', 'me.com', 'uol.com.br', 'bol.com.br', 'terra.com.br', 'ig.com.br',
    'globo.com', 'globomail.com', 'r7.com', 'zipmail.com.br', 'protonmail.com', 'proton.me', 'aol.com'
  ]);
$$;

-- ---------- Tabelas ----------
create table if not exists imobdesk.at_pessoas (
  id                 bigint      generated always as identity primary key,
  tipo               text        not null default 'pessoa' check (tipo in ('pessoa', 'empresa', 'departamento')),
  nome               text        not null check (length(btrim(nome)) between 1 and 160),
  razao_social       text        check (length(razao_social) <= 160),
  ramo               text        check (length(ramo) <= 120),
  documento          text        check (documento ~ '^\d{11}$|^\d{14}$'),
  cod_ref            text        check (length(cod_ref) <= 80),
  cod_ref_adicional  text        check (length(cod_ref_adicional) <= 80),
  classificacao      text        not null default 'Cliente' check (length(classificacao) between 1 and 60),
  dominios           text[]      not null default '{}',
  sinalizadores      text[]      not null default '{}',
  observacoes        text        check (length(observacoes) <= 8000),
  avatar_path        text,
  habilitada         boolean     not null default true,
  origem             text        not null default 'manual' check (origem in ('manual', 'email', 'whatsapp', 'importacao')),
  origem_detalhe     text,
  ultimo_contato_em  timestamptz,
  criado_em          timestamptz not null default now(),
  criado_por         uuid,
  atualizado_em      timestamptz not null default now(),
  atualizado_por     uuid
);
create unique index if not exists at_pessoas_documento_uidx on imobdesk.at_pessoas (documento) where documento is not null;
create index if not exists at_pessoas_nome_idx on imobdesk.at_pessoas (lower(nome));
create index if not exists at_pessoas_dominios_idx on imobdesk.at_pessoas using gin (dominios);
create index if not exists at_pessoas_cod_ref_idx on imobdesk.at_pessoas (cod_ref) where cod_ref is not null;

create table if not exists imobdesk.at_pessoa_contatos (
  id         bigint      generated always as identity primary key,
  pessoa_id  bigint      not null references imobdesk.at_pessoas (id) on delete cascade,
  tipo       text        not null check (tipo in ('email', 'telefone', 'whatsapp')),
  valor      text        not null check (length(valor) between 3 and 160),
  principal  boolean     not null default false,
  criado_em  timestamptz not null default now(),
  unique (tipo, valor)
);
create index if not exists at_pessoa_contatos_pessoa_idx on imobdesk.at_pessoa_contatos (pessoa_id);

-- Pessoa ↔ empresa/departamento (pessoa_id é o membro; empresa_id é a empresa ou o departamento).
create table if not exists imobdesk.at_pessoa_relacoes (
  pessoa_id   bigint not null references imobdesk.at_pessoas (id) on delete cascade,
  empresa_id  bigint not null references imobdesk.at_pessoas (id) on delete cascade,
  cargo       text   check (length(cargo) <= 80),
  primary key (pessoa_id, empresa_id),
  check (pessoa_id <> empresa_id)
);
create index if not exists at_pessoa_relacoes_empresa_idx on imobdesk.at_pessoa_relacoes (empresa_id);

create table if not exists imobdesk.at_pessoa_anexos (
  id           bigint      generated always as identity primary key,
  pessoa_id    bigint      not null references imobdesk.at_pessoas (id) on delete cascade,
  nome         text        not null,
  path         text        not null unique,
  mime         text,
  tamanho      bigint,
  enviado_por  uuid,
  enviado_em   timestamptz not null default now()
);

-- Histórico: conversas do WhatsApp e e-mails recebidos apontam para a pessoa.
alter table imobdesk.at_conversas add column if not exists pessoa_id bigint references imobdesk.at_pessoas (id) on delete set null;
alter table imobdesk.at_email_recebidos add column if not exists pessoa_id bigint references imobdesk.at_pessoas (id) on delete set null;
create index if not exists at_conversas_pessoa_idx on imobdesk.at_conversas (pessoa_id) where pessoa_id is not null;
create index if not exists at_email_recebidos_pessoa_idx on imobdesk.at_email_recebidos (pessoa_id) where pessoa_id is not null;

do $$
declare
  t text;
begin
  foreach t in array array['at_pessoas', 'at_pessoa_contatos', 'at_pessoa_relacoes', 'at_pessoa_anexos'] loop
    execute format('alter table imobdesk.%I enable row level security', t);
    execute format('revoke all on imobdesk.%I from anon, public, authenticated', t);
    execute format('grant all on imobdesk.%I to service_role', t);
  end loop;
end;
$$;

-- ---------- Bucket de anexos e imagens (privado, 20 MB) ----------
insert into storage.buckets (id, name, public, file_size_limit)
values ('imobdesk-atendimento-pessoas', 'imobdesk-atendimento-pessoas', false, 20971520)
on conflict (id) do nothing;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'atendimento-pessoas: leitura') then
    create policy "atendimento-pessoas: leitura" on storage.objects for select to authenticated
      using (bucket_id = 'imobdesk-atendimento-pessoas' and (select imobdesk.tem_permissao('manage_pessoas')));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'atendimento-pessoas: envio') then
    create policy "atendimento-pessoas: envio" on storage.objects for insert to authenticated
      with check (bucket_id = 'imobdesk-atendimento-pessoas' and (select imobdesk.tem_permissao('manage_pessoas')));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'atendimento-pessoas: exclusão') then
    create policy "atendimento-pessoas: exclusão" on storage.objects for delete to authenticated
      using (bucket_id = 'imobdesk-atendimento-pessoas' and (select imobdesk.tem_permissao('manage_pessoas')));
  end if;
end;
$$;

-- ---------- Acesso ----------
create or replace function imobdesk.at_exigir_pessoas()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not imobdesk.tem_permissao('manage_pessoas') then
    perform imobdesk.erro('FORBIDDEN', 'Você não tem permissão para o cadastro de Pessoas.');
  end if;
  return auth.uid();
end;
$$;

-- ---------- Lista ----------
-- p: {busca?, tipo?, origem?, pagina?, porPagina?}
create or replace function imobdesk.at_pessoas_lista(p jsonb default '{}')
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_busca text := lower(btrim(coalesce(p ->> 'busca', '')));
  v_digitos text := regexp_replace(coalesce(p ->> 'busca', ''), '\D', '', 'g');
  v_tipo text := nullif(p ->> 'tipo', '');
  v_origem text := nullif(p ->> 'origem', '');
  v_por int := least(greatest(coalesce((p ->> 'porPagina')::int, 25), 5), 100);
  v_pag int := greatest(coalesce((p ->> 'pagina')::int, 1), 1);
  v_total int;
  v_linhas jsonb;
begin
  perform imobdesk.at_exigir_pessoas();
  with filtro as (
    select ps.* from imobdesk.at_pessoas ps
    where (v_tipo is null or ps.tipo = v_tipo)
      and (v_origem is null or ps.origem = v_origem)
      and (length(v_busca) < 3
           or lower(ps.nome) like '%' || v_busca || '%'
           or lower(coalesce(ps.razao_social, '')) like '%' || v_busca || '%'
           or lower(coalesce(ps.cod_ref, '')) like '%' || v_busca || '%'
           or lower(coalesce(ps.cod_ref_adicional, '')) like '%' || v_busca || '%'
           or (length(v_digitos) >= 3 and ps.documento like '%' || v_digitos || '%')
           or exists (select 1 from imobdesk.at_pessoa_contatos c where c.pessoa_id = ps.id
                      and (c.valor like '%' || v_busca || '%' or (length(v_digitos) >= 4 and c.valor like '%' || v_digitos || '%'))))
  )
  select count(*) into v_total from filtro;
  with filtro as (
    select ps.* from imobdesk.at_pessoas ps
    where (v_tipo is null or ps.tipo = v_tipo)
      and (v_origem is null or ps.origem = v_origem)
      and (length(v_busca) < 3
           or lower(ps.nome) like '%' || v_busca || '%'
           or lower(coalesce(ps.razao_social, '')) like '%' || v_busca || '%'
           or lower(coalesce(ps.cod_ref, '')) like '%' || v_busca || '%'
           or lower(coalesce(ps.cod_ref_adicional, '')) like '%' || v_busca || '%'
           or (length(v_digitos) >= 3 and ps.documento like '%' || v_digitos || '%')
           or exists (select 1 from imobdesk.at_pessoa_contatos c where c.pessoa_id = ps.id
                      and (c.valor like '%' || v_busca || '%' or (length(v_digitos) >= 4 and c.valor like '%' || v_digitos || '%'))))
    order by ps.habilitada desc, coalesce(ps.ultimo_contato_em, ps.criado_em) desc, ps.id desc
    limit v_por offset (v_pag - 1) * v_por
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', f.id, 'tipo', f.tipo, 'nome', f.nome, 'documento', f.documento, 'codRef', f.cod_ref, 'origem', f.origem, 'habilitada', f.habilitada,
    'ultimoContatoEm', f.ultimo_contato_em, 'avatarPath', f.avatar_path,
    'email', (select c.valor from imobdesk.at_pessoa_contatos c where c.pessoa_id = f.id and c.tipo = 'email' order by c.principal desc, c.id limit 1),
    'telefone', (select c.valor from imobdesk.at_pessoa_contatos c where c.pessoa_id = f.id and c.tipo <> 'email' order by c.principal desc, c.id limit 1),
    'empresa', (select e.nome from imobdesk.at_pessoa_relacoes r join imobdesk.at_pessoas e on e.id = r.empresa_id where r.pessoa_id = f.id order by e.nome limit 1),
    'chamados', (select count(*) from imobdesk.at_atendimentos a join imobdesk.at_conversas cv on cv.id = a.conversa_id where cv.pessoa_id = f.id)
              + (select count(*) from imobdesk.at_email_recebidos er where er.pessoa_id = f.id)
  )), '[]') into v_linhas
  from filtro f;
  return jsonb_build_object('total', v_total, 'pagina', v_pag, 'porPagina', v_por, 'linhas', v_linhas);
end;
$$;

-- Busca rápida para o seletor de Relações.
create or replace function imobdesk.at_pessoas_busca(p_busca text, p_tipos text[] default null)
returns table (id bigint, nome text, tipo text, email text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform imobdesk.at_exigir_pessoas();
  return query
    select ps.id, ps.nome, ps.tipo,
           (select c.valor from imobdesk.at_pessoa_contatos c where c.pessoa_id = ps.id and c.tipo = 'email' order by c.principal desc, c.id limit 1)
    from imobdesk.at_pessoas ps
    where (p_tipos is null or ps.tipo = any (p_tipos))
      and (lower(ps.nome) like '%' || lower(btrim(coalesce(p_busca, ''))) || '%'
           or exists (select 1 from imobdesk.at_pessoa_contatos c where c.pessoa_id = ps.id and c.valor like '%' || lower(btrim(coalesce(p_busca, ''))) || '%'))
    order by ps.nome
    limit 20;
end;
$$;

-- ---------- Detalhe (com contatos, relações, anexos e histórico) ----------
create or replace function imobdesk.at_pessoa_detalhe(p_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  ps imobdesk.at_pessoas;
  v_grupo bigint[];
begin
  perform imobdesk.at_exigir_pessoas();
  select * into ps from imobdesk.at_pessoas where id = p_id;
  if ps.id is null then
    perform imobdesk.erro('NOT_FOUND', 'Pessoa não encontrada.');
  end if;
  -- Histórico da empresa inclui as pessoas relacionadas a ela.
  v_grupo := array[ps.id] || coalesce((select array_agg(r.pessoa_id) from imobdesk.at_pessoa_relacoes r where r.empresa_id = ps.id), '{}');
  return jsonb_build_object(
    'id', ps.id, 'tipo', ps.tipo, 'nome', ps.nome, 'razaoSocial', ps.razao_social, 'ramo', ps.ramo, 'documento', ps.documento,
    'codRef', ps.cod_ref, 'codRefAdicional', ps.cod_ref_adicional, 'classificacao', ps.classificacao, 'dominios', to_jsonb(ps.dominios),
    'sinalizadores', to_jsonb(ps.sinalizadores), 'observacoes', ps.observacoes, 'avatarPath', ps.avatar_path, 'habilitada', ps.habilitada,
    'origem', ps.origem, 'origemDetalhe', ps.origem_detalhe, 'ultimoContatoEm', ps.ultimo_contato_em, 'criadoEm', ps.criado_em,
    'criadoPor', (select u.nome from imobdesk.usuarios u where u.id = ps.criado_por),
    'contatos', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'tipo', c.tipo, 'valor', c.valor, 'principal', c.principal) order by c.tipo, c.principal desc, c.id)
                          from imobdesk.at_pessoa_contatos c where c.pessoa_id = ps.id), '[]'),
    'relacoes', coalesce((
      select jsonb_agg(jsonb_build_object('pessoaId', o.id, 'nome', o.nome, 'tipo', o.tipo, 'cargo', x.cargo,
                                          'email', (select c.valor from imobdesk.at_pessoa_contatos c where c.pessoa_id = o.id and c.tipo = 'email' order by c.principal desc, c.id limit 1)) order by o.nome)
      from (select r.empresa_id as outro, r.cargo from imobdesk.at_pessoa_relacoes r where r.pessoa_id = ps.id
            union all
            select r.pessoa_id, r.cargo from imobdesk.at_pessoa_relacoes r where r.empresa_id = ps.id) x
      join imobdesk.at_pessoas o on o.id = x.outro), '[]'),
    'anexos', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'nome', a.nome, 'path', a.path, 'mime', a.mime, 'tamanho', a.tamanho,
                                                            'enviadoPor', (select u.nome from imobdesk.usuarios u where u.id = a.enviado_por), 'enviadoEm', a.enviado_em) order by a.enviado_em desc)
                        from imobdesk.at_pessoa_anexos a where a.pessoa_id = ps.id), '[]'),
    'historico', coalesce((
      select jsonb_agg(h order by h ->> 'em' desc) from (
        select jsonb_build_object('canal', 'whatsapp', 'ticket', a.id, 'titulo', coalesce(cv.ultima_previa, 'Conversa no WhatsApp'),
               'setor', s.nome, 'atendente', u.nome, 'pessoa', pp.nome, 'em', a.entrou_fila_em,
               'situacao', case when a.encerrado_em is null then 'andamento' else 'encerrado' end) h
        from imobdesk.at_atendimentos a
        join imobdesk.at_conversas cv on cv.id = a.conversa_id
        join imobdesk.at_setores s on s.id = a.setor_id
        join imobdesk.at_pessoas pp on pp.id = cv.pessoa_id
        left join imobdesk.usuarios u on u.id = a.atendente_id
        where cv.pessoa_id = any (v_grupo)
        union all
        select jsonb_build_object('canal', 'email', 'ticket', null, 'titulo', coalesce(er.assunto, '(sem assunto)'),
               'setor', s.nome, 'atendente', null, 'pessoa', pp.nome, 'em', er.recebido_em,
               'situacao', case er.estado when 'pendente' then 'andamento' when 'ignorado' then 'ignorado' else 'encerrado' end)
        from imobdesk.at_email_recebidos er
        join imobdesk.at_email_contas ec on ec.id = er.conta_id
        join imobdesk.at_setores s on s.id = ec.setor_id
        join imobdesk.at_pessoas pp on pp.id = er.pessoa_id
        where er.pessoa_id = any (v_grupo)
        order by 1 desc
        limit 200
      ) z), '[]')
  );
end;
$$;

-- ---------- Salvar ----------
-- p: {id?, tipo, nome, razaoSocial, ramo, documento, codRef, codRefAdicional, classificacao, dominios[], sinalizadores[],
--     observacoes, avatarPath, habilitada, contatos: [{tipo, valor, principal}], relacoes: [{pessoaId, cargo}]}
-- Relações: se esta ficha é pessoa, os outros são as empresas dela; se é empresa/departamento, os outros são os membros.
create or replace function imobdesk.at_pessoa_salvar(p jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := imobdesk.at_exigir_pessoas();
  v_id bigint := nullif(p ->> 'id', '')::bigint;
  v_tipo text := coalesce(nullif(p ->> 'tipo', ''), 'pessoa');
  v_nome text := btrim(coalesce(p ->> 'nome', ''));
  v_doc text := nullif(regexp_replace(coalesce(p ->> 'documento', ''), '\D', '', 'g'), '');
  v_dominios text[];
  v_antes jsonb;
  c jsonb;
  v_valor text;
  v_dono text;
  r jsonb;
  v_outro bigint;
  v_outro_tipo text;
begin
  if v_tipo not in ('pessoa', 'empresa', 'departamento') then
    perform imobdesk.erro('INVALID_INPUT', 'Tipo inválido.', 'tipo');
  end if;
  if length(v_nome) not between 1 and 160 then
    perform imobdesk.erro('INVALID_INPUT', 'Informe o nome.', 'nome');
  end if;
  if v_doc is not null then
    if v_tipo = 'pessoa' and length(v_doc) <> 11 or v_tipo <> 'pessoa' and length(v_doc) <> 14 then
      perform imobdesk.erro('INVALID_INPUT', case when v_tipo = 'pessoa' then 'CPF precisa ter 11 dígitos.' else 'CNPJ precisa ter 14 dígitos.' end, 'documento');
    end if;
    if not imobdesk.at_documento_valido(v_doc) then
      perform imobdesk.erro('INVALID_INPUT', case when v_tipo = 'pessoa' then 'CPF inválido (dígito verificador não confere).' else 'CNPJ inválido (dígito verificador não confere).' end, 'documento');
    end if;
    select ps.nome into v_dono from imobdesk.at_pessoas ps where ps.documento = v_doc and ps.id is distinct from v_id;
    if v_dono is not null then
      perform imobdesk.erro('DUPLICATE', format('Esse documento já está cadastrado em "%s". Use Mesclar pessoa se for a mesma.', v_dono), 'documento');
    end if;
  end if;
  select coalesce(array_agg(distinct lower(btrim(x, ' @'))) filter (where btrim(x, ' @') <> ''), '{}') into v_dominios
  from jsonb_array_elements_text(coalesce(p -> 'dominios', '[]')) x;
  if v_tipo = 'pessoa' then
    v_dominios := '{}';
  elsif exists (select 1 from unnest(v_dominios) d where imobdesk.at_dominio_publico(d)) then
    perform imobdesk.erro('INVALID_INPUT', 'Domínio público (gmail, hotmail, outlook…) não identifica empresa.', 'dominios');
  end if;
  -- Contatos: válidos e de ninguém mais.
  for c in select * from jsonb_array_elements(coalesce(p -> 'contatos', '[]')) loop
    if c ->> 'tipo' not in ('email', 'telefone', 'whatsapp') then
      perform imobdesk.erro('INVALID_INPUT', 'Tipo de contato inválido.', 'contatos');
    end if;
    v_valor := imobdesk.at_contato_normalizar(c ->> 'tipo', c ->> 'valor');
    if c ->> 'tipo' = 'email' and v_valor !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
      perform imobdesk.erro('INVALID_INPUT', format('E-mail inválido: %s', c ->> 'valor'), 'contatos');
    end if;
    if c ->> 'tipo' <> 'email' and v_valor !~ '^\d{10,15}$' then
      perform imobdesk.erro('INVALID_INPUT', format('Telefone inválido: %s (use DDD + número).', c ->> 'valor'), 'contatos');
    end if;
    select ps.nome into v_dono from imobdesk.at_pessoa_contatos ct join imobdesk.at_pessoas ps on ps.id = ct.pessoa_id
    where ct.tipo = c ->> 'tipo' and ct.valor = v_valor and ct.pessoa_id is distinct from v_id;
    if v_dono is not null then
      perform imobdesk.erro('DUPLICATE', format('O contato %s já pertence a "%s". Use Mesclar pessoa se for a mesma.', c ->> 'valor', v_dono), 'contatos');
    end if;
  end loop;

  begin
    if v_id is null then
      insert into imobdesk.at_pessoas (tipo, nome, criado_por, atualizado_por) values (v_tipo, v_nome, v_ator, v_ator) returning id into v_id;
    else
      select to_jsonb(x) into v_antes from imobdesk.at_pessoas x where x.id = v_id;
      if v_antes is null then
        perform imobdesk.erro('NOT_FOUND', 'Pessoa não encontrada.');
      end if;
    end if;
    update imobdesk.at_pessoas x set
      tipo = v_tipo, nome = v_nome,
      razao_social = case when v_tipo = 'pessoa' then null else nullif(btrim(p ->> 'razaoSocial'), '') end,
      ramo = case when v_tipo = 'pessoa' then null else nullif(btrim(p ->> 'ramo'), '') end,
      documento = v_doc,
      cod_ref = nullif(btrim(p ->> 'codRef'), ''),
      cod_ref_adicional = nullif(btrim(p ->> 'codRefAdicional'), ''),
      classificacao = coalesce(nullif(btrim(p ->> 'classificacao'), ''), 'Cliente'),
      dominios = v_dominios,
      sinalizadores = coalesce((select array_agg(distinct btrim(s)) filter (where btrim(s) <> '') from jsonb_array_elements_text(coalesce(p -> 'sinalizadores', '[]')) s), '{}'),
      observacoes = nullif(p ->> 'observacoes', ''),
      avatar_path = case when p ? 'avatarPath' then nullif(p ->> 'avatarPath', '') else x.avatar_path end,
      habilitada = coalesce((p ->> 'habilitada')::boolean, x.habilitada),
      atualizado_em = now(), atualizado_por = v_ator
    where x.id = v_id;
  exception when check_violation then
    perform imobdesk.erro('INVALID_INPUT', 'Algum campo passou do tamanho permitido.');
  end;

  -- Contatos: troca o conjunto (o primeiro de cada grupo vira principal se nenhum vier marcado).
  delete from imobdesk.at_pessoa_contatos where pessoa_id = v_id;
  insert into imobdesk.at_pessoa_contatos (pessoa_id, tipo, valor, principal)
  select v_id, x.tipo, x.valor, coalesce(x.principal, false)
  from (select distinct on (e ->> 'tipo', imobdesk.at_contato_normalizar(e ->> 'tipo', e ->> 'valor'))
               e ->> 'tipo' as tipo, imobdesk.at_contato_normalizar(e ->> 'tipo', e ->> 'valor') as valor, (e ->> 'principal')::boolean as principal
        from jsonb_array_elements(coalesce(p -> 'contatos', '[]')) e) x;
  update imobdesk.at_pessoa_contatos ct set principal = true
  where ct.pessoa_id = v_id
    and ct.id = (select min(c2.id) from imobdesk.at_pessoa_contatos c2 where c2.pessoa_id = v_id and (c2.tipo = 'email') = (ct.tipo = 'email'))
    and not exists (select 1 from imobdesk.at_pessoa_contatos c3 where c3.pessoa_id = v_id and c3.principal and (c3.tipo = 'email') = (ct.tipo = 'email'));

  -- Relações (do lado desta ficha).
  if p ? 'relacoes' then
    if v_tipo = 'pessoa' then
      delete from imobdesk.at_pessoa_relacoes where pessoa_id = v_id;
    else
      delete from imobdesk.at_pessoa_relacoes where empresa_id = v_id;
    end if;
    for r in select * from jsonb_array_elements(p -> 'relacoes') loop
      v_outro := (r ->> 'pessoaId')::bigint;
      select ps.tipo into v_outro_tipo from imobdesk.at_pessoas ps where ps.id = v_outro;
      if v_outro_tipo is null or v_outro = v_id then
        perform imobdesk.erro('INVALID_INPUT', 'Relação com uma ficha que não existe.', 'relacoes');
      end if;
      if v_tipo = 'pessoa' then
        if v_outro_tipo = 'pessoa' then
          perform imobdesk.erro('INVALID_INPUT', 'Uma pessoa se relaciona com uma empresa ou um departamento.', 'relacoes');
        end if;
        insert into imobdesk.at_pessoa_relacoes (pessoa_id, empresa_id, cargo) values (v_id, v_outro, nullif(btrim(r ->> 'cargo'), ''))
        on conflict (pessoa_id, empresa_id) do update set cargo = excluded.cargo;
      else
        insert into imobdesk.at_pessoa_relacoes (pessoa_id, empresa_id, cargo) values (v_outro, v_id, nullif(btrim(r ->> 'cargo'), ''))
        on conflict (pessoa_id, empresa_id) do update set cargo = excluded.cargo;
      end if;
    end loop;
  end if;

  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', case when v_antes is null then 'create' else 'update' end,
    format('Pessoa "%s" %s', v_nome, case when v_antes is null then 'cadastrada' else 'alterada' end), v_antes,
    (select to_jsonb(x) from imobdesk.at_pessoas x where x.id = v_id), v_id::text);
  return v_id;
end;
$$;

-- ---------- Mesclar (a ficha `p_sai` é incorporada em `p_fica`) ----------
create or replace function imobdesk.at_pessoa_mesclar(p_fica bigint, p_sai bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := imobdesk.at_exigir_pessoas();
  f imobdesk.at_pessoas;
  s imobdesk.at_pessoas;
begin
  if p_fica = p_sai then
    perform imobdesk.erro('INVALID_INPUT', 'Escolha duas fichas diferentes.');
  end if;
  select * into f from imobdesk.at_pessoas where id = p_fica;
  select * into s from imobdesk.at_pessoas where id = p_sai;
  if f.id is null or s.id is null then
    perform imobdesk.erro('NOT_FOUND', 'Pessoa não encontrada.');
  end if;
  -- Contatos que a ficha que fica ainda não tem.
  update imobdesk.at_pessoa_contatos c set pessoa_id = p_fica, principal = false
  where c.pessoa_id = p_sai
    and not exists (select 1 from imobdesk.at_pessoa_contatos x where x.pessoa_id = p_fica and x.tipo = c.tipo and x.valor = c.valor);
  -- Relações (sem duplicar e sem relacionar a ficha com ela mesma).
  insert into imobdesk.at_pessoa_relacoes (pessoa_id, empresa_id, cargo)
  select case when r.pessoa_id = p_sai then p_fica else r.pessoa_id end, case when r.empresa_id = p_sai then p_fica else r.empresa_id end, r.cargo
  from imobdesk.at_pessoa_relacoes r
  where (r.pessoa_id = p_sai or r.empresa_id = p_sai)
    and (case when r.pessoa_id = p_sai then p_fica else r.pessoa_id end) <> (case when r.empresa_id = p_sai then p_fica else r.empresa_id end)
  on conflict do nothing;
  update imobdesk.at_pessoa_anexos set pessoa_id = p_fica where pessoa_id = p_sai;
  update imobdesk.at_conversas set pessoa_id = p_fica where pessoa_id = p_sai;
  update imobdesk.at_email_recebidos set pessoa_id = p_fica where pessoa_id = p_sai;
  update imobdesk.at_pessoas x set
    razao_social = coalesce(x.razao_social, s.razao_social), ramo = coalesce(x.ramo, s.ramo),
    cod_ref = coalesce(x.cod_ref, s.cod_ref), cod_ref_adicional = coalesce(x.cod_ref_adicional, s.cod_ref_adicional),
    dominios = (select coalesce(array_agg(distinct d), '{}') from unnest(x.dominios || s.dominios) d),
    sinalizadores = (select coalesce(array_agg(distinct d), '{}') from unnest(x.sinalizadores || s.sinalizadores) d),
    observacoes = nullif(concat_ws(E'\n\n', x.observacoes, s.observacoes), ''),
    avatar_path = coalesce(x.avatar_path, s.avatar_path),
    ultimo_contato_em = greatest(x.ultimo_contato_em, s.ultimo_contato_em),
    atualizado_em = now(), atualizado_por = v_ator
  where x.id = p_fica;
  -- O documento passa depois de apagar a ficha que sai (é único).
  delete from imobdesk.at_pessoas where id = p_sai;
  if f.documento is null and s.documento is not null then
    update imobdesk.at_pessoas set documento = s.documento where id = p_fica;
  end if;
  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', 'update', format('Pessoa "%s" incorporada em "%s"', s.nome, f.nome),
    to_jsonb(s), jsonb_build_object('fica', p_fica), p_fica::text);
end;
$$;

create or replace function imobdesk.at_pessoa_excluir(p_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := imobdesk.at_exigir_pessoas();
  v_antes jsonb;
  v_paths jsonb;
begin
  select to_jsonb(x) into v_antes from imobdesk.at_pessoas x where x.id = p_id;
  if v_antes is null then
    perform imobdesk.erro('NOT_FOUND', 'Pessoa não encontrada.');
  end if;
  if exists (select 1 from imobdesk.at_conversas c where c.pessoa_id = p_id)
     or exists (select 1 from imobdesk.at_email_recebidos e where e.pessoa_id = p_id) then
    perform imobdesk.erro('INVALID_INPUT', 'Esta pessoa já tem chamados no histórico. Desabilite em vez de excluir.');
  end if;
  -- Devolve os arquivos para a tela apagar do Storage.
  select coalesce(jsonb_agg(a.path), '[]')
         || case when v_antes ->> 'avatar_path' is null then '[]'::jsonb else jsonb_build_array(v_antes ->> 'avatar_path') end
    into v_paths from imobdesk.at_pessoa_anexos a where a.pessoa_id = p_id;
  delete from imobdesk.at_pessoas where id = p_id;
  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', 'delete', format('Pessoa "%s" excluída', v_antes ->> 'nome'), v_antes, null, p_id::text);
  return jsonb_build_object('arquivos', v_paths);
end;
$$;

-- ---------- Anexos ----------
create or replace function imobdesk.at_pessoa_anexo_registrar(p_pessoa bigint, p_nome text, p_path text, p_mime text, p_tamanho bigint)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := imobdesk.at_exigir_pessoas();
  v_id bigint;
begin
  if not exists (select 1 from imobdesk.at_pessoas where id = p_pessoa) then
    perform imobdesk.erro('NOT_FOUND', 'Pessoa não encontrada.');
  end if;
  if p_path !~ ('^pessoas/' || p_pessoa || '/') then
    perform imobdesk.erro('INVALID_INPUT', 'Caminho do anexo inválido.');
  end if;
  insert into imobdesk.at_pessoa_anexos (pessoa_id, nome, path, mime, tamanho, enviado_por)
  values (p_pessoa, left(btrim(p_nome), 200), p_path, p_mime, p_tamanho, v_ator) returning id into v_id;
  return v_id;
end;
$$;

create or replace function imobdesk.at_pessoa_anexo_remover(p_id bigint)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_path text;
begin
  perform imobdesk.at_exigir_pessoas();
  delete from imobdesk.at_pessoa_anexos where id = p_id returning path into v_path;
  if v_path is null then
    perform imobdesk.erro('NOT_FOUND', 'Anexo não encontrado.');
  end if;
  return v_path;
end;
$$;

-- ---------- Autocadastro (só Edge Functions: leitura de e-mail e webhook do WhatsApp) ----------
-- Acha a pessoa pelo contato ou cria. E-mail de domínio de empresa cadastrada já nasce relacionado a ela.
create or replace function imobdesk.at_pessoa_identificar(p_tipo text, p_valor text, p_nome text default null, p_origem_detalhe text default null)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tipo text := case when p_tipo = 'email' then 'email' else 'whatsapp' end;
  v_valor text := imobdesk.at_contato_normalizar(v_tipo, p_valor);
  v_id bigint;
  v_dominio text;
  v_empresa bigint;
begin
  if v_tipo = 'email' and v_valor !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or v_tipo = 'whatsapp' and v_valor !~ '^\d{10,15}$' then
    return null;
  end if;
  -- O mesmo número pode estar cadastrado como "telefone" ou "whatsapp".
  select c.pessoa_id into v_id from imobdesk.at_pessoa_contatos c
  where c.valor = v_valor and (c.tipo = v_tipo or (v_tipo = 'whatsapp' and c.tipo = 'telefone'))
  order by (c.tipo = v_tipo) desc limit 1;
  if v_id is not null then
    update imobdesk.at_pessoas set ultimo_contato_em = now() where id = v_id;
    return v_id;
  end if;
  insert into imobdesk.at_pessoas (tipo, nome, origem, origem_detalhe, ultimo_contato_em)
  values ('pessoa', coalesce(nullif(left(btrim(p_nome), 160), ''), case when v_tipo = 'email' then v_valor else '+' || v_valor end),
          case when v_tipo = 'email' then 'email' else 'whatsapp' end, p_origem_detalhe, now())
  returning id into v_id;
  insert into imobdesk.at_pessoa_contatos (pessoa_id, tipo, valor, principal) values (v_id, v_tipo, v_valor, true);
  if v_tipo = 'email' then
    v_dominio := split_part(v_valor, '@', 2);
    if not imobdesk.at_dominio_publico(v_dominio) then
      select e.id into v_empresa from imobdesk.at_pessoas e
      where e.tipo <> 'pessoa' and e.habilitada and v_dominio = any (e.dominios) order by e.id limit 1;
      if v_empresa is not null then
        insert into imobdesk.at_pessoa_relacoes (pessoa_id, empresa_id) values (v_id, v_empresa) on conflict do nothing;
      end if;
    end if;
  end if;
  return v_id;
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'imobdesk.at_exigir_pessoas()', 'imobdesk.at_pessoas_lista(jsonb)', 'imobdesk.at_pessoas_busca(text, text[])',
    'imobdesk.at_pessoa_detalhe(bigint)', 'imobdesk.at_pessoa_salvar(jsonb)', 'imobdesk.at_pessoa_mesclar(bigint, bigint)',
    'imobdesk.at_pessoa_excluir(bigint)', 'imobdesk.at_pessoa_anexo_registrar(bigint, text, text, text, bigint)',
    'imobdesk.at_pessoa_anexo_remover(bigint)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
  revoke execute on function imobdesk.at_pessoa_identificar(text, text, text, text) from public, anon, authenticated;
  grant execute on function imobdesk.at_pessoa_identificar(text, text, text, text) to service_role;
  revoke execute on function imobdesk.at_documento_valido(text), imobdesk.at_contato_normalizar(text, text),
    imobdesk.at_dominio_publico(text) from public, anon;
  grant execute on function imobdesk.at_documento_valido(text), imobdesk.at_contato_normalizar(text, text),
    imobdesk.at_dominio_publico(text) to authenticated, service_role;
end;
$$;

do $$
begin
  if to_regclass('acessos.aplicativos') is not null then
    if exists (select 1 from acessos.aplicativos a where a.schema_name = 'imobdesk' and a.controle_ativo) then
      perform acessos.aplicar_protecao('imobdesk', true);
    end if;
  end if;
end;
$$;

notify pgrst, 'reload schema';

-- ======================================== 20261006190200_imobdesk_equipes_setores.sql
-- Equipes: lista de setores para o seletor da equipe. Quem gerencia usuários pode não ter setor no atendimento
-- (at_contexto só devolve os setores do usuário). Só aditiva.

create or replace function imobdesk.at_equipes_setores()
returns table (id bigint, nome text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform imobdesk.at_exigir_equipes();
  return query select s.id, s.nome from imobdesk.at_setores s where s.ativo order by s.nome;
end;
$$;

revoke execute on function imobdesk.at_equipes_setores() from public, anon;
grant execute on function imobdesk.at_equipes_setores() to authenticated, service_role;

notify pgrst, 'reload schema';

-- ======================================== 20261006200000_imobdesk_google_escopos.sql
-- Contas de e-mail · Google Workspace: escopos configuráveis e Client ID guardado (06/10/2026).
-- Se a empresa já usa a Delegação em todo o domínio (Admin › Segurança › Controles de API › Clientes da API) com o
-- escopo https://mail.google.com/. Na delegação, o Google só emite o token se os escopos pedidos estiverem
-- exatamente na lista do cliente; por isso o portal pede os mesmos escopos cadastrados lá. Só aditiva.

alter table imobdesk.at_config add column if not exists google_sa_client_id text;
alter table imobdesk.at_config add column if not exists google_escopos text[] not null default '{https://mail.google.com/}';

-- Reescreve a função (mesma assinatura) para guardar também o client_id, que a TI informa em "Adicionar novo".
create or replace function imobdesk.at_google_sa_salvar(p_json text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := auth.uid();
  j jsonb;
  v_id uuid;
begin
  if v_ator is null or not imobdesk.eh_super_admin() then
    perform imobdesk.erro('FORBIDDEN', 'Só o super admin configura o Google Workspace.');
  end if;
  begin
    j := p_json::jsonb;
  exception when others then
    perform imobdesk.erro('INVALID_INPUT', 'Arquivo inválido: envie o JSON da chave da conta de serviço do Google Cloud.', 'chave');
  end;
  if j ->> 'type' is distinct from 'service_account' or coalesce(j ->> 'client_email', '') = '' or coalesce(j ->> 'private_key', '') not like '-----BEGIN PRIVATE KEY-----%' then
    perform imobdesk.erro('INVALID_INPUT', 'O JSON precisa ser de uma conta de serviço (type, client_email e private_key).', 'chave');
  end if;
  v_id := coalesce((select c.google_sa_segredo_id from imobdesk.at_config c where c.id),
                   (select s.id from vault.secrets s where s.name = ('imobdesk_google_sa_' || imobdesk.empresa_atual())));
  if v_id is null then
    v_id := vault.create_secret(p_json, ('imobdesk_google_sa_' || imobdesk.empresa_atual()), 'Chave da conta de serviço do Google Workspace (Imobdesk)');
  else
    perform vault.update_secret(v_id, p_json);
  end if;
  update imobdesk.at_config set google_sa_segredo_id = v_id, google_sa_email = j ->> 'client_email', google_sa_client_id = j ->> 'client_id',
    google_sa_definido_em = now(), google_verificacao = null, atualizado_em = now(), atualizado_por = v_ator where id;
  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', 'secret', 'Chave da conta de serviço do Google Workspace substituída',
    null, jsonb_build_object('client_email', j ->> 'client_email', 'client_id', j ->> 'client_id'), 'at_config');
end;
$$;

-- Escopos que o portal pede ao Google (precisam ser os mesmos autorizados em "Clientes da API").
create or replace function imobdesk.at_google_escopos_salvar(p_escopos text[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := auth.uid();
  v_permitidos text[] := array['https://mail.google.com/', 'https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/gmail.send',
                               'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.labels'];
  v_antes text[];
begin
  if v_ator is null or not imobdesk.eh_super_admin() then
    perform imobdesk.erro('FORBIDDEN', 'Só o super admin configura o Google Workspace.');
  end if;
  if coalesce(cardinality(p_escopos), 0) = 0 or exists (select 1 from unnest(p_escopos) e where not (e = any (v_permitidos))) then
    perform imobdesk.erro('INVALID_INPUT', 'Escopo não suportado pelo portal.', 'escopos');
  end if;
  select c.google_escopos into v_antes from imobdesk.at_config c where c.id;
  update imobdesk.at_config set google_escopos = (select array_agg(distinct e order by e) from unnest(p_escopos) e),
    google_verificacao = null, atualizado_em = now(), atualizado_por = v_ator where id;
  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', 'config', 'Escopos do Google Workspace alterados',
    jsonb_build_object('escopos', to_jsonb(v_antes)), jsonb_build_object('escopos', to_jsonb(p_escopos)), 'at_config');
end;
$$;

revoke execute on function imobdesk.at_google_escopos_salvar(text[]) from public, anon;
grant execute on function imobdesk.at_google_escopos_salvar(text[]) to authenticated, service_role;

notify pgrst, 'reload schema';

-- ======================================== 20261006210000_imobdesk_email_oauth.sql
-- Contas de e-mail · "Autorizar com Gmail" por conta (OAuth2), como a Movidesk (pedido do Wagner, 06/10/2026).
-- Alguém entra no Google com a própria caixa e autoriza; o portal guarda o refresh token da caixa no Vault.
-- Não precisa de conta de serviço nem de delegação no domínio (que continuam como alternativa).
-- A TI cria uma vez o "ID do cliente OAuth" (Aplicativo da Web, tela de consentimento Interna) no Google Cloud.
-- Traz também os campos da tela de recebimento da Movidesk: habilitar recebimento, apagar processadas depois de
-- N dias, regra de abertura de novos tickets. Só aditiva (o check de `modo` só ganha um valor).

-- ---------- Conta: modo OAuth e campos de recebimento ----------
alter table imobdesk.at_email_contas drop constraint if exists at_email_contas_modo_check;
alter table imobdesk.at_email_contas add constraint at_email_contas_modo_check check (modo in ('oauth_google', 'api_google', 'imap_smtp'));

alter table imobdesk.at_email_contas add column if not exists receber_habilitado boolean not null default true;
alter table imobdesk.at_email_contas add column if not exists apagar_apos_dias int check (apagar_apos_dias between 1 and 3650);
alter table imobdesk.at_email_contas add column if not exists abrir_tickets text not null default 'qualquer'
  check (abrir_tickets in ('qualquer', 'cliente', 'cliente_ou_dominio', 'nao'));
alter table imobdesk.at_email_contas add column if not exists oauth_segredo_id uuid;
alter table imobdesk.at_email_contas add column if not exists oauth_email text;
alter table imobdesk.at_email_contas add column if not exists oauth_autorizado_em timestamptz;
alter table imobdesk.at_email_contas add column if not exists oauth_autorizado_por uuid references imobdesk.usuarios (id) on delete set null;

-- ---------- Aplicativo OAuth do portal (um para o domínio) ----------
alter table imobdesk.at_config add column if not exists google_oauth_client_id text;
alter table imobdesk.at_config add column if not exists google_oauth_segredo_id uuid;
alter table imobdesk.at_config add column if not exists google_oauth_definido_em timestamptz;

-- ---------- "state" do login no Google (uso único, 10 min) ----------
create table if not exists imobdesk.at_email_oauth_estados (
  state       text        primary key,
  conta_id    bigint      not null references imobdesk.at_email_contas (id) on delete cascade,
  usuario_id  uuid        not null,
  retorno     text        not null,                      -- origem do portal para onde o Google volta
  criado_em   timestamptz not null default now(),
  expira_em   timestamptz not null default now() + interval '10 minutes'
);
alter table imobdesk.at_email_oauth_estados enable row level security;
revoke all on imobdesk.at_email_oauth_estados from anon, public, authenticated;
grant all on imobdesk.at_email_oauth_estados to service_role;

-- ---------- Lista (com os campos novos) ----------
create or replace function imobdesk.at_email_contas_lista()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id, 'nome', c.nome, 'email', c.email, 'setorId', c.setor_id, 'setorNome', s.nome,
    'nomeRemetente', c.nome_remetente, 'exibirNoEnvio', c.exibir_no_envio, 'padraoDoSetor', c.padrao_do_setor,
    'usarLogo', c.usar_logo, 'logoPath', c.logo_path, 'habilitada', c.habilitada,
    'provedor', c.provedor, 'modo', c.modo,
    'imapHost', c.imap_host, 'imapPorta', c.imap_porta, 'imapSeguranca', c.imap_seguranca,
    'smtpHost', c.smtp_host, 'smtpPorta', c.smtp_porta, 'usuario', c.usuario,
    'senhaMascara', c.senha_mascara,
    'pasta', c.pasta, 'intervaloMin', c.intervalo_min, 'lerDesde', c.ler_desde,
    'marcarLido', c.marcar_lido, 'moverPara', c.mover_para, 'juntarRespostas', c.juntar_respostas,
    'ignorarRemetentes', to_jsonb(c.ignorar_remetentes),
    'responderPara', c.responder_para, 'copiaOculta', c.copia_oculta, 'assinatura', c.assinatura,
    'receberHabilitado', c.receber_habilitado, 'apagarAposDias', c.apagar_apos_dias, 'abrirTickets', c.abrir_tickets,
    'oauthEmail', c.oauth_email, 'oauthAutorizadoEm', c.oauth_autorizado_em,
    'oauthAutorizadoPor', (select u.nome from imobdesk.usuarios u where u.id = c.oauth_autorizado_por),
    'status', c.status, 'ultimoErro', c.ultimo_erro, 'ultimaLeituraEm', c.ultima_leitura_em, 'verificacao', c.verificacao,
    'naFila', (select count(*) from imobdesk.at_email_recebidos r where r.conta_id = c.id and r.estado = 'pendente')
  ) order by c.email), '[]')
  from imobdesk.at_email_contas c
  join imobdesk.at_setores s on s.id = c.setor_id
  where imobdesk.at_supervisor() or imobdesk.at_gestor_de(c.setor_id);
$$;

-- ---------- Salvar (mesma assinatura; aceita o modo OAuth e os campos novos) ----------
create or replace function imobdesk.at_email_conta_salvar(p jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := auth.uid();
  v_id bigint := nullif(p ->> 'id', '')::bigint;
  v_email text := lower(btrim(coalesce(p ->> 'email', '')));
  v_setor bigint := nullif(p ->> 'setorId', '')::bigint;
  v_modo text := coalesce(p ->> 'modo', 'oauth_google');
  v_antes jsonb;
  v_ignorar text[];
begin
  if v_ator is null or not imobdesk.at_supervisor() then
    perform imobdesk.erro('FORBIDDEN', 'Só a supervisão geral cadastra contas de e-mail.');
  end if;
  if length(btrim(coalesce(p ->> 'nome', ''))) not between 2 and 80 then
    perform imobdesk.erro('INVALID_INPUT', 'Informe o nome da conta (2 a 80 letras).', 'nome');
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    perform imobdesk.erro('INVALID_INPUT', 'Endereço de e-mail inválido.', 'email');
  end if;
  if exists (select 1 from imobdesk.at_email_contas c where c.email = v_email and c.id is distinct from v_id) then
    perform imobdesk.erro('DUPLICATE', 'Já existe uma conta com esse endereço.', 'email');
  end if;
  if v_setor is null or not exists (select 1 from imobdesk.at_setores s where s.id = v_setor) then
    perform imobdesk.erro('INVALID_INPUT', 'Escolha o setor que recebe os chamados desta conta.', 'setorId');
  end if;
  if v_modo not in ('oauth_google', 'api_google', 'imap_smtp') then
    perform imobdesk.erro('INVALID_INPUT', 'Modo de acesso inválido.', 'modo');
  end if;
  if v_modo in ('oauth_google', 'api_google') and coalesce(p ->> 'provedor', 'google') <> 'google' then
    perform imobdesk.erro('INVALID_INPUT', 'A autorização pelo Google só existe para contas do Google Workspace / Gmail.', 'modo');
  end if;
  if v_modo = 'imap_smtp' and (nullif(btrim(p ->> 'imapHost'), '') is null or nullif(btrim(p ->> 'smtpHost'), '') is null) then
    perform imobdesk.erro('INVALID_INPUT', 'Informe os servidores de entrada (IMAP) e de saída (SMTP).', 'imapHost');
  end if;
  if (p ->> 'smtpPorta')::int in (25, 587) then
    perform imobdesk.erro('INVALID_INPUT', 'Use a porta 465 (SSL): o servidor do portal bloqueia as portas 25 e 587.', 'smtpPorta');
  end if;
  if (p ->> 'apagarAposDias') is not null and (p ->> 'apagarAposDias')::int not between 1 and 3650 then
    perform imobdesk.erro('INVALID_INPUT', 'Informe de 1 a 3650 dias para apagar as mensagens processadas.', 'apagarAposDias');
  end if;
  select coalesce(array_agg(lower(btrim(x))) filter (where btrim(x) <> ''), '{}') into v_ignorar
  from jsonb_array_elements_text(coalesce(p -> 'ignorarRemetentes', '[]')) x;

  if (p ->> 'padraoDoSetor')::boolean then
    update imobdesk.at_email_contas set padrao_do_setor = false
    where setor_id = v_setor and padrao_do_setor and id is distinct from v_id;
  end if;

  begin
    if v_id is null then
      insert into imobdesk.at_email_contas (nome, email, setor_id, modo, atualizado_por) values (btrim(p ->> 'nome'), v_email, v_setor, v_modo, v_ator)
      returning id into v_id;
    else
      select to_jsonb(c) - 'senha_segredo_id' - 'oauth_segredo_id' - 'cursor' into v_antes from imobdesk.at_email_contas c where c.id = v_id;
      if v_antes is null then
        perform imobdesk.erro('NOT_FOUND', 'Conta não encontrada.');
      end if;
      -- Trocou o endereço: o token do Google era da caixa antiga e sai do Vault.
      if v_antes ->> 'email' is distinct from v_email then
        delete from vault.secrets where id = (select c.oauth_segredo_id from imobdesk.at_email_contas c where c.id = v_id);
      end if;
    end if;
    update imobdesk.at_email_contas c set
      nome = btrim(p ->> 'nome'),
      email = v_email,
      setor_id = v_setor,
      nome_remetente = nullif(btrim(p ->> 'nomeRemetente'), ''),
      exibir_no_envio = coalesce((p ->> 'exibirNoEnvio')::boolean, c.exibir_no_envio),
      padrao_do_setor = coalesce((p ->> 'padraoDoSetor')::boolean, c.padrao_do_setor),
      usar_logo = coalesce((p ->> 'usarLogo')::boolean, c.usar_logo),
      habilitada = coalesce((p ->> 'habilitada')::boolean, c.habilitada),
      provedor = coalesce(p ->> 'provedor', c.provedor),
      modo = v_modo,
      imap_host = nullif(btrim(p ->> 'imapHost'), ''),
      imap_porta = coalesce((p ->> 'imapPorta')::int, c.imap_porta),
      imap_seguranca = coalesce(p ->> 'imapSeguranca', c.imap_seguranca),
      smtp_host = nullif(btrim(p ->> 'smtpHost'), ''),
      smtp_porta = coalesce((p ->> 'smtpPorta')::int, c.smtp_porta),
      usuario = nullif(btrim(p ->> 'usuario'), ''),
      pasta = coalesce(nullif(btrim(p ->> 'pasta'), ''), 'INBOX'),
      intervalo_min = coalesce((p ->> 'intervaloMin')::int, c.intervalo_min),
      ler_desde = coalesce((p ->> 'lerDesde')::date, c.ler_desde),
      marcar_lido = coalesce((p ->> 'marcarLido')::boolean, c.marcar_lido),
      mover_para = nullif(btrim(p ->> 'moverPara'), ''),
      juntar_respostas = coalesce((p ->> 'juntarRespostas')::boolean, c.juntar_respostas),
      ignorar_remetentes = v_ignorar,
      responder_para = nullif(lower(btrim(p ->> 'responderPara')), ''),
      copia_oculta = nullif(lower(btrim(p ->> 'copiaOculta')), ''),
      assinatura = nullif(p ->> 'assinatura', ''),
      receber_habilitado = coalesce((p ->> 'receberHabilitado')::boolean, c.receber_habilitado),
      apagar_apos_dias = case when p ? 'apagarAposDias' then (p ->> 'apagarAposDias')::int else c.apagar_apos_dias end,
      abrir_tickets = coalesce(nullif(p ->> 'abrirTickets', ''), c.abrir_tickets),
      -- Trocou o endereço: a autorização do Google era de outra caixa.
      oauth_segredo_id = case when v_antes is not null and v_antes ->> 'email' is distinct from v_email then null else c.oauth_segredo_id end,
      oauth_email = case when v_antes is not null and v_antes ->> 'email' is distinct from v_email then null else c.oauth_email end,
      status = case when v_antes is null or v_antes ->> 'modo' is distinct from v_modo
                         or v_antes ->> 'imap_host' is distinct from nullif(btrim(p ->> 'imapHost'), '')
                         or v_antes ->> 'email' is distinct from v_email then 'aguardando' else c.status end,
      atualizado_em = now(),
      atualizado_por = v_ator
    where c.id = v_id;
  exception when check_violation then
    perform imobdesk.erro('INVALID_INPUT', 'Algum valor está fora do permitido (porta, intervalo, provedor, regra de abertura ou tamanho do texto).');
  end;

  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', case when v_antes is null then 'create' else 'update' end,
    format('Conta de e-mail %s %s', v_email, case when v_antes is null then 'criada' else 'alterada' end),
    v_antes, (select to_jsonb(c) - 'senha_segredo_id' - 'oauth_segredo_id' - 'cursor' from imobdesk.at_email_contas c where c.id = v_id), v_id::text);
  return v_id;
end;
$$;

-- ---------- Excluir (apaga também o token OAuth do Vault) ----------
create or replace function imobdesk.at_email_conta_excluir(p_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := auth.uid();
  c imobdesk.at_email_contas;
begin
  if v_ator is null or not imobdesk.at_supervisor() then
    perform imobdesk.erro('FORBIDDEN', 'Só a supervisão geral exclui contas de e-mail.');
  end if;
  select * into c from imobdesk.at_email_contas where id = p_id;
  if c.id is null then
    perform imobdesk.erro('NOT_FOUND', 'Conta não encontrada.');
  end if;
  if exists (select 1 from imobdesk.at_email_recebidos r where r.conta_id = p_id)
     or exists (select 1 from imobdesk.at_email_saida s where s.conta_id = p_id) then
    perform imobdesk.erro('INVALID_INPUT', 'Esta conta já tem e-mails no histórico. Desabilite em vez de excluir.');
  end if;
  delete from imobdesk.at_email_contas where id = p_id;
  delete from vault.secrets where id in (c.senha_segredo_id, c.oauth_segredo_id);
  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', 'delete', format('Conta de e-mail %s excluída', c.email),
    to_jsonb(c) - 'senha_segredo_id' - 'oauth_segredo_id' - 'cursor', null, p_id::text);
end;
$$;

-- ---------- Aplicativo OAuth (Integrações › Google Workspace, só super admin) ----------
create or replace function imobdesk.at_google_oauth_salvar(p_client_id text, p_client_secret text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := auth.uid();
  v_cid text := btrim(coalesce(p_client_id, ''));
  v_sec text := btrim(coalesce(p_client_secret, ''));
  v_id uuid;
begin
  if v_ator is null or not imobdesk.eh_super_admin() then
    perform imobdesk.erro('FORBIDDEN', 'Só o super admin configura o Google Workspace.');
  end if;
  if v_cid !~ '^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$' then
    perform imobdesk.erro('INVALID_INPUT', 'ID do cliente inválido: termina em .apps.googleusercontent.com.', 'clientId');
  end if;
  if v_sec <> '' then
    if length(v_sec) < 10 then
      perform imobdesk.erro('INVALID_INPUT', 'Chave secreta do cliente inválida.', 'clientSecret');
    end if;
    v_id := coalesce((select c.google_oauth_segredo_id from imobdesk.at_config c where c.id),
                     (select s.id from vault.secrets s where s.name = ('imobdesk_google_oauth_' || imobdesk.empresa_atual())));
    if v_id is null then
      v_id := vault.create_secret(v_sec, ('imobdesk_google_oauth_' || imobdesk.empresa_atual()), 'Chave secreta do cliente OAuth do Google (Imobdesk)');
    else
      perform vault.update_secret(v_id, v_sec);
    end if;
  elsif not exists (select 1 from imobdesk.at_config c where c.id and c.google_oauth_segredo_id is not null) then
    perform imobdesk.erro('INVALID_INPUT', 'Informe a chave secreta do cliente.', 'clientSecret');
  end if;
  update imobdesk.at_config set google_oauth_client_id = v_cid, google_oauth_segredo_id = coalesce(v_id, google_oauth_segredo_id),
    google_oauth_definido_em = now(), atualizado_em = now(), atualizado_por = v_ator where id;
  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', 'secret', 'Cliente OAuth do Google configurado', null,
    jsonb_build_object('client_id', v_cid, 'segredo_trocado', v_sec <> ''), 'at_config');
end;
$$;

-- ---------- Só para as Edge Functions (service_role) ----------
create or replace function imobdesk.at_google_oauth_ler()
returns table (client_id text, client_secret text)
language sql
stable
security definer
set search_path = ''
as $$
  select c.google_oauth_client_id, (select d.decrypted_secret from vault.decrypted_secrets d where d.id = c.google_oauth_segredo_id)
  from imobdesk.at_config c where c.id;
$$;

create or replace function imobdesk.at_email_oauth_estado_criar(p_conta bigint, p_usuario uuid, p_retorno text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  if p_retorno !~ '^https://[a-z0-9.-]+(:\d+)?$' and p_retorno !~ '^http://(localhost|127\.0\.0\.1)(:\d+)?$' then
    perform imobdesk.erro('INVALID_INPUT', 'Endereço de retorno inválido.');
  end if;
  delete from imobdesk.at_email_oauth_estados where expira_em < now();
  insert into imobdesk.at_email_oauth_estados (state, conta_id, usuario_id, retorno) values (v_state, p_conta, p_usuario, p_retorno);
  return v_state;
end;
$$;

-- Uso único: devolve e apaga.
create or replace function imobdesk.at_email_oauth_estado_consumir(p_state text)
returns table (conta_id bigint, usuario_id uuid, retorno text, email text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
    with apagado as (
      delete from imobdesk.at_email_oauth_estados e where e.state = p_state and e.expira_em >= now()
      returning e.conta_id, e.usuario_id, e.retorno
    )
    select a.conta_id, a.usuario_id, a.retorno, c.email from apagado a join imobdesk.at_email_contas c on c.id = a.conta_id;
end;
$$;

create or replace function imobdesk.at_email_oauth_gravar(p_conta bigint, p_refresh text, p_email text, p_usuario uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_seg uuid;
  v_email text;
begin
  select c.oauth_segredo_id, c.email into v_seg, v_email from imobdesk.at_email_contas c where c.id = p_conta;
  if v_email is null then
    perform imobdesk.erro('NOT_FOUND', 'Conta não encontrada.');
  end if;
  if v_seg is null then
    v_seg := vault.create_secret(p_refresh, 'imobdesk_email_oauth_' || p_conta, 'Token OAuth do Google da conta ' || v_email || ' (Imobdesk)');
  else
    perform vault.update_secret(v_seg, p_refresh);
  end if;
  update imobdesk.at_email_contas set oauth_segredo_id = v_seg, oauth_email = lower(p_email), oauth_autorizado_em = now(),
    oauth_autorizado_por = p_usuario, modo = 'oauth_google', status = 'aguardando', ultimo_erro = null, atualizado_em = now()
  where id = p_conta;
  perform imobdesk.registrar_auditoria(p_usuario, 'atendimento', 'secret', format('Conta de e-mail %s autorizada no Google', v_email), null,
    jsonb_build_object('autorizado_como', lower(p_email)), p_conta::text);
end;
$$;

create or replace function imobdesk.at_email_oauth_token(p_conta bigint)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select d.decrypted_secret from vault.decrypted_secrets d join imobdesk.at_email_contas c on c.oauth_segredo_id = d.id where c.id = p_conta;
$$;

do $$
declare
  f text;
begin
  revoke execute on function imobdesk.at_google_oauth_salvar(text, text) from public, anon;
  grant execute on function imobdesk.at_google_oauth_salvar(text, text) to authenticated, service_role;
  foreach f in array array[
    'imobdesk.at_google_oauth_ler()', 'imobdesk.at_email_oauth_estado_criar(bigint, uuid, text)',
    'imobdesk.at_email_oauth_estado_consumir(text)', 'imobdesk.at_email_oauth_gravar(bigint, text, text, uuid)',
    'imobdesk.at_email_oauth_token(bigint)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;

notify pgrst, 'reload schema';

-- ======================================== 20261006220000_imobdesk_email_sem_setor.sql
-- Central Email: a conta de e-mail existe sem setor (pedido do Wagner, 06/10/2026).
-- Basta a autorização do Google; o vínculo com a equipe/setor vem depois. Migração aditiva: só relaxa o NOT NULL
-- e troca as funções (mesma assinatura). Nada é apagado.

alter table imobdesk.at_email_contas alter column setor_id drop not null;

create or replace function imobdesk.at_email_contas_lista()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id, 'nome', c.nome, 'email', c.email, 'setorId', c.setor_id, 'setorNome', s.nome,
    'nomeRemetente', c.nome_remetente, 'exibirNoEnvio', c.exibir_no_envio, 'padraoDoSetor', c.padrao_do_setor,
    'usarLogo', c.usar_logo, 'logoPath', c.logo_path, 'habilitada', c.habilitada,
    'provedor', c.provedor, 'modo', c.modo,
    'imapHost', c.imap_host, 'imapPorta', c.imap_porta, 'imapSeguranca', c.imap_seguranca,
    'smtpHost', c.smtp_host, 'smtpPorta', c.smtp_porta, 'usuario', c.usuario,
    'senhaMascara', c.senha_mascara,
    'pasta', c.pasta, 'intervaloMin', c.intervalo_min, 'lerDesde', c.ler_desde,
    'marcarLido', c.marcar_lido, 'moverPara', c.mover_para, 'juntarRespostas', c.juntar_respostas,
    'ignorarRemetentes', to_jsonb(c.ignorar_remetentes),
    'responderPara', c.responder_para, 'copiaOculta', c.copia_oculta, 'assinatura', c.assinatura,
    'receberHabilitado', c.receber_habilitado, 'apagarAposDias', c.apagar_apos_dias, 'abrirTickets', c.abrir_tickets,
    'oauthEmail', c.oauth_email, 'oauthAutorizadoEm', c.oauth_autorizado_em,
    'oauthAutorizadoPor', (select u.nome from imobdesk.usuarios u where u.id = c.oauth_autorizado_por),
    'status', c.status, 'ultimoErro', c.ultimo_erro, 'ultimaLeituraEm', c.ultima_leitura_em, 'verificacao', c.verificacao,
    'naFila', (select count(*) from imobdesk.at_email_recebidos r where r.conta_id = c.id and r.estado = 'pendente')
  ) order by c.email), '[]')
  from imobdesk.at_email_contas c
  left join imobdesk.at_setores s on s.id = c.setor_id
  where imobdesk.at_supervisor() or (c.setor_id is not null and imobdesk.at_gestor_de(c.setor_id));
$$;

create or replace function imobdesk.at_email_conta_salvar(p jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := auth.uid();
  v_id bigint := nullif(p ->> 'id', '')::bigint;
  v_email text := lower(btrim(coalesce(p ->> 'email', '')));
  v_setor bigint := nullif(p ->> 'setorId', '')::bigint;
  v_modo text := coalesce(p ->> 'modo', 'oauth_google');
  v_antes jsonb;
  v_ignorar text[];
begin
  if v_ator is null or not imobdesk.at_supervisor() then
    perform imobdesk.erro('FORBIDDEN', 'Só a supervisão geral cadastra contas de e-mail.');
  end if;
  if length(btrim(coalesce(p ->> 'nome', ''))) not between 2 and 80 then
    perform imobdesk.erro('INVALID_INPUT', 'Informe o nome da conta (2 a 80 letras).', 'nome');
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    perform imobdesk.erro('INVALID_INPUT', 'Endereço de e-mail inválido.', 'email');
  end if;
  if exists (select 1 from imobdesk.at_email_contas c where c.email = v_email and c.id is distinct from v_id) then
    perform imobdesk.erro('DUPLICATE', 'Já existe uma conta com esse endereço.', 'email');
  end if;
  -- Setor é opcional: a conta existe só com a autorização do Google; o vínculo com a equipe/setor vem depois.
  if v_setor is not null and not exists (select 1 from imobdesk.at_setores s where s.id = v_setor) then
    perform imobdesk.erro('INVALID_INPUT', 'Setor não encontrado.', 'setorId');
  end if;
  if v_modo not in ('oauth_google', 'api_google', 'imap_smtp') then
    perform imobdesk.erro('INVALID_INPUT', 'Modo de acesso inválido.', 'modo');
  end if;
  if v_modo in ('oauth_google', 'api_google') and coalesce(p ->> 'provedor', 'google') <> 'google' then
    perform imobdesk.erro('INVALID_INPUT', 'A autorização pelo Google só existe para contas do Google Workspace / Gmail.', 'modo');
  end if;
  if v_modo = 'imap_smtp' and (nullif(btrim(p ->> 'imapHost'), '') is null or nullif(btrim(p ->> 'smtpHost'), '') is null) then
    perform imobdesk.erro('INVALID_INPUT', 'Informe os servidores de entrada (IMAP) e de saída (SMTP).', 'imapHost');
  end if;
  if (p ->> 'smtpPorta')::int in (25, 587) then
    perform imobdesk.erro('INVALID_INPUT', 'Use a porta 465 (SSL): o servidor do portal bloqueia as portas 25 e 587.', 'smtpPorta');
  end if;
  if (p ->> 'apagarAposDias') is not null and (p ->> 'apagarAposDias')::int not between 1 and 3650 then
    perform imobdesk.erro('INVALID_INPUT', 'Informe de 1 a 3650 dias para apagar as mensagens processadas.', 'apagarAposDias');
  end if;
  select coalesce(array_agg(lower(btrim(x))) filter (where btrim(x) <> ''), '{}') into v_ignorar
  from jsonb_array_elements_text(coalesce(p -> 'ignorarRemetentes', '[]')) x;

  if v_setor is not null and (p ->> 'padraoDoSetor')::boolean then
    update imobdesk.at_email_contas set padrao_do_setor = false
    where setor_id = v_setor and padrao_do_setor and id is distinct from v_id;
  end if;

  begin
    if v_id is null then
      insert into imobdesk.at_email_contas (nome, email, setor_id, modo, atualizado_por) values (btrim(p ->> 'nome'), v_email, v_setor, v_modo, v_ator)
      returning id into v_id;
    else
      select to_jsonb(c) - 'senha_segredo_id' - 'oauth_segredo_id' - 'cursor' into v_antes from imobdesk.at_email_contas c where c.id = v_id;
      if v_antes is null then
        perform imobdesk.erro('NOT_FOUND', 'Conta não encontrada.');
      end if;
      -- Trocou o endereço: o token do Google era da caixa antiga e sai do Vault.
      if v_antes ->> 'email' is distinct from v_email then
        delete from vault.secrets where id = (select c.oauth_segredo_id from imobdesk.at_email_contas c where c.id = v_id);
      end if;
    end if;
    update imobdesk.at_email_contas c set
      nome = btrim(p ->> 'nome'),
      email = v_email,
      setor_id = v_setor,
      nome_remetente = nullif(btrim(p ->> 'nomeRemetente'), ''),
      exibir_no_envio = coalesce((p ->> 'exibirNoEnvio')::boolean, c.exibir_no_envio),
      padrao_do_setor = v_setor is not null and coalesce((p ->> 'padraoDoSetor')::boolean, c.padrao_do_setor),
      usar_logo = coalesce((p ->> 'usarLogo')::boolean, c.usar_logo),
      habilitada = coalesce((p ->> 'habilitada')::boolean, c.habilitada),
      provedor = coalesce(p ->> 'provedor', c.provedor),
      modo = v_modo,
      imap_host = nullif(btrim(p ->> 'imapHost'), ''),
      imap_porta = coalesce((p ->> 'imapPorta')::int, c.imap_porta),
      imap_seguranca = coalesce(p ->> 'imapSeguranca', c.imap_seguranca),
      smtp_host = nullif(btrim(p ->> 'smtpHost'), ''),
      smtp_porta = coalesce((p ->> 'smtpPorta')::int, c.smtp_porta),
      usuario = nullif(btrim(p ->> 'usuario'), ''),
      pasta = coalesce(nullif(btrim(p ->> 'pasta'), ''), 'INBOX'),
      intervalo_min = coalesce((p ->> 'intervaloMin')::int, c.intervalo_min),
      ler_desde = coalesce((p ->> 'lerDesde')::date, c.ler_desde),
      marcar_lido = coalesce((p ->> 'marcarLido')::boolean, c.marcar_lido),
      mover_para = nullif(btrim(p ->> 'moverPara'), ''),
      juntar_respostas = coalesce((p ->> 'juntarRespostas')::boolean, c.juntar_respostas),
      ignorar_remetentes = v_ignorar,
      responder_para = nullif(lower(btrim(p ->> 'responderPara')), ''),
      copia_oculta = nullif(lower(btrim(p ->> 'copiaOculta')), ''),
      assinatura = nullif(p ->> 'assinatura', ''),
      receber_habilitado = coalesce((p ->> 'receberHabilitado')::boolean, c.receber_habilitado),
      apagar_apos_dias = case when p ? 'apagarAposDias' then (p ->> 'apagarAposDias')::int else c.apagar_apos_dias end,
      abrir_tickets = coalesce(nullif(p ->> 'abrirTickets', ''), c.abrir_tickets),
      -- Trocou o endereço: a autorização do Google era de outra caixa.
      oauth_segredo_id = case when v_antes is not null and v_antes ->> 'email' is distinct from v_email then null else c.oauth_segredo_id end,
      oauth_email = case when v_antes is not null and v_antes ->> 'email' is distinct from v_email then null else c.oauth_email end,
      status = case when v_antes is null or v_antes ->> 'modo' is distinct from v_modo
                         or v_antes ->> 'imap_host' is distinct from nullif(btrim(p ->> 'imapHost'), '')
                         or v_antes ->> 'email' is distinct from v_email then 'aguardando' else c.status end,
      atualizado_em = now(),
      atualizado_por = v_ator
    where c.id = v_id;
  exception when check_violation then
    perform imobdesk.erro('INVALID_INPUT', 'Algum valor está fora do permitido (porta, intervalo, provedor, regra de abertura ou tamanho do texto).');
  end;

  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', case when v_antes is null then 'create' else 'update' end,
    format('Conta de e-mail %s %s', v_email, case when v_antes is null then 'criada' else 'alterada' end),
    v_antes, (select to_jsonb(c) - 'senha_segredo_id' - 'oauth_segredo_id' - 'cursor' from imobdesk.at_email_contas c where c.id = v_id), v_id::text);
  return v_id;
end;
$$;

-- ======================================== 20261007120000_imobdesk_gestao_chamados_permissao.sql
-- Gestão de Chamados liberada para quem atende (pedido do Wagner, 07/10/2026): admin, ti e operador
-- (operador vai virar "Agente"; só o label muda, a chave fica). Libera o menu e o resumo de chamados
-- na Página Inicial. Migração aditiva: só insere, e não sobrescreve o que já foi ajustado em Perfis e permissões.

insert into imobdesk.profile_permissions (role, permission_id, enabled)
select v.role, 'gestao_chamados', true
from (values ('admin'), ('ti'), ('operador')) as v(role)
where exists (select 1 from imobdesk.perfis p where p.key = v.role)
on conflict (role, permission_id) do nothing;

-- ======================================== 20261007150000_imobdesk_chamados_status_visoes.sql
-- Gestão de Chamados › Status e visões de Tickets (pedido e decisões do Wagner, 07/10/2026;
-- docs/PLANO-tickets-visoes.md). Só aditiva: tabelas novas, funções novas, carga inicial e permissões.
--
-- D1: configurar visões e o cadastro de status = só perfil admin e super admin (regra fixa, aqui no banco).
-- D2: cadastro de status à parte; cada status tem uma CATEGORIA fixa (decide Abertos/Pendentes/Fechados).
-- D4: visão por equipe (at_equipes); agente vê as das suas equipes; admin vê e edita todas;
--     só o super admin exclui visão e define o Kanban padrão.
-- Leitura e escrita só por RPC (tabelas sem grant para authenticated), como em at_equipes.

-- ---------- Tabelas ----------

create table if not exists imobdesk.ch_status (
  id             bigint      generated by default as identity primary key,
  nome           text        not null check (length(btrim(nome)) between 2 and 40),
  categoria      text        not null check (categoria in ('novo', 'andamento', 'pendente', 'resolvido', 'fechado', 'cancelado')),
  ordem          integer     not null default 0,
  ativo          boolean     not null default true,
  atualizado_em  timestamptz not null default now(),
  atualizado_por uuid
);
create unique index if not exists ch_status_nome_uidx on imobdesk.ch_status (lower(btrim(nome)));

create table if not exists imobdesk.ch_status_justificativas (
  id             bigint      generated by default as identity primary key,
  status_id      bigint      not null references imobdesk.ch_status (id) on delete cascade,
  nome           text        not null check (length(btrim(nome)) between 2 and 40),
  ordem          integer     not null default 0,
  ativa          boolean     not null default true,
  atualizado_em  timestamptz not null default now(),
  atualizado_por uuid
);
create unique index if not exists ch_status_justificativas_nome_uidx on imobdesk.ch_status_justificativas (status_id, lower(btrim(nome)));

create table if not exists imobdesk.ch_visoes (
  id             bigint      generated by default as identity primary key,
  nome           text        not null check (length(btrim(nome)) between 2 and 60),
  habilitada     boolean     not null default true,
  tipo           text        not null check (tipo in ('lista', 'kanban')),
  padrao         boolean     not null default false,
  equipes        bigint[]    not null default '{}',
  condicoes      jsonb       not null default '{"todas": [], "qualquer": []}',
  kanban         jsonb       not null,
  agrupamento    jsonb       not null,
  atualizado_em  timestamptz not null default now(),
  atualizado_por uuid
);
create unique index if not exists ch_visoes_nome_uidx on imobdesk.ch_visoes (lower(btrim(nome)));
-- Só uma visão padrão no sistema.
create unique index if not exists ch_visoes_padrao_uidx on imobdesk.ch_visoes (padrao) where padrao;

create table if not exists imobdesk.ch_kanban_padrao (
  id             integer     primary key default 1 check (id = 1),
  colunas        jsonb       not null,
  atualizado_em  timestamptz not null default now(),
  atualizado_por uuid
);

do $$
declare
  t text;
begin
  foreach t in array array['ch_status', 'ch_status_justificativas', 'ch_visoes', 'ch_kanban_padrao'] loop
    execute format('alter table imobdesk.%I enable row level security', t);
    execute format('revoke all on imobdesk.%I from anon, public, authenticated', t);
    execute format('grant all on imobdesk.%I to service_role', t);
  end loop;
end;
$$;

-- ---------- Carga inicial (mesmos ids do front: src/features/chamados/status/seed.ts) ----------

insert into imobdesk.ch_status (id, nome, categoria, ordem) values
  (1, 'Novo', 'novo', 1),
  (2, 'Em atendimento', 'andamento', 2),
  (3, 'Aguardando', 'pendente', 3),
  (4, 'Resolvido', 'resolvido', 4),
  (5, 'Fechado', 'fechado', 5),
  (6, 'Cancelado', 'cancelado', 6),
  (7, 'Reaberto', 'andamento', 7)
on conflict (id) do nothing;

insert into imobdesk.ch_status_justificativas (id, status_id, nome, ordem) values
  (1, 3, 'Retorno do cliente', 1),
  (2, 3, 'Fornecedor', 2),
  (3, 3, 'Pendência vistoria', 3),
  (4, 3, 'Pré-fechamento', 4),
  (5, 3, 'Cotação', 5),
  (6, 3, 'Aprovação do gestor', 6),
  (7, 7, 'Pelo cliente', 1)
on conflict (id) do nothing;

-- Os próximos cadastros começam depois da carga.
select setval(pg_get_serial_sequence('imobdesk.ch_status', 'id'), greatest(100, (select max(id) from imobdesk.ch_status)));
select setval(pg_get_serial_sequence('imobdesk.ch_status_justificativas', 'id'), greatest(100, (select max(id) from imobdesk.ch_status_justificativas)));

insert into imobdesk.ch_kanban_padrao (id, colunas) values (1, '[
  {"id": "a-fazer", "nome": "A Fazer", "status": [{"statusId": 1, "justificativaId": null}]},
  {"id": "a-fazer-aguardando", "nome": "A Fazer · Aguardando", "status": [{"statusId": 3, "justificativaId": 1}]},
  {"id": "em-atendimento", "nome": "Em atendimento", "status": [{"statusId": 2, "justificativaId": null}, {"statusId": 3, "justificativaId": 3}, {"statusId": 3, "justificativaId": 2}]},
  {"id": "pre-fechamento", "nome": "Pré-fechamento", "status": [{"statusId": 3, "justificativaId": 4}, {"statusId": 4, "justificativaId": null}]},
  {"id": "reabertura", "nome": "Reabertura", "status": [{"statusId": 7, "justificativaId": null}]},
  {"id": "concluido", "nome": "Concluído", "status": [{"statusId": 5, "justificativaId": null}, {"statusId": 6, "justificativaId": null}]}
]'::jsonb)
on conflict (id) do nothing;

-- ---------- Regras de acesso ----------

create or replace function imobdesk.ch_eh_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(imobdesk.perfil_usuario_atual() in ('admin', 'super_admin'), false);
$$;

/** Quem usa Gestão de Chamados (lê status e visões). */
create or replace function imobdesk.ch_pode_ler()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select imobdesk.ch_eh_admin()
      or imobdesk.tem_permissao('gestao_chamados_tickets')
      or imobdesk.tem_permissao('gestao_chamados_visao_geral');
$$;

create or replace function imobdesk.ch_exigir_admin()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not imobdesk.ch_eh_admin() then
    perform imobdesk.erro('FORBIDDEN', 'Só Admin e Super admin alteram status e visões.');
  end if;
  return (select auth.uid());
end;
$$;

create or replace function imobdesk.ch_exigir_super()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not imobdesk.eh_super_admin() then
    perform imobdesk.erro('FORBIDDEN', 'Só o Super admin pode fazer isso.');
  end if;
  return (select auth.uid());
end;
$$;

-- ---------- Status ----------

create or replace function imobdesk.ch_status_lista()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not imobdesk.ch_pode_ler() then
    perform imobdesk.erro('FORBIDDEN', 'Sem acesso à Gestão de Chamados.');
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', s.id, 'nome', s.nome, 'categoria', s.categoria, 'ordem', s.ordem, 'ativo', s.ativo,
      'justificativas', coalesce((
        select jsonb_agg(jsonb_build_object('id', j.id, 'statusId', j.status_id, 'nome', j.nome, 'ordem', j.ordem, 'ativa', j.ativa) order by j.ordem, j.id)
        from imobdesk.ch_status_justificativas j where j.status_id = s.id), '[]'::jsonb)
    ) order by s.ordem, s.id)
    from imobdesk.ch_status s), '[]'::jsonb);
end;
$$;

create or replace function imobdesk.ch_status_salvar(p jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := imobdesk.ch_exigir_admin();
  v_id bigint := nullif(p ->> 'id', '')::bigint;
  v_nome text := btrim(coalesce(p ->> 'nome', ''));
  v_cat text := p ->> 'categoria';
  v_antes jsonb;
begin
  if length(v_nome) not between 2 and 40 then
    perform imobdesk.erro('INVALID_INPUT', 'Informe o nome (2 a 40 letras).', 'nome');
  end if;
  if v_cat is null or v_cat not in ('novo', 'andamento', 'pendente', 'resolvido', 'fechado', 'cancelado') then
    perform imobdesk.erro('INVALID_INPUT', 'Categoria inválida.', 'categoria');
  end if;
  if exists (select 1 from imobdesk.ch_status s where lower(btrim(s.nome)) = lower(v_nome) and s.id is distinct from v_id) then
    perform imobdesk.erro('DUPLICATE', 'Já existe um status com esse nome.', 'nome');
  end if;
  if v_id is null then
    insert into imobdesk.ch_status (nome, categoria, ativo, ordem, atualizado_por)
    values (v_nome, v_cat, coalesce((p ->> 'ativo')::boolean, true), coalesce((select max(ordem) from imobdesk.ch_status), 0) + 1, v_ator)
    returning id into v_id;
  else
    select to_jsonb(s) into v_antes from imobdesk.ch_status s where s.id = v_id;
    if v_antes is null then
      perform imobdesk.erro('NOT_FOUND', 'Status não encontrado.');
    end if;
    update imobdesk.ch_status
       set nome = v_nome, categoria = v_cat, ativo = coalesce((p ->> 'ativo')::boolean, ativo), atualizado_em = now(), atualizado_por = v_ator
     where id = v_id;
  end if;
  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', case when v_antes is null then 'create' else 'update' end,
    format('Status de ticket "%s" %s', v_nome, case when v_antes is null then 'criado' else 'alterado' end), v_antes,
    jsonb_build_object('nome', v_nome, 'categoria', v_cat, 'ativo', coalesce((p ->> 'ativo')::boolean, true)), v_id::text);
  return v_id;
end;
$$;

create or replace function imobdesk.ch_justificativa_salvar(p jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := imobdesk.ch_exigir_admin();
  v_id bigint := nullif(p ->> 'id', '')::bigint;
  v_status bigint := nullif(p ->> 'statusId', '')::bigint;
  v_nome text := btrim(coalesce(p ->> 'nome', ''));
  v_status_nome text;
  v_antes jsonb;
begin
  select s.nome into v_status_nome from imobdesk.ch_status s where s.id = v_status;
  if v_status_nome is null then
    perform imobdesk.erro('NOT_FOUND', 'Status não encontrado.');
  end if;
  if length(v_nome) not between 2 and 40 then
    perform imobdesk.erro('INVALID_INPUT', 'Informe o nome (2 a 40 letras).', 'nome');
  end if;
  if exists (select 1 from imobdesk.ch_status_justificativas j
             where j.status_id = v_status and lower(btrim(j.nome)) = lower(v_nome) and j.id is distinct from v_id) then
    perform imobdesk.erro('DUPLICATE', 'Esse status já tem uma justificativa com esse nome.', 'nome');
  end if;
  if v_id is null then
    insert into imobdesk.ch_status_justificativas (status_id, nome, ativa, ordem, atualizado_por)
    values (v_status, v_nome, coalesce((p ->> 'ativa')::boolean, true),
            coalesce((select max(ordem) from imobdesk.ch_status_justificativas where status_id = v_status), 0) + 1, v_ator)
    returning id into v_id;
  else
    select to_jsonb(j) into v_antes from imobdesk.ch_status_justificativas j where j.id = v_id and j.status_id = v_status;
    if v_antes is null then
      perform imobdesk.erro('NOT_FOUND', 'Justificativa não encontrada.');
    end if;
    update imobdesk.ch_status_justificativas
       set nome = v_nome, ativa = coalesce((p ->> 'ativa')::boolean, ativa), atualizado_em = now(), atualizado_por = v_ator
     where id = v_id;
  end if;
  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', case when v_antes is null then 'create' else 'update' end,
    format('Justificativa "%s › %s" %s', v_status_nome, v_nome, case when v_antes is null then 'criada' else 'alterada' end), v_antes,
    jsonb_build_object('status', v_status, 'nome', v_nome), v_id::text);
  return v_id;
end;
$$;

create or replace function imobdesk.ch_status_ordenar(p_ids bigint[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := imobdesk.ch_exigir_admin();
begin
  update imobdesk.ch_status s
     set ordem = o.pos, atualizado_em = now(), atualizado_por = v_ator
    from unnest(p_ids) with ordinality as o(id, pos)
   where s.id = o.id;
end;
$$;

-- ---------- Visões ----------

create or replace function imobdesk.ch_visao_json(v imobdesk.ch_visoes)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', v.id, 'nome', v.nome, 'habilitada', v.habilitada, 'tipo', v.tipo, 'padrao', v.padrao,
    'equipes', to_jsonb(v.equipes), 'condicoes', v.condicoes, 'kanban', v.kanban, 'agrupamento', v.agrupamento,
    'atualizadoEm', v.atualizado_em, 'atualizadoPor', (select u.nome from imobdesk.usuarios u where u.id = v.atualizado_por));
$$;

create or replace function imobdesk.ch_visoes_lista()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform imobdesk.ch_exigir_admin();
  return coalesce((select jsonb_agg(imobdesk.ch_visao_json(v) order by v.padrao desc, lower(v.nome))
                   from imobdesk.ch_visoes v), '[]'::jsonb);
end;
$$;

/** Visões habilitadas que o usuário usa: admin/super admin todas; os demais, as das suas equipes. */
create or replace function imobdesk.ch_visoes_disponiveis()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin boolean := imobdesk.ch_eh_admin();
  v_minhas bigint[];
begin
  if not (v_admin or imobdesk.tem_permissao('gestao_chamados_tickets')) then
    perform imobdesk.erro('FORBIDDEN', 'Sem acesso a Tickets.');
  end if;
  select coalesce(array_agg(m.equipe_id), '{}') into v_minhas
    from imobdesk.at_equipe_membros m
    join imobdesk.at_equipes e on e.id = m.equipe_id and e.ativa
   where m.usuario_id = (select auth.uid());
  return coalesce((select jsonb_agg(imobdesk.ch_visao_json(v) order by v.padrao desc, lower(v.nome))
                   from imobdesk.ch_visoes v
                   where v.habilitada and (v_admin or v.equipes && v_minhas)), '[]'::jsonb);
end;
$$;

create or replace function imobdesk.ch_visoes_equipes()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform imobdesk.ch_exigir_admin();
  return coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'nome', e.nome) order by lower(e.nome))
                   from imobdesk.at_equipes e where e.ativa), '[]'::jsonb);
end;
$$;

-- Lista fechada de campos e operadores (a mesma de src/features/chamados/visoes/campos.ts).
create or replace function imobdesk.ch_condicao_valida(c jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case c ->> 'campo'
    when 'recebido_em'  then c ->> 'operador' in ('igual', 'diferente')
    when 'origem'       then c ->> 'operador' in ('igual', 'diferente')
    when 'equipe'       then c ->> 'operador' in ('igual', 'diferente', 'vazio')
    when 'responsavel'  then c ->> 'operador' in ('igual', 'diferente', 'vazio', 'preenchido', 'usuario_logado')
    when 'solicitante'  then c ->> 'operador' in ('contem', 'igual')
    when 'servico'      then c ->> 'operador' in ('igual', 'diferente')
    when 'status'       then c ->> 'operador' in ('igual', 'diferente')
    when 'justificativa' then c ->> 'operador' in ('igual', 'diferente', 'vazio')
    when 'prioridade'   then c ->> 'operador' in ('igual', 'diferente')
    when 'tag'          then c ->> 'operador' in ('igual', 'diferente', 'vazio', 'preenchido')
    when 'criado_em'    then c ->> 'operador' in ('ultimos_dias', 'antes', 'depois')
    when 'sla'          then c ->> 'operador' in ('vencido', 'vence_hoje', 'no_prazo')
    else false
  end
  and jsonb_typeof(coalesce(c -> 'valores', '[]'::jsonb)) = 'array'
  and (c ->> 'operador' in ('vazio', 'preenchido', 'usuario_logado', 'vencido', 'vence_hoje', 'no_prazo')
       or exists (select 1 from jsonb_array_elements_text(c -> 'valores') x where btrim(x) <> ''));
$$;

create or replace function imobdesk.ch_visao_salvar(p jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := imobdesk.ch_exigir_admin();
  v_id bigint := nullif(p ->> 'id', '')::bigint;
  v_nome text := btrim(coalesce(p ->> 'nome', ''));
  v_tipo text := p ->> 'tipo';
  v_padrao boolean := coalesce((p ->> 'padrao')::boolean, false);
  v_cond jsonb := coalesce(p -> 'condicoes', '{"todas": [], "qualquer": []}'::jsonb);
  v_kanban jsonb := p -> 'kanban';
  v_agrup jsonb := p -> 'agrupamento';
  v_equipes bigint[];
  v_antes jsonb;
begin
  if length(v_nome) not between 2 and 60 then
    perform imobdesk.erro('INVALID_INPUT', 'Informe o nome da visão (2 a 60 letras).', 'nome');
  end if;
  if v_tipo is null or v_tipo not in ('lista', 'kanban') then
    perform imobdesk.erro('INVALID_INPUT', 'Tipo de visualização inválido.', 'tipo');
  end if;
  if jsonb_typeof(v_cond -> 'todas') <> 'array' or jsonb_typeof(v_cond -> 'qualquer') <> 'array'
     or jsonb_array_length(v_cond -> 'todas') + jsonb_array_length(v_cond -> 'qualquer') > 30
     or exists (select 1 from jsonb_array_elements((v_cond -> 'todas') || (v_cond -> 'qualquer')) c where not imobdesk.ch_condicao_valida(c)) then
    perform imobdesk.erro('INVALID_INPUT', 'Há uma condição com campo, operador ou valor inválido.', 'condicoes');
  end if;
  if v_kanban is null or jsonb_typeof(v_kanban -> 'colunas') <> 'array'
     or coalesce(v_kanban ->> 'ordenar', '') not in ('sla', 'criado', 'prioridade')
     or coalesce(v_kanban ->> 'arrastar', '') not in ('mudar_status', 'bloqueado')
     or exists (select 1 from jsonb_array_elements(v_kanban -> 'colunas') c where length(btrim(coalesce(c ->> 'nome', ''))) = 0) then
    perform imobdesk.erro('INVALID_INPUT', 'Configuração do Kanban inválida (toda coluna precisa de nome).', 'kanban');
  end if;
  if v_tipo = 'kanban' and jsonb_array_length(v_kanban -> 'colunas') = 0 then
    perform imobdesk.erro('INVALID_INPUT', 'O Kanban precisa de ao menos uma coluna.', 'kanban');
  end if;
  if v_agrup is null or jsonb_typeof(v_agrup -> 'colunas') <> 'array'
     or (v_agrup ->> 'por') is not null and v_agrup ->> 'por' not in ('equipe', 'responsavel', 'status', 'servico', 'origem', 'prioridade')
     or coalesce(v_agrup ->> 'porPagina', '') not in ('25', '50', '100') then
    perform imobdesk.erro('INVALID_INPUT', 'Configuração de agrupamento inválida.', 'agrupamento');
  end if;
  select coalesce(array_agg(distinct x::bigint), '{}') into v_equipes from jsonb_array_elements_text(coalesce(p -> 'equipes', '[]')) x;
  if exists (select 1 from unnest(v_equipes) e where not exists (select 1 from imobdesk.at_equipes q where q.id = e)) then
    perform imobdesk.erro('INVALID_INPUT', 'Equipe não encontrada.', 'equipes');
  end if;
  if exists (select 1 from imobdesk.ch_visoes v where lower(btrim(v.nome)) = lower(v_nome) and v.id is distinct from v_id) then
    perform imobdesk.erro('DUPLICATE', 'Já existe uma visão com esse nome.', 'nome');
  end if;

  if v_padrao then
    update imobdesk.ch_visoes set padrao = false where padrao and id is distinct from v_id;
  end if;
  if v_id is null then
    insert into imobdesk.ch_visoes (nome, habilitada, tipo, padrao, equipes, condicoes, kanban, agrupamento, atualizado_por)
    values (v_nome, coalesce((p ->> 'habilitada')::boolean, true), v_tipo, v_padrao, v_equipes, v_cond, v_kanban, v_agrup, v_ator)
    returning id into v_id;
  else
    select to_jsonb(v) into v_antes from imobdesk.ch_visoes v where v.id = v_id;
    if v_antes is null then
      perform imobdesk.erro('NOT_FOUND', 'Visão não encontrada.');
    end if;
    update imobdesk.ch_visoes
       set nome = v_nome, habilitada = coalesce((p ->> 'habilitada')::boolean, habilitada), tipo = v_tipo, padrao = v_padrao,
           equipes = v_equipes, condicoes = v_cond, kanban = v_kanban, agrupamento = v_agrup, atualizado_em = now(), atualizado_por = v_ator
     where id = v_id;
  end if;
  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', case when v_antes is null then 'create' else 'update' end,
    format('Visão de tickets "%s" %s', v_nome, case when v_antes is null then 'criada' else 'alterada' end), v_antes,
    (select to_jsonb(v) from imobdesk.ch_visoes v where v.id = v_id), v_id::text);
  return v_id;
end;
$$;

create or replace function imobdesk.ch_visao_excluir(p_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := imobdesk.ch_exigir_super();
  v_antes jsonb;
begin
  delete from imobdesk.ch_visoes v where v.id = p_id returning to_jsonb(v) into v_antes;
  if v_antes is null then
    perform imobdesk.erro('NOT_FOUND', 'Visão não encontrada.');
  end if;
  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', 'delete', format('Visão de tickets "%s" excluída', v_antes ->> 'nome'), v_antes, null, p_id::text);
end;
$$;

create or replace function imobdesk.ch_kanban_padrao()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform imobdesk.ch_exigir_admin();
  return coalesce((select k.colunas from imobdesk.ch_kanban_padrao k where k.id = 1), '[]'::jsonb);
end;
$$;

create or replace function imobdesk.ch_kanban_padrao_salvar(p_colunas jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := imobdesk.ch_exigir_super();
begin
  if jsonb_typeof(p_colunas) <> 'array' or jsonb_array_length(p_colunas) = 0
     or exists (select 1 from jsonb_array_elements(p_colunas) c where length(btrim(coalesce(c ->> 'nome', ''))) = 0) then
    perform imobdesk.erro('INVALID_INPUT', 'O Kanban padrão precisa de colunas com nome.', 'kanban');
  end if;
  insert into imobdesk.ch_kanban_padrao (id, colunas, atualizado_por) values (1, p_colunas, v_ator)
  on conflict (id) do update set colunas = excluded.colunas, atualizado_em = now(), atualizado_por = v_ator;
  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', 'update', 'Kanban padrão das visões de tickets redefinido', null, p_colunas, 'ch_kanban_padrao');
end;
$$;

-- ---------- Visões iniciais (as de src/features/chamados/visoes/seed.ts) ----------
-- Equipes "Sistemas" e "Infraestrutura" se existirem no cadastro; senão a visão fica só para Admin e Super admin.

insert into imobdesk.ch_visoes (nome, tipo, padrao, equipes, condicoes, kanban, agrupamento)
select x.nome, x.tipo, x.padrao,
       coalesce((select array_agg(e.id) from imobdesk.at_equipes e where e.ativa and lower(e.nome) in ('sistemas', 'infraestrutura')), '{}'),
       x.condicoes,
       jsonb_build_object('colunas', (select k.colunas from imobdesk.ch_kanban_padrao k where k.id = 1), 'ordenar', 'sla', 'arrastar', 'mudar_status'),
       x.agrupamento
from (values
  ('TI · Fila de chamados', 'kanban', true,
   '{"todas": [{"campo": "equipe", "operador": "igual", "valores": ["Sistemas", "Infraestrutura"]}], "qualquer": []}'::jsonb,
   '{"por": null, "ordemGrupos": "az", "ordenar": "sla", "porPagina": 25, "colunas": ["solicitante", "status", "responsavel", "sla"]}'::jsonb),
  ('TI · Por equipe', 'lista', false,
   '{"todas": [{"campo": "equipe", "operador": "igual", "valores": ["Sistemas", "Infraestrutura"]}], "qualquer": []}'::jsonb,
   '{"por": "equipe", "ordemGrupos": "az", "ordenar": "sla", "porPagina": 25, "colunas": ["solicitante", "status", "responsavel", "prioridade", "sla"]}'::jsonb),
  ('Meus tickets', 'kanban', false,
   '{"todas": [{"campo": "responsavel", "operador": "usuario_logado", "valores": []}], "qualquer": []}'::jsonb,
   '{"por": null, "ordemGrupos": "az", "ordenar": "sla", "porPagina": 25, "colunas": ["solicitante", "status", "responsavel", "sla"]}'::jsonb)
) as x(nome, tipo, padrao, condicoes, agrupamento)
where not exists (select 1 from imobdesk.ch_visoes v where lower(v.nome) = lower(x.nome));

-- ---------- Permissões das seções (Status é adminOnly: não usa profile_permissions) ----------

insert into imobdesk.profile_permissions (role, permission_id, enabled)
select r.role, p.permissao, true
from (values ('admin'), ('ti'), ('operador')) as r(role)
cross join (values ('gestao_chamados_visao_geral'), ('gestao_chamados_tickets')) as p(permissao)
where exists (select 1 from imobdesk.perfis pf where pf.key = r.role)
on conflict (role, permission_id) do nothing;

-- ---------- Grants ----------

do $$
declare
  f text;
begin
  foreach f in array array[
    'ch_eh_admin()', 'ch_pode_ler()', 'ch_exigir_admin()', 'ch_exigir_super()',
    'ch_status_lista()', 'ch_status_salvar(jsonb)', 'ch_justificativa_salvar(jsonb)', 'ch_status_ordenar(bigint[])',
    'ch_visao_json(imobdesk.ch_visoes)', 'ch_visoes_lista()', 'ch_visoes_disponiveis()', 'ch_visoes_equipes()',
    'ch_condicao_valida(jsonb)', 'ch_visao_salvar(jsonb)', 'ch_visao_excluir(bigint)', 'ch_kanban_padrao()', 'ch_kanban_padrao_salvar(jsonb)'
  ] loop
    execute format('revoke execute on function imobdesk.%s from public, anon', f);
    execute format('grant execute on function imobdesk.%s to authenticated, service_role', f);
  end loop;
end;
$$;

notify pgrst, 'reload schema';

-- ======================================== 20261007170000_imobdesk_cadastros_ticket.sql
-- Cadastros do ticket (docs/PLANO-cadastros-ticket.md, aprovado em 07/10/2026): urgências, categorias,
-- serviços (árvore de até 3 níveis por setor, com SLA por urgência), campos adicionais, regras para exibição
-- e macros. Mais os setores e equipes iniciais (plano de IA, D8) e os padrões do setor (ticket único, D5/D6).
-- Só aditiva. Leitura e escrita só por RPC; escrever = Admin e Super admin (regra fixa, ch_exigir_admin).

-- ---------- Setores e equipes iniciais (D8) ----------
alter table imobdesk.at_setores add column if not exists sla_padrao_horas numeric(6,2) not null default 8 check (sla_padrao_horas > 0 and sla_padrao_horas <= 999);
alter table imobdesk.at_setores add column if not exists equipe_padrao_id bigint;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'at_setores_equipe_padrao_fk') then
    alter table imobdesk.at_setores add constraint at_setores_equipe_padrao_fk
      foreign key (equipe_padrao_id) references imobdesk.at_equipes (id) on delete set null;
  end if;
end;
$$;

-- Descrição usada pela IA para classificar (plano de IA, D3).
alter table imobdesk.at_equipes add column if not exists descricao_ia text check (length(descricao_ia) <= 2000);

insert into imobdesk.at_setores (nome)
select x.nome from (values ('TI'), ('CFTV'), ('Administrativo')) as x(nome)
where not exists (select 1 from imobdesk.at_setores s where lower(btrim(s.nome)) = lower(x.nome));

insert into imobdesk.at_equipes (nome, setor_id, descricao, descricao_ia)
select x.nome, s.id, x.descricao, x.ia
from (values
  ('Sistemas', 'TI', 'ERP, portais internos, acessos e usuários.',
   'Problemas e pedidos sobre sistemas e software: ERP Sienge, portais internos, relatórios, erros de tela, lentidão de sistema, criação e bloqueio de usuários e senhas de sistemas.'),
  ('Infraestrutura', 'TI', 'Rede, VPN, internet, impressão e equipamentos.',
   'Problemas e pedidos de infraestrutura: rede, Wi-Fi, internet, VPN, firewall e liberação de sites, impressoras, computadores, notebooks, periféricos, servidores, e-mail corporativo e telefonia.'),
  ('CFTV', 'CFTV', 'Câmeras, gravações e monitoramento.',
   'Câmeras de segurança, imagens, gravadores (DVR/NVR), recuperação de gravações e monitoramento.'),
  ('Administração', 'Administrativo', 'Demandas administrativas.',
   'Demandas administrativas: reembolsos, compras, documentos, contratos e solicitações internas.')
) as x(nome, setor, descricao, ia)
join imobdesk.at_setores s on lower(s.nome) = lower(x.setor)
where not exists (select 1 from imobdesk.at_equipes e where e.setor_id = s.id and lower(btrim(e.nome)) = lower(x.nome));

-- Equipe padrão do setor (para onde vai o ticket antes da triagem): TI fica sem padrão (a IA escolhe entre
-- Sistemas e Infraestrutura); CFTV e Administrativo têm uma equipe só.
update imobdesk.at_setores s set equipe_padrao_id = e.id
from imobdesk.at_equipes e
where e.setor_id = s.id and s.equipe_padrao_id is null
  and ((lower(s.nome) = 'cftv' and lower(e.nome) = 'cftv') or (lower(s.nome) = 'administrativo' and lower(e.nome) = 'administração'));

-- As visões iniciais de Tickets (criadas antes das equipes existirem) passam a valer para Sistemas e Infraestrutura.
update imobdesk.ch_visoes v
   set equipes = (select array_agg(e.id order by e.id) from imobdesk.at_equipes e where lower(e.nome) in ('sistemas', 'infraestrutura'))
 where v.equipes = '{}' and v.nome in ('TI · Fila de chamados', 'TI · Por equipe', 'Meus tickets');

-- ---------- Urgências ----------
create table if not exists imobdesk.ch_urgencias (
  id             bigint      generated by default as identity primary key,
  nome           text        not null check (length(btrim(nome)) between 2 and 30),
  ordem          int         not null default 0,
  cor            text        not null default 'cinza' check (cor in ('vermelho', 'laranja', 'azul', 'verde', 'roxo', 'cinza')),
  descricao      text        check (length(descricao) <= 300),
  padrao         boolean     not null default false,
  ativa          boolean     not null default true,
  atualizado_em  timestamptz not null default now(),
  atualizado_por uuid
);
create unique index if not exists ch_urgencias_nome_uidx on imobdesk.ch_urgencias (lower(btrim(nome)));
create unique index if not exists ch_urgencias_padrao_uidx on imobdesk.ch_urgencias (padrao) where padrao;

insert into imobdesk.ch_urgencias (id, nome, ordem, cor, descricao, padrao) values
  (1, 'Urgente', 1, 'vermelho', 'Operação parada, obra inteira sem sistema ou rede.', false),
  (2, 'Alta', 2, 'laranja', 'Um setor parado ou prazo legal no dia.', false),
  (3, 'Normal', 3, 'azul', 'Uma pessoa afetada, existe contorno.', true),
  (4, 'Baixa', 4, 'cinza', 'Dúvidas e melhorias sem impacto.', false)
on conflict (id) do nothing;

-- ---------- Categorias ----------
create table if not exists imobdesk.ch_categorias (
  id             bigint      generated by default as identity primary key,
  nome           text        not null check (length(btrim(nome)) between 2 and 40),
  descricao      text        check (length(descricao) <= 300),
  -- null = vale para todos os serviços; senão, só para estes (e os filhos deles).
  servicos       bigint[],
  ordem          int         not null default 0,
  padrao         boolean     not null default false,
  ativa          boolean     not null default true,
  atualizado_em  timestamptz not null default now(),
  atualizado_por uuid
);
create unique index if not exists ch_categorias_nome_uidx on imobdesk.ch_categorias (lower(btrim(nome)));
create unique index if not exists ch_categorias_padrao_uidx on imobdesk.ch_categorias (padrao) where padrao;

insert into imobdesk.ch_categorias (id, nome, descricao, ordem, padrao, ativa) values
  (1, 'Dúvida', 'Como fazer algo; sem defeito.', 1, false, true),
  (2, 'Problema', 'Algo que funcionava parou ou dá erro.', 2, true, true),
  (3, 'Solicitação', 'Pedido de algo novo: acesso, equipamento, cadastro, liberação.', 3, false, true),
  (4, 'Incidente', 'Falha que afeta várias pessoas.', 4, false, true),
  (5, 'Melhoria', 'Sugestão de mudança.', 5, false, false)
on conflict (id) do nothing;

-- ---------- Serviços (árvore de até 3 níveis por setor) ----------
create table if not exists imobdesk.ch_servicos (
  id                  bigint      generated by default as identity primary key,
  pai_id              bigint      references imobdesk.ch_servicos (id),
  setor_id            bigint      not null references imobdesk.at_setores (id),
  nivel               int         not null default 1 check (nivel between 1 and 3),
  nome                text        not null check (length(btrim(nome)) between 2 and 80),
  equipe_id           bigint      references imobdesk.at_equipes (id) on delete set null,  -- null = herda do pai
  descricao           text        check (length(descricao) <= 2000),                                 -- vai para a IA
  urgencia_padrao_id  bigint      references imobdesk.ch_urgencias (id),
  categoria_padrao_id bigint      references imobdesk.ch_categorias (id),
  canais              text[]      not null default '{agente,intranet,email,whatsapp}'
                                  check (canais <@ array['agente', 'intranet', 'email', 'whatsapp']),
  ordem               int         not null default 0,
  ativo               boolean     not null default true,
  atualizado_em       timestamptz not null default now(),
  atualizado_por      uuid
);
create unique index if not exists ch_servicos_nome_uidx on imobdesk.ch_servicos (setor_id, coalesce(pai_id, 0), lower(btrim(nome)));
create index if not exists ch_servicos_pai_idx on imobdesk.ch_servicos (pai_id);

-- Prazos por serviço × urgência, em horas úteis no horário do setor. Sem linha = herda do pai; sem nada = SLA padrão do setor.
create table if not exists imobdesk.ch_servicos_sla (
  servico_id     bigint       not null references imobdesk.ch_servicos (id) on delete cascade,
  urgencia_id    bigint       not null references imobdesk.ch_urgencias (id),
  resposta_horas numeric(6,2) check (resposta_horas > 0),
  solucao_horas  numeric(6,2) check (solucao_horas > 0),
  primary key (servico_id, urgencia_id)
);

-- Carga inicial (mesma árvore do mockup docs/mockups/cadastros-ticket.html).
do $$
declare
  v_ti bigint := (select id from imobdesk.at_setores where lower(nome) = 'ti');
  v_cftv bigint := (select id from imobdesk.at_setores where lower(nome) = 'cftv');
  v_adm bigint := (select id from imobdesk.at_setores where lower(nome) = 'administrativo');
  v_sis bigint := (select id from imobdesk.at_equipes where lower(nome) = 'sistemas');
  v_inf bigint := (select id from imobdesk.at_equipes where lower(nome) = 'infraestrutura');
  v_eq_cftv bigint := (select id from imobdesk.at_equipes where lower(nome) = 'cftv');
  v_eq_adm bigint := (select id from imobdesk.at_equipes where lower(nome) = 'administração');
  r record;
  v_id bigint;
  v_pai bigint;
begin
  if exists (select 1 from imobdesk.ch_servicos) then
    return;
  end if;
  -- nível 1 (raiz do setor), nível 2 e nível 3: (setor, pai, nome, equipe, descrição, solução Normal em h)
  for r in select * from (values
    (1, v_ti, null::text, 'TI', null::bigint, null::text, null::numeric),
    (2, v_ti, 'TI', 'Sistemas', v_sis, 'Sistemas e software da empresa.', null),
    (3, v_ti, 'Sistemas', 'ERP Sienge', v_sis, 'Erros, lentidão, boletos, notas e relatórios do ERP Sienge.', 8),
    (3, v_ti, 'Sistemas', 'Portais internos', v_sis, 'Portais e sistemas internos: erros e dúvidas.', 8),
    (3, v_ti, 'Sistemas', 'Acessos e usuários', v_sis, 'Criar, bloquear ou liberar usuário; senha de sistema; permissões.', 4),
    (2, v_ti, 'TI', 'Infraestrutura', v_inf, 'Rede, equipamentos e serviços de TI.', null),
    (3, v_ti, 'Infraestrutura', 'Rede / VPN', v_inf, 'Sem internet, Wi-Fi, VPN que não conecta, rede lenta.', 4),
    (3, v_ti, 'Infraestrutura', 'Liberação de acesso a sites', v_inf, 'Liberar site ou domínio bloqueado no firewall.', 8),
    (3, v_ti, 'Infraestrutura', 'Impressão', v_inf, 'Impressora offline, sem toner, fila travada, scanner.', 8),
    (3, v_ti, 'Infraestrutura', 'Equipamentos', v_inf, 'Computador, notebook, monitor e periféricos: defeito, troca ou novo.', 16),
    (1, v_cftv, null, 'CFTV', v_eq_cftv, null, null),
    (2, v_cftv, 'CFTV', 'Câmera sem imagem', v_eq_cftv, 'Câmera apagada, sem imagem ou com imagem ruim.', 8),
    (2, v_cftv, 'CFTV', 'Recuperar gravação', v_eq_cftv, 'Pedido de imagens gravadas de um período.', 24),
    (1, v_adm, null, 'Administrativo', v_eq_adm, null, null),
    (2, v_adm, 'Administrativo', 'Solicitação administrativa', v_eq_adm, 'Pedidos administrativos em geral.', 24)
  ) as x(nivel, setor, pai, nome, equipe, descricao, horas)
  loop
    continue when r.setor is null;
    v_pai := case when r.pai is null then null else
      (select s.id from imobdesk.ch_servicos s where s.setor_id = r.setor and s.nome = r.pai) end;
    insert into imobdesk.ch_servicos (pai_id, setor_id, nivel, nome, equipe_id, descricao, urgencia_padrao_id, categoria_padrao_id, ordem)
    values (v_pai, r.setor, r.nivel, r.nome, r.equipe, r.descricao, 3, 2,
            (select count(*) from imobdesk.ch_servicos s where s.setor_id = r.setor and s.pai_id is not distinct from v_pai) + 1)
    returning id into v_id;
    if r.horas is not null then
      -- Normal = horas; Urgente = metade; Alta = 3/4; Baixa = dobro. Resposta = metade da solução.
      insert into imobdesk.ch_servicos_sla (servico_id, urgencia_id, resposta_horas, solucao_horas)
      select v_id, u.id, round(r.horas * f / 2, 2), round(r.horas * f, 2)
      from (values (1, 0.5), (2, 0.75), (3, 1.0), (4, 2.0)) as u(id, f);
    end if;
  end loop;
end;
$$;

-- ---------- Campos adicionais ----------
create table if not exists imobdesk.ch_campos (
  id              bigint      generated by default as identity primary key,
  chave           text        not null unique check (chave ~ '^[a-z][a-z0-9_]{1,39}$'),   -- não muda depois de criada (D6)
  rotulo          text        not null check (length(btrim(rotulo)) between 2 and 60),
  tipo            text        not null check (tipo in ('texto', 'texto_longo', 'numero', 'data', 'data_hora', 'lista', 'multipla', 'sim_nao', 'usuario')),
  opcoes          text[]      not null default '{}',
  ajuda           text        check (length(ajuda) <= 300),
  aparece         text[]      not null default '{abertura,detalhe}' check (aparece <@ array['abertura', 'detalhe', 'encerramento']),
  interno         boolean     not null default false,                                     -- aba Interno (o solicitante não vê)
  obrigatorio     text        not null default 'nao' check (obrigatorio in ('sempre', 'nao', 'regra')),
  usar_em_visoes  boolean     not null default true,
  ordem           int         not null default 0,
  ativo           boolean     not null default true,
  atualizado_em   timestamptz not null default now(),
  atualizado_por  uuid,
  check (tipo not in ('lista', 'multipla') or cardinality(opcoes) between 1 and 200)
);

insert into imobdesk.ch_campos (chave, rotulo, tipo, opcoes, ajuda, aparece, interno, obrigatorio, ordem) values
  ('forma_atendimento', 'Forma de atendimento', 'lista', '{E-mail,WhatsApp,Telefone,Presencial,Acesso remoto}', 'Canal usado pelo agente.', '{abertura,detalhe}', false, 'nao', 1),
  ('previsao_inicio', 'Data de previsão de início', 'data', '{}', 'Para tickets de projeto.', '{detalhe}', true, 'nao', 2),
  ('protocolo', 'PROTOCOLO', 'texto', '{}', 'Número do protocolo do fornecedor ou do órgão.', '{abertura,detalhe}', false, 'regra', 3),
  ('patrimonio', 'Patrimônio do equipamento', 'texto', '{}', 'Etiqueta de patrimônio do equipamento.', '{abertura,detalhe}', false, 'regra', 4),
  ('camera', 'Câmera', 'texto', '{}', 'Identificação ou local da câmera.', '{abertura,detalhe}', false, 'regra', 5),
  ('data_ocorrido', 'Data do ocorrido', 'data_hora', '{}', null, '{abertura,detalhe}', false, 'nao', 6)
on conflict (chave) do nothing;

-- ---------- Regras para exibição ----------
-- condicoes: [{"campo": "servico"|"categoria"|"urgencia"|"setor"|"origem"|"campo:<chave>", "operador": "um_de"|"nao_um_de"|"preenchido"|"vazio", "valores": [...]}] (todas valem)
-- acoes:     [{"acao": "exibir"|"ocultar"|"obrigar"|"liberar", "campo": "<chave>"}]
create table if not exists imobdesk.ch_regras_exibicao (
  id             bigint      generated by default as identity primary key,
  nome           text        not null check (length(btrim(nome)) between 2 and 80),
  ordem          int         not null default 0,
  condicoes      jsonb       not null default '[]',
  acoes          jsonb       not null default '[]',
  ativa          boolean     not null default true,
  atualizado_em  timestamptz not null default now(),
  atualizado_por uuid
);

insert into imobdesk.ch_regras_exibicao (nome, ordem, condicoes, acoes)
select x.nome, x.ordem, x.condicoes, x.acoes
from (values
  ('Protocolo em portais e acessos', 1,
   jsonb_build_array(
     jsonb_build_object('campo', 'servico', 'operador', 'um_de', 'valores',
       (select jsonb_agg(s.id::text) from imobdesk.ch_servicos s where s.nome in ('Portais internos', 'Acessos e usuários'))),
     jsonb_build_object('campo', 'categoria', 'operador', 'um_de', 'valores', jsonb_build_array('3'))),
   '[{"acao": "obrigar", "campo": "protocolo"}]'::jsonb),
  ('Patrimônio para equipamentos e impressão', 2,
   jsonb_build_array(jsonb_build_object('campo', 'servico', 'operador', 'um_de', 'valores',
     (select jsonb_agg(s.id::text) from imobdesk.ch_servicos s where s.nome in ('Equipamentos', 'Impressão')))),
   '[{"acao": "obrigar", "campo": "patrimonio"}]'::jsonb),
  ('Câmera no CFTV', 3,
   jsonb_build_array(jsonb_build_object('campo', 'setor', 'operador', 'um_de', 'valores',
     (select jsonb_agg(s.id::text) from imobdesk.at_setores s where lower(s.nome) = 'cftv'))),
   '[{"acao": "obrigar", "campo": "camera"}, {"acao": "exibir", "campo": "data_ocorrido"}]'::jsonb)
) as x(nome, ordem, condicoes, acoes)
where not exists (select 1 from imobdesk.ch_regras_exibicao);

-- ---------- Macros (tela do ticket, T5) ----------
-- acoes: {"statusId", "justificativaId", "categoriaId", "urgenciaId", "equipeId", "responsavelId", "tags": []} (todos opcionais)
create table if not exists imobdesk.ch_macros (
  id             bigint      generated by default as identity primary key,
  nome           text        not null check (length(btrim(nome)) between 2 and 80),
  texto          text        not null default '' check (length(texto) <= 20000),
  acoes          jsonb       not null default '{}',
  escopo         text        not null default 'todos' check (escopo in ('pessoal', 'equipe', 'todos')),
  dono_id        uuid        references imobdesk.usuarios (id) on delete cascade,
  equipe_id      bigint      references imobdesk.at_equipes (id) on delete cascade,
  ativa          boolean     not null default true,
  atualizado_em  timestamptz not null default now(),
  atualizado_por uuid,
  check (escopo <> 'pessoal' or dono_id is not null),
  check (escopo <> 'equipe' or equipe_id is not null)
);

insert into imobdesk.ch_macros (nome, texto, acoes)
select x.nome, x.texto, x.acoes::jsonb
from (values
  ('Pedido de novo teste', E'Olá, {{solicitante.nome}}.\n\nPor gentileza, faça um novo teste e nos avise o resultado.\n\nAtenciosamente,\n{{agente.nome}}', '{"statusId": 3, "justificativaId": 1}'),
  ('Acesso liberado', E'Olá, {{solicitante.nome}}. O acesso foi liberado. Qualquer dúvida, responda esta mensagem.\n\n{{agente.nome}}', '{"statusId": 4, "tags": ["liberado"]}'),
  ('Pedir mais informações', E'Olá, {{solicitante.nome}}. Para seguir com o atendimento, precisamos de um print da tela de erro e do horário em que aconteceu.\n\n{{agente.nome}}', '{"statusId": 3, "justificativaId": 1}')
) as x(nome, texto, acoes)
where not exists (select 1 from imobdesk.ch_macros);

do $$
declare
  t text;
begin
  foreach t in array array['ch_urgencias', 'ch_categorias', 'ch_servicos', 'ch_servicos_sla', 'ch_campos', 'ch_regras_exibicao', 'ch_macros'] loop
    execute format('alter table imobdesk.%I enable row level security', t);
    execute format('revoke all on imobdesk.%I from anon, public, authenticated', t);
    execute format('grant all on imobdesk.%I to service_role', t);
  end loop;
end;
$$;

select setval(pg_get_serial_sequence('imobdesk.ch_urgencias', 'id'), greatest(100, (select max(id) from imobdesk.ch_urgencias)));
select setval(pg_get_serial_sequence('imobdesk.ch_categorias', 'id'), greatest(100, (select max(id) from imobdesk.ch_categorias)));

-- ---------- RPCs: leitura (quem usa Gestão de Chamados ou é admin) ----------

/** Todos os cadastros de uma vez (a tela do ticket e as telas de cadastro usam o mesmo pacote). */
create or replace function imobdesk.ch_cadastros()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not imobdesk.ch_pode_ler() then
    perform imobdesk.erro('FORBIDDEN', 'Sem acesso à Gestão de Chamados.');
  end if;
  return jsonb_build_object(
    'setores', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'nome', s.nome, 'ativo', s.ativo, 'slaPadraoHoras', s.sla_padrao_horas, 'equipePadraoId', s.equipe_padrao_id) order by s.nome) from imobdesk.at_setores s), '[]'),
    'equipes', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'nome', e.nome, 'setorId', e.setor_id, 'ativa', e.ativa, 'descricaoIa', e.descricao_ia) order by e.nome) from imobdesk.at_equipes e), '[]'),
    'urgencias', coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'nome', u.nome, 'ordem', u.ordem, 'cor', u.cor, 'descricao', u.descricao, 'padrao', u.padrao, 'ativa', u.ativa) order by u.ordem, u.id) from imobdesk.ch_urgencias u), '[]'),
    'categorias', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'nome', c.nome, 'descricao', c.descricao, 'servicos', c.servicos, 'ordem', c.ordem, 'padrao', c.padrao, 'ativa', c.ativa) order by c.ordem, c.id) from imobdesk.ch_categorias c), '[]'),
    'servicos', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'paiId', s.pai_id, 'setorId', s.setor_id, 'nivel', s.nivel, 'nome', s.nome, 'equipeId', s.equipe_id, 'descricao', s.descricao,
                          'urgenciaPadraoId', s.urgencia_padrao_id, 'categoriaPadraoId', s.categoria_padrao_id, 'canais', s.canais, 'ordem', s.ordem, 'ativo', s.ativo,
                          'sla', coalesce((select jsonb_agg(jsonb_build_object('urgenciaId', l.urgencia_id, 'respostaHoras', l.resposta_horas, 'solucaoHoras', l.solucao_horas) order by l.urgencia_id)
                                           from imobdesk.ch_servicos_sla l where l.servico_id = s.id), '[]')) order by s.setor_id, s.nivel, s.ordem, s.id)
                         from imobdesk.ch_servicos s), '[]'),
    'campos', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'chave', c.chave, 'rotulo', c.rotulo, 'tipo', c.tipo, 'opcoes', c.opcoes, 'ajuda', c.ajuda, 'aparece', c.aparece,
                          'interno', c.interno, 'obrigatorio', c.obrigatorio, 'usarEmVisoes', c.usar_em_visoes, 'ordem', c.ordem, 'ativo', c.ativo) order by c.ordem, c.id)
                       from imobdesk.ch_campos c), '[]'),
    'regras', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'nome', r.nome, 'ordem', r.ordem, 'condicoes', r.condicoes, 'acoes', r.acoes, 'ativa', r.ativa) order by r.ordem, r.id)
                       from imobdesk.ch_regras_exibicao r), '[]')
  );
end;
$$;

/** Macros que o usuário pode aplicar: todas as "todos", as da sua equipe e as suas. Admin vê todas. */
create or replace function imobdesk.ch_macros_lista()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin boolean := imobdesk.ch_eh_admin();
begin
  if not imobdesk.ch_pode_ler() then
    perform imobdesk.erro('FORBIDDEN', 'Sem acesso à Gestão de Chamados.');
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', m.id, 'nome', m.nome, 'texto', m.texto, 'acoes', m.acoes, 'escopo', m.escopo, 'donoId', m.dono_id, 'equipeId', m.equipe_id, 'ativa', m.ativa) order by lower(m.nome))
    from imobdesk.ch_macros m
    where v_admin
       or (m.ativa and (m.escopo = 'todos'
                        or (m.escopo = 'pessoal' and m.dono_id = (select auth.uid()))
                        or (m.escopo = 'equipe' and exists (select 1 from imobdesk.at_equipe_membros em where em.equipe_id = m.equipe_id and em.usuario_id = (select auth.uid())))))
  ), '[]'::jsonb);
end;
$$;

-- ---------- RPCs: escrita (Admin e Super admin) ----------

create or replace function imobdesk.ch_urgencia_salvar(p jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := imobdesk.ch_exigir_admin();
  v_id bigint := nullif(p ->> 'id', '')::bigint;
  v_nome text := btrim(coalesce(p ->> 'nome', ''));
  v_padrao boolean := coalesce((p ->> 'padrao')::boolean, false);
begin
  if length(v_nome) not between 2 and 30 then perform imobdesk.erro('INVALID_INPUT', 'Informe o nome (2 a 30 letras).', 'nome'); end if;
  if coalesce(p ->> 'cor', '') not in ('vermelho', 'laranja', 'azul', 'verde', 'roxo', 'cinza') then perform imobdesk.erro('INVALID_INPUT', 'Cor inválida.', 'cor'); end if;
  if exists (select 1 from imobdesk.ch_urgencias u where lower(btrim(u.nome)) = lower(v_nome) and u.id is distinct from v_id) then
    perform imobdesk.erro('DUPLICATE', 'Já existe uma urgência com esse nome.', 'nome');
  end if;
  if v_padrao then update imobdesk.ch_urgencias set padrao = false where padrao and id is distinct from v_id; end if;
  if v_id is null then
    insert into imobdesk.ch_urgencias (nome, cor, descricao, padrao, ativa, ordem, atualizado_por)
    values (v_nome, p ->> 'cor', nullif(btrim(p ->> 'descricao'), ''), v_padrao, coalesce((p ->> 'ativa')::boolean, true),
            coalesce((select max(ordem) from imobdesk.ch_urgencias), 0) + 1, v_ator)
    returning id into v_id;
  else
    update imobdesk.ch_urgencias set nome = v_nome, cor = p ->> 'cor', descricao = nullif(btrim(p ->> 'descricao'), ''), padrao = v_padrao,
           ativa = coalesce((p ->> 'ativa')::boolean, ativa), atualizado_em = now(), atualizado_por = v_ator
     where id = v_id;
    if not found then perform imobdesk.erro('NOT_FOUND', 'Urgência não encontrada.'); end if;
  end if;
  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', 'update', format('Urgência "%s" salva', v_nome), null, p, v_id::text);
  return v_id;
end;
$$;

create or replace function imobdesk.ch_categoria_salvar(p jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := imobdesk.ch_exigir_admin();
  v_id bigint := nullif(p ->> 'id', '')::bigint;
  v_nome text := btrim(coalesce(p ->> 'nome', ''));
  v_padrao boolean := coalesce((p ->> 'padrao')::boolean, false);
  v_servicos bigint[];
begin
  if length(v_nome) not between 2 and 40 then perform imobdesk.erro('INVALID_INPUT', 'Informe o nome (2 a 40 letras).', 'nome'); end if;
  if exists (select 1 from imobdesk.ch_categorias c where lower(btrim(c.nome)) = lower(v_nome) and c.id is distinct from v_id) then
    perform imobdesk.erro('DUPLICATE', 'Já existe uma categoria com esse nome.', 'nome');
  end if;
  if jsonb_typeof(p -> 'servicos') = 'array' then
    select array_agg(x::bigint) into v_servicos from jsonb_array_elements_text(p -> 'servicos') x;
  end if;
  if v_padrao then update imobdesk.ch_categorias set padrao = false where padrao and id is distinct from v_id; end if;
  if v_id is null then
    insert into imobdesk.ch_categorias (nome, descricao, servicos, padrao, ativa, ordem, atualizado_por)
    values (v_nome, nullif(btrim(p ->> 'descricao'), ''), v_servicos, v_padrao, coalesce((p ->> 'ativa')::boolean, true),
            coalesce((select max(ordem) from imobdesk.ch_categorias), 0) + 1, v_ator)
    returning id into v_id;
  else
    update imobdesk.ch_categorias set nome = v_nome, descricao = nullif(btrim(p ->> 'descricao'), ''), servicos = v_servicos, padrao = v_padrao,
           ativa = coalesce((p ->> 'ativa')::boolean, ativa), atualizado_em = now(), atualizado_por = v_ator
     where id = v_id;
    if not found then perform imobdesk.erro('NOT_FOUND', 'Categoria não encontrada.'); end if;
  end if;
  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', 'update', format('Categoria "%s" salva', v_nome), null, p, v_id::text);
  return v_id;
end;
$$;

/** Reordena urgências ou categorias (ids na ordem desejada). */
create or replace function imobdesk.ch_cadastro_ordenar(p_tabela text, p_ids bigint[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := imobdesk.ch_exigir_admin();
begin
  if p_tabela = 'urgencias' then
    update imobdesk.ch_urgencias u set ordem = o.pos, atualizado_em = now(), atualizado_por = v_ator from unnest(p_ids) with ordinality o(id, pos) where u.id = o.id;
  elsif p_tabela = 'categorias' then
    update imobdesk.ch_categorias c set ordem = o.pos, atualizado_em = now(), atualizado_por = v_ator from unnest(p_ids) with ordinality o(id, pos) where c.id = o.id;
  elsif p_tabela = 'campos' then
    update imobdesk.ch_campos c set ordem = o.pos, atualizado_em = now(), atualizado_por = v_ator from unnest(p_ids) with ordinality o(id, pos) where c.id = o.id;
  elsif p_tabela = 'regras' then
    update imobdesk.ch_regras_exibicao r set ordem = o.pos, atualizado_em = now(), atualizado_por = v_ator from unnest(p_ids) with ordinality o(id, pos) where r.id = o.id;
  else
    perform imobdesk.erro('INVALID_INPUT', 'Cadastro inválido.');
  end if;
end;
$$;

create or replace function imobdesk.ch_servico_salvar(p jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := imobdesk.ch_exigir_admin();
  v_id bigint := nullif(p ->> 'id', '')::bigint;
  v_nome text := btrim(coalesce(p ->> 'nome', ''));
  v_pai bigint := nullif(p ->> 'paiId', '')::bigint;
  v_setor bigint := nullif(p ->> 'setorId', '')::bigint;
  v_nivel int := 1;
  v_canais text[];
  v_cursor bigint;
begin
  if length(v_nome) not between 2 and 80 then perform imobdesk.erro('INVALID_INPUT', 'Informe o nome (2 a 80 letras).', 'nome'); end if;
  if v_pai is not null then
    select s.setor_id, s.nivel + 1 into v_setor, v_nivel from imobdesk.ch_servicos s where s.id = v_pai;
    if v_nivel is null then perform imobdesk.erro('NOT_FOUND', 'Serviço pai não encontrado.', 'paiId'); end if;
    if v_nivel > 3 then perform imobdesk.erro('INVALID_INPUT', 'O catálogo tem no máximo 3 níveis.', 'paiId'); end if;
    -- Sem ciclo: o pai não pode ser o próprio serviço nem um descendente dele.
    v_cursor := v_pai;
    while v_cursor is not null loop
      if v_cursor = v_id then perform imobdesk.erro('INVALID_INPUT', 'Um serviço não pode ficar dentro dele mesmo.', 'paiId'); end if;
      select s.pai_id into v_cursor from imobdesk.ch_servicos s where s.id = v_cursor;
    end loop;
  elsif v_setor is null or not exists (select 1 from imobdesk.at_setores s where s.id = v_setor) then
    perform imobdesk.erro('INVALID_INPUT', 'Escolha o setor.', 'setorId');
  end if;
  if v_id is not null and v_nivel + coalesce((
       with recursive d as (select s.id, 1 as prof from imobdesk.ch_servicos s where s.pai_id = v_id
                            union all select s.id, d.prof + 1 from imobdesk.ch_servicos s join d on s.pai_id = d.id)
       select max(prof) from d), 0) > 3 then
    perform imobdesk.erro('INVALID_INPUT', 'Com os serviços de dentro, o catálogo passaria de 3 níveis.', 'paiId');
  end if;
  if exists (select 1 from imobdesk.ch_servicos s where s.setor_id = v_setor and s.pai_id is not distinct from v_pai and lower(btrim(s.nome)) = lower(v_nome) and s.id is distinct from v_id) then
    perform imobdesk.erro('DUPLICATE', 'Já existe um serviço com esse nome neste nível.', 'nome');
  end if;
  select coalesce(array_agg(x), '{}') into v_canais from jsonb_array_elements_text(coalesce(p -> 'canais', '[]')) x
   where x in ('agente', 'intranet', 'email', 'whatsapp');

  if v_id is null then
    insert into imobdesk.ch_servicos (pai_id, setor_id, nivel, nome, equipe_id, descricao, urgencia_padrao_id, categoria_padrao_id, canais, ativo, ordem, atualizado_por)
    values (v_pai, v_setor, v_nivel, v_nome, nullif(p ->> 'equipeId', '')::bigint, nullif(btrim(p ->> 'descricao'), ''),
            nullif(p ->> 'urgenciaPadraoId', '')::bigint, nullif(p ->> 'categoriaPadraoId', '')::bigint, v_canais, coalesce((p ->> 'ativo')::boolean, true),
            coalesce((select max(ordem) from imobdesk.ch_servicos s where s.setor_id = v_setor and s.pai_id is not distinct from v_pai), 0) + 1, v_ator)
    returning id into v_id;
  else
    update imobdesk.ch_servicos
       set pai_id = v_pai, setor_id = v_setor, nivel = v_nivel, nome = v_nome, equipe_id = nullif(p ->> 'equipeId', '')::bigint, descricao = nullif(btrim(p ->> 'descricao'), ''),
           urgencia_padrao_id = nullif(p ->> 'urgenciaPadraoId', '')::bigint, categoria_padrao_id = nullif(p ->> 'categoriaPadraoId', '')::bigint, canais = v_canais,
           ativo = coalesce((p ->> 'ativo')::boolean, ativo), atualizado_em = now(), atualizado_por = v_ator
     where id = v_id;
    if not found then perform imobdesk.erro('NOT_FOUND', 'Serviço não encontrado.'); end if;
    -- Filhos acompanham setor e nível.
    with recursive d as (select s.id, v_nivel + 1 as niv from imobdesk.ch_servicos s where s.pai_id = v_id
                         union all select s.id, d.niv + 1 from imobdesk.ch_servicos s join d on s.pai_id = d.id)
    update imobdesk.ch_servicos s set setor_id = v_setor, nivel = d.niv from d where s.id = d.id;
  end if;

  if jsonb_typeof(p -> 'sla') = 'array' then
    delete from imobdesk.ch_servicos_sla where servico_id = v_id;
    insert into imobdesk.ch_servicos_sla (servico_id, urgencia_id, resposta_horas, solucao_horas)
    select v_id, (x ->> 'urgenciaId')::bigint, nullif(x ->> 'respostaHoras', '')::numeric, nullif(x ->> 'solucaoHoras', '')::numeric
      from jsonb_array_elements(p -> 'sla') x
     where nullif(x ->> 'respostaHoras', '') is not null or nullif(x ->> 'solucaoHoras', '') is not null;
  end if;
  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', 'update', format('Serviço "%s" salvo', v_nome), null, p, v_id::text);
  return v_id;
end;
$$;

create or replace function imobdesk.ch_campo_salvar(p jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := imobdesk.ch_exigir_admin();
  v_id bigint := nullif(p ->> 'id', '')::bigint;
  v_rotulo text := btrim(coalesce(p ->> 'rotulo', ''));
  v_chave text := p ->> 'chave';
  v_tipo text := p ->> 'tipo';
  v_opcoes text[];
  v_aparece text[];
begin
  if length(v_rotulo) not between 2 and 60 then perform imobdesk.erro('INVALID_INPUT', 'Informe o nome do campo (2 a 60 letras).', 'rotulo'); end if;
  if v_tipo is null or v_tipo not in ('texto', 'texto_longo', 'numero', 'data', 'data_hora', 'lista', 'multipla', 'sim_nao', 'usuario') then
    perform imobdesk.erro('INVALID_INPUT', 'Tipo de campo inválido.', 'tipo');
  end if;
  select coalesce(array_agg(btrim(x)), '{}') into v_opcoes from jsonb_array_elements_text(coalesce(p -> 'opcoes', '[]')) x where btrim(x) <> '';
  if v_tipo in ('lista', 'multipla') and cardinality(v_opcoes) = 0 then perform imobdesk.erro('INVALID_INPUT', 'Informe as opções da lista.', 'opcoes'); end if;
  select coalesce(array_agg(x), '{}') into v_aparece from jsonb_array_elements_text(coalesce(p -> 'aparece', '[]')) x where x in ('abertura', 'detalhe', 'encerramento');
  if coalesce(p ->> 'obrigatorio', '') not in ('sempre', 'nao', 'regra') then perform imobdesk.erro('INVALID_INPUT', 'Obrigatoriedade inválida.', 'obrigatorio'); end if;

  if v_id is null then
    if v_chave is null or v_chave !~ '^[a-z][a-z0-9_]{1,39}$' then perform imobdesk.erro('INVALID_INPUT', 'Chave inválida (letras minúsculas, números e _).', 'chave'); end if;
    if exists (select 1 from imobdesk.ch_campos c where c.chave = v_chave) then perform imobdesk.erro('DUPLICATE', 'Já existe um campo com essa chave.', 'chave'); end if;
    insert into imobdesk.ch_campos (chave, rotulo, tipo, opcoes, ajuda, aparece, interno, obrigatorio, usar_em_visoes, ativo, ordem, atualizado_por)
    values (v_chave, v_rotulo, v_tipo, v_opcoes, nullif(btrim(p ->> 'ajuda'), ''), v_aparece, coalesce((p ->> 'interno')::boolean, false), p ->> 'obrigatorio',
            coalesce((p ->> 'usarEmVisoes')::boolean, true), coalesce((p ->> 'ativo')::boolean, true), coalesce((select max(ordem) from imobdesk.ch_campos), 0) + 1, v_ator)
    returning id into v_id;
  else
    -- A chave não muda (D6).
    update imobdesk.ch_campos
       set rotulo = v_rotulo, tipo = v_tipo, opcoes = v_opcoes, ajuda = nullif(btrim(p ->> 'ajuda'), ''), aparece = v_aparece, interno = coalesce((p ->> 'interno')::boolean, interno),
           obrigatorio = p ->> 'obrigatorio', usar_em_visoes = coalesce((p ->> 'usarEmVisoes')::boolean, usar_em_visoes), ativo = coalesce((p ->> 'ativo')::boolean, ativo),
           atualizado_em = now(), atualizado_por = v_ator
     where id = v_id;
    if not found then perform imobdesk.erro('NOT_FOUND', 'Campo não encontrado.'); end if;
  end if;
  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', 'update', format('Campo adicional "%s" salvo', v_rotulo), null, p, v_id::text);
  return v_id;
end;
$$;

create or replace function imobdesk.ch_regra_salvar(p jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := imobdesk.ch_exigir_admin();
  v_id bigint := nullif(p ->> 'id', '')::bigint;
  v_nome text := btrim(coalesce(p ->> 'nome', ''));
  v_cond jsonb := coalesce(p -> 'condicoes', '[]');
  v_acoes jsonb := coalesce(p -> 'acoes', '[]');
begin
  if length(v_nome) not between 2 and 80 then perform imobdesk.erro('INVALID_INPUT', 'Informe o nome da regra.', 'nome'); end if;
  if jsonb_typeof(v_cond) <> 'array' or jsonb_array_length(v_cond) = 0
     or exists (select 1 from jsonb_array_elements(v_cond) c
                where not ((c ->> 'campo') in ('servico', 'categoria', 'urgencia', 'setor', 'origem') or (c ->> 'campo') like 'campo:%')
                   or coalesce(c ->> 'operador', '') not in ('um_de', 'nao_um_de', 'preenchido', 'vazio')
                   or ((c ->> 'operador') in ('um_de', 'nao_um_de') and coalesce(jsonb_array_length(c -> 'valores'), 0) = 0)) then
    perform imobdesk.erro('INVALID_INPUT', 'Revise as condições: campo, operador e valores.', 'condicoes');
  end if;
  if jsonb_typeof(v_acoes) <> 'array' or jsonb_array_length(v_acoes) = 0
     or exists (select 1 from jsonb_array_elements(v_acoes) a
                where coalesce(a ->> 'acao', '') not in ('exibir', 'ocultar', 'obrigar', 'liberar')
                   or not exists (select 1 from imobdesk.ch_campos c where c.chave = a ->> 'campo')) then
    perform imobdesk.erro('INVALID_INPUT', 'Revise as ações: cada uma precisa de um campo existente.', 'acoes');
  end if;
  if v_id is null then
    insert into imobdesk.ch_regras_exibicao (nome, condicoes, acoes, ativa, ordem, atualizado_por)
    values (v_nome, v_cond, v_acoes, coalesce((p ->> 'ativa')::boolean, true), coalesce((select max(ordem) from imobdesk.ch_regras_exibicao), 0) + 1, v_ator)
    returning id into v_id;
  else
    update imobdesk.ch_regras_exibicao set nome = v_nome, condicoes = v_cond, acoes = v_acoes, ativa = coalesce((p ->> 'ativa')::boolean, ativa),
           atualizado_em = now(), atualizado_por = v_ator
     where id = v_id;
    if not found then perform imobdesk.erro('NOT_FOUND', 'Regra não encontrada.'); end if;
  end if;
  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', 'update', format('Regra para exibição "%s" salva', v_nome), null, p, v_id::text);
  return v_id;
end;
$$;

/** Macro: Admin salva qualquer uma; o agente salva só as pessoais dele. */
create or replace function imobdesk.ch_macro_salvar(p jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := (select auth.uid());
  v_admin boolean := imobdesk.ch_eh_admin();
  v_id bigint := nullif(p ->> 'id', '')::bigint;
  v_nome text := btrim(coalesce(p ->> 'nome', ''));
  v_escopo text := coalesce(p ->> 'escopo', 'pessoal');
begin
  if not imobdesk.ch_pode_ler() then perform imobdesk.erro('FORBIDDEN', 'Sem acesso à Gestão de Chamados.'); end if;
  if not v_admin and (v_escopo <> 'pessoal'
       or (v_id is not null and not exists (select 1 from imobdesk.ch_macros m where m.id = v_id and m.escopo = 'pessoal' and m.dono_id = v_ator))) then
    perform imobdesk.erro('FORBIDDEN', 'Você só pode criar e editar as suas macros pessoais.');
  end if;
  if length(v_nome) not between 2 and 80 then perform imobdesk.erro('INVALID_INPUT', 'Informe o nome da macro.', 'nome'); end if;
  if v_escopo not in ('pessoal', 'equipe', 'todos') then perform imobdesk.erro('INVALID_INPUT', 'Escopo inválido.', 'escopo'); end if;
  if v_escopo = 'equipe' and nullif(p ->> 'equipeId', '') is null then perform imobdesk.erro('INVALID_INPUT', 'Escolha a equipe.', 'equipeId'); end if;
  if jsonb_typeof(coalesce(p -> 'acoes', '{}')) <> 'object' then perform imobdesk.erro('INVALID_INPUT', 'Ações inválidas.', 'acoes'); end if;
  if v_id is null then
    insert into imobdesk.ch_macros (nome, texto, acoes, escopo, dono_id, equipe_id, ativa, atualizado_por)
    values (v_nome, coalesce(p ->> 'texto', ''), coalesce(p -> 'acoes', '{}'), v_escopo, case when v_escopo = 'pessoal' then v_ator end,
            case when v_escopo = 'equipe' then (p ->> 'equipeId')::bigint end, coalesce((p ->> 'ativa')::boolean, true), v_ator)
    returning id into v_id;
  else
    update imobdesk.ch_macros set nome = v_nome, texto = coalesce(p ->> 'texto', ''), acoes = coalesce(p -> 'acoes', '{}'), escopo = v_escopo,
           dono_id = case when v_escopo = 'pessoal' then coalesce(dono_id, v_ator) end, equipe_id = case when v_escopo = 'equipe' then (p ->> 'equipeId')::bigint end,
           ativa = coalesce((p ->> 'ativa')::boolean, ativa), atualizado_em = now(), atualizado_por = v_ator
     where id = v_id;
    if not found then perform imobdesk.erro('NOT_FOUND', 'Macro não encontrada.'); end if;
  end if;
  return v_id;
end;
$$;

/** Padrões do setor para o ticket: equipe padrão (D5) e SLA padrão em horas úteis (D6). */
create or replace function imobdesk.ch_setor_padroes_salvar(p_setor bigint, p_equipe bigint, p_sla_horas numeric)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := imobdesk.ch_exigir_admin();
begin
  if p_equipe is not null and not exists (select 1 from imobdesk.at_equipes e where e.id = p_equipe and e.setor_id = p_setor) then
    perform imobdesk.erro('INVALID_INPUT', 'A equipe padrão precisa ser do mesmo setor.', 'equipePadraoId');
  end if;
  if p_sla_horas is null or p_sla_horas <= 0 or p_sla_horas > 999 then
    perform imobdesk.erro('INVALID_INPUT', 'SLA padrão inválido.', 'slaPadraoHoras');
  end if;
  update imobdesk.at_setores set equipe_padrao_id = p_equipe, sla_padrao_horas = p_sla_horas, atualizado_em = now(), atualizado_por = v_ator where id = p_setor;
  if not found then perform imobdesk.erro('NOT_FOUND', 'Setor não encontrado.'); end if;
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'ch_cadastros()', 'ch_macros_lista()', 'ch_urgencia_salvar(jsonb)', 'ch_categoria_salvar(jsonb)', 'ch_cadastro_ordenar(text, bigint[])',
    'ch_servico_salvar(jsonb)', 'ch_campo_salvar(jsonb)', 'ch_regra_salvar(jsonb)', 'ch_macro_salvar(jsonb)', 'ch_setor_padroes_salvar(bigint, bigint, numeric)'
  ] loop
    execute format('revoke execute on function imobdesk.%s from public, anon', f);
    execute format('grant execute on function imobdesk.%s to authenticated, service_role', f);
  end loop;
end;
$$;

notify pgrst, 'reload schema';

commit;
