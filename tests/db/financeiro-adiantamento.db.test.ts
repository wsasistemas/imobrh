// Solicitações Financeiras, Fase 5B (migration 20261017160000): adiantamento de numerário. Formulário com rateio e
// documento de origem (A01, A05), cadeia de 4 níveis com 3 valores, A02/A03/A06, comprovação com acerto (maior,
// igual, menor), devolução e bloqueio por comprovação vencida.
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser, startTestDb, type TestDb } from "./pgHarness";

let db: TestDb;
let colab: string;
let colab2: string;
let plan: string;
let ger: string;
let dir: string;
let pres: string;
let fin: string;
let obra: number;
let sha = 7000;
let pedido = 100;

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

const recusa = (u: string, sql: string, args: unknown[], erro: RegExp) => asUser(db.admin, claims(u), (c) => expect(c.query(sql, args)).rejects.toThrow(erro));
const hoje = () => new Date().toISOString().slice(0, 10);
const daqui = (dias: number) => new Date(Date.now() + dias * 86_400_000).toISOString().slice(0, 10);

function formulario(id: number, valor: number, extra: Record<string, unknown> = {}) {
  return {
    id, obra: "ETEHE RESIDENCIAL", contaCaixa: "11401", contaPagamento: "SICOOB 30.062-4", centroCusto: "00.00114", valor,
    favorecido: "J.A BLINDAGEM LTDA", favorecidoDoc: "53.520.864/0001-09", finalidade: "Sinal do pedido", formaPagamento: "deposito",
    banco: "ITAU", agencia: "2847", conta: "98667-2", tipoConta: "corrente", vencimento: daqui(3),
    pedidoNumero: String(pedido++), pedidoFornecedorDoc: "53520864000109", pedidoValor: valor * 2, pedidoPercentual: 50,
    rateio: [{ tarefa: "29.02.20", porcentagem: 60 }, { tarefa: "29.02.21", porcentagem: 40 }], ...extra,
  };
}

/** Rascunho completo (com documento de origem), já gravado. */
async function rascunho(u: string, valor: number, extra: Record<string, unknown> = {}): Promise<number> {
  return gravando(u, async (c) => {
    const id = Number(await rpc(c, "imobdesk.sf_rascunho_criar('adiantamento')"));
    await rpc(c, "imobdesk.sf_anexo_registrar($1)", [{ solicitacaoId: id, finalidade: "documento_origem", path: `${u}/${id}/pedido.pdf`, nome: "pedido.pdf",
      mime: "application/pdf", tamanho: 10, sha256: (sha++).toString(16).padStart(64, "a") }]);
    await rpc(c, "imobdesk.sf_adiantamento_salvar($1)", [formulario(id, valor, extra)]);
    return id;
  });
}

const cadeia = async (id: number) =>
  (await db.admin.query("select papel, status from imobdesk.sf_aprovacao where solicitacao_id = $1 order by nivel", [id])).rows.map((r) => `${r.papel}:${r.status}`);
const sol = async (id: number) => (await db.admin.query("select * from imobdesk.sf_solicitacao where id = $1", [id])).rows[0];

/** Enviado, aprovado em todos os níveis, conferido, "lançado", programado e pago → comprovação pendente. */
async function pago(valor: number): Promise<number> {
  const id = await rascunho(colab, valor);
  await gravando(colab, (c) => rpc(c, "imobdesk.sf_enviar($1, true)", [id]));
  for (const u of [plan, ger, dir, pres]) {
    const etapa = await db.admin.query("select 1 from imobdesk.sf_aprovacao a where a.solicitacao_id = $1 and a.aprovador_id = $2 and a.status = 'aguardando'", [id, u]);
    if (etapa.rowCount) await gravando(u, (c) => c.query("select imobdesk.sf_decidir_aprovacao($1, 'aprovar', null)", [id]));
  }
  const item = Number((await db.admin.query("select id from imobdesk.sf_item where solicitacao_id = $1", [id])).rows[0].id);
  await gravando(fin, (c) => rpc(c, "imobdesk.sf_decidir_item($1, 'aceitar', null, 'ok')", [item]));
  await db.admin.query("update imobdesk.sf_solicitacao set status = 'lancamento_gerado', sienge_lancamento_id = '1' where id = $1", [id]);
  await gravando(fin, async (c) => {
    await c.query("select imobdesk.sf_programar_pagamento($1, $2)", [id, hoje()]);
    await c.query("select imobdesk.sf_marcar_paga($1)", [id]);
  });
  return id;
}

async function comprovar(id: number, valor: number) {
  return gravando(colab, async (c) => {
    const a = await rpc(c, "imobdesk.sf_comprovacao_anexar($1)", [{ solicitacaoId: id, path: `${colab}/${id}/nf.pdf`, nome: "nf.pdf", mime: "application/pdf", tamanho: 10,
      sha256: (sha++).toString(16).padStart(64, "b") }]);
    return rpc(c, "imobdesk.sf_enviar_comprovacao($1)", [{ id, anexoId: a.id, tipoDocumento: "nfe", emissao: hoje(), emitente: "J.A BLINDAGEM LTDA",
      emitenteDoc: "53520864000109", valor, numero: String(sha) }]);
  });
}

beforeAll(async () => {
  db = await startTestDb(54426);
  obra = Number((await db.admin.query("select id from imobdesk.at_setores where nome = 'Obra - Arte Wave'")).rows[0].id);
  await db.admin.query("update imobdesk.at_setores set sf_setor_obra = true, sf_limite_adiantamentos_abertos = 10 where id = $1", [obra]);
  const financeiro = Number((await db.admin.query("insert into imobdesk.at_setores (nome, sf_financeiro) values ('Financeiro', true) returning id")).rows[0].id);
  colab = await usuario("colab.adt@exemplo.com.br", obra);
  colab2 = await usuario("colab2.adt@exemplo.com.br", obra);
  plan = await usuario("plan.adt@exemplo.com.br", obra);
  ger = await usuario("ger.adt@exemplo.com.br", obra);
  dir = await usuario("dir.adt@exemplo.com.br", obra);
  pres = await usuario("pres.adt@exemplo.com.br", obra);
  fin = await usuario("fin.adt@exemplo.com.br", financeiro);
  const ins = "insert into imobdesk.sf_setor_aprovador (setor_id, tipo_solicitacao, ordem, papel, aprovador_id, condicao, alcada_minima) values ($1, 'adiantamento', $2, $3, $4, $5, $6)";
  await db.admin.query(ins, [obra, 1, "planejamento", plan, "obra", 0]);
  await db.admin.query(ins, [obra, 2, "gerente", ger, "sempre", 0]);
  await db.admin.query(ins, [obra, 3, "diretor", dir, "valor_acima", 5000]);
  await db.admin.query(ins, [obra, 4, "presidente", pres, "valor_acima", 10000]);
});

afterAll(async () => {
  await db?.stop();
});

describe("formulário do adiantamento", () => {
  it("grava o formulário: linha única, rateio com valor e prazo de comprovação = vencimento + 30 dias", async () => {
    const id = await rascunho(colab, 658.4);
    const s = await sol(id);
    expect(Number(s.valor_adiantamento)).toBe(658.4);
    expect(Number(s.total_despesas)).toBe(658.4);
    expect(s.favorecido_doc).toBe("53520864000109");
    expect(s.prazo_comprovacao.toISOString().slice(0, 10)).toBe(daqui(33));
    const rat = (await db.admin.query("select tarefa, valor from imobdesk.sf_rateio where solicitacao_id = $1 order by id", [id])).rows;
    expect(rat.map((r) => Number(r.valor))).toEqual([395.04, 263.36]);
    const d = await gravando(colab, (c) => rpc(c, "imobdesk.sf_detalhe($1)", [id]));
    expect(d.adiantamento.documentos).toHaveLength(1);
    expect(d.adiantamento.obras).toContain("Obra - Arte Wave");
    const ch = await gravando(colab, (c) => rpc(c, "imobdesk.sf_checagens($1)", [id]));
    expect(Object.fromEntries(ch.map((x: { codigo: string; resultado: string }) => [x.codigo, x.resultado]))).toEqual({ A01: "ok", A02: "ok", A03: "ok", A05: "ok", A06: "ok" });
  });

  it("A05 bloqueia rateio que não fecha 100%; A02 e A03 só alertam", async () => {
    const id = await rascunho(colab2, 700, { rateio: [{ tarefa: "1.1", porcentagem: 90 }], pedidoValor: 1000, pedidoFornecedorDoc: "11222333000144" });
    const ch = await gravando(colab2, (c) => rpc(c, "imobdesk.sf_checagens($1)", [id]));
    const r = Object.fromEntries(ch.map((x: { codigo: string; resultado: string }) => [x.codigo, x.resultado]));
    expect(r).toMatchObject({ A02: "alerta", A03: "alerta", A05: "bloqueio" });
    await recusa(colab2, "select imobdesk.sf_enviar($1, true)", [id], /A05/);
  });

  it("recusa CPF/CNPJ inválido e envio sem vencimento", async () => {
    const id = await rascunho(colab2, 100);
    await recusa(colab2, "select imobdesk.sf_adiantamento_salvar($1)", [formulario(id, 100, { favorecidoDoc: "123" })], /CPF\/CNPJ/);
    await gravando(colab2, (c) => rpc(c, "imobdesk.sf_adiantamento_salvar($1)", [formulario(id, 100, { vencimento: null })]));
    await recusa(colab2, "select imobdesk.sf_enviar($1, true)", [id], /vencimento/);
  });
});

describe("cadeia de 4 níveis", () => {
  it.each([
    [658.4, ["planejamento:aguardando", "gerente:pendente", "diretor:nao_exigido", "presidente:nao_exigido"]],
    [6000, ["planejamento:aguardando", "gerente:pendente", "diretor:pendente", "presidente:nao_exigido"]],
    [20000, ["planejamento:aguardando", "gerente:pendente", "diretor:pendente", "presidente:pendente"]],
  ])("valor %s", async (valor, esperado) => {
    const id = await rascunho(colab2, valor as number);
    await gravando(colab2, (c) => rpc(c, "imobdesk.sf_enviar($1, true)", [id]));
    expect(await cadeia(id)).toEqual(esperado);
    expect((await sol(id)).modo_aprovacao).toBe("sequencial");
    await gravando(colab2, (c) => c.query("select imobdesk.sf_cancelar($1)", [id]));
  });

  it("A06 bloqueia outro adiantamento no mesmo pedido em aberto", async () => {
    const a = await rascunho(colab2, 300, { pedidoNumero: "PED-A06" });
    await gravando(colab2, (c) => rpc(c, "imobdesk.sf_enviar($1, true)", [a]));
    const b = await rascunho(colab2, 300, { pedidoNumero: "PED-A06" });
    await recusa(colab2, "select imobdesk.sf_enviar($1, true)", [b], /A06/);
  });
});

describe("comprovação", () => {
  it("nota maior: encerra com saldo do pedido a lançar", async () => {
    const id = await pago(1200);
    const s = await sol(id);
    expect(s.status).toBe("comprovacao_pendente");
    expect(s.pago_em).not.toBeNull();
    const prev = await gravando(colab, (c) => rpc(c, "imobdesk.sf_comprovacao_checar($1, $2)", [id, { emitenteDoc: "53520864000109", emissao: hoje(), valor: 2400 }]));
    expect(prev.every((x: { resultado: string }) => x.resultado === "ok")).toBe(true);
    const r = await comprovar(id, 2400);
    expect(r).toMatchObject({ acerto: "comprovado", saldoPagar: 1200 });
    expect((await sol(id)).status).toBe("comprovacao_em_conferencia");
    await gravando(fin, (c) => rpc(c, "imobdesk.sf_decidir_comprovacao($1, 'aceitar', null)", [id]));
    expect((await sol(id)).status).toBe("encerrada");
    const ped = await gravando(fin, (c) => rpc(c, "imobdesk.sf_lancamento_saldo_pedido($1)", [id]));
    expect(Number(ped.aPagar)).toBe(1200);
  });

  it("nota igual: encerra sem saldo", async () => {
    const id = await pago(500);
    await comprovar(id, 500);
    await gravando(fin, (c) => rpc(c, "imobdesk.sf_decidir_comprovacao($1, 'aceitar', null)", [id]));
    expect((await sol(id)).status).toBe("encerrada");
    await recusa(fin, "select imobdesk.sf_lancamento_saldo_pedido($1)", [id], /saldo/);
  });

  it("nota menor: alerta exige observação, devolução pendente e encerra ao confirmar", async () => {
    const id = await pago(1200);
    expect(await comprovar(id, 850)).toMatchObject({ acerto: "devolucao", saldoDevolver: 350 });
    await recusa(fin, "select imobdesk.sf_decidir_comprovacao($1, 'aceitar', null)", [id], /observação/);
    await gravando(fin, (c) => rpc(c, "imobdesk.sf_decidir_comprovacao($1, 'aceitar', 'nota menor')", [id]));
    expect((await sol(id)).status).toBe("devolucao_pendente");
    await gravando(fin, (c) => c.query("select imobdesk.sf_confirmar_devolucao($1, 'pix recebido')", [id]));
    expect((await sol(id)).status).toBe("encerrada");
  });

  it("pedir ajuste volta para o colaborador; nota repetida é apontada", async () => {
    const id = await pago(300);
    await comprovar(id, 300);
    await gravando(fin, (c) => rpc(c, "imobdesk.sf_decidir_comprovacao($1, 'ajuste', 'foto ilegível')", [id]));
    expect((await sol(id)).status).toBe("comprovacao_pendente");
    const outra = await pago(300);
    const num = (await db.admin.query("select numero_documento from imobdesk.sf_comprovacao where solicitacao_id = $1", [id])).rows[0].numero_documento;
    await db.admin.query("update imobdesk.sf_comprovacao set status = 'aceita' where solicitacao_id = $1", [id]);
    const prev = await gravando(colab, (c) => rpc(c, "imobdesk.sf_comprovacao_checar($1, $2)", [outra, { emitenteDoc: "53520864000109", emissao: hoje(), valor: 300, numero: num }]));
    expect(prev.find((x: { nome: string }) => x.nome === "Nota não usada antes").resultado).toBe("alerta");
  });

  it("só o Financeiro decide; o colaborador não", async () => {
    const id = await pago(200);
    await comprovar(id, 200);
    await recusa(colab, "select imobdesk.sf_decidir_comprovacao($1, 'aceitar', null)", [id], /Financeiro/);
  });
});

describe("prazo da comprovação", () => {
  it("lembrete D-7, vencida avisa e bloqueia novo adiantamento", async () => {
    const id = await pago(150);
    await db.admin.query("update imobdesk.sf_solicitacao set prazo_comprovacao = current_date + 5 where id = $1", [id]);
    expect(await rpc(db.admin, "imobdesk.sf_comprovacao_job()")).toMatchObject({ lembretes: 1 });
    expect((await sol(id)).comprovacao_aviso7_em).not.toBeNull();
    await db.admin.query("update imobdesk.sf_solicitacao set prazo_comprovacao = current_date - 1 where id = $1", [id]);
    expect(await rpc(db.admin, "imobdesk.sf_comprovacao_job()")).toMatchObject({ vencidas: 1 });
    expect((await sol(id)).status_comprovacao).toBe("vencida");
    await recusa(colab, "select imobdesk.sf_rascunho_criar('adiantamento')", [], /vencida/);
    // Reembolso continua liberado.
    await gravando(colab, (c) => rpc(c, "imobdesk.sf_rascunho_criar('reembolso')"));
  });
});
