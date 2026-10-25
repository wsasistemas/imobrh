// Security Gateway do login (supabase/functions/_shared/security/gateway.ts).
// Cobre os testes 2, 8-12 do pedido de segurança na camada HTTP: resposta uniforme (sem
// enumeração), erro do Supabase nunca vaza, fail closed, validação de payload, IP confiável,
// chamada direta (curl/Postman) sujeita às mesmas regras. Os limites em si: tests/db/.
import { describe, expect, it, vi } from "vitest";
import {
  classifyAuthError,
  clientIp,
  handleAuthRequest,
  PUBLIC_DENIED_MESSAGE,
  PUBLIC_RECOVER_MESSAGE,
  type AuthBackend,
  type BeginResult,
  type GatewayConfig,
  type GatewayStore,
  type SignInOutcome,
} from "../supabase/functions/_shared/security/gateway";

const ORIGIN = "https://portal.exemplo.com.br";
const PASSWORD = "Senha-Secreta#2026";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";

function jwt(claims: Record<string, unknown>): string {
  const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${enc({ alg: "HS256" })}.${enc(claims)}.assinatura`;
}
const ACCESS = jwt({ sub: USER_ID, session_id: SESSION_ID, amr: [{ method: "password" }] });
const REFRESH = "refresh-token-opaco";

const config: GatewayConfig = {
  allowedOrigins: [ORIGIN, "http://localhost:5173"],
  ipHeader: "x-forwarded-for",
  // E-mail de empresa cliente (no servidor: cadastro ativo ou domínio da empresa).
  isDomainAllowed: async (email: string) => email.endsWith("@exemplo.com.br"),
  resetPath: "/redefinir-senha",
  minResponseMs: 900,
  jitterMs: 0,
};

interface Scenario {
  begin?: BeginResult | Error;
  signIn?: SignInOutcome | Error;
  finish?: Error;
  reset?: { ok: boolean; status?: number };
}

function setup(scenario: Scenario = {}) {
  let clock = 0;
  const logs: Record<string, unknown>[] = [];
  const store: GatewayStore = {
    begin: vi.fn(async () => {
      clock += 5;
      if (scenario.begin instanceof Error) throw scenario.begin;
      return scenario.begin ?? { allowed: true, attemptId: "attempt-1", risk: 0 };
    }),
    finish: vi.fn(async () => {
      clock += 5;
      if (scenario.finish) throw scenario.finish;
    }),
  };
  const auth: AuthBackend = {
    signInWithPassword: vi.fn(async () => {
      clock += 300; // o Auth leva tempo (bcrypt); negar antes dele não pode ser mais rápido na resposta
      if (scenario.signIn instanceof Error) throw scenario.signIn;
      return scenario.signIn ?? { ok: true, userId: USER_ID, session: { access_token: ACCESS, refresh_token: REFRESH } };
    }),
    resetPasswordForEmail: vi.fn(async () => scenario.reset ?? { ok: true }),
    revokeSession: vi.fn(async () => {}),
  };
  const sleep = vi.fn(async (ms: number) => {
    clock += ms;
  });
  const deps = { store, auth, config, log: (entry: Record<string, unknown>) => logs.push(entry), sleep, now: () => clock, random: () => 0 };
  const send = async (init: { body?: unknown; raw?: string; headers?: Record<string, string>; method?: string } = {}) => {
    clock = 0;
    const headers = new Headers({ "content-type": "application/json", origin: ORIGIN, "x-forwarded-for": "200.10.20.30", ...init.headers });
    for (const [key, value] of Object.entries(init.headers ?? {})) if (value === "") headers.delete(key);
    const method = init.method ?? "POST";
    const body = method === "GET" ? undefined : (init.raw ?? JSON.stringify(init.body ?? { action: "login", email: "alvo@exemplo.com.br", password: PASSWORD }));
    const response = await handleAuthRequest(new Request("https://fn.supabase.co/imobdesk-auth", { method, headers, body }), deps);
    const text = await response.text();
    return { status: response.status, text, json: text ? JSON.parse(text) : null, headers: response.headers, elapsed: clock };
  };
  return { store, auth, sleep, logs, send };
}

describe("TESTE 11: enumeração — toda negativa é igual", () => {
  const cases: Array<[string, Scenario, Record<string, unknown>?]> = [
    ["usuário inexistente", { signIn: { ok: false, status: 400, code: "invalid_credentials" } }],
    ["senha inválida", { signIn: { ok: false, status: 400, code: "invalid_credentials" } }],
    ["conta bloqueada (nem chega ao Auth)", { begin: { allowed: false, reason: "SEC_AUTH_001", risk: 40 } }],
    ["IP limitado", { begin: { allowed: false, reason: "SEC_AUTH_005", risk: 20 } }],
    ["conta sem confirmação / banida", { signIn: { ok: false, status: 400, code: "email_not_confirmed" } }],
    ["Auth fora do ar", { signIn: { ok: false, status: 500, code: "unexpected_failure" } }],
    ["camada de segurança fora do ar", { begin: new Error("connection refused") }],
    ["domínio fora da empresa", {}, { action: "login", email: "alguem@gmail.com", password: PASSWORD }],
  ];

  it("mesmo status, mesmo corpo, mesmos cabeçalhos e mesmo tempo de resposta", async () => {
    const seen = new Set<string>();
    const times = new Set<number>();
    for (const [, scenario, body] of cases) {
      const { send } = setup(scenario.begin || scenario.signIn ? scenario : { begin: { allowed: false, reason: "SEC_AUTH_013", risk: 0 } });
      const response = await send(body ? { body } : {});
      const headerNames = [...response.headers.keys()].filter((key) => key !== "x-request-id").sort().join(",");
      seen.add(`${response.status}|${response.text}|${headerNames}`);
      times.add(response.elapsed);
    }
    expect(seen.size).toBe(1);
    expect([...seen][0]).toContain(`401|${JSON.stringify({ success: false, message: PUBLIC_DENIED_MESSAGE })}`);
    expect([...times]).toEqual([900]);
  });

  it("não devolve tentativas restantes, locked_until, risco nem motivo", async () => {
    const { send } = setup({ begin: { allowed: false, reason: "SEC_AUTH_001", risk: 90 } });
    const { json } = await send();
    expect(Object.keys(json).sort()).toEqual(["message", "success"]);
  });
});

describe("TESTE 2: conta bloqueada", () => {
  it("com a senha correta, o Supabase Auth nem é chamado", async () => {
    const { send, auth, store } = setup({ begin: { allowed: false, reason: "SEC_AUTH_001", risk: 40 } });
    const response = await send();
    expect(response.status).toBe(401);
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
    expect(store.finish).not.toHaveBeenCalled();
  });
});

describe("TESTE 12: erro do Supabase nunca chega ao cliente", () => {
  it("mensagem técnica do Auth (resposta ou exceção) não aparece na resposta nem no log", async () => {
    for (const signIn of [new Error("Database error querying schema"), { ok: false as const, status: 500, code: "unexpected_failure" }]) {
      const { send, logs } = setup({ signIn });
      const response = await send();
      expect(response.text).not.toMatch(/database|schema|querying|unexpected|invalid login/i);
      expect(JSON.stringify(logs)).not.toMatch(/Database error querying schema/);
    }
  });

  it("log não tem senha, e-mail completo nem tokens", async () => {
    const { send, logs } = setup();
    await send();
    const all = JSON.stringify(logs);
    expect(all).not.toContain(PASSWORD);
    expect(all).not.toContain("alvo@exemplo.com.br");
    expect(all).not.toContain(ACCESS);
    expect(all).not.toContain(REFRESH);
  });
});

describe("fail closed", () => {
  it("falha da camada de segurança: nega e não chama o Auth", async () => {
    const { send, auth } = setup({ begin: new Error("timeout") });
    expect((await send()).status).toBe(401);
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
  });

  it("senha certa mas sessão não registrada: derruba a sessão no Auth e nega", async () => {
    const { send, auth } = setup({ finish: new Error("db down") });
    const response = await send();
    expect(response.status).toBe(401);
    expect(response.text).not.toContain(ACCESS);
    expect(auth.revokeSession).toHaveBeenCalledWith(ACCESS);
  });

  it("token do Auth de outro usuário ou sem session_id: derruba e nega", async () => {
    for (const access of [jwt({ sub: "outro", session_id: SESSION_ID }), jwt({ sub: USER_ID })]) {
      const { send, auth, store } = setup({ signIn: { ok: true, userId: USER_ID, session: { access_token: access, refresh_token: REFRESH } } });
      expect((await send()).status).toBe(401);
      expect(auth.revokeSession).toHaveBeenCalled();
      expect(store.finish).not.toHaveBeenCalled();
    }
  });
});

describe("login com sucesso", () => {
  it("devolve só os tokens oficiais do Supabase e registra a sessão", async () => {
    const { send, store } = setup();
    const response = await send();
    expect(response.status).toBe(200);
    expect(response.json).toEqual({ success: true, session: { access_token: ACCESS, refresh_token: REFRESH } });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(store.finish).toHaveBeenCalledWith(expect.objectContaining({ result: "SUCCESS", userId: USER_ID, sessionId: SESSION_ID, ip: "200.10.20.30" }));
  });

  it("senha errada conta como INVALID_CREDENTIALS; erro do Auth não", async () => {
    const wrong = setup({ signIn: { ok: false, status: 400, code: "invalid_credentials" } });
    await wrong.send();
    expect(wrong.store.finish).toHaveBeenCalledWith(expect.objectContaining({ result: "INVALID_CREDENTIALS" }));
    const down = setup({ signIn: { ok: false, status: 503 } });
    await down.send();
    expect(down.store.finish).toHaveBeenCalledWith(expect.objectContaining({ result: "AUTH_ERROR" }));
  });
});

describe("validação do payload antes de qualquer coisa", () => {
  const invalid: Array<[string, Parameters<ReturnType<typeof setup>["send"]>[0], number]> = [
    ["JSON quebrado", { raw: "{nao é json" }, 400],
    ["corpo é lista", { body: [] }, 400],
    ["campo a mais", { body: { action: "login", email: "a@exemplo.com.br", password: "x", is_admin: true } }, 400],
    ["sem senha", { body: { action: "login", email: "a@exemplo.com.br" } }, 400],
    ["senha vazia", { body: { action: "login", email: "a@exemplo.com.br", password: "" } }, 400],
    ["senha enorme", { body: { action: "login", email: "a@exemplo.com.br", password: "x".repeat(257) } }, 400],
    ["senha não-string", { body: { action: "login", email: "a@exemplo.com.br", password: { $ne: 1 } } }, 400],
    ["e-mail inválido", { body: { action: "login", email: "a@", password: "x" } }, 400],
    ["e-mail enorme", { body: { action: "login", email: `${"a".repeat(250)}@exemplo.com.br`, password: "x" } }, 400],
    ["ação desconhecida", { body: { action: "signup", email: "a@exemplo.com.br", password: "x" } }, 400],
    ["corpo acima de 2 KB", { raw: JSON.stringify({ action: "login", email: "a@exemplo.com.br", password: "x".repeat(3000) }) }, 413],
    ["content-type errado", { headers: { "content-type": "text/plain" } }, 415],
    ["GET", { method: "GET" }, 405],
    ["origem desconhecida", { headers: { origin: "https://evil.example" } }, 403],
  ];

  it.each(invalid)("%s: recusa sem tocar no banco nem no Auth", async (_name, init, status) => {
    const { send, store, auth } = setup();
    const response = await send(init);
    expect(response.status).toBe(status);
    expect(response.text).not.toMatch(/exemplo|senha|password|stack|Error/i);
    expect(store.begin).not.toHaveBeenCalled();
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
  });
});

describe("TESTES 8-10: sem front, Postman, curl", () => {
  it("chamada direta sem Origin, sem apikey e com User-Agent de script passa pelas MESMAS regras", async () => {
    const { send, store } = setup({ begin: { allowed: false, reason: "SEC_AUTH_001", risk: 40 } });
    const response = await send({ headers: { origin: "", "user-agent": "curl/8.5.0" } });
    expect(store.begin).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(401);
    expect(response.json).toEqual({ success: false, message: PUBLIC_DENIED_MESSAGE });
  });

  it("CORS só libera a origem do portal (não é controle de acesso: o servidor decide igual)", async () => {
    const { send } = setup();
    expect((await send()).headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect((await send({ headers: { origin: "" } })).headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("IP confiável", () => {
  it("lê só o cabeçalho configurado; os outros (forjáveis) são ignorados", () => {
    const headers = new Headers({ "x-forwarded-for": "200.1.2.3, 10.0.0.1", "x-real-ip": "6.6.6.6", "cf-connecting-ip": "7.7.7.7" });
    expect(clientIp(headers, "x-forwarded-for")).toBe("200.1.2.3");
    expect(clientIp(headers, "cf-connecting-ip")).toBe("7.7.7.7");
  });

  it("valor inválido ou ausente vira 'unknown' (e conta e IP+conta continuam valendo)", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "' or 1=1 --" }), "x-forwarded-for")).toBe("unknown");
    expect(clientIp(new Headers({ "x-forwarded-for": "999.1.1.1" }), "x-forwarded-for")).toBe("unknown");
    expect(clientIp(new Headers({ "x-forwarded-for": "x".repeat(600) }), "x-forwarded-for")).toBe("unknown");
    expect(clientIp(new Headers(), "x-forwarded-for")).toBe("unknown");
    expect(clientIp(new Headers({ "x-forwarded-for": "2804:14C:5B:8000::1" }), "x-forwarded-for")).toBe("2804:14c:5b:8000::1");
  });
});

describe("recuperação de senha", () => {
  it.each<[string, Scenario]>([
    ["conta existe", {}],
    ["limite atingido", { begin: { allowed: false, reason: "SEC_AUTH_020", risk: 0 } }],
    ["Auth recusou", { reset: { ok: false, status: 429 } }],
    ["banco fora", { begin: new Error("down") }],
  ])("%s: sempre a mesma resposta neutra", async (_name, scenario) => {
    const { send } = setup(scenario);
    const response = await send({ body: { action: "recover", email: "quem@exemplo.com.br" } });
    expect(response.status).toBe(200);
    expect(response.json).toEqual({ success: true, message: PUBLIC_RECOVER_MESSAGE });
    expect(response.elapsed).toBe(900);
  });

  it("o link de volta usa só origem permitida", async () => {
    const { send, auth } = setup();
    await send({ body: { action: "recover", email: "quem@exemplo.com.br" } });
    expect(auth.resetPasswordForEmail).toHaveBeenCalledWith("quem@exemplo.com.br", `${ORIGIN}/redefinir-senha`);
  });

  it("primeiro acesso (App do solicitante): cria a conta corporativa antes de mandar o link, com a mesma resposta", async () => {
    const { send, auth } = setup();
    const ensureAccount = vi.fn(async () => ({ created: true }));
    auth.ensureAccount = ensureAccount;
    const response = await send({ body: { action: "recover", email: "novo@exemplo.com.br" } });
    expect(ensureAccount).toHaveBeenCalledWith("novo@exemplo.com.br");
    expect(auth.resetPasswordForEmail).toHaveBeenCalledWith("novo@exemplo.com.br", `${ORIGIN}/redefinir-senha`);
    expect(response.json).toEqual({ success: true, message: PUBLIC_RECOVER_MESSAGE });
    expect(response.elapsed).toBe(900);
  });

  it("primeiro acesso: nunca cria conta fora do domínio nem com o limite atingido", async () => {
    for (const [email, scenario] of [["fora@gmail.com", {}], ["quem@exemplo.com.br", { begin: { allowed: false, reason: "SEC_AUTH_020", risk: 0 } }]] as const) {
      const { send, auth } = setup(scenario as Scenario);
      const ensureAccount = vi.fn(async () => ({ created: true }));
      auth.ensureAccount = ensureAccount;
      await send({ body: { action: "recover", email } });
      expect(ensureAccount).not.toHaveBeenCalled();
    }
  });
});

describe("classificação do erro do Auth", () => {
  it.each([
    [{ code: "invalid_credentials", status: 400 }, "INVALID_CREDENTIALS"],
    [{ status: 400 }, "INVALID_CREDENTIALS"],
    [{ code: "over_request_rate_limit", status: 429 }, "AUTH_RATE_LIMITED"],
    [{ code: "email_not_confirmed", status: 400 }, "ACCOUNT_UNAVAILABLE"],
    [{ code: "user_banned", status: 400 }, "ACCOUNT_UNAVAILABLE"],
    [{ code: "unexpected_failure", status: 500 }, "AUTH_ERROR"],
    [{ status: 0, code: "network" }, "AUTH_ERROR"],
  ] as const)("%o -> %s", (error, expected) => {
    expect(classifyAuthError(error)).toBe(expected);
  });
});
