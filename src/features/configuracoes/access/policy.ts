import { ADMIN_ROLE, SUPER_ADMIN_ROLE, type RoleKey } from "../../../config/app";
import { getPermission, permissionEntries, type PermissionEntry, type PermissionId } from "../../../config/menuRegistry";
import type { PermissionRules } from "../services/types";

/**
 * Regra única de decisão de acesso:
 * sempre visível > super admin tem tudo > exclusivo de super admin > exclusivo de admin (regra fixa) > regra do perfil.
 * Sem regra = negado.
 */
export function isAllowed(item: Pick<PermissionEntry, "id" | "alwaysVisible" | "superAdminOnly" | "adminOnly">, role: RoleKey | null, rules: PermissionRules): boolean {
  if (item.alwaysVisible) return true;
  if (role === SUPER_ADMIN_ROLE) return true;
  if (item.superAdminOnly || !role) return false;
  if (item.adminOnly) return role === ADMIN_ROLE;
  return rules[item.id] === true;
}

/** Permissão efetiva: uma ação só vale junto com a permissão do item a que pertence. */
export function isEffectivelyAllowed(id: PermissionId, role: RoleKey | null, rules: PermissionRules): boolean {
  const entry = getPermission(id);
  if (!isAllowed(entry, role, rules)) return false;
  return entry.kind !== "action" || !entry.parent || isEffectivelyAllowed(entry.parent, role, rules);
}

/** Mapa completo de permissões do usuário, entregue pronto ao AccessProvider. */
export function computePermissions(role: RoleKey | null, rules: PermissionRules): Record<PermissionId, boolean> {
  return Object.fromEntries(
    permissionEntries.map((entry) => [entry.id, isEffectivelyAllowed(entry.id, role, rules)]),
  ) as Record<PermissionId, boolean>;
}
