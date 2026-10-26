import { format, startOfDay, subDays } from "date-fns";
import { AUDIT_ACTION_LABELS, AUDIT_MODULE_LABELS } from "./labels";
import type { AuditEntry, AuditPeriod } from "./types";

// Peças da auditoria usadas igual pelas implementações mock e Supabase.

export const AUDIT_PAGE_SIZE = 10;

/** Início do período do filtro; null = todo o período. */
export function auditPeriodStart(period: AuditPeriod): Date | null {
  const now = new Date();
  switch (period) {
    case "today":
      return startOfDay(now);
    case "7d":
      return subDays(now, 7);
    case "30d":
      return subDays(now, 30);
    case "all":
      return null;
  }
}

function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/** CSV com ";" (Excel pt-BR). O BOM para os acentos é colocado por quem baixa o arquivo. */
export function buildAuditCsv(entries: AuditEntry[]): string {
  const header = ["Data e hora", "Usuário", "Módulo", "Ação", "Descrição", "Origem"];
  const lines = entries.map((entry) =>
    [
      format(new Date(entry.at), "dd/MM/yyyy HH:mm"),
      entry.actorName,
      AUDIT_MODULE_LABELS[entry.module],
      AUDIT_ACTION_LABELS[entry.action],
      entry.description,
      entry.origin,
    ]
      .map(csvCell)
      .join(";"),
  );
  return [header.map(csvCell).join(";"), ...lines].join("\r\n");
}
