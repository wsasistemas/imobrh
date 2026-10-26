-- Stub do imobdesk para os testes de banco do ImobRH. As migrations do imobdesk vivem no repositório dele;
-- aqui fica só o que o app_imobrh lê: empresas, usuarios, empresa_atual() e sessao_confiavel().
-- Mesmas assinaturas e mesma regra de empresa do ikvj (ver imobdesk 20261024000200_imobdesk_empresa_edge.sql).

create schema imobdesk;
grant usage on schema imobdesk to authenticated, service_role;

create table imobdesk.empresas (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  ativa boolean not null default true,
  modelo boolean not null default false,
  created_at timestamptz not null default now()
);

create table imobdesk.usuarios (
  tenant_id uuid not null references imobdesk.empresas (id),
  id uuid not null references auth.users (id) on delete cascade,
  email text not null,
  nome text not null,
  status text not null default 'active' check (status in ('active', 'inactive', 'pending')),
  created_at timestamptz not null default now(),
  primary key (tenant_id, id)
);

-- Contexto do servidor (GUC) > cabeçalho x-empresa-id da service_role > primeiro cadastro ativo do login.
create function imobdesk.empresa_atual()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_papel text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
                           nullif(current_setting('request.jwt.claim.role', true), ''));
  v_empresa uuid := nullif(current_setting('imobdesk.empresa_id', true), '')::uuid;
begin
  if v_empresa is not null or v_papel is null then
    return v_empresa;
  end if;
  if v_papel = 'service_role' then
    return nullif(nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-empresa-id', '')::uuid;
  end if;
  select u.tenant_id into v_empresa
    from imobdesk.usuarios u
   where u.id = auth.uid() and u.status <> 'inactive'
   order by u.created_at
   limit 1;
  return v_empresa;
end;
$$;

-- No ikvj: a sessão de senha só vale se o gateway imobdesk-auth a registrou. Aqui o teste liga e desliga
-- pelo claim "sessao_confiavel" (padrão: confiável).
create function imobdesk.sessao_confiavel()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((auth.jwt() ->> 'sessao_confiavel')::boolean, true);
$$;

grant execute on function imobdesk.empresa_atual(), imobdesk.sessao_confiavel() to authenticated, service_role;
