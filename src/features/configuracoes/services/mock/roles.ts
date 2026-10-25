import { SUPER_ADMIN_ROLE, type RoleKey } from "../../../../config/app";
import { normalizeText } from "../../../../utils/text";
import type { RolesService } from "../contracts";
import { ServiceError, type AuditValues, type RoleSummary } from "../types";
import { db, type RoleRecord, type UserRecord } from "./db";
import {
  canAssignRole,
  canManageRole,
  canPlaceBelow,
  delay,
  findRole,
  isRoleManager,
  recordAudit,
  requireAnyPermission,
  requirePermission,
} from "./runtime";

const MAX_LABEL_LENGTH = 40;

function toSummary(actor: UserRecord, role: RoleRecord): RoleSummary {
  const members = db.users.filter((user) => user.role === role.key);
  const connectedIds = new Set(db.sessions.map((session) => session.userId));
  return {
    key: role.key,
    label: role.label,
    description: role.description,
    userCount: members.length,
    connectedCount: members.filter((user) => connectedIds.has(user.id)).length,
    locked: role.key === SUPER_ADMIN_ROLE,
    assignable: canAssignRole(actor, role.key),
    manageable: canManageRole(actor, role.key),
    canPlaceBelow: canPlaceBelow(actor, role.key),
  };
}

/** Só Super admin e Admin mexem no cadastro de perfis. */
function requireRoleManager(): UserRecord {
  const actor = requirePermission("manage_permissions");
  if (!isRoleManager(actor)) {
    throw new ServiceError("FORBIDDEN", "Somente Super admin e Admin podem cadastrar perfis.");
  }
  return actor;
}

function requireManageable(actor: UserRecord, key: RoleKey): RoleRecord {
  const role = findRole(key);
  if (!canManageRole(actor, key)) {
    throw new ServiceError(
      "FORBIDDEN",
      key === SUPER_ADMIN_ROLE
        ? "O perfil Super admin não pode ser alterado."
        : "Você só pode alterar perfis abaixo do seu na hierarquia.",
    );
  }
  return role;
}

function validateLabel(label: string, exceptKey?: RoleKey): string {
  const clean = label.trim();
  if (clean.length < 2 || clean.length > MAX_LABEL_LENGTH) {
    throw new ServiceError("ROLE_EXISTS", `O nome precisa ter entre 2 e ${MAX_LABEL_LENGTH} caracteres.`, "label");
  }
  const taken = db.roles.some((role) => role.key !== exceptKey && normalizeText(role.label) === normalizeText(clean));
  if (taken) throw new ServiceError("ROLE_EXISTS", "Já existe um perfil com este nome.", "label");
  return clean;
}

function validatePlacement(actor: UserRecord, placeAfter: RoleKey, selfKey?: RoleKey): void {
  findRole(placeAfter);
  if (placeAfter === selfKey || !canPlaceBelow(actor, placeAfter)) {
    throw new ServiceError("ROLE_NOT_ALLOWED", "Escolha uma posição no seu nível ou abaixo dele.", "placeAfter");
  }
}

/** Chave estável derivada do nome (ex.: "Supervisor de vendas" → "supervisor_de_vendas"). */
function uniqueKey(label: string): RoleKey {
  const base = normalizeText(label).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "perfil";
  let key = base;
  for (let suffix = 2; db.roles.some((role) => role.key === key); suffix += 1) key = `${base}_${suffix}`;
  return key;
}

function insertAfter(role: RoleRecord, placeAfter: RoleKey): void {
  const index = db.roles.findIndex((entry) => entry.key === placeAfter);
  db.roles.splice(index + 1, 0, role);
}

export const mockRolesService: RolesService = {
  async list() {
    await delay();
    const actor = requireAnyPermission(["manage_users", "manage_permissions"]);
    return db.roles.map((role) => toSummary(actor, role));
  },

  async create(input) {
    await delay();
    const actor = requireRoleManager();
    const label = validateLabel(input.label);
    validatePlacement(actor, input.placeAfter);

    const role: RoleRecord = {
      key: uniqueKey(label),
      label,
      description: input.description.trim(),
    };
    insertAfter(role, input.placeAfter);
    // Perfil novo começa sem regras: todos os menus negados até serem liberados.
    db.rolePermissions[role.key] = {};
    recordAudit({
      module: "permissoes",
      action: "create",
      description: `Perfil ${role.label} criado`,
      after: { key: role.key, label: role.label },
    });
    return toSummary(actor, role);
  },

  async update(key, input) {
    await delay();
    const actor = requireRoleManager();
    const role = requireManageable(actor, key);
    const label = validateLabel(input.label, key);
    validatePlacement(actor, input.placeAfter, key);

    const before: AuditValues = {};
    const after: AuditValues = {};
    const description = input.description.trim();
    if (label !== role.label) {
      before.label = role.label;
      after.label = label;
    }
    if (description !== role.description) {
      before.description = role.description;
      after.description = description;
    }

    const currentIndex = db.roles.indexOf(role);
    const currentAbove = db.roles[currentIndex - 1]?.key ?? null;
    if (input.placeAfter !== currentAbove) {
      db.roles.splice(currentIndex, 1);
      insertAfter(role, input.placeAfter);
      before.placeAfter = currentAbove;
      after.placeAfter = input.placeAfter;
    }

    role.label = label;
    role.description = description;
    if (Object.keys(after).length > 0) {
      recordAudit({ module: "permissoes", action: "update", description: `Perfil ${role.label} alterado`, before, after });
    }
    return toSummary(actor, role);
  },

  async delete(key) {
    await delay();
    const actor = requireRoleManager();
    const role = requireManageable(actor, key);
    const members = db.users.filter((user) => user.role === key).length;
    if (members > 0) {
      throw new ServiceError(
        "ROLE_IN_USE",
        `O perfil ${role.label} tem ${members} ${members === 1 ? "usuário" : "usuários"}. Mude o perfil ${members === 1 ? "dele" : "deles"} antes de excluir.`,
      );
    }

    db.roles = db.roles.filter((entry) => entry.key !== key);
    delete db.rolePermissions[key];
    recordAudit({
      module: "permissoes",
      action: "delete",
      description: `Perfil ${role.label} excluído`,
      before: { key: role.key, label: role.label },
    });
  },
};
