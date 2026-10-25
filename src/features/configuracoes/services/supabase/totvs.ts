import { edgeFunction } from "../../../../config/app";
import { supabase } from "../../../../lib/supabase";
import type { TotvsService } from "../contracts";
import { ServiceError, type TotvsConnectionView, type TotvsTestResult } from "../types";
import { fromFunction, required, unwrap } from "./errors";
import { toTestResult } from "./mappers";

type Json = Parameters<typeof toTestResult>[0];

function toTotvsTest(value: Json | null): TotvsTestResult | null {
  const base = toTestResult(value);
  if (!base || value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const proposalId = value.proposalId;
  return { ...base, proposalId: typeof proposalId === "string" ? proposalId : null };
}

function text(value: Json | undefined): string | null {
  return typeof value === "string" ? value : null;
}

// A RPC devolve só campos seguros: a senha nunca sai do banco (fica no Vault).
async function getConnection(): Promise<TotvsConnectionView> {
  const data = required(await supabase.rpc("obter_conexao_totvs"));
  if (typeof data !== "object" || Array.isArray(data)) throw new ServiceError("INTERNAL", "Resposta inesperada do servidor.");
  return {
    url: text(data.url) ?? "",
    user: text(data.user) ?? "",
    active: data.active === true,
    passwordMasked: text(data.passwordMasked),
    passwordSetAt: text(data.passwordSetAt),
    passwordSetBy: text(data.passwordSetBy),
    lastTest: toTotvsTest(data.lastTest ?? null),
  };
}

export const supabaseTotvsService: TotvsService = {
  getConnection,

  async saveConnection(input) {
    unwrap(
      await supabase.rpc("salvar_conexao_totvs", {
        p_url: input.url,
        p_usuario: input.user,
        p_senha: input.password,
        p_ativo: input.active,
      }),
    );
    return getConnection();
  },

  async testConnection(proposalId) {
    const { data, error } = await supabase.functions.invoke(edgeFunction("totvs"), {
      body: { action: "testar", proposalId: proposalId ?? undefined },
    });
    if (error) throw await fromFunction(error);
    const result = toTotvsTest(data as Json);
    if (!result) throw new ServiceError("INTERNAL", "Resposta inesperada do teste de conexão.");
    const url = typeof data === "object" && data !== null && "url" in data && typeof data.url === "string" ? data.url : undefined;
    return { ...result, url };
  },
};
