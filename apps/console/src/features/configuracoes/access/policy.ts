import { ADMIN_ROLE, SUPER_ADMIN_ROLE, type RoleKey } from "../../../config/app";
import { getPermission, permissionEntries, type PermissionEntry, type PermissionId } from "../../../config/menuRegistry";
import { PAPEIS } from "@imobrh/shared";
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

/**
 * Permissões de um login com vários papéis: vale o que qualquer um dos papéis libera. O Administrador tem tudo.
 * `rulesByRole` traz as regras efetivas de cada papel (padrão do banco com as alterações da empresa por cima).
 */
export function computePermissionsForRoles(
  roles: readonly RoleKey[],
  rulesByRole: Partial<Record<RoleKey, PermissionRules>>,
): Record<PermissionId, boolean> {
  if (roles.includes(SUPER_ADMIN_ROLE)) return computePermissions(SUPER_ADMIN_ROLE, {});
  const union = Object.fromEntries(permissionEntries.map((entry) => [entry.id, false])) as Record<PermissionId, boolean>;
  for (const role of roles) {
    const permissions = computePermissions(role, rulesByRole[role] ?? {});
    for (const entry of permissionEntries) if (permissions[entry.id]) union[entry.id] = true;
  }
  return union;
}

/** Papel principal para exibição: o mais alto da lista do PRD (admin, rh_dp, … colaborador). */
export function principalRole(roles: readonly RoleKey[]): RoleKey | null {
  return [...roles].sort((a, b) => papelOrder(a) - papelOrder(b))[0] ?? null;
}

function papelOrder(role: RoleKey): number {
  const index = (PAPEIS as readonly string[]).indexOf(role);
  return index === -1 ? PAPEIS.length : index;
}
