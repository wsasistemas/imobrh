import { SUPER_ADMIN_ROLE } from "../../../../config/app";
import { getPermission } from "../../../../config/menuRegistry";
import { principalRole } from "../../access/policy";
import type { PermissionsService } from "../contracts";
import { ServiceError } from "../types";
import { db } from "./db";
import {
  currentActor,
  delay,
  hasConsoleRole,
  isAdmin,
  permissionsOf,
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
    return { ...rulesFor(role) };
  },

  async saveRolePermissions(role, changes) {
    await delay();
    requirePermission("manage_permissions");
    if (role === SUPER_ADMIN_ROLE) {
      throw new ServiceError("ESTADO_INVALIDO", "O papel Administrador tem acesso total e não é editável.");
    }
    const rules = (db.rolePermissions[role] ??= {});
    for (const change of changes) {
      const previous = rulesFor(role)[change.id];
      if (previous === change.enabled) continue;
      rules[change.id] = change.enabled;
      recordAudit({
        module: "permissoes",
        action: "permission",
        description: `Papel ${roleLabelOf(role)}: ${getPermission(change.id).label} ${change.enabled ? "liberado" : "negado"}`,
        before: { enabled: previous ?? null },
        after: { enabled: change.enabled },
      });
    }
  },

  async getEffectiveAccess() {
    await delay();
    const actor = currentActor();
    if (!hasConsoleRole(actor)) {
      throw new ServiceError("NO_APP_ACCESS", "O seu login não tem papel de RH no Console. Peça ao Administrador do RH.");
    }
    const role = principalRole(actor.roles);
    return {
      user: toPublicUser(actor),
      role,
      roleLabel: roleLabelOf(role),
      isSuperAdmin: isAdmin(actor),
      canManageRoles: false,
      permissions: permissionsOf(actor),
      mustChangePassword: false,
    };
  },
};
