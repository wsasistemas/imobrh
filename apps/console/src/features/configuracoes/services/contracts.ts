import type { RoleKey } from "../../../config/app";
import type {
  ActiveSession,
  AuditEntry,
  AuditFilters,
  AuditListResult,
  EffectiveAccess,
  IntegrationHistoryKey,
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
  User,
  UserListParams,
  UserListResult,
} from "./types";

// Contratos da camada de dados. Duas implementações: Supabase (schema app_imobrh e Edge Functions) e mock
// (memória, para demonstração e testes). Hooks e telas não mudam entre elas.

/** Usuários do ImobRH: as contas são as do imobdesk; aqui só se atribuem os papéis. */
export interface UsersService {
  list(params: UserListParams): Promise<UserListResult>;
  /** Troca os papéis manuais (os de origem RM, colaborador e gestor, ficam). Devolve o usuário atualizado. */
  setRoles(id: string, roles: RoleKey[]): Promise<User>;
}

export interface RolesService {
  /** Os 8 papéis do PRD v2, com contagens e o que o usuário logado pode atribuir. */
  list(): Promise<RoleSummary[]>;
  /** Os papéis são fixos: criar, editar e excluir recusam (mantidos pelo contrato das telas herdadas). */
  create(input: RoleInput): Promise<RoleSummary>;
  update(key: RoleKey, input: RoleInput): Promise<RoleSummary>;
  delete(key: RoleKey): Promise<void>;
}

export interface PermissionsService {
  getRolePermissions(role: RoleKey): Promise<PermissionRules>;
  saveRolePermissions(role: RoleKey, changes: PermissionChange[]): Promise<void>;
  getEffectiveAccess(): Promise<EffectiveAccess>;
}

export interface IntegrationsService {
  history(key: IntegrationHistoryKey): Promise<AuditEntry[]>;
}

/** Conexão TOTVS RM. A senha do usuário de integração é só de escrita (vai para o Vault). */
export interface TotvsService {
  getConnection(): Promise<TotvsConnectionView>;
  saveConnection(input: TotvsConnectionInput): Promise<TotvsConnectionView>;
  /** Pede um token novo ao RM (POST /api/connect/token) pela Edge Function rm-token. */
  testConnection(proposalId: string | null): Promise<TotvsTestResult>;
}

/** Catálogo das Consultas SQL do RM (API.RH.*). */
export interface SqlQueriesService {
  list(): Promise<SqlQuery[]>;
  /** id null cria; devolve o id salvo. */
  save(id: string | null, input: SqlQueryInput): Promise<string>;
  setActive(id: string, active: boolean): Promise<void>;
  move(id: string, direction: "up" | "down"): Promise<void>;
  /** Recusa consulta usada por uma Edge Function (ESTADO_INVALIDO). */
  delete(id: string): Promise<void>;
  /** Roda no RM (só leitura); parâmetros no formato "NOME=valor;NOME2=valor". */
  test(id: string, parameters: string): Promise<SqlQueryTestResult>;
}

export interface AuditService {
  list(filters: AuditFilters, page: number): Promise<AuditListResult>;
  exportCsv(filters: AuditFilters): Promise<string>;
}

export interface SessionsService {
  list(): Promise<ActiveSession[]>;
  revoke(sessionId: string): Promise<void>;
}

/** Vínculo dos logins com o TOTVS RM (tela Vínculos pendentes). */
export interface VinculosService {
  listPending(): Promise<PendingLink[]>;
  /** Procura o CPF no RM (Edge Function rm-funcionario) e grava o vínculo: vinculado, pendente ou divergente. */
  link(userId: string, cpf: string): Promise<LinkResult>;
}

export interface PendingLink {
  userId: string;
  name: string;
  email: string;
  status: "sem_registro" | "pendente" | "divergente";
  reason: string | null;
  /** CPF mascarado (***.456.***-01) do último vínculo tentado. */
  cpfMasked: string | null;
  updatedAt: string;
}

export interface LinkResult {
  status: "vinculado" | "pendente" | "divergente";
  chapa: string | null;
  name: string | null;
  reason: string | null;
}

/**
 * Lado "dados" da sessão. O login é feito pelo gateway imobdesk-auth (features/auth); aqui o serviço só fica
 * sabendo quem entrou. `listSwitchableUsers`/`switchUser` existem só para o "Ver como" do modo mock.
 */
export interface AuthService {
  bindSession(email: string | null): Promise<void>;
  endSession(): Promise<void>;
  listSwitchableUsers(): Promise<User[]>;
  switchUser(userId: string): Promise<void>;
}
