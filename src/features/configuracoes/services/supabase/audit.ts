import { supabase } from "../../../../lib/supabase";
import { AUDIT_PAGE_SIZE, auditPeriodStart, buildAuditCsv } from "../auditShared";
import type { AuditService } from "../contracts";
import { SYSTEM_ACTOR_ID, type AuditEntry, type AuditFilters } from "../types";
import { required } from "./errors";
import { AUDIT_ACTIONS, AUDIT_COLUMNS, AUDIT_MODULES, toAuditEntry } from "./mappers";

const EXPORT_LIMIT = 5000;

/** Só registros do portal (módulos/ações conhecidos), mais recentes primeiro. A RLS exige view_audit_logs. */
function filteredQuery(filters: AuditFilters) {
  let query = supabase
    .from("audit_logs")
    .select(AUDIT_COLUMNS, { count: "exact" })
    .in("menu_module", AUDIT_MODULES)
    .in("action_type", AUDIT_ACTIONS)
    .order("created_at", { ascending: false });

  const since = auditPeriodStart(filters.period);
  if (since) query = query.gte("created_at", since.toISOString());
  if (filters.userId === SYSTEM_ACTOR_ID) query = query.is("user_id", null);
  else if (filters.userId !== "all") query = query.eq("user_id", filters.userId);
  if (filters.module !== "all") query = query.eq("menu_module", filters.module);
  if (filters.action !== "all") query = query.eq("action_type", filters.action);
  return query;
}

function toEntries(rows: Parameters<typeof toAuditEntry>[0][]): AuditEntry[] {
  return rows.map(toAuditEntry).filter((entry): entry is AuditEntry => entry !== null);
}

export const supabaseAuditService: AuditService = {
  async list(filters, page) {
    const start = (page - 1) * AUDIT_PAGE_SIZE;
    const result = await filteredQuery(filters).range(start, start + AUDIT_PAGE_SIZE - 1);
    const rows = required(result);

    // Quem aparece no log, para o filtro "Usuário".
    const actorRows = required(
      await supabase
        .from("audit_logs")
        .select("user_id, ator_nome, user_email")
        .in("menu_module", AUDIT_MODULES)
        .order("created_at", { ascending: false })
        .limit(1000),
    );
    const actors = new Map<string, string>();
    for (const row of actorRows) {
      const id = row.user_id ?? SYSTEM_ACTOR_ID;
      if (!actors.has(id)) actors.set(id, row.ator_nome ?? row.user_email ?? "Sistema");
    }

    return {
      items: toEntries(rows),
      total: result.count ?? rows.length,
      page,
      pageSize: AUDIT_PAGE_SIZE,
      actors: [...actors].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, "pt-BR")),
    };
  },

  async exportCsv(filters) {
    const rows = required(await filteredQuery(filters).limit(EXPORT_LIMIT));
    return buildAuditCsv(toEntries(rows));
  },
};
