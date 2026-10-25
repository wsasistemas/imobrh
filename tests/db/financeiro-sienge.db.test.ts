// Integração SIENGE (migration 20261017150000): configuração só Admin, senha no Vault (nunca volta), ativar exige o
// essencial; pedido de lançamento só do Financeiro, com itens resolvidos, CPF e trava contra clique duplo; registro do
// resultado (sucesso → lancamento_gerado; erro → mensagem); credenciais só para o service_role.
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser, startTestDb, type TestDb } from "./pgHarness";

let db: TestDb;
let svc: pg.Client;
let admin: string;
let fin: string;
let colab: string;
let obra: number;

const sessoes = new Map<string, string>();
const claims = (user: string) => ({ role: "authenticated", sub: user, session_id: sessoes.get(user), amr: [{ method: "recovery", timestamp: 1 }] });

async function usuario(email: string, perfil: string, setor: number | null, cpf: string | null = null): Promise<string> {
  const { rows } = await db.admin.query("insert into auth.users (email) values ($1) returning id", [email]);
  await db.admin.query("insert into imobdesk.usuarios (id, email, nome, perfil_key, status) values ($1, $2, $3, $4, 'active')", [rows[0].id, email, email, perfil]);
  sessoes.set(rows[0].id, (await db.admin.query("insert into auth.sessions (user_id) values ($1) returning id", [rows[0].id])).rows[0].id);
  if (setor) {
    const p = await db.admin.query("insert into imobdesk.at_pessoas (nome, setor_id, documento) values ($1, $2, $3) returning id", [email, setor, cpf]);
    await db.admin.query("insert into imobdesk.at_pessoa_contatos (pessoa_id, tipo, valor, principal) values ($1, 'email', $2, true)", [p.rows[0].id, email]);
  }
  return rows[0].id as string;
}

const rpc = async (c: pg.Client, sql: string, args: unknown[] = []) => (await c.query(`select ${sql} as r`, args)).rows[0].r;
const recusa = (u: string, sql: string, args: unknown[], erro: RegExp) => asUser(db.admin, claims(u), (c) => expect(c.query(sql, args)).rejects.toThrow(erro));

/** Solicitação em conferência com 1 item no status pedido. */
async function emConferencia(statusItem: string): Promise<number> {
  const pessoa = (await db.admin.query("select imobdesk.sf_pessoa_do_usuario($1) as p", [colab])).rows[0].p;
  const { rows } = await db.admin.query(
    "insert into imobdesk.sf_solicitacao (tipo, solicitante_id, pessoa_id, setor_id, status, total_despesas, valor_a_pagar) values ('reembolso', $1, $2, $3, 'em_conferencia', 100, 100) returning id",
    [colab, pessoa, obra],
  );
  await db.admin.query("insert into imobdesk.sf_item (solicitacao_id, ordem, valor, status_conferencia) values ($1, 1, 100, $2)", [rows[0].id, statusItem]);
  return Number(rows[0].id);
}

beforeAll(async () => {
  db = await startTestDb(54425);
  svc = await db.connect();
  await svc.query("set role service_role");
  obra = Number((await db.admin.query("select id from imobdesk.at_setores where nome = 'Obra - Arte Wave'")).rows[0].id);
  const financeiro = Number((await db.admin.query("insert into imobdesk.at_setores (nome, sf_financeiro) values ('Financeiro', true) returning id")).rows[0].id);
  admin = await usuario("admin.sienge@exemplo.com.br", "admin", null);
  fin = await usuario("fin.sienge@exemplo.com.br", "operador", financeiro);
  colab = await usuario("colab.sienge@exemplo.com.br", "operador", obra, "12345678900");
});

afterAll(async () => {
  await svc?.end().catch(() => {});
  await db?.stop();
});

describe("configuração", () => {
  it("só Admin; ativar exige senha e campos essenciais; a senha vai para o Vault e não volta", async () => {
    await recusa(fin, "select imobdesk.sf_sienge_config_salvar($1)", [{ subdominio: "exemplo" }], /Só Admin/);
    const base = { subdominio: "exemplo", usuario: "api-portal", empresaId: 1, tipoDocumento: "av", indexadorId: 0, planoReembolso: "2010101" };
    await recusa(admin, "select imobdesk.sf_sienge_config_salvar($1)", [{ ...base, ativo: true }], /salve a senha/);
    await recusa(admin, "select imobdesk.sf_sienge_config_salvar($1)", [{ ...base, planoReembolso: "2.01.01" }], /sem máscara/);
    await asUser(db.admin, claims(admin), async (c) => {
      await c.query("select imobdesk.sf_sienge_senha_salvar('segredo-api')");
      await c.query("select imobdesk.sf_sienge_config_salvar($1)", [{ ...base, ativo: true }]);
      const lido = await rpc(c, "imobdesk.sf_sienge_config_ler()");
      expect(lido).toMatchObject({ ativo: true, subdominio: "exemplo", tipoDocumento: "AV", senhaDefinida: true });
      expect(JSON.stringify(lido)).not.toContain("segredo-api");
      await c.query("commit; begin");
    });
    expect((await rpc(svc, "imobdesk.sf_sienge_credenciais()")).senha).toBe("segredo-api");
    await recusa(admin, "select imobdesk.sf_sienge_credenciais()", [], /permission denied/);
  });
});

describe("lançamento", () => {
  it("pedido: só Financeiro, itens resolvidos; trava contra clique duplo; devolve CPF completo", async () => {
    const pendente = await emConferencia("pendente");
    await recusa(fin, "select imobdesk.sf_lancamento_pedido($1)", [pendente], /Resolva todos os itens/);
    const id = await emConferencia("aceito");
    await recusa(colab, "select imobdesk.sf_lancamento_pedido($1)", [id], /Só o setor Financeiro/);
    await asUser(db.admin, claims(fin), async (c) => {
      const p = await rpc(c, "imobdesk.sf_lancamento_pedido($1)", [id]);
      expect(p).toMatchObject({ cpf: "12345678900", tipo: "reembolso" });
      await c.query("commit; begin");
    });
    await recusa(fin, "select imobdesk.sf_lancamento_pedido($1)", [id], /em andamento/);
  });

  it("registro: erro guarda a mensagem; sucesso vai para lancamento_gerado com o número do título", async () => {
    const id = await emConferencia("aceito");
    await svc.query("select imobdesk.sf_lancamento_registrar($1, false, null, 'SIENGE 400: Credor inativo', '{}')", [id]);
    let s = (await db.admin.query("select status, sienge_status, sienge_erro from imobdesk.sf_solicitacao where id = $1", [id])).rows[0];
    expect(s).toEqual({ status: "em_conferencia", sienge_status: "erro", sienge_erro: "SIENGE 400: Credor inativo" });
    await svc.query("select imobdesk.sf_lancamento_registrar($1, true, '9876', null, $2)", [id, { credorId: 55, centroCusto: 114, plano: "2010101" }]);
    s = (await db.admin.query("select status, sienge_lancamento_id, sienge_credor_id from imobdesk.sf_solicitacao where id = $1", [id])).rows[0];
    expect(s).toEqual({ status: "lancamento_gerado", sienge_lancamento_id: "9876", sienge_credor_id: 55 });
    const sit = await asUser(db.admin, claims(colab), (c) => rpc(c, "imobdesk.sf_sienge_situacao($1)", [id]));
    expect(sit).toMatchObject({ titulo: "9876", configurada: true });
  });

  it("sem CPF no cadastro não lança", async () => {
    const id = await emConferencia("aceito");
    await db.admin.query("update imobdesk.at_pessoas set documento = null where id = (select pessoa_id from imobdesk.sf_solicitacao where id = $1)", [id]);
    await recusa(fin, "select imobdesk.sf_lancamento_pedido($1)", [id], /sem CPF/);
  });
});
