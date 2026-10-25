import { FunctionsHttpError, type PostgrestError } from "@supabase/supabase-js";
import { isServiceErrorCode, ServiceError } from "../types";

const GENERIC = "Não foi possível concluir. Tente novamente.";

/**
 * Erro do PostgREST → ServiceError. As RPCs do schema do aplicativo levantam P0001 com
 * detail = código e hint = campo do formulário (ver <schema>.erro).
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

/** Erro de Edge Function (corpo { code, message, field }) → ServiceError. */
export async function fromFunction(error: unknown): Promise<ServiceError> {
  if (error instanceof FunctionsHttpError) {
    try {
      const body: unknown = await (error.context as Response).json();
      if (typeof body === "object" && body !== null && "code" in body && isServiceErrorCode(body.code)) {
        const message = "message" in body && typeof body.message === "string" ? body.message : GENERIC;
        const field = "field" in body && typeof body.field === "string" ? body.field : undefined;
        return new ServiceError(body.code, message, field);
      }
    } catch {
      // corpo não é JSON: cai no genérico
    }
  }
  return new ServiceError("INTERNAL", "Não foi possível falar com o servidor. Tente novamente.");
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
