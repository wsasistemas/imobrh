
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
