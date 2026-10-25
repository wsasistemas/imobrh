
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
