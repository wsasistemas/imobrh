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
