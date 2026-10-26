import type { AuditService, IntegrationsService } from "../contracts";
import { AUDIT_PAGE_SIZE, auditPeriodStart, buildAuditCsv } from "../auditShared";
import { SYSTEM_ACTOR_ID, type AuditEntry, type AuditFilters } from "../types";
import { db } from "./db";
import { delay, requirePermission } from "./runtime";

function applyFilters(filters: AuditFilters): AuditEntry[] {
  const since = auditPeriodStart(filters.period);
  return db.audit
    .filter((entry) => !since || new Date(entry.at) >= since)
    .filter((entry) => filters.userId === "all" || (entry.actorId ?? SYSTEM_ACTOR_ID) === filters.userId)
    .filter((entry) => filters.module === "all" || entry.module === filters.module)
    .filter((entry) => filters.action === "all" || entry.action === filters.action)
    .sort((a, b) => b.at.localeCompare(a.at));
}

export const mockAuditService: AuditService = {
  async list(filters, page) {
    await delay();
    requirePermission("view_audit_logs");
    const entries = applyFilters(filters);
    const start = (page - 1) * AUDIT_PAGE_SIZE;
    const actors = new Map<string, string>();
    for (const entry of db.audit) actors.set(entry.actorId ?? SYSTEM_ACTOR_ID, entry.actorName);
    return {
      items: entries.slice(start, start + AUDIT_PAGE_SIZE).map((entry) => ({ ...entry })),
      total: entries.length,
      page,
      pageSize: AUDIT_PAGE_SIZE,
      actors: [...actors].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, "pt-BR")),
    };
  },

  async exportCsv(filters) {
    await delay();
    requirePermission("view_audit_logs");
    return buildAuditCsv(applyFilters(filters));
  },
};

/** Histórico da Integração TOTVS RM (conexão e consultas), lido da auditoria. */
export const mockIntegrationsService: IntegrationsService = {
  async history(key) {
    await delay();
    requirePermission("configure_integrations");
    return db.audit.filter((entry) => entry.module === "integracoes" && entry.targetKey === key).map((entry) => ({ ...entry }));
  },
};
