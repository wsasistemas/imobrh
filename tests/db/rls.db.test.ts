// RLS do app_imobrh (Fase 0): isolamento por empresa, por papel e por hierarquia do RM.
// Critérios do PLANO-fase0: um colaborador não lê dados de outro; ninguém fora de compliance lê caso sensível.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { asUser, startTestDb, type TestDb } from "./pgHarness";

const EMPRESA_A = "0000000a-0000-0000-0000-00000000000a";
const EMPRESA_B = "0000000b-0000-0000-0000-00000000000b";

// Logins (auth.users) e o que cada um é no ImobRH.
const U = {
  colab1: "00000000-0000-0000-0000-0000000000c1",
  colab2: "00000000-0000-0000-0000-0000000000c2",
  gestor: "00000000-0000-0000-0000-0000000000a6",
  rh: "00000000-0000-0000-0000-0000000000d1",
  compliance: "00000000-0000-0000-0000-0000000000e1",
  admin: "00000000-0000-0000-0000-0000000000f1",
  rhB: "00000000-0000-0000-0000-0000000000b1",
  complianceB: "00000000-0000-0000-0000-0000000000b2",
};

let db: TestDb;
let client: pg.Client;

function claims(user: string, extra: Record<string, unknown> = {}) {
  return { sub: user, role: "authenticated", email: `${user.slice(-2)}@teste.com`, session_id: "00000000-0000-0000-0000-000000000099", ...extra };
}

/** Roda como o usuário e devolve as linhas. */
async function como<T extends pg.QueryResultRow>(user: string, sql: string, params: unknown[] = [], extra: Record<string, unknown> = {}) {
  return asUser(client, claims(user, extra), async (c) => (await c.query<T>(sql, params)).rows);
}

/** Roda como o usuário e devolve o erro do banco (detail = código da regra). */
async function erroComo(user: string, sql: string, params: unknown[] = []) {
  return asUser(client, claims(user), async (c) => {
    try {
      await c.query(sql, params);
      return null;
    } catch (error) {
      const e = error as { code?: string; detail?: string; message: string };
      return { code: e.code, detail: e.detail, message: e.message };
    }
  });
}

beforeAll(async () => {
  db = await startTestDb(54391);
  client = await db.connect();
  const a = db.admin;

  await a.query(`insert into imobdesk.empresas (id, nome) values ($1, 'Empresa A'), ($2, 'Empresa B')`, [EMPRESA_A, EMPRESA_B]);
  for (const [nome, id] of Object.entries(U)) {
    await a.query(`insert into auth.users (id, email) values ($1, $2)`, [id, `${nome}@teste.com`]);
    const empresa = nome.endsWith("B") ? EMPRESA_B : EMPRESA_A;
    await a.query(`insert into imobdesk.usuarios (tenant_id, id, email, nome) values ($1, $2, $3, $4)`, [empresa, id, `${nome}@teste.com`, `Usuário ${nome}`]);
  }

  // Vínculos com o RM: o gestor (chapa G001) chefia o colab1; o colab2 é de outra seção.
  const vinculo = `insert into app_imobrh.colaborador_vinculo (tenant_id, user_id, cpf, coligada, chapa, nome, gestor_chapa, status)
                   values ($1, $2, $3, 1, $4, $5, $6, 'vinculado')`;
  await a.query(vinculo, [EMPRESA_A, U.colab1, "11111111111", "C001", "Colab 1", "G001"]);
  await a.query(vinculo, [EMPRESA_A, U.colab2, "22222222222", "C002", "Colab 2", "G999"]);
  await a.query(vinculo, [EMPRESA_A, U.gestor, "33333333333", "G001", "Gestor", null]);
  await a.query(vinculo, [EMPRESA_B, U.rhB, "44444444444", "B001", "RH da B", null]);

  const papel = `insert into app_imobrh.papel_usuario (tenant_id, user_id, papel) values ($1, $2, $3)`;
  // colaborador e gestor vêm do RM (vínculo e hierarquia); os do RH são concedidos à mão.
  const papelRm = `insert into app_imobrh.papel_usuario (tenant_id, user_id, papel, origem) values ($1, $2, $3, 'rm')`;
  await a.query(papelRm, [EMPRESA_A, U.colab1, "colaborador"]);
  await a.query(papelRm, [EMPRESA_A, U.colab2, "colaborador"]);
  await a.query(papelRm, [EMPRESA_A, U.gestor, "gestor"]);
  await a.query(papel, [EMPRESA_A, U.rh, "rh_dp"]);
  await a.query(papel, [EMPRESA_A, U.compliance, "compliance"]);
  await a.query(papel, [EMPRESA_A, U.admin, "admin"]);
  await a.query(papel, [EMPRESA_B, U.rhB, "rh_dp"]);
  await a.query(papel, [EMPRESA_B, U.complianceB, "compliance"]);

  // RH com o menu Usuários liberado (mas sem poder conceder compliance/admin).
  await a.query(`insert into app_imobrh.papel_permissao (tenant_id, papel, permission_id, enabled) values ($1, 'rh_dp', 'manage_users', true)`, [EMPRESA_A]);

  await a.query(`insert into app_imobrh.caso_sensivel (tenant_id, codigo, categoria, relato) values ($1, 'AAAA1111', 'assedio_moral', 'relato A'), ($2, 'BBBB2222', 'outros', 'relato B')`, [EMPRESA_A, EMPRESA_B]);
}, 180_000);

afterAll(async () => {
  await client?.end().catch(() => {});
  await db?.stop();
});

describe("colaborador_vinculo", () => {
  const sql = "select user_id from app_imobrh.colaborador_vinculo order by chapa";

  it("o colaborador lê só o próprio vínculo, nunca o de outro", async () => {
    expect((await como(U.colab1, sql)).map((r) => r.user_id)).toEqual([U.colab1]);
    expect((await como(U.colab2, sql)).map((r) => r.user_id)).toEqual([U.colab2]);
  });

  it("o gestor lê o próprio e o de quem está abaixo dele no RM, não o de outra seção", async () => {
    const vistos = (await como(U.gestor, sql)).map((r) => r.user_id);
    expect(vistos).toContain(U.colab1);
    expect(vistos).toContain(U.gestor);
    expect(vistos).not.toContain(U.colab2);
  });

  it("o RH lê todos da própria empresa e nenhum de outra", async () => {
    const vistos = (await como(U.rh, sql)).map((r) => r.user_id);
    expect(vistos.sort()).toEqual([U.colab1, U.colab2, U.gestor].sort());
    expect((await como(U.rhB, sql)).map((r) => r.user_id)).toEqual([U.rhB]);
  });

  it("sessão aberta fora do gateway de login não lê nada", async () => {
    expect(await como(U.colab1, sql, [], { sessao_confiavel: false })).toEqual([]);
  });

  it("ninguém grava direto na tabela (só por função)", async () => {
    const erro = await erroComo(U.rh, `update app_imobrh.colaborador_vinculo set nome = 'x' where user_id = $1`, [U.colab1]);
    expect(erro?.code).toBe("42501");
  });
});

describe("caso_sensivel", () => {
  const sql = "select codigo from app_imobrh.caso_sensivel";

  it("ninguém fora do compliance lê casos sensíveis, nem o admin", async () => {
    for (const user of [U.colab1, U.gestor, U.rh, U.admin, U.rhB]) {
      expect(await como(user, sql), `usuário ${user}`).toEqual([]);
    }
  });

  it("o compliance lê só os casos da própria empresa", async () => {
    expect((await como(U.compliance, sql)).map((r) => r.codigo)).toEqual(["AAAA1111"]);
    expect((await como(U.complianceB, sql)).map((r) => r.codigo)).toEqual(["BBBB2222"]);
  });
});

describe("auditoria", () => {
  it("é só INSERT: nem o postgres altera ou apaga", async () => {
    await db.admin.query(`insert into app_imobrh.auditoria (tenant_id, modulo, acao, descricao) values ($1, 'teste', 'create', 'x')`, [EMPRESA_A]);
    await expect(db.admin.query("update app_imobrh.auditoria set descricao = 'y'")).rejects.toThrow(/só INSERT/);
    await expect(db.admin.query("delete from app_imobrh.auditoria")).rejects.toThrow(/só INSERT/);
  });

  it("só quem tem o menu Auditoria lê a trilha", async () => {
    expect(await como(U.colab1, "select id from app_imobrh.auditoria")).toEqual([]);
    expect((await como(U.admin, "select id from app_imobrh.auditoria")).length).toBeGreaterThan(0);
  });
});

describe("RPCs do Console", () => {
  it("o colaborador não lista usuários (SEM_PERMISSAO)", async () => {
    expect((await erroComo(U.colab1, "select * from app_imobrh.listar_usuarios_rh()"))?.detail).toBe("SEM_PERMISSAO");
  });

  it("o admin lista só os usuários da própria empresa, com os papéis", async () => {
    const linhas = await como<{ id: string; papeis: string[] }>(U.admin, "select id, papeis from app_imobrh.listar_usuarios_rh()");
    expect(linhas.map((l) => l.id)).not.toContain(U.rhB);
    expect(linhas.find((l) => l.id === U.gestor)?.papeis).toEqual(["gestor"]);
  });

  it("só o admin concede compliance; o RH com o menu Usuários não; papéis do RM ficam", async () => {
    const negado = await erroComo(U.rh, "select app_imobrh.definir_papeis_usuario($1, array['compliance'])", [U.colab2]);
    expect(negado?.detail).toBe("SEM_PERMISSAO");
    const papeis = await como<{ p: string[] }>(U.admin, "select app_imobrh.definir_papeis_usuario($1, array['rh_dp_restrita']) p", [U.colab2]);
    expect(papeis[0].p).toEqual(["rh_dp_restrita", "colaborador"]);
  });

  it("o admin não retira o próprio papel de admin", async () => {
    const erro = await erroComo(U.admin, "select app_imobrh.definir_papeis_usuario($1, array[]::text[])", [U.admin]);
    expect(erro?.detail).toBe("ESTADO_INVALIDO");
  });

  it("meu_acesso devolve papéis e vínculo do próprio login", async () => {
    const [linha] = await como<{ a: { papeis: string[]; vinculo: { chapa: string } } }>(U.colab1, "select app_imobrh.meu_acesso() a");
    expect(linha.a.papeis).toEqual(["colaborador"]);
    expect(linha.a.vinculo.chapa).toBe("C001");
  });

  it("vínculos pendentes: só quem não tem chapa no RM", async () => {
    const linhas = await como<{ user_id: string }>(U.admin, "select user_id from app_imobrh.listar_vinculos_pendentes()");
    const ids = linhas.map((l) => l.user_id);
    expect(ids).toContain(U.rh);
    expect(ids).not.toContain(U.colab1);
    expect(ids).not.toContain(U.rhB);
  });

  it("matriz padrão: o RH/DP vê Vínculos pendentes sem configurar nada; o colaborador não", async () => {
    expect((await como(U.rh, "select count(*) from app_imobrh.listar_vinculos_pendentes()")).length).toBe(1);
    expect((await erroComo(U.colab1, "select * from app_imobrh.listar_vinculos_pendentes()"))?.detail).toBe("SEM_PERMISSAO");
  });

  it("alteração na matriz vale por cima do padrão", async () => {
    await asUser(client, claims(U.admin), async (c) => {
      await c.query(`select app_imobrh.salvar_permissoes_perfil('rh_dp', '[{"id":"config_vinculos","enabled":false}]'::jsonb)`);
      const r = await c.query<{ r: Record<string, boolean> }>("select app_imobrh.regras_do_papel('rh_dp') r");
      expect(r.rows[0].r.config_vinculos).toBe(false);
      expect(r.rows[0].r.caixa_rh).toBe(true);
    });
  });

  it("service_role grava o vínculo na empresa do cabeçalho x-empresa-id", async () => {
    const vinculo = await asUser(client, { role: "service_role" }, async (c) => {
      const r = await c.query<{ v: { tenant_id: string; status: string } }>(
        "select app_imobrh.registrar_vinculo($1, $2::jsonb) v",
        [U.rh, JSON.stringify({ cpf: "55555555555", coligada: 1, chapa: "D001", nome: "RH" })],
      );
      return r.rows[0].v;
    }, { "x-empresa-id": EMPRESA_A });
    expect(vinculo.tenant_id).toBe(EMPRESA_A);
    expect(vinculo.status).toBe("vinculado");
  });
});

describe("Sessões ativas", () => {
  it("o admin lista as sessões de quem tem papel no Console (tipos iguais aos do Supabase)", async () => {
    await db.admin.query(`insert into auth.sessions (user_id, user_agent, ip) values ($1, 'Mozilla/5.0 Chrome/130', '189.40.12.8')`, [U.rh]);
    await db.admin.query(`insert into auth.sessions (user_id) values ($1)`, [U.colab1]);
    const linhas = await como<{ email: string; ip: string }>(U.admin, "select email, ip from app_imobrh.listar_sessoes()");
    expect(linhas.map((l) => l.email)).toEqual(["rh@teste.com"]);
    expect(linhas[0].ip).toBe("189.40.12.8");
  });

  it("o colaborador não lista sessões", async () => {
    expect((await erroComo(U.colab1, "select * from app_imobrh.listar_sessoes()"))?.detail).toBe("SEM_PERMISSAO");
  });
});

describe("menu do app (GET /rh/me)", () => {
  async function menu(papeis: string[], substituto = false) {
    const r = await db.admin.query<{ m: string[] }>("select app_imobrh.menu_app($1::text[], $2) m", [papeis, substituto]);
    return r.rows[0].m;
  }

  it("colaborador vê pedidos e canal confidencial, sem aprovações nem console", async () => {
    expect(await menu(["colaborador"])).toEqual(["rh_novo_pedido", "rh_meus_pedidos", "rh_canal_confidencial"]);
  });

  it("gestor ganha aprovações e requisição de pessoal; substituto ganha aprovações", async () => {
    expect(await menu(["colaborador", "gestor"])).toContain("rh_aprovacoes");
    expect(await menu(["colaborador", "gestor"])).toContain("rh_requisicao_pessoal");
    expect(await menu(["colaborador"], true)).toContain("rh_aprovacoes");
  });

  it("papéis do RH ganham o link do Console", async () => {
    expect(await menu(["rh_dp"])).toContain("rh_console");
    expect(await menu([])).toEqual(["rh_canal_confidencial"]);
  });
});
