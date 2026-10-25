import type { AuditAction, AuditModule } from "./types";

export const AUDIT_MODULE_LABELS: Record<AuditModule, string> = {
  usuarios: "Usuários",
  permissoes: "Perfis e permissões",
  integracoes: "Integrações",
  sessoes: "Sessões",
  autenticacao: "Autenticação",
  atendimento: "Administração",
};

export const AUDIT_ACTION_LABELS: Record<AuditAction, string> = {
  create: "Criação",
  update: "Alteração",
  delete: "Exclusão",
  deactivate: "Inativação",
  activate: "Reativação",
  permission: "Permissão",
  password_reset: "Redefinição de senha",
  password_change: "Troca de senha",
  secret: "Segredo",
  config: "Configuração",
  test: "Teste",
  session_revoked: "Sessão encerrada",
  login_denied: "Login negado",
};
