import { supabase } from "../../../../lib/supabase";
import type { TotvsService } from "../contracts";
import { ServiceError, type TotvsConnectionView, type TotvsTestResult } from "../types";
import { invokeFunction, required, unwrap } from "./errors";
import { toTestResult } from "./mappers";

type Json = Parameters<typeof toTestResult>[0];

function text(value: Json | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function toTotvsTest(value: Json | null | undefined): TotvsTestResult | null {
  const base = toTestResult(value);
  return base ? { ...base, proposalId: null } : null;
}

// A RPC devolve só campos seguros: a senha nunca sai do banco (fica no Vault).
async function getConnection(): Promise<TotvsConnectionView> {
  const data = required(await supabase.rpc("obter_conexao_totvs")) as Json;
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw new ServiceError("INTERNAL", "Resposta inesperada do servidor.");
  return {
    url: text(data.url) ?? "",
    user: text(data.user) ?? "",
    active: data.active === true,
    passwordMasked: text(data.passwordMasked),
    passwordSetAt: text(data.passwordSetAt),
    passwordSetBy: text(data.passwordSetBy),
    lastTest: toTotvsTest(data.lastTest),
  };
}

export const supabaseTotvsService: TotvsService = {
  getConnection,

  async saveConnection(input) {
    unwrap(await supabase.rpc("salvar_conexao_totvs", { p_url: input.url, p_usuario: input.user, p_senha: input.password, p_ativo: input.active }));
    return getConnection();
  },

  /** Edge Function rm-token: pede um token novo ao RM; o token não volta para o navegador. */
  async testConnection() {
    const data = await invokeFunction<Json>("rm-token", { action: "testar" });
    const result = toTotvsTest(data);
    if (!result) throw new ServiceError("INTERNAL", "Resposta inesperada do teste de conexão.");
    return result;
  },
};
