
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
