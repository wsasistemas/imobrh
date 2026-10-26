import type { AuthService } from "../contracts";
import { db } from "./db";
import { delay, findUser, hasConsoleRole, toPublicUser } from "./runtime";

export const mockAuthService: AuthService = {
  async bindSession(email) {
    const normalized = email?.trim().toLowerCase() ?? null;
    db.sessionEmail = normalized;
    db.currentUserId = normalized ? (db.users.find((record) => record.email === normalized)?.id ?? null) : null;
  },

  async endSession() {
    if (db.currentUserId) db.sessions = db.sessions.filter((session) => session.userId !== db.currentUserId);
    db.sessionEmail = null;
    db.currentUserId = null;
  },

  async listSwitchableUsers() {
    await delay();
    // "Ver como": só quem entra no Console (tem papel de RH).
    return db.users.filter((record) => record.status !== "inactive" && hasConsoleRole(record)).map(toPublicUser);
  },

  async switchUser(userId) {
    await delay();
    db.currentUserId = findUser(userId).id;
  },
};
