// Security Gateway do login (núcleo sem dependências de Deno/npm: roda na Edge Function e nos testes).
//
// Ordem (docs/SEGURANCA-LOGIN.md): request id -> origem -> método/tipo/tamanho -> JSON e campos ->
// IP confiável -> e-mail normalizado -> limites/bloqueio/risco no banco (begin) -> só então o
// Supabase Auth -> classifica o erro (sem repassar) -> atualiza contadores (finish) -> resposta pública.
//
// Regras fixas:
//   * Uma única resposta pública para toda negativa (401 + a mesma mensagem), com tempo mínimo de
//     resposta: não dá para saber se a conta existe, está bloqueada ou se a senha estava errada.
//   * Fail closed: qualquer erro na camada de segurança nega o login. Nunca "deixa passar".
//   * Nunca loga senha, token, e-mail completo ou mensagem crua do Auth.

export const PUBLIC_DENIED_MESSAGE = "Não foi possível realizar o acesso. Verifique os dados informados ou tente novamente mais tarde.";
export const PUBLIC_RECOVER_MESSAGE = "Se existir uma conta associada ao endereço informado, enviaremos as instruções necessárias.";
export const PUBLIC_INVALID_MESSAGE = "Requisição inválida.";

export const MAX_BODY_BYTES = 2048;
export const MAX_EMAIL_LENGTH = 254;
export const MAX_PASSWORD_LENGTH = 256;

export type AuthResult = "SUCCESS" | "INVALID_CREDENTIALS" | "ACCOUNT_UNAVAILABLE" | "AUTH_RATE_LIMITED" | "AUTH_ERROR";

export interface BeginResult {
  allowed: boolean;
  attemptId?: string;
  reason?: string;
  risk: number;
}

export interface GatewayStore {
  begin(input: { kind: "login" | "recover"; email: string; ip: string; requestId: string; domainAllowed: boolean }): Promise<BeginResult>;
  finish(input: { attemptId: string; result: AuthResult; email: string; ip: string; userId?: string; sessionId?: string }): Promise<void>;
}

export interface SessionTokens {
  access_token: string;
  refresh_token: string;
}

export type SignInOutcome =
  | { ok: true; session: SessionTokens; userId: string }
  | { ok: false; code?: string; status?: number };

export interface AuthBackend {
  signInWithPassword(email: string, password: string): Promise<SignInOutcome>;
  resetPasswordForEmail(email: string, redirectTo: string): Promise<{ ok: boolean; code?: string; status?: number }>;
  /** Derruba uma sessão recém-criada que não pôde ser registrada (fail closed). */
  revokeSession(accessToken: string): Promise<void>;
  /**
   * Primeiro acesso (App do solicitante): cria a conta, sem senha, quando o e-mail corporativo ainda não existe no Auth.
   * O link de "redefinir senha" enviado em seguida é o que cria a senha. Só é chamada para o domínio corporativo.
   */
  ensureAccount?(email: string): Promise<{ created: boolean }>;
}

export interface GatewayConfig {
  /** Origens do front aceitas (ex.: https://portal.vercel.app). Requisição de outra origem é recusada. */
  allowedOrigins: string[];
  /** Cabeçalho com o IP do cliente posto pela infraestrutura (validar no deploy, ver docs). */
  ipHeader: string;
  /** E-mail de uma empresa cliente (cadastro ativo ou domínio da empresa): libera o 1º acesso do App do solicitante. */
  isDomainAllowed: (email: string) => Promise<boolean>;
  /** Caminho da tela de nova senha no front (o link do e-mail volta para origem + caminho). */
  resetPath: string;
  minResponseMs: number;
  jitterMs: number;
}

export interface GatewayDeps {
  store: GatewayStore;
  auth: AuthBackend;
  config: GatewayConfig;
  log?: (entry: Record<string, unknown>) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const IPV4_RE = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6_RE = /^[0-9a-f:]{2,39}$/i;

export function isIp(value: string): boolean {
  return IPV4_RE.test(value) || (value.includes(":") && IPV6_RE.test(value));
}

/**
 * IP do cliente a partir de UM cabeçalho escolhido na configuração (posto pela infraestrutura).
 * Qualquer outro cabeçalho mandado pelo cliente é ignorado. Valor inválido vira "unknown" — e o
 * IP é só um dos sinais: bloqueio e limite por conta não dependem dele.
 */
export function clientIp(headers: Headers, ipHeader: string): string {
  const raw = headers.get(ipHeader);
  if (!raw || raw.length > 512) return "unknown";
  // x-forwarded-for: o primeiro item é o cliente segundo o proxy da plataforma.
  const candidate = raw.split(",")[0].trim().toLowerCase();
  return isIp(candidate) ? candidate : "unknown";
}

/** Erro do Supabase Auth -> resultado interno. A mensagem do Auth nunca é usada. */
export function classifyAuthError(error: { code?: string; status?: number }): Exclude<AuthResult, "SUCCESS"> {
  const { code, status } = error;
  if (code === "invalid_credentials" || (status === 400 && !code)) return "INVALID_CREDENTIALS";
  if (code === "over_request_rate_limit" || status === 429) return "AUTH_RATE_LIMITED";
  if (code === "email_not_confirmed" || code === "user_banned" || code === "user_not_found") return "ACCOUNT_UNAVAILABLE";
  return "AUTH_ERROR";
}

/** Lê o payload de um JWT emitido agora pelo Auth (não valida assinatura: veio do próprio Auth via TLS). */
export function jwtClaims(token: string): Record<string, unknown> {
  const part = token.split(".")[1] ?? "";
  const base64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
  return JSON.parse(atob(base64)) as Record<string, unknown>;
}

interface LoginBody {
  action: "login";
  email: string;
  password: string;
}
interface RecoverBody {
  action: "recover";
  email: string;
}

/** Valida o corpo inteiro. Campo a mais, tipo errado ou tamanho fora do limite = inválido. */
export function parseBody(raw: unknown): LoginBody | RecoverBody | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  const keys = Object.keys(body);
  if (typeof body.email !== "string") return null;
  const email = body.email.trim().toLowerCase();
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(email)) return null;

  if (body.action === "login") {
    if (keys.some((key) => !["action", "email", "password"].includes(key))) return null;
    if (typeof body.password !== "string" || body.password.length === 0 || body.password.length > MAX_PASSWORD_LENGTH) return null;
    return { action: "login", email, password: body.password };
  }
  if (body.action === "recover") {
    if (keys.some((key) => !["action", "email"].includes(key))) return null;
    return { action: "recover", email };
  }
  return null;
}

async function readLimitedText(req: Request, limit: number): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > limit) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(all);
}

function baseHeaders(origin: string | null, config: GatewayConfig, requestId: string): Headers {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Request-Id": requestId,
    Vary: "Origin",
  });
  if (origin && config.allowedOrigins.includes(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Headers", "authorization, x-client-info, apikey, content-type");
    headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    headers.set("Access-Control-Expose-Headers", "x-request-id");
    headers.set("Access-Control-Max-Age", "600");
  }
  return headers;
}

export async function handleAuthRequest(req: Request, deps: GatewayDeps): Promise<Response> {
  const { store, auth, config } = deps;
  const log = deps.log ?? (() => {});
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => Date.now());
  const random = deps.random ?? Math.random;

  const requestId = crypto.randomUUID();
  const started = now();
  const origin = req.headers.get("origin");
  const headers = baseHeaders(origin, config, requestId);
  const respond = (status: number, body: unknown) => new Response(body === null ? null : JSON.stringify(body), { status, headers });
  const entry: Record<string, unknown> = { request_id: requestId };

  // CORS ajuda o navegador; não é autorização (curl/Postman ignoram). As regras abaixo valem igual.
  if (origin && !config.allowedOrigins.includes(origin)) {
    log({ ...entry, outcome: "rejected", reason: "ORIGIN_NOT_ALLOWED" });
    return respond(403, { success: false, message: PUBLIC_INVALID_MESSAGE });
  }
  if (req.method === "OPTIONS") return respond(204, null);
  if (req.method !== "POST") return respond(405, { success: false, message: PUBLIC_INVALID_MESSAGE });
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return respond(415, { success: false, message: PUBLIC_INVALID_MESSAGE });
  }

  let text: string | null;
  try {
    text = await readLimitedText(req, MAX_BODY_BYTES);
  } catch {
    text = null;
  }
  if (text === null) return respond(413, { success: false, message: PUBLIC_INVALID_MESSAGE });

  let body: LoginBody | RecoverBody | null = null;
  try {
    body = parseBody(JSON.parse(text));
  } catch {
    body = null;
  }
  if (!body) return respond(400, { success: false, message: PUBLIC_INVALID_MESSAGE });

  const ip = clientIp(req.headers, config.ipHeader);
  const email = body.email;
  const domainAllowed = await config.isDomainAllowed(email).catch(() => false);
  entry.action = body.action;

  // Tempo mínimo de resposta: negar antes do Auth (bloqueio) e negar depois (senha errada) levam o mesmo tempo.
  const pad = async () => {
    const target = config.minResponseMs + Math.floor(random() * config.jitterMs);
    const elapsed = now() - started;
    if (elapsed < target) await sleep(target - elapsed);
  };

  if (body.action === "recover") {
    try {
      const gate = await store.begin({ kind: "recover", email, ip, requestId, domainAllowed });
      entry.outcome = gate.allowed ? "allowed" : "denied";
      entry.reason = gate.reason;
      if (gate.allowed && gate.attemptId) {
        if (domainAllowed && auth.ensureAccount) {
          const account = await auth.ensureAccount(email);
          entry.account_created = account.created;
        }
        const redirectBase = origin ?? config.allowedOrigins[0];
        const sent = await auth.resetPasswordForEmail(email, `${redirectBase}${config.resetPath}`);
        entry.auth_status = sent.status;
        entry.auth_code = sent.code;
        await store.finish({ attemptId: gate.attemptId, result: sent.ok ? "SUCCESS" : "AUTH_ERROR", email, ip });
      }
    } catch (error) {
      entry.outcome = "error";
      entry.error = error instanceof Error ? error.name : "unknown";
    }
    log(entry);
    await pad();
    // Mesma resposta exista ou não a conta, com ou sem limite atingido.
    return respond(200, { success: true, message: PUBLIC_RECOVER_MESSAGE });
  }

  const deny = async () => {
    log(entry);
    await pad();
    return respond(401, { success: false, message: PUBLIC_DENIED_MESSAGE });
  };

  let gate: BeginResult;
  try {
    gate = await store.begin({ kind: "login", email, ip, requestId, domainAllowed });
  } catch (error) {
    // Fail closed: sem a camada de segurança, ninguém entra.
    entry.outcome = "error";
    entry.reason = "SECURITY_UNAVAILABLE";
    entry.error = error instanceof Error ? error.name : "unknown";
    return deny();
  }
  entry.risk = gate.risk;
  if (!gate.allowed || !gate.attemptId) {
    entry.outcome = "denied";
    entry.reason = gate.reason;
    return deny();
  }

  let outcome: SignInOutcome;
  try {
    outcome = await auth.signInWithPassword(email, body.password);
  } catch {
    outcome = { ok: false, status: 0, code: "network" };
  }

  if (!outcome.ok) {
    const result = classifyAuthError(outcome);
    entry.outcome = "failure";
    entry.reason = result;
    entry.auth_status = outcome.status;
    entry.auth_code = outcome.code;
    try {
      await store.finish({ attemptId: gate.attemptId, result, email, ip });
    } catch (error) {
      entry.finish_error = error instanceof Error ? error.name : "unknown";
    }
    return deny();
  }

  let sessionId: string | undefined;
  try {
    const claims = jwtClaims(outcome.session.access_token);
    sessionId = typeof claims.session_id === "string" ? claims.session_id : undefined;
    if (!sessionId || claims.sub !== outcome.userId) throw new Error("claims");
    await store.finish({ attemptId: gate.attemptId, result: "SUCCESS", email, ip, userId: outcome.userId, sessionId });
  } catch (error) {
    // Senha certa, mas a sessão não ficou registrada: ela não abriria o portal. Derruba e nega.
    entry.outcome = "error";
    entry.reason = "SESSION_NOT_REGISTERED";
    entry.error = error instanceof Error ? error.name : "unknown";
    await auth.revokeSession(outcome.session.access_token).catch(() => {});
    return deny();
  }

  entry.outcome = "success";
  log(entry);
  await pad();
  return respond(200, {
    success: true,
    session: { access_token: outcome.session.access_token, refresh_token: outcome.session.refresh_token },
  });
}
