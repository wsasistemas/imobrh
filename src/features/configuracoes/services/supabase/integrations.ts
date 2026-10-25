import { edgeFunction } from "../../../../config/app";
import { supabase } from "../../../../lib/supabase";
import type { IntegrationsService } from "../contracts";
import { ServiceError, type AuditEntry, type IntegrationKey, type IntegrationView } from "../types";
import { fromFunction, required, unwrap } from "./errors";
import { AUDIT_COLUMNS, toAuditEntry, toTestResult } from "./mappers";

// Colunas liberadas ao front: o segredo_id (referência ao Vault) não é lido.
const INTEGRATION_COLUMNS =
  "key, nome, descricao, ativo, remetente, enviar_emails_auth, segredo_mascara, segredo_definido_em, segredo_definido_por, ultimo_teste";

async function getIntegration(key: IntegrationKey): Promise<IntegrationView> {
  const row = unwrap(await supabase.from("integracoes").select(INTEGRATION_COLUMNS).eq("key", key).maybeSingle());
  // A RLS esconde a linha de quem não é super admin.
  if (!row) throw new ServiceError("FORBIDDEN", "Somente super admin pode configurar integrações.");
  return {
    key,
    name: row.nome,
    description: row.descricao,
    active: row.ativo,
    sender: row.remetente,
    sendAuthEmails: row.enviar_emails_auth,
    secretMasked: row.segredo_mascara,
    secretSetAt: row.segredo_definido_em,
    secretSetBy: row.segredo_definido_por,
    lastTest: toTestResult(row.ultimo_teste),
  };
}

export const supabaseIntegrationsService: IntegrationsService = {
  get: getIntegration,

  async update(key, fields) {
    const current = await getIntegration(key);
    unwrap(
      await supabase.rpc("atualizar_integracao", {
        p_key: key,
        p_remetente: fields.sender ?? current.sender,
        p_enviar_emails_auth: fields.sendAuthEmails ?? current.sendAuthEmails,
        p_ativo: fields.active ?? current.active,
      }),
    );
    return getIntegration(key);
  },

  async replaceSecret(key, secret) {
    // Vai direto para o Vault pela RPC; o valor nunca volta.
    unwrap(await supabase.rpc("substituir_segredo_integracao", { p_key: key, p_segredo: secret }));
    return getIntegration(key);
  },

  async test(key) {
    const { data, error } = await supabase.functions.invoke(edgeFunction("integracao-teste"), { body: { key } });
    if (error) throw await fromFunction(error);
    const result = toTestResult(data);
    if (!result) throw new ServiceError("INTERNAL", "Resposta inesperada do teste de e-mail.");
    return result;
  },

  async history(key) {
    const rows = required(
      await supabase
        .from("audit_logs")
        .select(AUDIT_COLUMNS)
        .eq("menu_module", "integracoes")
        .eq("entity_id", key)
        .order("created_at", { ascending: false })
        .limit(50),
    );
    return rows.map(toAuditEntry).filter((entry): entry is AuditEntry => entry !== null);
  },
};
