import { isAllowedLoginEmail } from "../../../../config/app";
import { meetsPasswordRules } from "../../access/passwordRules";
import type { AuthService } from "../contracts";
import { ServiceError } from "../types";
import { db } from "./db";
import { currentActor, delay, findUser, newId, recordAudit, toPublicUser } from "./runtime";

export const mockAuthService: AuthService = {
  async bindSession(email) {
    const normalized = email?.trim().toLowerCase() ?? null;
    db.sessionEmail = normalized;
    db.currentUserId = normalized ? (db.users.find((user) => user.email === normalized)?.id ?? null) : null;
  },

  async verifyCurrentPassword(password) {
    await delay();
    currentActor();
    // Sem senhas no mock: qualquer valor preenchido vale (exceto "errada", para testar o erro).
    if (!password || password === "errada") {
      throw new ServiceError("INVALID_PASSWORD", "A senha atual está incorreta.", "currentPassword");
    }
  },

  async changePassword(newPassword) {
    await delay();
    const actor = currentActor();

    if (!meetsPasswordRules(newPassword)) {
      throw new ServiceError("INVALID_PASSWORD", "A senha não atende aos requisitos.", "newPassword");
    }
    if (actor.tempPassword !== null && newPassword === actor.tempPassword) {
      throw new ServiceError("PASSWORD_REUSED", "A nova senha precisa ser diferente da temporária.", "newPassword");
    }

    const now = new Date().toISOString();
    actor.mustChangePassword = false;
    actor.tempPassword = null;
    actor.lastAccessAt = now;
    // Convite aceito: definir a senha conclui o primeiro acesso.
    if (actor.status === "pending") actor.status = "active";
    if (!db.sessions.some((session) => session.userId === actor.id)) {
      db.sessions.push({
        id: newId("s"),
        userId: actor.id,
        device: "Chrome · Windows",
        location: "São Paulo, SP",
        startedAt: now,
        lastActivityAt: now,
      });
    }
    // O valor da senha nunca vai para a auditoria.
    recordAudit({ module: "autenticacao", action: "password_change", description: `${actor.name} definiu uma senha pessoal` });
  },

  async endSession() {
    if (db.currentUserId) db.sessions = db.sessions.filter((session) => session.userId !== db.currentUserId);
    db.sessionEmail = null;
    db.currentUserId = null;
  },

  async listSwitchableUsers() {
    await delay();
    // Só entra quem está ativo (ou com convite pendente) e tem e-mail do domínio autorizado.
    return db.users
      .filter((user) => user.status !== "inactive" && isAllowedLoginEmail(user.email))
      .map(toPublicUser);
  },

  async switchUser(userId) {
    await delay();
    db.currentUserId = findUser(userId).id;
  },
};
