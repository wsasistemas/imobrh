import { supabase } from "../../../../lib/supabase";
import { AUDIT_PAGE_SIZE, auditPeriodStart, buildAuditCsv } from "../auditShared";
import type { AuditService } from "../contracts";
import { SYSTEM_ACTOR_ID, type AuditEntry, type AuditFilters } from "../types";
import { required } from "./errors";
import { AUDIT_ACTIONS, AUDIT_COLUMNS, AUDIT_MODULES, toAuditEntry, type AuditRow } from "./mappers";

const EXPORT_LIMIT = 5000;

/** app_imobrh.auditoria, mais recentes primeiro. A RLS exige o menu Auditoria (view_audit_logs). */
function filteredQuery(filters: AuditFilters) {
  let query = supabase
    .from("auditoria")
    .select(AUDIT_COLUMNS, { count: "exact" })
    .in("modulo", AUDIT_MODULES)
    .in("acao", AUDIT_ACTIONS)
    .order("ocorrido_em", { ascending: false });

  const since = auditPeriodStart(filters.period);
  if (since) query = query.gte("ocorrido_em", since.toISOString());
  if (filters.userId === SYSTEM_ACTOR_ID) query = query.is("ator_id", null);
  else if (filters.userId !== "all") query = query.eq("ator_id", filters.userId);
  if (filters.module !== "all") query = query.eq("modulo", filters.module);
  if (filters.action !== "all") query = query.eq("acao", filters.action);
  return query;
}

function toEntries(rows: AuditRow[]): AuditEntry[] {
  return rows.map(toAuditEntry).filter((entry): entry is AuditEntry => entry !== null);
}

export const supabaseAuditService: AuditService = {
  async list(filters, page) {
    const start = (page - 1) * AUDIT_PAGE_SIZE;
    const result = await filteredQuery(filters).range(start, start + AUDIT_PAGE_SIZE - 1);
    const rows = required(result) as AuditRow[];

    // Quem aparece no log, para o filtro "Usuário".
    const actorRows = required(
      await supabase.from("auditoria").select("ator_id, ator_nome").in("modulo", AUDIT_MODULES).order("ocorrido_em", { ascending: false }).limit(1000),
    ) as Pick<AuditRow, "ator_id" | "ator_nome">[];
    const actors = new Map<string, string>();
    for (const row of actorRows) {
      const id = row.ator_id ?? SYSTEM_ACTOR_ID;
      if (!actors.has(id)) actors.set(id, row.ator_nome ?? "Sistema");
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
    const rows = required(await filteredQuery(filters).limit(EXPORT_LIMIT)) as AuditRow[];
    return buildAuditCsv(toEntries(rows));
  },
};
