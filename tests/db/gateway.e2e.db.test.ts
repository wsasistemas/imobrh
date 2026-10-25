// Ponta a ponta: o gateway HTTP de verdade (handleAuthRequest) ligado às funções de verdade no
// Postgres (security_auth_begin/finish), com o Supabase Auth simulado. Mostra pelo HTTP o que
// security.db.test.ts mostra no banco: 50 requisições simultâneas, bloqueio, senha certa barrada,
// e a sessão emitida pelo gateway valendo na RLS.
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleAuthRequest, type AuthBackend, type GatewayStore } from "../../supabase/functions/_shared/security/gateway";
import { asUser, startTestDb, type TestDb } from "./pgHarness";

let db: TestDb;
let pool: pg.Client[] = [];
let next = 0;
let userId: string;
const EMAIL = "e2e@exemplo.com.br";
const RIGHT = "Senha-Certa#1";
let authCalls = 0;

const client = () => pool[next++ % pool.length];

const store: GatewayStore = {
  async begin({ kind, email, ip, requestId, domainAllowed }) {
    const { rows } = await client().query("select imobdesk.security_auth_begin($1, $2, $3, $4, $5) as r", [kind, email, ip, requestId, domainAllowed]);
    const r = rows[0].r;
    return { allowed: r.allowed, attemptId: r.attempt_id, reason: r.reason, risk: r.risk };
  },
  async finish({ attemptId, result, email, ip, userId: uid, sessionId }) {
    await client().query("select imobdesk.security_auth_finish($1, $2, $3, $4, $5, $6)", [attemptId, result, email, ip, uid ?? null, sessionId ?? null]);
  },
};

function jwt(claims: Record<string, unknown>) {
  const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${enc({ alg: "HS256" })}.${enc(claims)}.x`;
}

/** Supabase Auth simulado: cria a sessão em auth.sessions como o GoTrue faria. */
const auth: AuthBackend = {
  async signInWithPassword(email, password) {
    authCalls++;
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (email !== EMAIL || password !== RIGHT) return { ok: false, status: 400, code: "invalid_credentials" };
    const { rows } = await db.admin.query("insert into auth.sessions (user_id) values ($1) returning id", [userId]);
    return { ok: true, userId, session: { access_token: jwt({ sub: userId, session_id: rows[0].id, amr: [{ method: "password" }] }), refresh_token: "r" } };
  },
  async resetPasswordForEmail() {
    return { ok: true };
  },
  async revokeSession() {},
};

const config = { allowedOrigins: ["https://portal.test"], ipHeader: "x-forwarded-for", isDomainAllowed: async (email: string) => email.endsWith("@exemplo.com.br"), resetPath: "/redefinir-senha", minResponseMs: 0, jitterMs: 0 };

function request(password: string, ip = "200.1.1.1") {
  return handleAuthRequest(
    new Request("https://fn/auth", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify({ action: "login", email: EMAIL, password }),
    }),
    { store, auth, config },
  );
}

beforeAll(async () => {
  db = await startTestDb(54403);
  pool = await Promise.all(Array.from({ length: 20 }, () => db.connect()));
  await Promise.all(pool.map((c) => c.query("set role service_role")));
  const { rows } = await db.admin.query("insert into auth.users (email) values ($1) returning id", [EMAIL]);
  userId = rows[0].id;
  await db.admin.query("insert into imobdesk.usuarios (id, email, nome, perfil_key, status) values ($1, $2, 'Usuário E2E', 'operador', 'active')", [userId, EMAIL]);
});

afterAll(async () => {
  await Promise.all(pool.map((c) => c.end().catch(() => {})));
  await db?.stop();
});

beforeEach(async () => {
  authCalls = 0;
  await db.admin.query("truncate imobdesk.security_auth_control, imobdesk.security_attempts, imobdesk.security_ip_blocks, imobdesk.security_events, imobdesk.security_sessions");
  await db.admin.query("update imobdesk.security_config set value = 0 where key = 'account_backoff_base_ms'");
  // Isola o bloqueio por conta: o motor de risco (rajada de requisições no teste) tem testes próprios.
  await db.admin.query("update imobdesk.security_config set value = 1000 where key in ('velocity_max', 'risk_cooldown', 'risk_block', 'risk_critical')");
});

describe("gateway + banco", () => {
  it("50 requisições HTTP simultâneas com senha errada: o Auth recebe 1", async () => {
    const responses = await Promise.all(Array.from({ length: 50 }, (_, i) => request(`errada-${i}`, `200.2.${i}.1`)));
    expect(new Set(responses.map((r) => r.status))).toEqual(new Set([401]));
    expect(authCalls).toBe(1);
  });

  it("5 senhas erradas bloqueiam; a 6ª tentativa com a senha CERTA nem chega ao Auth", async () => {
    for (let i = 0; i < 5; i++) expect((await request(`errada-${i}`, `200.3.${i}.1`)).status).toBe(401);
    expect(authCalls).toBe(5);
    const blocked = await request(RIGHT, "200.3.99.1");
    expect(blocked.status).toBe(401);
    expect(authCalls).toBe(5);
  });

  it("login certo: sessão registrada e aceita pela RLS do portal", async () => {
    const response = await request(RIGHT);
    expect(response.status).toBe(200);
    const { session } = (await response.json()) as { session: { access_token: string } };
    const claims = JSON.parse(Buffer.from(session.access_token.split(".")[1], "base64url").toString());
    const ativo = await asUser(db.admin, { role: "authenticated", ...claims }, async (c) => (await c.query("select imobdesk.usuario_portal_ativo() as v")).rows[0].v);
    expect(ativo).toBe(true);
  });

  it("depois do login certo, as falhas consecutivas zeram", async () => {
    for (let i = 0; i < 3; i++) await request(`errada-${i}`, `200.4.${i}.1`);
    expect((await request(RIGHT, "200.4.9.1")).status).toBe(200);
    const { rows } = await db.admin.query("select failed_attempts from imobdesk.security_auth_control where user_id = $1", [userId]);
    expect(rows[0].failed_attempts).toBe(0);
  });

  it("uma requisição inválida não consome tentativa nem chega ao banco", async () => {
    const response = await handleAuthRequest(
      new Request("https://fn/auth", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "login", email: EMAIL }) }),
      { store, auth, config },
    );
    expect(response.status).toBe(400);
    expect((await db.admin.query("select count(*)::int as n from imobdesk.security_attempts")).rows[0].n).toBe(0);
  });
});
