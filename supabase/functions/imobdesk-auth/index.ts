// Edge Function imobdesk-auth: único caminho de login e de "esqueci a senha" do portal.
//
//   POST { action: "login", email, password }  -> 200 { success, session } | 401 { success: false, message }
//   POST { action: "recover", email }          -> 200 { success, message } (sempre a mesma)
//
// A regra está em ../_shared/security/gateway.ts (testada em tests/security-gateway.test.ts) e no
// banco (security_auth_begin/finish). Aqui só se liga o gateway ao Postgres e ao Supabase Auth.
//
// Variáveis (Supabase > Edge Functions > Secrets):
//   AUTH_ALLOWED_ORIGINS  obrigatória: origens do front separadas por vírgula (https://..., http://localhost:5173)
//   AUTH_IP_HEADER        opcional (padrão x-forwarded-for): cabeçalho com o IP do cliente posto pela plataforma
//   AUTH_MIN_RESPONSE_MS  opcional (padrão 900): tempo mínimo de toda resposta de login
// SUPABASE_URL, SUPABASE_ANON_KEY e SUPABASE_SERVICE_ROLE_KEY já vêm do Supabase.
import { createClient } from "npm:@supabase/supabase-js@2";
import { handleAuthRequest, type AuthBackend, type GatewayConfig, type GatewayStore } from "../_shared/security/gateway.ts";

const url = Deno.env.get("SUPABASE_URL") ?? "";
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const publicKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

const config: GatewayConfig = {
  allowedOrigins: (Deno.env.get("AUTH_ALLOWED_ORIGINS") ?? "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean),
  ipHeader: (Deno.env.get("AUTH_IP_HEADER") ?? "x-forwarded-for").toLowerCase(),
  // Empresa cliente: cadastro ativo em alguma empresa ou domínio de e-mail cadastrado (imobdesk.dominio_permitido).
  isDomainAllowed: async (email) => {
    const { data, error } = await admin.rpc("dominio_permitido", { p_email: email });
    return !error && data === true;
  },
  resetPath: "/redefinir-senha",
  minResponseMs: Number(Deno.env.get("AUTH_MIN_RESPONSE_MS") ?? "900"),
  jitterMs: 200,
};

// service_role só aqui no servidor, só para as funções do gateway e para derrubar sessão órfã.
const admin = createClient(url, serviceKey, {
  db: { schema: "imobdesk" },
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

const store: GatewayStore = {
  async begin({ kind, email, ip, requestId, domainAllowed }) {
    const { data, error } = await admin.rpc("security_auth_begin", {
      p_kind: kind,
      p_email: email,
      p_ip: ip,
      p_request_id: requestId,
      p_domain_allowed: domainAllowed,
    });
    if (error || !data) throw new Error("security_auth_begin");
    return { allowed: data.allowed === true, attemptId: data.attempt_id ?? undefined, reason: data.reason ?? undefined, risk: data.risk ?? 0 };
  },
  async finish({ attemptId, result, email, ip, userId, sessionId }) {
    const { error } = await admin.rpc("security_auth_finish", {
      p_attempt_id: attemptId,
      p_result: result,
      p_email: email,
      p_ip: ip,
      p_user_id: userId ?? null,
      p_session_id: sessionId ?? null,
    });
    if (error) throw new Error("security_auth_finish");
  },
};

// Um cliente por chamada: a sessão do login nunca fica guardada em memória compartilhada entre requisições.
function authClient() {
  return createClient(url, publicKey || serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

const auth: AuthBackend = {
  async signInWithPassword(email, password) {
    const { data, error } = await authClient().auth.signInWithPassword({ email, password });
    if (error || !data.session || !data.user) {
      return { ok: false, code: error?.code, status: error?.status };
    }
    return { ok: true, userId: data.user.id, session: { access_token: data.session.access_token, refresh_token: data.session.refresh_token } };
  },
  async resetPasswordForEmail(email, redirectTo) {
    const { error } = await authClient().auth.resetPasswordForEmail(email, { redirectTo });
    return error ? { ok: false, code: error.code, status: error.status } : { ok: true };
  },
  async revokeSession(accessToken) {
    await admin.auth.admin.signOut(accessToken, "local");
  },
  // Primeiro acesso do App do solicitante: conta sem senha, e-mail já confirmado (o link de redefinir prova a caixa).
  async ensureAccount(email) {
    const { error } = await admin.auth.admin.createUser({ email, email_confirm: true });
    return { created: !error };
  },
};

// Log estruturado: request id, ação, resultado e código interno. Nunca e-mail, senha ou token.
const log = (entry: Record<string, unknown>) => console.log(JSON.stringify({ fn: "imobdesk-auth", ...entry }));

Deno.serve(async (req) => {
  if (!url || !serviceKey || config.allowedOrigins.length === 0) {
    log({ outcome: "error", reason: "MISCONFIGURED" });
    return new Response(JSON.stringify({ success: false, message: "Serviço indisponível." }), {
      status: 503,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }
  return handleAuthRequest(req, { store, auth, config, log });
});

