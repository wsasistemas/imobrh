import type { RoleKey } from "../../../config/app";
import type { AuditFilters, IntegrationHistoryKey, UserListParams } from "../services/types";

// Chaves do TanStack Query centralizadas, para invalidar sempre pelo mesmo nome.
export const queryKeys = {
  access: ["access"] as const,
  switchableUsers: ["switchable-users"] as const,
  usersRoot: ["users"] as const,
  users: (params: UserListParams) => ["users", params] as const,
  roles: ["roles"] as const,
  rolePermissions: (role: RoleKey) => ["role-permissions", role] as const,
  integrationHistory: (key: IntegrationHistoryKey) => ["integration", key, "history"] as const,
  // Mesmo prefixo das integrações: invalidar a conexão recarrega também o histórico dela.
  totvsConnection: ["integration", "totvs_rm"] as const,
  // Idem: invalidar as consultas recarrega também o histórico delas.
  sqlQueries: ["integration", "consultas_sql"] as const,
  auditRoot: ["audit"] as const,
  audit: (filters: AuditFilters, page: number) => ["audit", filters, page] as const,
  sessions: ["sessions"] as const,
  pendingLinks: ["vinculos", "pendentes"] as const,
};
