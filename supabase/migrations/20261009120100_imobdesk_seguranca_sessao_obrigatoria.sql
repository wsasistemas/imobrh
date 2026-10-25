-- Segurança do login, etapa 2 de 2: a RLS do portal passa a exigir sessão confiável.
--
-- Aplicar SÓ DEPOIS de publicar a Edge Function imobdesk-auth e o front que loga por ela
-- (ordem completa em docs/SEGURANCA-LOGIN.md). Antes disso, ninguém teria sessão registrada e o
-- portal ficaria sem acesso. Desfazer: recriar as duas funções sem a linha sessao_confiavel()
-- (versão em 20261006141704_..._funcoes_acesso.sql e 20261006141707_..._rpcs_base.sql).
--
-- As duas raízes da autorização do portal passam a exigir sessão confiável. Todas as policies e RPCs
-- usam uma delas (perfil_usuario_atual -> tem_permissao/eh_super_admin/usuario_portal_ativo;
-- perfil_de -> tem_permissao_de/pode_*), então uma sessão aberta direto no Auth não tem perfil no portal.
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
    and u.status <> 'inactive'
    and imobdesk.sessao_confiavel();
$$;

create or replace function imobdesk.perfil_de(p_usuario uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select u.perfil_key
  from imobdesk.usuarios u
  where u.id = p_usuario and u.status <> 'inactive'
    and imobdesk.sessao_confiavel();
$$;

