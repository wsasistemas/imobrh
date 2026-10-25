// Testes da camada de segurança do login contra um Postgres real com todas as migrations.
// Cobrem os testes 1-7, 14 e 15 do pedido de segurança (docs/SEGURANCA-LOGIN.md) no banco:
// a Edge Function só repassa a decisão daqui.
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asUser, startTestDb, type TestDb } from "./pgHarness";

let db: TestDb;
let svc: pg.Client;

const DEFAULTS: Record<string, number> = {};

beforeAll(async () => {
  db = await startTestDb(54402);
  svc = await db.connect();
  await svc.query("set role service_role");
  for (const row of (await db.admin.query("select key, value from imobdesk.security_config")).rows) DEFAULTS[row.key] = row.value;
});

afterAll(async () => {
  await svc?.end().catch(() => {});
  await db?.stop();
});

/** Estado limpo e limites padrão; `overrides` isola o mecanismo testado (ex.: sem atraso progressivo). */
async function reset(overrides: Record<string, number> = {}) {
  await db.admin.query(
    "truncate imobdesk.security_auth_control, imobdesk.security_attempts, imobdesk.security_ip_blocks, imobdesk.security_events, imobdesk.security_sessions",
  );
  for (const [key, value] of Object.entries({ ...DEFAULTS, ...overrides })) {
    await db.admin.query("update imobdesk.security_config set value = $2 where key = $1", [key, value]);
  }
}

interface Begin {
  allowed: boolean;
  reason?: string;
  attempt_id?: string;
  risk: number;
}

async function begin(email: string, ip: string, kind = "login", client: pg.Client = svc): Promise<Begin> {
  const { rows } = await client.query("select imobdesk.security_auth_begin($1, $2, $3, $4) as r", [kind, email, ip, randomUUID()]);
  return rows[0].r;
}

async function finish(attempt: string, result: string, email: string, ip: string, userId?: string, sessionId?: string) {
  await svc.query("select imobdesk.security_auth_finish($1, $2, $3, $4, $5, $6)", [attempt, result, email, ip, userId ?? null, sessionId ?? null]);
}

/** Uma tentativa completa com senha errada (o que a Edge Function faz quando o Auth responde invalid_credentials). */
async function fail(email: string, ip: string): Promise<Begin> {
  const r = await begin(email, ip);
  if (r.allowed) await finish(r.attempt_id!, "INVALID_CREDENTIALS", email, ip);
  return r;
}

async function control(email: string) {
  const { rows } = await db.admin.query(
    "select * from imobdesk.security_auth_control where user_hash = imobdesk.security_hash('acct', $1)",
    [email.toLowerCase()],
  );
  return rows[0];
}

async function events(type: string): Promise<number> {
  const { rows } = await db.admin.query("select count(*)::int as n from imobdesk.security_events where event_type = $1", [type]);
  return rows[0].n;
}

/** Simula o fim do bloqueio/espera sem dormir. */
async function expire(email: string) {
  await db.admin.query(
    "update imobdesk.security_auth_control set locked_until = now() - interval '1 second', next_allowed_at = null where user_hash = imobdesk.security_hash('acct', $1)",
    [email],
  );
}

const NO_BACKOFF = { account_backoff_base_ms: 0, velocity_max: 1000, risk_cooldown: 1000, risk_block: 1000, risk_critical: 1000 };

describe("limite por conta e bloqueio", () => {
  beforeEach(() => reset(NO_BACKOFF));

  it("TESTE 1: a 5ª senha inválida bloqueia a conta", async () => {
    const email = "alvo@exemplo.com.br";
    for (let i = 1; i <= 4; i++) {
      expect((await fail(email, "200.1.1.1")).allowed).toBe(true);
      expect((await control(email)).failed_attempts).toBe(i);
    }
    expect((await fail(email, "200.1.1.1")).allowed).toBe(true);
    const c = await control(email);
    expect(c.lock_level).toBe(1);
    expect(new Date(c.locked_until).getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(new Date(c.locked_until).getTime() - Date.now()).toBeLessThanOrEqual(15 * 60_000 + 5_000); // folga de relógio Node x Postgres
    expect(await events("LOGIN_BLOCKED")).toBe(1);

    const next = await begin(email, "200.1.1.1");
    expect(next).toMatchObject({ allowed: false, reason: "SEC_AUTH_001" });
  });

  it("TESTE 2: conta bloqueada não chega ao Auth nem com a senha correta", async () => {
    const email = "alvo@exemplo.com.br";
    for (let i = 0; i < 5; i++) await fail(email, "200.1.1.1");
    // A decisão é tomada antes do Auth, sem a senha: begin nega => a Edge Function não chama o Auth.
    expect(await begin(email, "200.1.1.1")).toMatchObject({ allowed: false, reason: "SEC_AUTH_001" });
  });

  it("TESTE 3: trocar de IP não tira o bloqueio da conta", async () => {
    const email = "alvo@exemplo.com.br";
    for (let i = 0; i < 5; i++) await fail(email, "200.1.1.1");
    for (const ip of ["10.0.0.1", "177.5.5.5", "2804:14c::1", "unknown"]) {
      expect(await begin(email, ip)).toMatchObject({ allowed: false, reason: "SEC_AUTH_001" });
    }
  });

  it("bloqueio escalonado: 15, 30, 60 e depois 60 minutos (nunca permanente)", async () => {
    const email = "alvo@exemplo.com.br";
    const minutes: number[] = [];
    for (let round = 0; round < 4; round++) {
      for (let i = 0; i < 5; i++) await fail(email, `200.1.${round}.${i}`);
      const c = await control(email);
      minutes.push(Math.round((new Date(c.locked_until).getTime() - Date.now()) / 60_000));
      await expire(email);
    }
    expect(minutes).toEqual([15, 30, 60, 60]);
  });

  it("atraso progressivo 1s, 2s, 4s, 8s sem dormir no servidor", async () => {
    await reset({ ...NO_BACKOFF, account_backoff_base_ms: 1000 });
    const email = "alvo@exemplo.com.br";
    const waits: number[] = [];
    for (let i = 0; i < 4; i++) {
      // Um IP por rodada: as tentativas negadas também contam no limite IP + conta, como devem.
      const ip = `200.1.1.${i}`;
      expect((await fail(email, ip)).allowed).toBe(true);
      const c = await control(email);
      waits.push(Math.round((new Date(c.next_allowed_at).getTime() - Date.now()) / 1000));
      // Antes de vencer a espera: negado.
      expect(await begin(email, ip)).toMatchObject({ allowed: false, reason: "SEC_AUTH_002" });
      await db.admin.query("update imobdesk.security_auth_control set next_allowed_at = null where user_id is null");
    }
    expect(waits).toEqual([1, 2, 4, 8]);
  });

  it("TESTE 47/48: login válido zera só as falhas consecutivas; histórico, nível e bloqueio de IP ficam", async () => {
    const email = "alvo@exemplo.com.br";
    for (let i = 0; i < 5; i++) await fail(email, "200.1.1.1");
    await expire(email);
    expect((await fail(email, "200.1.1.9")).allowed).toBe(true);
    await db.admin.query("insert into imobdesk.security_ip_blocks (ip_hash, blocked_until, reason) values ('x', now() + interval '1 hour', 'PASSWORD_SPRAY')");
    const user = randomUUID();
    const ok = await begin(email, "200.1.1.2");
    await finish(ok.attempt_id!, "SUCCESS", email, "200.1.1.2", user, randomUUID());
    const c = await control(email);
    expect(c.failed_attempts).toBe(0);
    expect(c.lock_level).toBe(1);
    expect(c.user_id).toBe(user);
    expect(await events("LOGIN_FAILED")).toBe(6);
    expect((await db.admin.query("select count(*)::int as n from imobdesk.security_ip_blocks")).rows[0].n).toBe(1);
  });

  it("TESTE 11 (banco): e-mail inexistente recebe exatamente o mesmo tratamento", async () => {
    const real = "existe@exemplo.com.br";
    const ghost = "nao-existe@exemplo.com.br";
    await db.admin.query("insert into auth.users (email) values ($1)", [real]);
    const a: Begin[] = [];
    const b: Begin[] = [];
    for (let i = 0; i < 6; i++) {
      a.push(await fail(real, "200.1.1.1"));
      b.push(await fail(ghost, "200.2.2.2"));
    }
    const shape = (list: Begin[]) => list.map((r) => ({ allowed: r.allowed, reason: r.reason ?? null }));
    expect(shape(a)).toEqual(shape(b));
  });

  it("finish não aceita replay nem e-mail trocado", async () => {
    const r = await begin("a@exemplo.com.br", "200.1.1.1");
    await expect(finish(r.attempt_id!, "INVALID_CREDENTIALS", "outro@exemplo.com.br", "200.1.1.1")).rejects.toThrow();
    await finish(r.attempt_id!, "INVALID_CREDENTIALS", "a@exemplo.com.br", "200.1.1.1");
    await expect(finish(r.attempt_id!, "SUCCESS", "a@exemplo.com.br", "200.1.1.1", randomUUID(), randomUUID())).rejects.toThrow();
  });

  it("erro do Auth (fora do ar / limite nativo) não conta como senha errada e libera a reserva", async () => {
    await reset({ ...NO_BACKOFF, distributed_ips_15m: 1000 });
    const email = "a@exemplo.com.br";
    for (let i = 0; i < 7; i++) {
      const r = await begin(email, `200.1.1.${i}`);
      expect(r.allowed).toBe(true);
      await finish(r.attempt_id!, i % 2 ? "AUTH_ERROR" : "AUTH_RATE_LIMITED", email, `200.1.1.${i}`);
    }
    expect((await control(email)).failed_attempts).toBe(0);
  });
});

describe("limites por IP e IP + conta", () => {
  beforeEach(() => reset(NO_BACKOFF));

  it("TESTE 4: IP no limite continua limitado ao trocar de conta", async () => {
    await reset({ ...NO_BACKOFF, spray_accounts_5m: 1000 });
    const ip = "200.9.9.9";
    for (let i = 0; i < 10; i++) expect((await fail(`u${i}@exemplo.com.br`, ip)).allowed).toBe(true);
    for (const email of ["nova@exemplo.com.br", "outra@exemplo.com.br", "u0@exemplo.com.br"]) {
      expect(await begin(email, ip)).toMatchObject({ allowed: false, reason: "SEC_AUTH_005" });
    }
    expect(await events("RATE_LIMIT_IP")).toBe(3);
    // Outro IP segue normal: o limite é do IP, não global.
    expect((await begin("nova@exemplo.com.br", "200.9.9.10")).allowed).toBe(true);
  });

  it("IP + conta: 5 tentativas do mesmo IP na mesma conta em 15 min", async () => {
    await reset({ ...NO_BACKOFF, account_max_failures: 100 });
    const email = "a@exemplo.com.br";
    for (let i = 0; i < 5; i++) expect((await fail(email, "200.1.1.1")).allowed).toBe(true);
    expect(await begin(email, "200.1.1.1")).toMatchObject({ allowed: false, reason: "SEC_AUTH_006" });
    expect(await events("RATE_LIMIT_IP_ACCOUNT")).toBe(1);
  });

  it("tentativa barrada não prolonga o limite de IP + conta (caso de 10/10/2026)", async () => {
    await reset({ ...NO_BACKOFF, account_max_failures: 100 });
    const email = "a@exemplo.com.br";
    for (let i = 0; i < 5; i++) await fail(email, "200.1.1.1");
    // A pessoa insiste durante o bloqueio: cada tentativa é barrada (denied)…
    for (let i = 0; i < 3; i++) expect(await begin(email, "200.1.1.1")).toMatchObject({ allowed: false, reason: "SEC_AUTH_006" });
    // …e quando as 5 senhas erradas saem da janela de 15 min, ela volta a entrar (as barradas não contam).
    await db.admin.query("update imobdesk.security_attempts set created_at = created_at - interval '16 minutes' where outcome = 'failure'");
    expect((await begin(email, "200.1.1.1")).allowed).toBe(true);
  });

  it("login certo não conta para o limite de IP + conta", async () => {
    await reset({ ...NO_BACKOFF, account_max_failures: 100 });
    const email = "a@exemplo.com.br";
    for (let i = 0; i < 6; i++) {
      const r = await begin(email, "200.1.1.1");
      expect(r.allowed).toBe(true);
      await finish(r.attempt_id!, "SUCCESS", email, "200.1.1.1", randomUUID(), randomUUID());
    }
  });

  it("limite por conta somando IPs (20 em 15 min)", async () => {
    await reset({ ...NO_BACKOFF, account_max_failures: 1000, distributed_ips_15m: 1000 });
    const email = "a@exemplo.com.br";
    for (let i = 0; i < 20; i++) expect((await fail(email, `201.0.${i}.1`)).allowed).toBe(true);
    expect(await begin(email, "201.0.99.1")).toMatchObject({ allowed: false, reason: "SEC_AUTH_007" });
    expect(await events("RATE_LIMIT_ACCOUNT")).toBe(1);
  });
});

describe("password spraying, ataque distribuído e bots", () => {
  beforeEach(() => reset(NO_BACKOFF));

  it("TESTE 5: um IP tentando mais de 10 contas em 5 min é detectado e bloqueado", async () => {
    await reset({ ...NO_BACKOFF, ip_attempts_1m: 1000, ip_attempts_15m: 1000, ip_attempts_1h: 1000 });
    const ip = "200.7.7.7";
    for (let i = 0; i < 10; i++) expect((await fail(`v${i}@exemplo.com.br`, ip)).allowed).toBe(true);
    expect(await begin("v10@exemplo.com.br", ip)).toMatchObject({ allowed: false, reason: "SEC_AUTH_008" });
    expect(await events("PASSWORD_SPRAY_DETECTED")).toBe(1);
    // IP fica bloqueado para qualquer conta, inclusive uma nunca tentada.
    expect(await begin("nunca@exemplo.com.br", ip)).toMatchObject({ allowed: false, reason: "SEC_AUTH_004" });
    const sev = await db.admin.query("select severity from imobdesk.security_events where event_type = 'PASSWORD_SPRAY_DETECTED'");
    expect(sev.rows[0].severity).toBe("critical");
  });

  it("TESTE 6: vários IPs na mesma conta (cada um abaixo do limite) bloqueiam a conta", async () => {
    await reset({ ...NO_BACKOFF, account_max_failures: 100 });
    const email = "alvo@exemplo.com.br";
    for (let i = 1; i <= 5; i++) expect((await fail(email, `189.${i}.0.1`)).allowed).toBe(true);
    expect(await begin(email, "189.6.0.1")).toMatchObject({ allowed: false, reason: "SEC_AUTH_009" });
    expect(await events("DISTRIBUTED_ATTACK")).toBe(1);
    // Conta bloqueada para qualquer IP novo.
    expect(await begin(email, "189.7.0.1")).toMatchObject({ allowed: false, reason: "SEC_AUTH_001" });
  });

  it("limites padrão: usuário errando de vários IPs ganha só uma pausa curta, e o IP (NAT do escritório) não é bloqueado", async () => {
    await reset();
    const email = "humano@exemplo.com.br";
    for (let i = 0; i < 3; i++) {
      // Humano: tentativas espaçadas (recua os registros no tempo em vez de dormir no teste).
      await db.admin.query("update imobdesk.security_attempts set created_at = created_at - interval '20 seconds'");
      await db.admin.query("update imobdesk.security_auth_control set next_allowed_at = null");
      expect((await fail(email, `177.10.${i}.1`)).allowed).toBe(true);
    }
    // Logo depois da 3ª falha vale a espera progressiva (4 s).
    expect(await begin(email, "177.10.9.1")).toMatchObject({ allowed: false, reason: "SEC_AUTH_002" });
    // Passada a espera, o risco (alto só por sinais da conta: 3 falhas + 4 IPs) pede intervalo mínimo
    // desde a última tentativa — e não bloqueia o IP.
    await db.admin.query("update imobdesk.security_auth_control set next_allowed_at = null");
    expect(await begin(email, "177.10.9.1")).toMatchObject({ allowed: false, reason: "SEC_AUTH_010", risk: 60 });
    expect((await db.admin.query("select count(*)::int as n from imobdesk.security_ip_blocks")).rows[0].n).toBe(0);
    await db.admin.query("update imobdesk.security_attempts set created_at = created_at - interval '20 seconds'");
    await db.admin.query("update imobdesk.security_auth_control set next_allowed_at = null");
    expect((await begin(email, "177.10.9.1")).allowed).toBe(true);
    // Colegas atrás do mesmo IP seguem entrando.
    expect((await begin("colega@exemplo.com.br", "177.10.9.1")).allowed).toBe(true);
  });

  it("limites padrão: script rápido (sem pausa) contra várias contas é barrado pelo risco antes do 10º alvo", async () => {
    await reset();
    const ip = "200.66.66.66";
    let denied: Begin | null = null;
    let tried = 0;
    for (let i = 0; i < 20 && !denied; i++) {
      const r = await fail(`bot${i}@exemplo.com.br`, ip);
      tried++;
      if (!r.allowed) denied = r;
    }
    expect(denied).not.toBeNull();
    expect(tried).toBeLessThan(10);
    expect(["SEC_AUTH_010", "SEC_AUTH_011", "SEC_AUTH_012"]).toContain(denied!.reason);
    const { rows } = await db.admin.query("select detail from imobdesk.security_events where event_type in ('BOT_PATTERN','LOGIN_BLOCKED') order by id desc limit 1");
    expect(rows[0].detail.signals).toContain("velocidade_anormal");
  });
});

describe("TESTE 7: concorrência (50 requisições simultâneas)", () => {
  let pool: pg.Client[] = [];
  beforeAll(async () => {
    pool = await Promise.all(Array.from({ length: 50 }, () => db.connect()));
    await Promise.all(pool.map((c) => c.query("set role service_role")));
  });
  afterAll(async () => {
    await Promise.all(pool.map((c) => c.end().catch(() => {})));
  });

  it("conta com 4 falhas: das 50 simultâneas só 1 chega ao Auth, e a conta bloqueia", async () => {
    await reset(NO_BACKOFF);
    const email = "corrida@exemplo.com.br";
    for (let i = 0; i < 4; i++) await fail(email, `177.0.0.${i}`);
    const results = await Promise.all(pool.map((c, i) => begin(email, `177.1.${i}.1`, "login", c)));
    const allowed = results.filter((r) => r.allowed);
    expect(allowed).toHaveLength(1);
    await finish(allowed[0].attempt_id!, "INVALID_CREDENTIALS", email, "177.1.0.1");
    expect((await control(email)).lock_level).toBe(1);
    const authCalls = (await db.admin.query("select count(*)::int as n from imobdesk.security_attempts where outcome <> 'denied'")).rows[0].n;
    expect(authCalls).toBe(5);
  });

  it("50 simultâneas do mesmo IP em contas diferentes respeitam o limite de 10/min do IP", async () => {
    await reset({ ...NO_BACKOFF, spray_accounts_5m: 1000 });
    const results = await Promise.all(pool.map((c, i) => begin(`p${i}@exemplo.com.br`, "200.50.50.50", "login", c)));
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
  });

  it("50 simultâneas na mesma conta e mesmo IP: 1 passa, as outras viram sinal de automação", async () => {
    await reset(NO_BACKOFF);
    const results = await Promise.all(pool.map((c) => begin("par@exemplo.com.br", "200.51.51.51", "login", c)));
    expect(results.filter((r) => r.allowed)).toHaveLength(1);
    expect(await events("BOT_PATTERN")).toBeGreaterThan(0);
  });
});

describe("recuperação de senha", () => {
  beforeEach(() => reset(NO_BACKOFF));

  it("3 pedidos por conta por hora e 5 por IP em 15 min", async () => {
    for (let i = 0; i < 3; i++) {
      const r = await begin("a@exemplo.com.br", `200.3.3.${i}`, "recover");
      expect(r.allowed).toBe(true);
      await finish(r.attempt_id!, "SUCCESS", "a@exemplo.com.br", `200.3.3.${i}`);
    }
    expect(await begin("a@exemplo.com.br", "200.3.3.9", "recover")).toMatchObject({ allowed: false, reason: "SEC_AUTH_020" });
    for (let i = 0; i < 5; i++) expect((await begin(`r${i}@exemplo.com.br`, "200.4.4.4", "recover")).allowed).toBe(true);
    expect(await begin("r9@exemplo.com.br", "200.4.4.4", "recover")).toMatchObject({ allowed: false, reason: "SEC_AUTH_020" });
  });

  it("conta bloqueada ainda pode pedir redefinição (é como o dono legítimo sai do bloqueio)", async () => {
    for (let i = 0; i < 5; i++) await fail("a@exemplo.com.br", "200.1.1.1");
    expect((await begin("a@exemplo.com.br", "200.1.1.2", "recover")).allowed).toBe(true);
  });
});

describe("RLS em todo o schema do portal", () => {
  it("todas as tabelas do schema têm RLS ligada", async () => {
    const { rows } = await db.admin.query(
      "select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'imobdesk' and c.relkind = 'r' and not c.relrowsecurity order by 1",
    );
    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  it("anon não tem privilégio em nenhuma tabela nem função do schema", async () => {
    const tables = await db.admin.query(
      "select table_name, privilege_type from information_schema.role_table_grants where table_schema = 'imobdesk' and grantee in ('anon', 'PUBLIC')",
    );
    expect(tables.rows).toEqual([]);
    const fns = await db.admin.query(
      "select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'imobdesk' and has_function_privilege('anon', p.oid, 'execute') order by 1",
    );
    expect(fns.rows.map((r) => r.proname)).toEqual([]);
  });
});

describe("TESTE 15 / RLS das tabelas de segurança", () => {
  const tables = ["security_config", "security_secret", "security_auth_control", "security_attempts", "security_ip_blocks", "security_events", "security_sessions"];

  const pk: Record<string, string> = {
    security_config: "key", security_secret: "id", security_auth_control: "user_hash", security_attempts: "id",
    security_ip_blocks: "ip_hash", security_events: "event_type", security_sessions: "session_id",
  };

  it.each(["authenticated", "anon"])("%s não lê, não altera e não apaga as tabelas de segurança", async (role) => {
    const claims = { role, sub: role === "anon" ? undefined : randomUUID(), session_id: randomUUID() };
    for (const table of tables) {
      for (const sql of [
        `select * from imobdesk.${table} limit 1`,
        `update imobdesk.${table} set ${pk[table]} = ${pk[table]}`,
        `delete from imobdesk.${table}`,
        `insert into imobdesk.${table} default values`,
      ]) {
        await expect(asUser(db.admin, claims, (c) => c.query(sql)), `${role}: ${sql}`).rejects.toThrow(/permission denied/);
      }
    }
  });

  it.each(["authenticated", "anon"])("%s não executa as funções do gateway nem o hook", async (role) => {
    const claims = { role, sub: randomUUID() };
    for (const sql of [
      "select imobdesk.security_auth_begin('login', 'a@exemplo.com.br', '1.1.1.1', gen_random_uuid())",
      "select imobdesk.security_auth_finish(gen_random_uuid(), 'SUCCESS', 'a@exemplo.com.br', '1.1.1.1')",
      "select imobdesk.security_password_verification_hook('{}'::jsonb)",
      "select imobdesk.security_hash('acct', 'a')",
      "select imobdesk.security_sessao_valida(gen_random_uuid(), gen_random_uuid(), '[]')",
    ]) {
      await expect(asUser(db.admin, claims, (c) => c.query(sql)), sql).rejects.toThrow(/permission denied/);
    }
  });
});

describe("sessão confiável (bypass do gateway pela API do Auth)", () => {
  let alice: string;
  let bob: string;

  beforeAll(async () => {
    await reset(NO_BACKOFF);
    const mk = async (email: string, nome: string, perfil: string) => {
      const { rows } = await db.admin.query("insert into auth.users (email) values ($1) returning id", [email]);
      await db.admin.query("insert into imobdesk.usuarios (id, email, nome, perfil_key, status) values ($1, $2, $3, $4, 'active')", [rows[0].id, email, nome, perfil]);
      return rows[0].id as string;
    };
    alice = await mk("alice@exemplo.com.br", "Alice Teste", "operador");
    bob = await mk("bob@exemplo.com.br", "Bob Teste", "operador");
  });

  async function session(user: string) {
    const { rows } = await db.admin.query("insert into auth.sessions (user_id) values ($1) returning id", [user]);
    return rows[0].id as string;
  }
  const claims = (user: string, sid: string, method = "password") => ({ role: "authenticated", sub: user, session_id: sid, amr: [{ method, timestamp: 1 }] });
  const portalAccess = (c: Record<string, unknown>) =>
    asUser(db.admin, c, async (client) => {
      const { rows } = await client.query(
        "select imobdesk.usuario_portal_ativo() as ativo, imobdesk.perfil_usuario_atual() as perfil, (select count(*)::int from imobdesk.perfis) as perfis",
      );
      return rows[0];
    });

  it("sessão de senha criada direto no Auth (sem gateway) não acessa o portal", async () => {
    const sid = await session(alice);
    expect(await portalAccess(claims(alice, sid))).toEqual({ ativo: false, perfil: null, perfis: 0 });
  });

  it("sessão de senha emitida pelo gateway acessa", async () => {
    const sid = await session(alice);
    const r = await begin("alice@exemplo.com.br", "200.1.1.1");
    await finish(r.attempt_id!, "SUCCESS", "alice@exemplo.com.br", "200.1.1.1", alice, sid);
    // 6 perfis: os 5 do modelo + "solicitante" (App do solicitante, 20261010100000).
    expect(await portalAccess(claims(alice, sid))).toEqual({ ativo: true, perfil: "operador", perfis: 6 });
  });

  it("sessão de link de e-mail (recovery) acessa sem vínculo; a de senha não", async () => {
    const sid = await session(alice);
    expect((await portalAccess(claims(alice, sid, "recovery"))).ativo).toBe(true);
    expect((await portalAccess(claims(alice, sid, "password"))).ativo).toBe(false);
  });

  it("logout (sessão apagada no Auth) corta o acesso na hora, mesmo com o JWT ainda válido", async () => {
    const sid = await session(alice);
    const r = await begin("alice@exemplo.com.br", "200.1.1.1");
    await finish(r.attempt_id!, "SUCCESS", "alice@exemplo.com.br", "200.1.1.1", alice, sid);
    expect((await portalAccess(claims(alice, sid))).ativo).toBe(true);
    await db.admin.query("delete from auth.sessions where id = $1", [sid]);
    expect((await portalAccess(claims(alice, sid))).ativo).toBe(false);
  });

  it("session_id de outro usuário no JWT não vale", async () => {
    const sidBob = await session(bob);
    const r = await begin("bob@exemplo.com.br", "200.1.1.1");
    await finish(r.attempt_id!, "SUCCESS", "bob@exemplo.com.br", "200.1.1.1", bob, sidBob);
    expect((await portalAccess(claims(alice, sidBob))).ativo).toBe(false);
  });

  it("troca de senha: desbloqueia a conta e derruba as outras sessões de senha", async () => {
    const atual = await session(alice);
    const outra = await session(alice);
    for (const sid of [atual, outra]) {
      const r = await begin("alice@exemplo.com.br", "200.1.1.1");
      await finish(r.attempt_id!, "SUCCESS", "alice@exemplo.com.br", "200.1.1.1", alice, sid);
    }
    await reset(NO_BACKOFF);
    for (const sid of [atual, outra]) {
      await db.admin.query("insert into imobdesk.security_sessions (session_id, user_id) values ($1, $2)", [sid, alice]);
    }
    for (let i = 0; i < 5; i++) await fail("alice@exemplo.com.br", "200.1.1.1");
    expect((await control("alice@exemplo.com.br")).locked_until).not.toBeNull();

    await asUser(db.admin, claims(alice, atual, "recovery"), (c) => c.query("select imobdesk.security_apos_troca_senha()"));
    // asUser desfaz a transação; repete fora dela para conferir o efeito.
    await db.admin.query("begin");
    await db.admin.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims(alice, atual, "recovery"))]);
    await db.admin.query("select imobdesk.security_apos_troca_senha()");
    await db.admin.query("commit");

    expect((await control("alice@exemplo.com.br")).locked_until).toBeNull();
    expect((await portalAccess(claims(alice, atual))).ativo).toBe(true);
    expect((await portalAccess(claims(alice, outra))).ativo).toBe(false);
    // Caso de 10/10/2026: logo depois de trocar a senha, a conta entra do mesmo IP (as 5 falhas eram de antes da troca).
    expect((await begin("alice@exemplo.com.br", "200.1.1.1")).allowed).toBe(true);
  });

  it("TESTE 14: usuário A não lê o registro do usuário B", async () => {
    const sid = await session(alice);
    await db.admin.query("insert into imobdesk.security_sessions (session_id, user_id) values ($1, $2) on conflict do nothing", [sid, alice]);
    const ids = await asUser(db.admin, claims(alice, sid), async (c) => (await c.query("select id from imobdesk.usuarios")).rows.map((r) => r.id));
    expect(ids).toEqual([alice]);
    const write = asUser(db.admin, claims(alice, sid), (c) => c.query("update imobdesk.usuarios set nome = 'Hacker' where id = $1", [bob]));
    await expect(write).rejects.toThrow(/permission denied/);
  });
});

describe("Password Verification Hook do Auth (opcional)", () => {
  let carol: string;
  beforeAll(async () => {
    const { rows } = await db.admin.query("insert into auth.users (email) values ('Carol@Exemplo.com.br') returning id");
    carol = rows[0].id;
  });
  beforeEach(() => reset({ ...NO_BACKOFF, hook_counts_failures: 1 }));

  const hook = async (valid: boolean) => {
    const client = await db.connect();
    try {
      await client.query("set role supabase_auth_admin");
      const { rows } = await client.query("select imobdesk.security_password_verification_hook($1) as r", [JSON.stringify({ user_id: carol, valid })]);
      return rows[0].r;
    } finally {
      await client.end();
    }
  };

  it("login direto no Auth: conta as falhas, bloqueia na 5ª e rejeita até a senha certa", async () => {
    for (let i = 0; i < 5; i++) expect(await hook(false)).toEqual({ decision: "continue" });
    const r = await hook(true);
    expect(r.decision).toBe("reject");
    expect(r.message).toBe("Não foi possível realizar o acesso. Verifique os dados informados ou tente novamente mais tarde.");
    // O bloqueio é o mesmo do gateway (mesma chave HMAC do e-mail normalizado).
    expect(await begin("carol@exemplo.com.br", "200.1.1.1")).toMatchObject({ allowed: false, reason: "SEC_AUTH_001" });
  });

  it("com o hook ligado, a falha que passou pelo gateway não é contada duas vezes", async () => {
    for (let i = 0; i < 4; i++) {
      const r = await begin("carol@exemplo.com.br", `200.1.1.${i}`);
      expect(r.allowed).toBe(true);
      await hook(false); // o Auth chama o hook durante a tentativa do gateway
      await finish(r.attempt_id!, "INVALID_CREDENTIALS", "carol@exemplo.com.br", `200.1.1.${i}`);
    }
    expect((await control("carol@exemplo.com.br")).failed_attempts).toBe(4);
  });
});
