import { supabase } from "../../../../lib/supabase";
import type { IntegrationsService } from "../contracts";
import type { AuditEntry } from "../types";
import { required } from "./errors";
import { AUDIT_COLUMNS, toAuditEntry, type AuditRow } from "./mappers";

export const supabaseIntegrationsService: IntegrationsService = {
  /** Histórico da conexão TOTVS RM ou das Consultas SQL, lido da auditoria (entidade = chave). */
  async history(key) {
    const rows = required(
      await supabase
        .from("auditoria")
        .select(AUDIT_COLUMNS)
        .eq("modulo", "integracoes")
        .eq("entidade", key)
        .order("ocorrido_em", { ascending: false })
        .limit(50),
    ) as AuditRow[];
    return rows.map(toAuditEntry).filter((entry): entry is AuditEntry => entry !== null);
  },
};
