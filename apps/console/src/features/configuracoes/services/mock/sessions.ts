import type { SessionsService } from "../contracts";
import { ServiceError, type ActiveSession } from "../types";
import { db } from "./db";
import { delay, findUser, recordAudit, requirePermission } from "./runtime";

export const mockSessionsService: SessionsService = {
  async list() {
    await delay();
    const actor = requirePermission("manage_sessions");

    return db.sessions
      .map<ActiveSession>((session) => {
        const user = findUser(session.userId);
        const isCurrent = session.userId === actor.id;
        return {
          id: session.id,
          userId: user.id,
          userName: user.name,
          userEmail: user.email,
          device: session.device,
          location: session.location,
          startedAt: session.startedAt,
          // A sessão de quem está usando o portal está ativa neste instante.
          lastActivityAt: isCurrent ? new Date().toISOString() : session.lastActivityAt,
          isCurrent,
        };
      })
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  },

  async revoke(sessionId) {
    await delay();
    const actor = requirePermission("manage_sessions");
    const session = db.sessions.find((entry) => entry.id === sessionId);
    if (!session) throw new ServiceError("NOT_FOUND", "Sessão não encontrada ou já encerrada.");
    if (session.userId === actor.id) {
      throw new ServiceError("SELF_ACTION", "Você não pode encerrar a sua própria sessão por aqui.");
    }

    const user = findUser(session.userId);
    db.sessions = db.sessions.filter((entry) => entry.id !== sessionId);
    recordAudit({
      module: "sessoes",
      action: "session_revoked",
      description: `Sessão de ${user.name} encerrada (${session.device})`,
    });
  },
};
