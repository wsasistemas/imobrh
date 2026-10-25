import type { RoleKey } from "../../../config/app";
import type {
  ActiveSession,
  AppAccessApp,
  AppAccessAppInput,
  AppAccessGrantResult,
  AppAccessNewApp,
  AppAccessUser,
  AuditEntry,
  AuditFilters,
  AuditListResult,
  CreateUserWithPasswordInput,
  EffectiveAccess,
  IntegrationHistoryKey,
  IntegrationKey,
  IntegrationPublicFields,
  IntegrationTestResult,
  IntegrationView,
  InviteUserInput,
  PermissionChange,
  PermissionRules,
  RoleInput,
  RoleSummary,
  SqlQuery,
  SqlQueryInput,
  SqlQueryTestResult,
  TotvsConnectionInput,
  TotvsConnectionView,
  TotvsTestResult,
  UpdateUserInput,
  User,
  UserListParams,
  UserListResult,
} from "./types";

// Contratos da camada de dados. Hoje a implementação é mock (./mock); a versão
// Supabase implementa as mesmas interfaces sem alterar hooks nem telas.

export interface UsersService {
  list(params: UserListParams): Promise<UserListResult>;
  invite(input: InviteUserInput): Promise<User>;
  createWithTempPassword(input: CreateUserWithPasswordInput): Promise<User>;
  update(id: string, input: UpdateUserInput): Promise<User>;
  setActive(id: string, active: boolean): Promise<User>;
  delete(id: string): Promise<void>;
  sendPasswordReset(id: string): Promise<void>;
  /** Liga/desliga a troca de senha obrigatória no próximo login (a senha atual continua valendo). */
  setPasswordChangeRequired(id: string, required: boolean): Promise<User>;
  /** Define uma senha temporária (troca obrigatória no próximo login). O login é compartilhado com
   * os outros sistemas da WSA: a senha nova vale em todos. */
  setTemporaryPassword(id: string, password: string): Promise<User>;
}

export interface RolesService {
  /** Perfis em ordem de hierarquia, com as ações liberadas para o usuário logado. */
  list(): Promise<RoleSummary[]>;
  create(input: RoleInput): Promise<RoleSummary>;
  update(key: RoleKey, input: RoleInput): Promise<RoleSummary>;
  /** Recusa perfil com usuários vinculados (ROLE_IN_USE). */
  delete(key: RoleKey): Promise<void>;
}

export interface PermissionsService {
  getRolePermissions(role: RoleKey): Promise<PermissionRules>;
  saveRolePermissions(role: RoleKey, changes: PermissionChange[]): Promise<void>;
  getEffectiveAccess(): Promise<EffectiveAccess>;
}

export interface IntegrationsService {
  get(key: IntegrationKey): Promise<IntegrationView>;
  update(key: IntegrationKey, fields: IntegrationPublicFields): Promise<IntegrationView>;
  replaceSecret(key: IntegrationKey, secret: string): Promise<IntegrationView>;
  test(key: IntegrationKey): Promise<IntegrationTestResult>;
  history(key: IntegrationHistoryKey): Promise<AuditEntry[]>;
}

/** Conexão TOTVS RM (somente super admin). A senha é só de escrita. */
export interface TotvsService {
  getConnection(): Promise<TotvsConnectionView>;
  saveConnection(input: TotvsConnectionInput): Promise<TotvsConnectionView>;
  /** Teste só de leitura no RM; com proposta, confere também o acesso a ela. */
  testConnection(proposalId: string | null): Promise<TotvsTestResult>;
}

/** Catálogo de consultas do TOTVS RM (aba Consultas SQL, somente super admin). */
export interface SqlQueriesService {
  list(): Promise<SqlQuery[]>;
  /** id null cria; devolve o id salvo. */
  save(id: string | null, input: SqlQueryInput): Promise<string>;
  setActive(id: string, active: boolean): Promise<void>;
  move(id: string, direction: "up" | "down"): Promise<void>;
  /** Recusa consulta usada por uma sincronização (QUERY_IN_USE). */
  delete(id: string): Promise<void>;
  /** Roda no RM (só leitura); parâmetros no formato "NOME=valor;NOME2=valor". */
  test(id: string, parameters: string): Promise<SqlQueryTestResult>;
}

export interface AuditService {
  list(filters: AuditFilters, page: number): Promise<AuditListResult>;
  exportCsv(filters: AuditFilters): Promise<string>;
}

export interface AppAccessService {
  /** Catálogo, já sincronizado com os schemas expostos. Só Super admin. */
  listApps(): Promise<AppAccessApp[]>;
  listUsers(schema: string): Promise<AppAccessUser[]>;
  saveApp(schema: string, input: AppAccessAppInput): Promise<void>;
  /** Aplicativo com chave própria sobre um schema compartilhado. */
  addApp(input: AppAccessNewApp): Promise<void>;
  /** Ao ligar, quem já tem cadastro no aplicativo entra liberado; os demais, bloqueados. */
  setControl(schema: string, active: boolean): Promise<void>;
  /** Ao liberar, também cadastra no aplicativo com o perfil mais simples (a conta proprietária é ignorada). */
  setPermission(schema: string, userIds: string[], canEnter: boolean): Promise<AppAccessGrantResult>;
  /** Regra aplicada ao usuário logado neste aplicativo (APP_SCHEMA). */
  canAccessCurrentApp(): Promise<boolean>;
}

export interface SessionsService {
  list(): Promise<ActiveSession[]>;
  revoke(sessionId: string): Promise<void>;
}

/**
 * Lado "dados" da sessão. O login em si é feito pelo Supabase Auth (features/auth);
 * aqui o serviço só fica sabendo quem entrou. `listSwitchableUsers`/`switchUser` existem só
 * para o seletor "Ver como" de desenvolvimento.
 */
export interface AuthService {
  /** Informa o e-mail da sessão do Supabase (null ao sair). Na versão Supabase o JWT já identifica: no-op. */
  bindSession(email: string | null): Promise<void>;
  /** Troca obrigatória: valida as regras, recusa a senha temporária e libera o acesso. */
  changePassword(newPassword: string): Promise<void>;
  /** Confere a senha atual do usuário logado (antes de ele trocar a própria senha). */
  verifyCurrentPassword(password: string): Promise<void>;
  /** Encerra a sessão do portal antes do signOut do Supabase. */
  endSession(): Promise<void>;
  listSwitchableUsers(): Promise<User[]>;
  switchUser(userId: string): Promise<void>;
}
