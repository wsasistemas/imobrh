// Solicitações Financeiras, Fase 4 (migration 20261017130000): pedido de leitura só do dono, registro do resultado
// (só service_role), fila de leitura, linha a partir do comprovante (origem confirmada/editada) e as checagens que
// dependem da leitura (R02, R04, R05, R06 por CNPJ + data + valor, R07).
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser, startTestDb, type TestDb } from "./pgHarness";

let db: TestDb;
let svc: pg.Client;
let colab: string;
let outro: string;
let obra: number;
let sha = 5000;

const sessoes = new Map<string, string>();
const claims = (user: string) => ({ role: "authenticated", sub: user, session_id: sessoes.get(user), amr: [{ method: "recovery", timestamp: 1 }] });

async function usuario(email: string): Promise<string> {
  const { rows } = await db.admin.query("insert into auth.users (email) values ($1) returning id", [email]);
  await db.admin.query("insert into imobdesk.usuarios (id, email, nome, perfil_key, status) values ($1, $2, $3, 'operador', 'active')", [rows[0].id, email, email]);
  sessoes.set(rows[0].id, (await db.admin.query("insert into auth.sessions (user_id) values ($1) returning id", [rows[0].id])).rows[0].id);
  const p = await db.admin.query("insert into imobdesk.at_pessoas (nome, setor_id) values ($1, $2) returning id", [email, obra]);
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

/** Rascunho com um comprovante solto (sem linha), como no "adicionar por comprovante". */
async function comComprovante(u: string): Promise<{ id: number; anexo: number }> {
  return gravando(u, async (c) => {
    const id = Number(await rpc(c, "imobdesk.sf_rascunho_criar('reembolso')"));
    const a = await rpc(c, "imobdesk.sf_anexo_registrar($1)", [{ solicitacaoId: id, path: `${u}/${id}/c.jpg`, nome: "cupom.jpg", mime: "image/jpeg", tamanho: 100, sha256: (sha++).toString(16).padStart(64, "c") }]);
    return { id, anexo: Number(a.id) };
  });
}

const leitura = (p: Record<string, unknown> = {}) => ({
  tipo_documento: "nfce", data: new Date().toISOString().slice(0, 10), valor_total: 67, favorecido: "PADARIA ESTRELA DA BARRA LTDA", cnpj_cpf_emissor: "98765432000110",
  chave_acesso: null, itens: [{ descricao: "CAFE TORRADO", valor: 39.8 }, { descricao: "CERVEJA LATA 350ML", valor: 4.5 }],
  motivo_sugestoes: [{ categoria_id: 8, texto: "Copa/mantimentos — café", confianca: 0.9 }], legibilidade: { data: 0.99, valor: 0.98, favorecido: 0.95 }, alertas: [], ...p,
});

const registrar = (anexo: number, status: string, json: unknown) => svc.query("select imobdesk.sf_ocr_registrar($1, $2, $3)", [anexo, status, json]);
const checagens = (u: string, id: number) => asUser(db.admin, claims(u), (c) => rpc(c, "imobdesk.sf_checagens($1)", [id]));

beforeAll(async () => {
  db = await startTestDb(54423);
  svc = await db.connect();
  await svc.query("set role service_role");
  obra = Number((await db.admin.query("select id from imobdesk.at_setores where nome = 'Obra - Arte Wave'")).rows[0].id);
  colab = await usuario("colab.ocr@exemplo.com.br");
  outro = await usuario("outro.ocr@exemplo.com.br");
  await db.admin.query("update imobdesk.sf_regra set parametros = '{\"itens_proibidos\": [\"cerveja\"]}' where codigo = 'R07'");
});

afterAll(async () => {
  await svc?.end().catch(() => {});
  await db?.stop();
});

describe("leitura", () => {
  it("o pedido marca 'lendo' e traz limiar e categorias; outro usuário não pede", async () => {
    const { anexo } = await comComprovante(colab);
    const p = await gravando(colab, (c) => rpc(c, "imobdesk.sf_ocr_pedido($1)", [anexo]));
    expect(p).toMatchObject({ anexoId: anexo, modo: "comprovante", mime: "image/jpeg" });
    expect(Number(p.limiar)).toBe(0.8);
    expect(p.categorias).toHaveLength(10);
    expect((await db.admin.query("select ocr_status from imobdesk.sf_anexo where id = $1", [anexo])).rows[0].ocr_status).toBe("lendo");
    await recusa(outro, "select imobdesk.sf_ocr_pedido($1)", [anexo], /não encontrada/);
  });

  it("registrar é só do service_role; grava confiança mínima e aparece na fila", async () => {
    const { id, anexo } = await comComprovante(colab);
    await recusa(colab, "select imobdesk.sf_ocr_registrar($1, 'lido', '{}')", [anexo], /permission denied/);
    await registrar(anexo, "lido", leitura());
    const a = (await db.admin.query("select ocr_status, ocr_confianca from imobdesk.sf_anexo where id = $1", [anexo])).rows[0];
    expect([a.ocr_status, Number(a.ocr_confianca)]).toEqual(["lido", 0.95]);
    const fila = await asUser(db.admin, claims(colab), (c) => rpc(c, "imobdesk.sf_fila_leitura($1)", [id]));
    expect(fila).toEqual([expect.objectContaining({ id: anexo, status: "lido", ocr: expect.objectContaining({ valor_total: 67 }) })]);
  });

  it("confirmar sem mudar = ocr_confirmado; mudando o valor = ocr_editado; sai da fila", async () => {
    const hoje = new Date().toISOString().slice(0, 10);
    const a1 = await comComprovante(colab);
    await registrar(a1.anexo, "lido", leitura());
    await gravando(colab, (c) => rpc(c, "imobdesk.sf_linha_do_comprovante($1)", [{ anexoId: a1.anexo, data: hoje, valor: 67, descricao: "Padaria Estrela da Barra Ltda", categoriaId: 8 }]));
    const a2 = await comComprovante(colab);
    await registrar(a2.anexo, "lido", leitura());
    await gravando(colab, (c) => rpc(c, "imobdesk.sf_linha_do_comprovante($1)", [{ anexoId: a2.anexo, data: hoje, valor: 70, descricao: "PADARIA ESTRELA DA BARRA LTDA" }]));
    const origens = (await db.admin.query("select i.origem from imobdesk.sf_item i join imobdesk.sf_anexo a on a.item_id = i.id where a.id = any($1) order by a.id", [[a1.anexo, a2.anexo]])).rows.map((r) => r.origem);
    expect(origens).toEqual(["ocr_confirmado", "ocr_editado"]);
    expect(await asUser(db.admin, claims(colab), (c) => rpc(c, "imobdesk.sf_fila_leitura($1)", [a1.id]))).toEqual([]);
    await recusa(colab, "select imobdesk.sf_linha_do_comprovante($1)", [{ anexoId: a1.anexo, data: hoje, valor: 67, descricao: "x" }], /já virou linha/);
  });
});

describe("rascunho com linha da leitura", () => {
  it("salvar com 'conhecidos' não apaga a linha criada no meio do caminho; a conhecida e omitida é apagada", async () => {
    const hoje = new Date().toISOString().slice(0, 10);
    const a = await comComprovante(colab);
    const manual = await gravando(colab, (c) => rpc(c, "imobdesk.sf_rascunho_salvar($1)", [{ id: a.id, itens: [{ chave: "m", valor: 5, descricao: "Manual" }] }]));
    await registrar(a.anexo, "lido", leitura({ valor_total: 9.99 }));
    const doOcr = Number(await gravando(colab, (c) => rpc(c, "imobdesk.sf_linha_do_comprovante($1)", [{ anexoId: a.anexo, data: hoje, valor: 9.99, descricao: "Padaria" }])));
    // A tela ainda não sabia da linha do comprovante e tirou a manual.
    await gravando(colab, (c) => rpc(c, "imobdesk.sf_rascunho_salvar($1)", [{ id: a.id, itens: [], conhecidos: [manual.itens[0].id] }]));
    const ids = (await db.admin.query("select id from imobdesk.sf_item where solicitacao_id = $1", [a.id])).rows.map((r) => Number(r.id));
    expect(ids).toEqual([doOcr]);
  });
});

describe("checagens da leitura", () => {
  it("R04 (valor diferente), R07 (item proibido), R02 (ilegível) e R05 (sem documento fiscal)", async () => {
    const hoje = new Date().toISOString().slice(0, 10);
    const a = await comComprovante(colab);
    await registrar(a.anexo, "lido", leitura({ valor_total: 66.66 }));
    await gravando(colab, (c) => rpc(c, "imobdesk.sf_linha_do_comprovante($1)", [{ anexoId: a.anexo, data: hoje, valor: 70, descricao: "Padaria" }]));
    const b = await gravando(colab, async (c) => {
      const r = await rpc(c, "imobdesk.sf_anexo_registrar($1)", [{ solicitacaoId: a.id, path: `${colab}/${a.id}/d.jpg`, nome: "foto.jpg", mime: "image/jpeg", tamanho: 1, sha256: (sha++).toString(16).padStart(64, "c") }]);
      return Number(r.id);
    });
    await registrar(b, "ilegivel", leitura({ tipo_documento: "outro", cnpj_cpf_emissor: null, data: null, valor_total: null, itens: [], legibilidade: { data: 0.5, valor: 0.4, favorecido: 0.9 } }));
    await gravando(colab, (c) => rpc(c, "imobdesk.sf_linha_do_comprovante($1)", [{ anexoId: b, data: hoje, valor: 12, descricao: "Mercado" }]));
    const codigos = (await checagens(colab, a.id)).map((x: { codigo: string }) => x.codigo).sort();
    expect(codigos).toEqual(["R02", "R04", "R05", "R07"]);
  });

  it("R06: mesmo CNPJ + data + valor lidos em outra solicitação ativa bloqueia", async () => {
    const hoje = new Date().toISOString().slice(0, 10);
    for (const u of [colab, colab]) {
      const a = await comComprovante(u);
      await registrar(a.anexo, "lido", leitura({ valor_total: 123.45 }));
      await gravando(u, (c) => rpc(c, "imobdesk.sf_linha_do_comprovante($1)", [{ anexoId: a.anexo, data: hoje, valor: 123.45, descricao: "Padaria" }]));
      if (u === colab) var ultimo = a.id; // eslint-disable-line no-var
    }
    const r06 = (await checagens(colab, ultimo!)).filter((x: { codigo: string; resultado: string }) => x.codigo === "R06");
    expect(r06).toEqual([expect.objectContaining({ resultado: "bloqueio" })]);
  });
});
