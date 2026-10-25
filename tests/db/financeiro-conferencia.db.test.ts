// Solicitações Financeiras, Fase 5 parte 1 (migration 20261017140000): fila do Financeiro, decisão por item (aceitar
// com alerta exige observação; glosa reduz o valor a pagar), pendência do solicitante (troca de comprovante e resposta),
// pagamento programado e paga; só o setor financeiro confere.
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser, startTestDb, type TestDb } from "./pgHarness";

let db: TestDb;
let colab: string;
let gestor: string;
let fin: string;
let obra: number;
let sha = 9000;

const sessoes = new Map<string, string>();
const claims = (user: string) => ({ role: "authenticated", sub: user, session_id: sessoes.get(user), amr: [{ method: "recovery", timestamp: 1 }] });

async function usuario(email: string, setor: number): Promise<string> {
  const { rows } = await db.admin.query("insert into auth.users (email) values ($1) returning id", [email]);
  await db.admin.query("insert into imobdesk.usuarios (id, email, nome, perfil_key, status) values ($1, $2, $3, 'operador', 'active')", [rows[0].id, email, email]);
  sessoes.set(rows[0].id, (await db.admin.query("insert into auth.sessions (user_id) values ($1) returning id", [rows[0].id])).rows[0].id);
  const p = await db.admin.query("insert into imobdesk.at_pessoas (nome, setor_id) values ($1, $2) returning id", [email, setor]);
  await db.admin.query("insert into imobdesk.at_pessoa_contatos (pessoa_id, tipo, valor, principal) values ($1, 'email', $2, true)", [p.rows[0].id, email]);
  return rows[0].id as string;
}

const rpc = async (c: pg.Client, sql: string, args: unknown[] = []) => (await c.query(`select ${sql} as r`, args)).rows[0].r;
const recusa = (u: string, sql: string, args: unknown[], erro: RegExp) => asUser(db.admin, claims(u), (c) => expect(c.query(sql, args)).rejects.toThrow(erro));

async function gravando<T>(u: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  await db.admin.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify(claims(u))]);
  await db.admin.query("set role authenticated");
  try {
    return await fn(db.admin);
  } finally {
    await db.admin.query("reset role");
    await db.admin.query("select set_config('request.jwt.claims', '', false)");
  }
}

/** Reembolso com 2 linhas (100 e 50), enviado e aprovado → em conferência. */
async function emConferencia(): Promise<{ id: number; itens: number[] }> {
  const id = await gravando(colab, async (c) => {
    const id = Number(await rpc(c, "imobdesk.sf_rascunho_criar('reembolso')"));
    const d = await rpc(c, "imobdesk.sf_detalhe($1)", [id]);
    const m = (await rpc(c, "imobdesk.sf_rascunho_salvar($1)", [{ id, periodoDe: d.periodoDe, periodoAte: d.periodoAte,
      itens: [{ chave: "a", data: d.periodoDe, valor: 100, descricao: "Uber", motivo: "Transporte" }, { chave: "b", data: d.periodoDe, valor: 50, descricao: "Park", motivo: "Estacionamento" }] }])).itens;
    for (const x of m) {
      await rpc(c, "imobdesk.sf_anexo_registrar($1)", [{ solicitacaoId: id, itemId: x.id, path: `${colab}/${id}/${x.id}.pdf`, nome: "c.pdf", mime: "application/pdf", tamanho: 10, sha256: (sha++).toString(16).padStart(64, "d") }]);
    }
    await rpc(c, "imobdesk.sf_enviar($1, true)", [id]);
    return id;
  });
  await gravando(gestor, (c) => c.query("select imobdesk.sf_decidir_aprovacao($1, 'aprovar', null)", [id]));
  const itens = (await db.admin.query("select id from imobdesk.sf_item where solicitacao_id = $1 order by ordem", [id])).rows.map((r) => Number(r.id));
  return { id, itens };
}

const decidirItem = (item: number, decisao: string, glosa: number | null, obs: string | null) =>
  gravando(fin, (c) => rpc(c, "imobdesk.sf_decidir_item($1, $2, $3, $4)", [item, decisao, glosa, obs]));
const status = async (id: number) => (await db.admin.query("select status, valor_glosado, valor_a_pagar from imobdesk.sf_solicitacao where id = $1", [id])).rows[0];

beforeAll(async () => {
  db = await startTestDb(54424);
  obra = Number((await db.admin.query("select id from imobdesk.at_setores where nome = 'Obra - Arte Wave'")).rows[0].id);
  const financeiro = Number((await db.admin.query("insert into imobdesk.at_setores (nome, sf_financeiro) values ('Financeiro', true) returning id")).rows[0].id);
  colab = await usuario("colab.conf@exemplo.com.br", obra);
  gestor = await usuario("gestor.conf@exemplo.com.br", obra);
  fin = await usuario("fin.conf@exemplo.com.br", financeiro);
  await db.admin.query("insert into imobdesk.sf_setor_aprovador (setor_id, tipo_solicitacao, ordem, papel, aprovador_id, condicao, alcada_minima) values ($1, 'reembolso_fundo_fixo', 1, 'Gestor', $2, 'sempre', 0)", [obra, gestor]);
});

afterAll(async () => {
  await db?.stop();
});

describe("conferência", () => {
  it("fila: contador e a solicitação com itens resolvidos; quem não é do Financeiro não vê", async () => {
    const { id } = await emConferencia();
    const f = await asUser(db.admin, claims(fin), (c) => rpc(c, "imobdesk.sf_conferencia_fila()"));
    expect(f.kpis.aConferir).toBeGreaterThan(0);
    expect(f.lista.find((x: { id: number }) => x.id === id)).toMatchObject({ itens: 2, resolvidos: 0 });
    await recusa(gestor, "select imobdesk.sf_conferencia_fila()", [], /Só o setor Financeiro/);
  });

  it("glosa reduz o valor a pagar; glosa exige observação e valor válido; aceitar sem alerta dispensa observação", async () => {
    const { id, itens } = await emConferencia();
    await recusa(fin, "select imobdesk.sf_decidir_item($1, 'glosar', 10, null)", [itens[0]], /observação/);
    await recusa(fin, "select imobdesk.sf_decidir_item($1, 'glosar', 500, 'x')", [itens[0]], /valor glosado/);
    await decidirItem(itens[0], "glosar", 7.5, "Glosa parcial");
    await decidirItem(itens[1], "aceitar", null, null);
    expect(await status(id)).toMatchObject({ valor_glosado: "7.50", valor_a_pagar: "142.50" });
    const it = await asUser(db.admin, claims(fin), (c) => rpc(c, "imobdesk.sf_conferencia_itens($1)", [id]));
    expect(it.podeConferir).toBe(true);
    expect(it.itens.map((x: { status: string }) => x.status)).toEqual(["glosado", "aceito"]);
  });

  it("item com alerta só é aceito com observação", async () => {
    const { itens } = await emConferencia();
    await db.admin.query("update imobdesk.sf_item set data = date '2001-01-01' where id = $1", [itens[0]]);  // R03 fora do período
    await recusa(fin, "select imobdesk.sf_decidir_item($1, 'aceitar', null, null)", [itens[0]], /alerta/);
    await decidirItem(itens[0], "aceitar", null, "Data conferida no cupom");
  });

  it("pendência: Financeiro pede ajuste; solicitante troca o comprovante do item e responde; volta à conferência", async () => {
    const { id, itens } = await emConferencia();
    await recusa(fin, "select imobdesk.sf_pedir_ajuste($1, 'x')", [id], /Marque ao menos um item/);
    await decidirItem(itens[1], "ajuste", null, "Comprovante cortado");
    await gravando(fin, (c) => c.query("select imobdesk.sf_pedir_ajuste($1, 'Envie o comprovante inteiro')", [id]));
    expect((await status(id)).status).toBe("pendencia_solicitante");
    await recusa(colab, "select imobdesk.sf_pendencia_anexar($1)", [{ itemId: itens[0], path: `${colab}/${id}/n.pdf`, mime: "application/pdf", tamanho: 1, sha256: "e".repeat(64) }], /ajuste pedido/);
    await gravando(colab, (c) => rpc(c, "imobdesk.sf_pendencia_anexar($1)", [{ itemId: itens[1], path: `${colab}/${id}/n.pdf`, nome: "novo.pdf", mime: "application/pdf", tamanho: 1, sha256: "e".repeat(64) }]));
    await gravando(colab, (c) => c.query("select imobdesk.sf_pendencia_responder($1, 'Enviei o cupom inteiro')", [id]));
    expect((await status(id)).status).toBe("em_conferencia");
    expect((await db.admin.query("select status_conferencia from imobdesk.sf_item where id = $1", [itens[1]])).rows[0].status_conferencia).toBe("pendente");
  });

  it("pagamento: só depois do lançamento; paga encerra o reembolso", async () => {
    const { id } = await emConferencia();
    await recusa(fin, "select imobdesk.sf_programar_pagamento($1, current_date + 3)", [id], /depois do lançamento/);
    await db.admin.query("update imobdesk.sf_solicitacao set status = 'lancamento_gerado' where id = $1", [id]);
    await gravando(fin, (c) => c.query("select imobdesk.sf_programar_pagamento($1, current_date + 3)", [id]));
    await gravando(fin, (c) => c.query("select imobdesk.sf_marcar_paga($1)", [id]));
    expect((await status(id)).status).toBe("paga");
  });
});
