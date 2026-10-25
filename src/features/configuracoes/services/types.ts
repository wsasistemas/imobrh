import type { RoleKey } from "../../../config/app";
import type { PermissionId } from "../../../config/menuRegistry";

/** Códigos de regra de negócio. Os mesmos saem do banco (comercial.erro) e das Edge Functions. */
export const SERVICE_ERROR_CODES = [
  "EMAIL_EXISTS",
  "EMAIL_INVALID",
  "ROLE_NOT_ALLOWED",
  "PROTECTED_USER",
  "SELF_ACTION",
  "FORBIDDEN",
  "NOT_FOUND",
  "LOCKED_PERMISSION",
  "INVALID_PASSWORD",
  "PASSWORD_REUSED",
  "ROLE_EXISTS",
  "ROLE_IN_USE",
  "NO_PORTAL_ACCESS",
  "NO_APP_ACCESS",
  "INVALID_INPUT",
  "DUPLICATE",
  "ACCOUNT_EXISTS",
  "INVITE_FAILED",
  "CREATE_FAILED",
  "UNAUTHENTICATED",
  "INTEGRATION_NOT_CONFIGURED",
  "INTEGRATION_INACTIVE",
  "QUERY_EXISTS",
  "QUERY_IN_USE",
  "SYNC_RUNNING",
  "AI_LIMIT",
  "AI_NOT_CONFIGURED",
  "INTERNAL",
] as const;

export type ServiceErrorCode = (typeof SERVICE_ERROR_CODES)[number];

export function isServiceErrorCode(value: unknown): value is ServiceErrorCode {
  return typeof value === "string" && (SERVICE_ERROR_CODES as readonly string[]).includes(value);
}

/** Erro de regra de negócio. `field` indica o campo do formulário que deve exibir a mensagem. */
export class ServiceError extends Error {
  readonly code: ServiceErrorCode;
  readonly field?: string;

  constructor(code: ServiceErrorCode, message: string, field?: string) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
    this.field = field;
  }
}

// ---------- Usuários ----------

export type UserStatus = "active" | "inactive" | "pending";

export interface User {
  id: string;
  name: string;
  email: string;
  role: RoleKey | null;
  /** Nome do perfil para exibição; null quando não há perfil. */
  roleLabel: string | null;
  /** Conta proprietária do portal: sempre Super admin e protegida. */
  isOwner: boolean;
  status: UserStatus;
  /** ISO 8601; null quando o usuário nunca entrou. */
  lastAccessAt: string | null;
  mustChangePassword: boolean;
}

export type UserTab = "all" | "active" | "inactive" | "pending";

export interface UserListParams {
  tab: UserTab;
  search: string;
  role: RoleKey | "all";
  page: number;
}

export interface UserListResult {
  items: User[];
  total: number;
  page: number;
  pageSize: number;
  counts: Record<UserTab, number>;
}

export interface InviteUserInput {
  name: string;
  email: string;
  role: RoleKey;
}

export interface CreateUserWithPasswordInput extends InviteUserInput {
  password: string;
}

export interface UpdateUserInput {
  name?: string;
  email?: string;
  role?: RoleKey;
}

// ---------- Permissões ----------

/** Regras de um perfil. Item ausente = sem regra = negado. */
export type PermissionRules = Partial<Record<PermissionId, boolean>>;

export interface EffectiveAccess {
  user: User;
  role: RoleKey | null;
  roleLabel: string | null;
  isSuperAdmin: boolean;
  /** Pode criar, editar e excluir perfis (Super admin e Admin). */
  canManageRoles: boolean;
  permissions: Record<PermissionId, boolean>;
  mustChangePassword: boolean;
}

// ---------- Perfis ----------

/** Perfil cadastrado. A lista vem ordenada pela hierarquia, do mais alto para o mais baixo. */
export interface RoleSummary {
  key: RoleKey;
  label: string;
  description: string;
  userCount: number;
  /** Usuários do perfil com sessão ativa agora. */
  connectedCount: number;
  /** Super admin: acesso total, não editável. */
  locked: boolean;
  /** O usuário logado pode atribuir este perfil (mesmo nível ou abaixo). */
  assignable: boolean;
  /** O usuário logado pode editar ou excluir este perfil. */
  manageable: boolean;
  /** O usuário logado pode posicionar um perfil logo abaixo deste. */
  canPlaceBelow: boolean;
}

export interface RoleInput {
  label: string;
  description: string;
  /** Chave do perfil logo acima na hierarquia. */
  placeAfter: RoleKey;
}

export interface PermissionChange {
  id: PermissionId;
  enabled: boolean;
}

// ---------- Integrações ----------

export type IntegrationKey = "resend";

export interface IntegrationTestResult {
  at: string;
  ok: boolean;
  message: string;
}

/** Visão pública da integração: o segredo nunca sai do serviço, só a máscara. */
export interface IntegrationView {
  key: IntegrationKey;
  name: string;
  description: string;
  active: boolean;
  sender: string;
  sendAuthEmails: boolean;
  secretMasked: string | null;
  secretSetAt: string | null;
  secretSetBy: string | null;
  lastTest: IntegrationTestResult | null;
}

export interface IntegrationPublicFields {
  sender?: string;
  sendAuthEmails?: boolean;
  active?: boolean;
}

/** Chave do objeto no histórico (auditoria) de Integrações. */
export type IntegrationHistoryKey = IntegrationKey | "totvs_rm" | "consultas_sql";

// ---------- Consultas SQL (catálogo de consultas do TOTVS RM) ----------

export const SQL_QUERY_TYPES = ["resumo", "componentes", "kpis", "grafico", "detalhes", "status"] as const;

export type SqlQueryType = (typeof SQL_QUERY_TYPES)[number];

export interface SqlQuery {
  id: string;
  /** Código da consulta no RM (ex.: API.00.02.001); sem sufixo, a chamada usa /0/X. */
  code: string;
  name: string;
  description: string | null;
  type: SqlQueryType;
  active: boolean;
  order: number;
  /** Parâmetros que abrem preenchidos no teste (ex.: CODEMPREENDIMENTO=229). */
  testParams: string | null;
  /** Sincronização que depende desta consulta; null = consulta livre (pode ser excluída). */
  usedBy: string | null;
  lastTest: IntegrationTestResult | null;
}

export interface SqlQueryInput {
  code: string;
  name: string;
  description: string;
  type: SqlQueryType;
  active: boolean;
  /** Vazio = sem parâmetros de teste. */
  testParams: string;
}

export interface SqlQueryTestResult extends IntegrationTestResult {
  /** URL chamada no RM (sem credencial). */
  url: string;
  /** Status HTTP da resposta do RM (0 quando nem conectou). */
  status: number;
  rowCount: number;
  /** A resposta era grande e foi lida só em parte: rowCount vira "mais de". */
  truncated: boolean;
  columns: string[];
  preview: Record<string, unknown>[];
}

// ---------- Conexão TOTVS RM ----------

export interface TotvsTestResult extends IntegrationTestResult {
  /** Proposta usada no teste; null no teste básico. */
  proposalId: string | null;
  /** URL chamada no RM (sem credencial); só vem na resposta do teste, não no histórico. */
  url?: string;
}

/** Visão da conexão: a senha nunca sai do serviço, só a máscara e quem a definiu. */
export interface TotvsConnectionView {
  url: string;
  user: string;
  active: boolean;
  passwordMasked: string | null;
  passwordSetAt: string | null;
  passwordSetBy: string | null;
  lastTest: TotvsTestResult | null;
}

export interface TotvsConnectionInput {
  url: string;
  user: string;
  /** Vazio mantém a senha salva. */
  password: string;
  active: boolean;
}

// ---------- Auditoria ----------

export type AuditModule = "usuarios" | "permissoes" | "integracoes" | "sessoes" | "autenticacao" | "atendimento";

export type AuditAction =
  | "create"
  | "update"
  | "delete"
  | "deactivate"
  | "activate"
  | "permission"
  | "password_reset"
  | "password_change"
  | "secret"
  | "config"
  | "test"
  | "session_revoked"
  | "login_denied";

export type AuditValues = Record<string, string | number | boolean | null>;

export interface AuditEntry {
  id: string;
  at: string;
  actorId: string | null;
  actorName: string;
  module: AuditModule;
  action: AuditAction;
  description: string;
  origin: string;
  before?: AuditValues;
  after?: AuditValues;
  /** Chave do objeto afetado (ex.: integração), para filtrar históricos. */
  targetKey?: string;
}

export type AuditPeriod = "today" | "7d" | "30d" | "all";

export interface AuditFilters {
  period: AuditPeriod;
  userId: string | "all";
  module: AuditModule | "all";
  action: AuditAction | "all";
}

/** Ações feitas pelo próprio sistema (sem usuário) usam este id no filtro. */
export const SYSTEM_ACTOR_ID = "system";

export interface AuditListResult {
  items: AuditEntry[];
  total: number;
  page: number;
  pageSize: number;
  /** Quem aparece no log (para o filtro "Usuário"), incluindo o Sistema. */
  actors: { id: string; name: string }[];
}

// ---------- Permissões por aplicativo ----------

/** Um aplicativo = um schema exposto na API do Supabase. */
export interface AppAccessApp {
  schema: string;
  name: string;
  url: string | null;
  /** Desligado: todo login da WSA entra (o aplicativo funciona como hoje). */
  controlActive: boolean;
  newLoginsDefault: "bloqueado" | "liberado";
  /** Falso para aplicativo recém-detectado que ninguém configurou ainda. */
  configured: boolean;
  /** O schema está exposto na API de fato (pgrst.db_schemas do banco, que vale mais que o painel). */
  exposed: boolean;
  /** Falso para schema que existe no banco mas nunca foi exposto: aparece só para informar. */
  inCatalog: boolean;
  /** Rótulo do perfil usado no cadastro automático ao liberar alguém (null: aplicativo sem cadastro próprio). */
  defaultProfile?: string | null;
  /** Valor do perfil ao liberar (escolhido na tela ou o mais simples). */
  releaseProfile?: string | null;
  /** Perfis do aplicativo, do mais amplo para o mais simples. */
  profiles?: { value: string; label: string }[];
  /** Schema onde ficam os dados e o cadastro (o próprio schema, ou o compartilhado de um app manual). */
  dataSchema?: string;
  /** Adicionado à mão: chave própria sobre um schema compartilhado (ex.: financeiro sobre o public). */
  manual?: boolean;
  /** Proteção no banco (policy restritiva) ligada nas tabelas do schema. */
  protected?: boolean;
  /** Última vez que o aplicativo chamou pode_acessar_app: indica que a verificação está instalada. */
  lastCheckAt: string | null;
  totalLogins: number;
  allowedCount: number;
}

export interface AppAccessUser {
  id: string;
  name: string;
  email: string;
  lastSignInAt: string | null;
  /** Tem cadastro nas tabelas do próprio aplicativo (usuarios / user_roles / profiles). */
  registered: boolean;
  /** Conta proprietária: sempre pode entrar. */
  owner: boolean;
  /** Conta com sufixo (+projetocontratos…) ou fora do domínio da empresa: não recebe cadastro automático. */
  suffix?: boolean;
  /** O cadastro no aplicativo foi criado por esta tela (e não pelo próprio aplicativo, a origem). */
  registeredByCentral?: boolean;
  canEnter: boolean;
}

/** O que aconteceu ao liberar/bloquear: a porta e o cadastro automático no aplicativo. */
export interface AppAccessGrantResult {
  /** Logins cuja permissão mudou. */
  changed: number;
  /** Cadastrados agora no aplicativo, com o perfil mais simples. */
  created: number;
  /** Tinham cadastro inativo e foram reativados. */
  reactivated: number;
  /** Contas com sufixo ou de fora: liberadas, mas sem cadastro automático. */
  skippedSuffix: number;
  profile: string | null;
}

export interface AppAccessAppInput {
  name: string;
  url: string;
  newLoginsDefault: "bloqueado" | "liberado";
  /** Perfil usado ao liberar; null = o mais simples do aplicativo. */
  releaseProfile?: string | null;
}

/** Aplicativo que divide um schema com outros (ex.: Financeiro sobre o public). */
export interface AppAccessNewApp {
  key: string;
  name: string;
  url: string;
  dataSchema: string;
}

// ---------- Sessões ----------

export interface ActiveSession {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  device: string;
  location: string;
  startedAt: string;
  lastActivityAt: string;
  isCurrent: boolean;
}
