import { FunctionsHttpError, type PostgrestError } from "@supabase/supabase-js";
import type { EdgeFunctionName } from "../../../../config/app";
import { supabase } from "../../../../lib/supabase";
import { isServiceErrorCode, ServiceError } from "../types";

const GENERIC = "Não foi possível concluir. Tente novamente.";

/**
 * Erro do PostgREST → ServiceError. As RPCs do app_imobrh levantam P0001 com
 * detail = código e hint = campo do formulário (ver app_imobrh.erro).
 */
export function fromPostgrest(error: PostgrestError): ServiceError {
  if (error.code === "P0001" && isServiceErrorCode(error.details)) {
    return new ServiceError(error.details, error.message, error.hint || undefined);
  }
  if (error.code === "42501") return new ServiceError("FORBIDDEN", "Você não tem permissão para esta ação.");
  if (error.code === "PGRST301" || error.code === "PGRST303") {
    return new ServiceError("UNAUTHENTICATED", "Sua sessão expirou. Entre novamente.");
  }
  // Erro fora do padrão do portal: a tela mostra a mensagem genérica; o detalhe fica no console.
  console.error("[supabase] erro não mapeado", error.code, error.message, error.details, error.hint);
  return new ServiceError("INTERNAL", GENERIC);
}

/** Erro de Edge Function do ImobRH (corpo { data: null, error: { code, message, fields } }) → ServiceError. */
export async function fromFunction(error: unknown): Promise<ServiceError> {
  if (error instanceof FunctionsHttpError) {
    try {
      const body: unknown = await (error.context as Response).json();
      const erro = typeof body === "object" && body !== null && "error" in body ? (body as { error: unknown }).error : body;
      if (typeof erro === "object" && erro !== null && "code" in erro && isServiceErrorCode(erro.code)) {
        const message = "message" in erro && typeof erro.message === "string" ? erro.message : GENERIC;
        const fields = "fields" in erro && typeof erro.fields === "object" && erro.fields !== null ? Object.keys(erro.fields) : [];
        return new ServiceError(erro.code, message, fields[0]);
      }
    } catch {
      // corpo não é JSON: cai no genérico
    }
  }
  return new ServiceError("INTERNAL", "Não foi possível falar com o servidor. Tente novamente.");
}

/** Chama uma Edge Function do ImobRH e devolve o `data` da resposta { data, error }. */
export async function invokeFunction<T>(name: EdgeFunctionName, body?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke<{ data: T; error: null }>(name, body ? { body } : { method: "GET" });
  if (error) throw await fromFunction(error);
  if (!data || data.data === undefined) throw new ServiceError("INTERNAL", "Resposta inesperada do servidor.");
  return data.data;
}

/** Lança o erro já convertido; devolve os dados, que podem ser null (RPC sem retorno, maybeSingle). */
export function unwrap<T>(result: { data: T; error: PostgrestError | null }): T {
  if (result.error) throw fromPostgrest(result.error);
  return result.data;
}

/** Como unwrap, mas o dado é obrigatório (listas, single, RPC com retorno). */
export function required<T>(result: { data: T | null; error: PostgrestError | null }): T {
  const data = unwrap(result);
  if (data === null) throw new ServiceError("INTERNAL", "Resposta vazia do servidor. Tente novamente.");
  return data;
}
