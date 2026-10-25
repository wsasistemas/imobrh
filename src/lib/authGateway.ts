import { FunctionsFetchError } from "@supabase/supabase-js";
import { edgeFunction } from "../config/app";
import { supabase } from "./supabase";

/**
 * Login e "esqueci a senha" passam SEMPRE pelo Security Gateway (Edge Function <schema>-auth):
 * limites, bloqueio e risco são decididos lá, antes do Supabase Auth. O front não chama
 * signInWithPassword nem resetPasswordForEmail direto — e uma sessão de senha aberta direto no
 * Auth não acessa o portal (RLS exige a sessão registrada pelo gateway).
 *
 * As respostas do gateway são de propósito iguais para qualquer motivo (senha errada, conta
 * bloqueada, conta inexistente): aqui só se distingue "não deu" de "sem conexão".
 */

export const LOGIN_FAILED_MESSAGE = "Não foi possível realizar o acesso. Verifique os dados informados ou tente novamente mais tarde.";
export const RECOVER_SENT_MESSAGE = "Se existir uma conta associada ao endereço informado, enviaremos as instruções necessárias.";
export const OFFLINE_MESSAGE = "Sem conexão com o servidor. Confira a internet e tente de novo.";

export type GatewayResult = { ok: true } | { ok: false; offline: boolean };

interface LoginResponse {
  success?: boolean;
  session?: { access_token?: string; refresh_token?: string };
}

export async function signInThroughGateway(email: string, password: string): Promise<GatewayResult> {
  const { data, error } = await supabase.functions.invoke<LoginResponse>(edgeFunction("auth"), {
    body: { action: "login", email: email.trim().toLowerCase(), password },
  });
  if (error) return { ok: false, offline: error instanceof FunctionsFetchError };
  const accessToken = data?.session?.access_token;
  const refreshToken = data?.session?.refresh_token;
  if (!data?.success || !accessToken || !refreshToken) return { ok: false, offline: false };
  // A sessão é a oficial do Supabase Auth: daqui em diante o supabase-js renova e encerra como sempre.
  const { error: sessionError } = await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
  return sessionError ? { ok: false, offline: false } : { ok: true };
}

export async function requestResetThroughGateway(email: string): Promise<GatewayResult> {
  const { error } = await supabase.functions.invoke(edgeFunction("auth"), {
    body: { action: "recover", email: email.trim().toLowerCase() },
  });
  if (error) return { ok: false, offline: error instanceof FunctionsFetchError };
  return { ok: true };
}
