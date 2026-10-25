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
