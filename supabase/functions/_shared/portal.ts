// Peças comuns das Edge Functions do Imobdesk (Deno).
//
// Segurança: verify_jwt=true só garante um JWT válido do projeto — a chave anon também passa
// (ver Cerebro: supabase-verify-jwt-aceita-chave-anon-checar-papel-na-funcao). Por isso cada
// função confere o USUÁRIO do token (auth.getUser) e a permissão dele no portal.
import { createClient, type SupabaseClient, type User } from "npm:@supabase/supabase-js@2";
import { clienteDaEmpresa, empresaDoUsuario } from "./empresa.ts";

/** Cliente service_role no schema imobdesk (sem tipos gerados do banco). */
// deno-lint-ignore no-explicit-any
export type AdminClient = SupabaseClient<any, any, "imobdesk">;

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/** Mesmo formato do ServiceError do front: code, message e o campo do formulário. */
export class PortalError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly field?: string,
  ) {
    super(message);
  }
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof PortalError) {
    return json({ code: error.code, message: error.message, field: error.field }, error.status);
  }
  console.error(error);
  return json({ code: "INTERNAL", message: "Erro inesperado. Tente novamente." }, 500);
}

/** Erro de RPC do schema imobdesk: details = código, hint = campo (ver imobdesk.erro). */
export function fromRpcError(error: { message: string; details?: string | null; hint?: string | null; code?: string }): PortalError {
  if (error.code === "P0001" && error.details) {
    const status = error.details === "FORBIDDEN" ? 403 : 400;
    return new PortalError(error.details, error.message, status, error.hint || undefined);
  }
  return new PortalError("INTERNAL", "Erro inesperado no banco. Tente novamente.", 500);
}

export interface PortalContext {
  caller: User;
  /** service_role preso à empresa de quem chama (ver _shared/empresa.ts); usar só depois de validar o chamador. */
  admin: AdminClient;
  /** Empresa aberta por quem chama (a do seletor do topo). */
  empresaId: string;
}

export async function portalContext(req: Request): Promise<PortalContext> {
  const authorization = req.headers.get("Authorization") ?? "";
  const token = authorization.replace(/^Bearer\s+/i, "");
  if (!token) throw new PortalError("UNAUTHENTICATED", "Faça login para continuar.", 401);

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) throw new PortalError("INTERNAL", "Função sem configuração do Supabase.", 500);

  const admin = createClient(url, serviceKey, {
    db: { schema: "imobdesk" },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await admin.auth.getUser(token);
  // A chave anon é um JWT válido, mas não tem usuário: cai aqui.
  if (error || !data.user) throw new PortalError("UNAUTHENTICATED", "Sessão inválida. Faça login novamente.", 401);

  // Qualquer e-mail: quem pode o quê vem do cadastro na empresa, conferido pelo banco.
  // service_role ignora a RLS: a regra "sessão de senha só vale se veio do gateway de login" (e
  // "sessão encerrada não vale") é conferida aqui, com a mesma função que a RLS usa.
  const claims = jwtPayload(token);
  const { data: valida, error: sessaoError } = await admin.rpc("security_sessao_valida", {
    p_user_id: data.user.id,
    p_session_id: typeof claims.session_id === "string" ? claims.session_id : null,
    p_amr: Array.isArray(claims.amr) ? claims.amr : [],
  });
  if (sessaoError || valida !== true) throw new PortalError("UNAUTHENTICATED", "Sessão inválida. Faça login novamente.", 401);

  const empresaId = await empresaDoUsuario(data.user.id);
  if (!empresaId) throw new PortalError("FORBIDDEN", "Seu login não tem acesso a nenhuma empresa no Imobdesk.", 403);
  return { caller: data.user, admin: clienteDaEmpresa(empresaId), empresaId };
}

/** Payload do JWT (a assinatura já foi conferida pelo auth.getUser acima). */
function jwtPayload(token: string): Record<string, unknown> {
  try {
    const part = token.split(".")[1] ?? "";
    const base64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    return JSON.parse(atob(base64)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new PortalError("INVALID_INPUT", "Requisição inválida.");
  }
}
