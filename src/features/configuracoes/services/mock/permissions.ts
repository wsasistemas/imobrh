import { SUPER_ADMIN_ROLE } from "../../../../config/app";
import { getPermission } from "../../../../config/menuRegistry";
import { computePermissions } from "../../access/policy";
import type { PermissionsService } from "../contracts";
import { ServiceError } from "../types";
import { db } from "./db";
import {
  currentActor,
  delay,
  findRole,
  isRoleManager,
  recordAudit,
  requirePermission,
  roleLabelOf,
  rulesFor,
  toPublicUser,
} from "./runtime";

export const mockPermissionsService: PermissionsService = {
  async getRolePermissions(role) {
    await delay();
    requirePermission("manage_permissions");
    findRole(role);
    return { ...rulesFor(role) };
  },

  async saveRolePermissions(role, changes) {
    await delay();
    requirePermission("manage_permissions");
    const target = findRole(role);
    if (role === SUPER_ADMIN_ROLE) {
      throw new ServiceError("LOCKED_PERMISSION", "O perfil Super admin tem acesso total e não é editável.");
    }

    // Valida o lote inteiro antes de gravar: ou salva tudo, ou nada.
    for (const change of changes) {
      const item = getPermission(change.id);
      if (item.alwaysVisible || item.superAdminOnly) {
        throw new ServiceError("LOCKED_PERMISSION", `O menu ${item.label} não pode ser alterado por perfil.`);
      }
    }

    const rules = (db.rolePermissions[role] ??= {});
    for (const change of changes) {
      const previous = rules[change.id];
      if (previous === change.enabled) continue;
      rules[change.id] = change.enabled;
      recordAudit({
        module: "permissoes",
        action: "permission",
        description: `Perfil ${target.label}: ${getPermission(change.id).label} ${change.enabled ? "liberado" : "negado"}`,
        before: { enabled: previous ?? null },
        after: { enabled: change.enabled },
      });
    }
  },

  async getEffectiveAccess() {
    await delay();
    const actor = currentActor();
    const rules = rulesFor(actor.role);
    const permissions = computePermissions(actor.role, rules);

    return {
      user: toPublicUser(actor),
      role: actor.role,
      roleLabel: roleLabelOf(actor.role),
      isSuperAdmin: actor.role === SUPER_ADMIN_ROLE,
      canManageRoles: isRoleManager(actor) && permissions.manage_permissions,
      permissions,
      mustChangePassword: actor.mustChangePassword,
    };
  },
};
