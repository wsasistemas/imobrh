import type { RoleKey } from "../../../config/app";
import type { AuditFilters, IntegrationHistoryKey, IntegrationKey, UserListParams } from "../services/types";

// Chaves do TanStack Query centralizadas, para invalidar sempre pelo mesmo nome.
export const queryKeys = {
  access: ["access"] as const,
  switchableUsers: ["switchable-users"] as const,
  usersRoot: ["users"] as const,
  users: (params: UserListParams) => ["users", params] as const,
  roles: ["roles"] as const,
  rolePermissions: (role: RoleKey) => ["role-permissions", role] as const,
  integration: (key: IntegrationKey) => ["integration", key] as const,
  integrationHistory: (key: IntegrationHistoryKey) => ["integration", key, "history"] as const,
  // Mesmo prefixo das integrações: invalidar a conexão recarrega também o histórico dela.
  totvsConnection: ["integration", "totvs_rm"] as const,
  // Idem: invalidar as consultas recarrega também o histórico delas.
  sqlQueries: ["integration", "consultas_sql"] as const,
  syncStatus: ["sync-status"] as const,
  syncSchedule: ["sync-schedule"] as const,
  // Prefixo comum: terminar uma sincronização recarrega todas as abas de dados.
  syncData: ["sync-data"] as const,
  syncLogs: (status: string | null, api: string | null) => ["sync-data", "logs", status, api] as const,
  syncUnits: ["sync-data", "units"] as const,
  syncTable: (table: string, ...args: unknown[]) => ["sync-data", table, ...args] as const,
  // Fora do prefixo "sync-data": terminar a sincronização dos limites invalida valueRules à parte.
  valueRules: ["value-rules"] as const,
  valueRulesView: ["value-rules", "view"] as const,
  globalLimits: ["value-rules", "globals"] as const,
  kpiGrid: ["value-rules", "grid"] as const,
  unitLimits: (coligada: string, code: string) => ["value-rules", "unit", coligada, code] as const,
  limitHistory: (unit: string | null) => ["value-rules", "history", unit] as const,
  auditRoot: ["audit"] as const,
  audit: (filters: AuditFilters, page: number) => ["audit", filters, page] as const,
  sessions: ["sessions"] as const,
  // Prefixo comum: mudar um aplicativo recarrega o catálogo e a lista de logins dele.
  appAccess: ["app-access"] as const,
  appAccessUsers: (schema: string) => ["app-access", "users", schema] as const,
};
