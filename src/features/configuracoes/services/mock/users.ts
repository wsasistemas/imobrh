import { SUPER_ADMIN_ROLE } from "../../../../config/app";
import { normalizeText } from "../../../../utils/text";
import { meetsPasswordRules, MIN_PASSWORD_LENGTH } from "../../access/passwordRules";
import type { UsersService } from "../contracts";
import { ServiceError, type AuditValues, type UserTab } from "../types";
import { db, type UserRecord } from "./db";
import {
  assertAllowedEmail,
  assertNotOwner,
  assertRoleAllowed,
  delay,
  findUser,
  newId,
  recordAudit,
  requirePermission,
  roleLabelOf,
  toPublicUser,
} from "./runtime";

const PAGE_SIZE = 10;

function assertEmailFree(email: string, exceptId?: string): void {
  const target = normalizeText(email);
  const taken = db.users.some((user) => user.id !== exceptId && normalizeText(user.email) === target);
  if (taken) {
    throw new ServiceError(
      "EMAIL_EXISTS",
      "Este e-mail já pertence a um usuário. Para mudar senha ou perfil, edite o usuário existente.",
      "email",
    );
  }
}

/** Regras 4 e 5 + conta proprietária: ninguém mexe no dono do portal, super admin só é alterado
 * por super admin e ninguém age sobre a própria conta. */
function assertCanManage(actor: UserRecord, target: UserRecord, selfMessage: string): void {
  if (target.id !== actor.id) assertNotOwner(target);
  if (target.role === SUPER_ADMIN_ROLE && actor.role !== SUPER_ADMIN_ROLE) {
    throw new ServiceError("PROTECTED_USER", "Somente um super admin pode alterar outro super admin.");
  }
  if (target.id === actor.id) {
    throw new ServiceError("SELF_ACTION", selfMessage);
  }
}

function matchesTab(user: UserRecord, tab: UserTab): boolean {
  if (tab === "all") return true;
  return user.status === tab;
}

export const mockUsersService: UsersService = {
  async list({ tab, search, role, page }) {
    await delay();
    requirePermission("manage_users");

    const term = normalizeText(search);
    const filtered = db.users
      .filter((user) => role === "all" || user.role === role)
      .filter((user) => !term || normalizeText(user.name).includes(term) || normalizeText(user.email).includes(term))
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));

    const counts: Record<UserTab, number> = {
      all: filtered.length,
      active: filtered.filter((user) => matchesTab(user, "active")).length,
      inactive: filtered.filter((user) => matchesTab(user, "inactive")).length,
      pending: filtered.filter((user) => matchesTab(user, "pending")).length,
    };

    const inTab = filtered.filter((user) => matchesTab(user, tab));
    const start = (page - 1) * PAGE_SIZE;

    return {
      items: inTab.slice(start, start + PAGE_SIZE).map(toPublicUser),
      total: inTab.length,
      page,
      pageSize: PAGE_SIZE,
      counts,
    };
  },

  async invite({ name, email, role }) {
    await delay();
    const actor = requirePermission("manage_users");
    assertAllowedEmail(email);
    assertEmailFree(email);
    assertRoleAllowed(actor, role);

    const user: UserRecord = {
      id: newId("u"),
      name: name.trim(),
      email: email.trim().toLowerCase(),
      role,
      isOwner: false,
      status: "pending",
      lastAccessAt: null,
      // O convidado define a senha no primeiro acesso.
      mustChangePassword: true,
      tempPassword: null,
    };
    db.users.push(user);
    recordAudit({
      module: "usuarios",
      action: "create",
      description: `Convite enviado para ${user.name} (${roleLabelOf(role)})`,
      after: { name: user.name, email: user.email, role },
    });
    return toPublicUser(user);
  },

  async createWithTempPassword({ name, email, role, password }) {
    await delay();
    const actor = requirePermission("manage_users");
    assertAllowedEmail(email);
    assertEmailFree(email);
    assertRoleAllowed(actor, role);
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new ServiceError("INVALID_PASSWORD", "A senha temporária precisa de pelo menos 8 caracteres.", "password");
    }

    const user: UserRecord = {
      id: newId("u"),
      name: name.trim(),
      email: email.trim().toLowerCase(),
      role,
      isOwner: false,
      status: "active",
      lastAccessAt: null,
      mustChangePassword: true,
      tempPassword: password,
    };
    db.users.push(user);
    recordAudit({
      module: "usuarios",
      action: "create",
      description: `Conta de ${user.name} criada com senha temporária (${roleLabelOf(role)})`,
      after: { name: user.name, email: user.email, role, mustChangePassword: true },
    });
    return toPublicUser(user);
  },

  async update(id, input) {
    await delay();
    const actor = requirePermission("manage_users");
    const target = findUser(id);

    if (target.id !== actor.id) assertNotOwner(target);
    if (target.role === SUPER_ADMIN_ROLE && actor.role !== SUPER_ADMIN_ROLE) {
      throw new ServiceError("PROTECTED_USER", "Somente um super admin pode alterar outro super admin.");
    }

    const nextEmail = input.email?.trim().toLowerCase() ?? target.email;
    const nextRole = input.role ?? target.role;
    const roleChanged = input.role !== undefined && input.role !== target.role;
    const emailChanged = nextEmail !== target.email;

    if (roleChanged && target.id === actor.id) {
      throw new ServiceError("SELF_ACTION", "Você não pode alterar o seu próprio perfil.", "role");
    }
    if (emailChanged) {
      // O e-mail do dono identifica a conta proprietária: não muda.
      if (target.isOwner) {
        throw new ServiceError("PROTECTED_USER", "O e-mail da conta proprietária não pode ser trocado.", "email");
      }
      assertAllowedEmail(nextEmail);
      assertEmailFree(nextEmail, target.id);
    }
    if (roleChanged && nextRole) assertRoleAllowed(actor, nextRole);

    const before: AuditValues = {};
    const after: AuditValues = {};
    const nextName = input.name?.trim() ?? target.name;
    if (nextName !== target.name) {
      before.name = target.name;
      after.name = nextName;
    }
    if (emailChanged) {
      before.email = target.email;
      after.email = nextEmail;
    }
    if (roleChanged) {
      before.role = target.role;
      after.role = nextRole;
    }

    if (Object.keys(after).length > 0) {
      target.name = nextName;
      target.email = nextEmail;
      target.role = nextRole;
      recordAudit({
        module: "usuarios",
        action: "update",
        description: `Dados de ${target.name} alterados`,
        before,
        after,
      });
    }
    return toPublicUser(target);
  },

  async setActive(id, active) {
    await delay();
    const actor = requirePermission("manage_users");
    const target = findUser(id);
    assertCanManage(actor, target, "Você não pode inativar a sua própria conta.");

    const previous = target.status;
    if (active) {
      target.status = target.lastAccessAt ? "active" : "pending";
      recordAudit({
        module: "usuarios",
        action: "activate",
        description: `Conta de ${target.name} reativada`,
        before: { status: previous },
        after: { status: target.status },
      });
    } else {
      // Regra 6: inativar bloqueia o acesso e encerra todas as sessões do usuário.
      const revoked = db.sessions.filter((session) => session.userId === target.id).length;
      db.sessions = db.sessions.filter((session) => session.userId !== target.id);
      target.status = "inactive";
      recordAudit({
        module: "usuarios",
        action: "deactivate",
        description: `Conta de ${target.name} inativada e ${revoked} ${revoked === 1 ? "sessão encerrada" : "sessões encerradas"}`,
        before: { status: previous },
        after: { status: "inactive" },
      });
    }
    return toPublicUser(target);
  },

  async delete(id) {
    await delay();
    const actor = requirePermission("manage_users");
    const target = findUser(id);
    assertCanManage(actor, target, "Você não pode excluir a sua própria conta.");

    db.users = db.users.filter((user) => user.id !== target.id);
    db.sessions = db.sessions.filter((session) => session.userId !== target.id);
    recordAudit({
      module: "usuarios",
      action: "delete",
      description: `Conta de ${target.name} excluída`,
      before: { name: target.name, email: target.email, role: target.role },
    });
  },

  async setPasswordChangeRequired(id, required) {
    await delay();
    const actor = requirePermission("manage_users");
    const target = findUser(id);
    assertCanManage(actor, target, "Para a sua própria conta, use “Alterar senha”.");
    if (target.mustChangePassword !== required) {
      recordAudit({
        module: "usuarios",
        action: "update",
        description: required
          ? `Troca de senha exigida no próximo login de ${target.name}`
          : `Exigência de troca de senha removida de ${target.name}`,
        before: { must_change_password: target.mustChangePassword },
        after: { must_change_password: required },
      });
      target.mustChangePassword = required;
    }
    return toPublicUser(target);
  },

  async setTemporaryPassword(id, password) {
    await delay();
    const actor = requirePermission("manage_users");
    const target = findUser(id);
    assertCanManage(actor, target, "Para a sua própria conta, use “Alterar senha”.");
    if (!meetsPasswordRules(password)) {
      throw new ServiceError("INVALID_PASSWORD", "A senha temporária não atende às regras.", "password");
    }
    target.tempPassword = password;
    target.mustChangePassword = true;
    recordAudit({
      module: "usuarios",
      action: "password_reset",
      description: `Senha temporária definida para ${target.name} (troca obrigatória no próximo login)`,
      after: { must_change_password: true },
    });
    return toPublicUser(target);
  },

  async sendPasswordReset(id) {
    await delay();
    const actor = requirePermission("manage_users");
    const target = findUser(id);
    if (target.id !== actor.id) assertNotOwner(target);
    if (target.role === SUPER_ADMIN_ROLE && actor.role !== SUPER_ADMIN_ROLE) {
      throw new ServiceError("PROTECTED_USER", "Somente um super admin pode alterar outro super admin.");
    }
    recordAudit({
      module: "usuarios",
      action: "password_reset",
      description: `Link de redefinição de senha enviado para ${target.email}`,
    });
  },
};
