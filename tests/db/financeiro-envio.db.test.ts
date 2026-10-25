// Solicitações Financeiras, Fase 2 (migration 20261017110000): rascunho, linhas, anexos com SHA-256, checagens antes de
// enviar, cadeia do setor congelada no envio (alçada, etapa pulada do próprio solicitante, novo ciclo após devolução),
// fundo fixo (saldo e R10), cancelamento e as políticas do bucket sf-comprovantes.
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser, startTestDb, type TestDb } from "./pgHarness";

let db: TestDb;
let admin: string;
let colab: string;
let gestor: string;
let diretor: string;
let semSetor: string;
let obra: number;

const sessoes = new Map<string, string>();
const claims = (user: string) => ({ role: "authenticated", sub: user, session_id: sessoes.get(user), amr: [{ method: "recovery", timestamp: 1 }] });
const SHA = (n: number) => n.toString(16).padStart(64, "a");

async function usuario(email: string, perfil: string, nome: string): Promise<string> {
  const { rows } = await db.admin.query("insert into auth.users (email) values ($1) returning id", [email]);
  await db.admin.query("insert into imobdesk.usuarios (id, email, nome, perfil_key, status) values ($1, $2, $3, $4, 'active')", [rows[0].id, email, nome, perfil]);
  const sid = (await db.admin.query("insert into auth.sessions (user_id) values ($1) returning id", [rows[0].id])).rows[0].id as string;
  sessoes.set(rows[0].id, sid);
  return rows[0].id as string;
}

async function pessoa(email: string, setor: number | null, cpf: string | null = null) {
  const { rows } = await db.admin.query("insert into imobdesk.at_pessoas (nome, documento, setor_id) values ($1, $2, $3) returning id", [email, cpf, setor]);
  await db.admin.query("insert into imobdesk.at_pessoa_contatos (pessoa_id, tipo, valor, principal) values ($1, 'email', $2, true)", [rows[0].id, email]);
}

const rpc = async (c: pg.Client, sql: string, args: unknown[] = []) => (await c.query(`select ${sql} as r`, args)).rows[0].r;
const como = <T>(u: string, fn: (c: pg.Client) => Promise<T>) => asUser(db.admin, claims(u), fn);
/** Cada recusa numa transação própria. */
const recusa = (u: string, sql: string, args: unknown[], erro: RegExp) => como(u, (c) => expect(c.query(sql, args)).rejects.toThrow(erro));

/** Rascunho com linhas completas e um comprovante por linha (persistido: commit fora do asUser). */
async function rascunhoCompleto(u: string, tipo: string, valores: number[], shaBase: number): Promise<number> {
  await db.admin.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify(claims(u))]);
  await db.admin.query("set role authenticated");
  try {
    const id = Number(await rpc(db.admin, "imobdesk.sf_rascunho_criar($1)", [tipo]));
    const det = await rpc(db.admin, "imobdesk.sf_detalhe($1)", [id]);
    const itens = valores.map((v, i) => ({ chave: `k${i}`, data: det.periodoDe, valor: v, descricao: `Fornecedor ${i}`, motivo: "Transporte" }));
    const mapa = (await rpc(db.admin, "imobdesk.sf_rascunho_salvar($1)", [{ id, periodoDe: det.periodoDe, periodoAte: det.periodoAte, itens }])).itens;
    for (const [i, m] of mapa.entries()) {
      await rpc(db.admin, "imobdesk.sf_anexo_registrar($1)", [
        { solicitacaoId: id, itemId: m.id, path: `${u}/${id}/c${i}.pdf`, nome: `c${i}.pdf`, mime: "application/pdf", tamanho: 1000, sha256: SHA(shaBase + i) },
      ]);
    }
    return id;
  } finally {
    await db.admin.query("reset role");
    await db.admin.query("select set_config('request.jwt.claims', '', false)");
  }
}

async function enviar(u: string, id: number) {
  await db.admin.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify(claims(u))]);
  await db.admin.query("set role authenticated");
  try {
    return await rpc(db.admin, "imobdesk.sf_enviar($1, true)", [id]);
  } finally {
    await db.admin.query("reset role");
    await db.admin.query("select set_config('request.jwt.claims', '', false)");
  }
}

const etapas = async (id: number) =>
  (await db.admin.query("select ciclo, nivel, papel, status from imobdesk.sf_aprovacao where solicitacao_id = $1 order by ciclo, nivel", [id])).rows;

beforeAll(async () => {
  db = await startTestDb(54421);
  obra = Number((await db.admin.query("select id from imobdesk.at_setores where nome = 'Obra - Arte Wave'")).rows[0].id);
  admin = await usuario("admin.env@exemplo.com.br", "admin", "Admin");
  colab = await usuario("colab.env@exemplo.com.br", "operador", "João Silva");
  gestor = await usuario("gestor.env@exemplo.com.br", "operador", "Marina Costa");
  diretor = await usuario("diretor.env@exemplo.com.br", "operador", "Roberto Alves");
  semSetor = await usuario("sem.env@exemplo.com.br", "operador", "Sem Setor");
  await pessoa("colab.env@exemplo.com.br", obra, "12345678900");
  await pessoa("gestor.env@exemplo.com.br", obra);
  await pessoa("sem.env@exemplo.com.br", null);
  await como(admin, async (c) => {
    await c.query("select imobdesk.sf_setor_config_salvar($1)", [{
      setorId: obra, obra: true, modoAprovacao: "sequencial", prazoHoras: 48,
      reembolso: [{ papel: "Gestor", aprovadorId: gestor, alcadaMinima: 0 }, { papel: "Diretor", aprovadorId: diretor, alcadaMinima: 5000 }],
      adiantamento: [],
    }]);
    await c.query("select imobdesk.sf_fundo_fixo_salvar($1)", [{ usuarioId: colab, valor: 1000 }]);
    await c.query("commit; begin");
  });
});

afterAll(async () => {
  await db?.stop();
});

describe("rascunho", () => {
  it("cria com número, setor e período do mês; sem setor é recusado", async () => {
    await como(colab, async (c) => {
      const id = await rpc(c, "imobdesk.sf_rascunho_criar('reembolso')");
      const d = await rpc(c, "imobdesk.sf_detalhe($1)", [id]);
      expect(d).toMatchObject({ status: "rascunho", podeEditar: true, setor: { id: obra }, solicitante: { cpfMascarado: "***.456.789-**" } });
      expect(d.numero).toMatch(/^SF-\d{4}-\d{4}$/);
      expect(d.cadeiaPrevista.map((e: { papel: string; exigido: boolean }) => `${e.papel}:${e.exigido}`)).toEqual(["Gestor:true", "Diretor:false"]);
    });
    await recusa(semSetor, "select imobdesk.sf_rascunho_criar('reembolso')", [], /sem setor/);
  });

  it("grava linhas, troca e apaga; recalcula o total", async () => {
    await como(colab, async (c) => {
      const id = await rpc(c, "imobdesk.sf_rascunho_criar('reembolso')");
      const m1 = (await rpc(c, "imobdesk.sf_rascunho_salvar($1)", [{ id, itens: [{ chave: "a", valor: 10 }, { chave: "b", valor: 20 }] }])).itens;
      await rpc(c, "imobdesk.sf_rascunho_salvar($1)", [{ id, itens: [{ id: m1[1].id, valor: 25 }] }]);
      const d = await rpc(c, "imobdesk.sf_detalhe($1)", [id]);
      expect(d.itens.map((i: { id: number; valor: number }) => [i.id, Number(i.valor)])).toEqual([[m1[1].id, 25]]);
      expect(Number(d.totalDespesas)).toBe(25);
    });
  });

  it("fundo fixo sem cadastro é recusado; com cadastro traz o saldo inicial", async () => {
    // Fundo fixo só para o gestor do setor (20261023150000, D1).
    await recusa(colab, "select imobdesk.sf_rascunho_criar('fundo_fixo')", [], /só para o gestor do setor/);
    await db.admin.query("insert into imobdesk.at_setor_gestores (setor_id, usuario_id) values ($1, $2), ($1, $3)", [obra, gestor, colab]);
    await recusa(gestor,"select imobdesk.sf_rascunho_criar('fundo_fixo')", [], /não tem fundo fixo/);
    await como(colab, async (c) => {
      const d = await rpc(c, "imobdesk.sf_detalhe($1)", [await rpc(c, "imobdesk.sf_rascunho_criar('fundo_fixo')")]);
      expect([Number(d.valorFundoFixo), Number(d.saldoInicial)]).toEqual([1000, 1000]);
    });
  });
});

describe("anexos e Storage", () => {
  it("anexo fora da pasta é recusado; políticas do bucket só deixam gravar na própria pasta e solicitação editável", async () => {
    await como(colab, async (c) => {
      const id = await rpc(c, "imobdesk.sf_rascunho_criar('reembolso')");
      await expect(c.query("select imobdesk.sf_anexo_registrar($1)", [{ solicitacaoId: id, path: `${gestor}/${id}/x.pdf`, mime: "application/pdf", tamanho: 1, sha256: SHA(1) }]))
        .rejects.toThrow(/fora da pasta/);
    });
    await como(colab, async (c) => {
      const id = await rpc(c, "imobdesk.sf_rascunho_criar('reembolso')");
      expect(await rpc(c, "imobdesk.sf_storage_pode_gravar($1)", [`${colab}/${id}/a.pdf`])).toBe(true);
      expect(await rpc(c, "imobdesk.sf_storage_pode_gravar($1)", [`${gestor}/${id}/a.pdf`])).toBe(false);
      expect(await rpc(c, "imobdesk.sf_storage_pode_ler($1)", [`${colab}/${id}/a.pdf`])).toBe(true);
    });
  });
});

describe("envio", () => {
  it("sem aceite, sem comprovante ou linha incompleta é recusado", async () => {
    const id = await rascunhoCompleto(colab, "reembolso", [100], 100);
    await recusa(colab, "select imobdesk.sf_enviar($1, false)", [id], /aceite/);
    await db.admin.query("delete from imobdesk.sf_anexo where solicitacao_id = $1", [id]);
    await recusa(colab, "select imobdesk.sf_enviar($1, true)", [id], /R01/);
    await db.admin.query("update imobdesk.sf_item set motivo = null where solicitacao_id = $1", [id]);
    await recusa(colab, "select imobdesk.sf_enviar($1, true)", [id], /Preencha/);
  });

  it("congela a cadeia: abaixo da alçada só o gestor; diretor não exigido; regras gravadas", async () => {
    const id = await rascunhoCompleto(colab, "reembolso", [100, 50], 200);
    const r = await enviar(colab, id);
    expect(r).toMatchObject({ status: "em_aprovacao", ciclo: 1 });
    expect(await etapas(id)).toEqual([
      { ciclo: 1, nivel: 1, papel: "Gestor", status: "aguardando" },
      { ciclo: 1, nivel: 2, papel: "Diretor", status: "nao_exigido" },
    ]);
    const s = (await db.admin.query("select aceite_em is not null as aceite, enviado_em is not null as enviado from imobdesk.sf_solicitacao where id = $1", [id])).rows[0];
    expect(s).toEqual({ aceite: true, enviado: true });
    await recusa(colab, "select imobdesk.sf_rascunho_salvar($1)", [{ id, itens: [] }], /não pode mais ser alterada/);
  });

  it("acima da alçada entra o diretor (sequencial: aguardando só o 1º); mudar o cadastro depois não muda a cadeia", async () => {
    const id = await rascunhoCompleto(colab, "reembolso", [6000], 300);
    await enviar(colab, id);
    expect((await etapas(id)).map((e) => e.status)).toEqual(["aguardando", "pendente"]);
    await db.admin.query("delete from imobdesk.sf_setor_aprovador where setor_id = $1 and papel = 'Diretor'", [obra]);
    expect((await etapas(id)).map((e) => e.papel)).toEqual(["Gestor", "Diretor"]);
    await db.admin.query("insert into imobdesk.sf_setor_aprovador (setor_id, tipo_solicitacao, ordem, papel, aprovador_id, condicao, alcada_minima) values ($1, 'reembolso_fundo_fixo', 2, 'Diretor', $2, 'valor_acima', 5000)", [obra, diretor]);
  });

  it("a etapa do próprio solicitante é pulada", async () => {
    const id = await rascunhoCompleto(gestor, "reembolso", [6000], 400);
    await enviar(gestor, id);
    expect((await etapas(id)).map((e) => e.status)).toEqual(["pulado", "aguardando"]);
  });

  it("mesmo arquivo em outra solicitação ativa bloqueia (R06)", async () => {
    const id = await rascunhoCompleto(colab, "reembolso", [100], 200);  // mesmo SHA do teste anterior, já enviado
    await recusa(colab, "select imobdesk.sf_enviar($1, true)", [id], /R06/);
  });

  it("devolvida: reenvio abre novo ciclo recomeçando do nível 1", async () => {
    const id = await rascunhoCompleto(colab, "reembolso", [100], 500);
    await enviar(colab, id);
    await db.admin.query("update imobdesk.sf_solicitacao set status = 'devolvida' where id = $1", [id]);
    await enviar(colab, id);
    expect((await etapas(id)).filter((e) => e.ciclo === 2).map((e) => `${e.nivel}:${e.status}`)).toEqual(["1:aguardando", "2:nao_exigido"]);
  });

  it("fundo fixo acima do saldo é bloqueado (R10)", async () => {
    const id = await rascunhoCompleto(colab, "fundo_fixo", [800, 300], 600);
    await recusa(colab, "select imobdesk.sf_enviar($1, true)", [id], /R10/);
  });

  it("cancela antes da 1ª aprovação; depois de aprovada não", async () => {
    const id = await rascunhoCompleto(colab, "reembolso", [100], 700);
    await enviar(colab, id);
    await como(colab, (c) => c.query("select imobdesk.sf_cancelar($1)", [id]));
    const id2 = await rascunhoCompleto(colab, "reembolso", [100], 800);
    await enviar(colab, id2);
    await db.admin.query("update imobdesk.sf_aprovacao set status = 'aprovado' where solicitacao_id = $1 and nivel = 1", [id2]);
    await recusa(colab, "select imobdesk.sf_cancelar($1)", [id2], /antes da primeira aprovação/);
  });

  it("minhas: contadores e lista com a etapa atual", async () => {
    await como(colab, async (c) => {
      const m = await rpc(c, "imobdesk.sf_minhas()");
      expect(m.kpis.emAprovacao).toBeGreaterThan(0);
      expect(m.temFundoFixo).toBe(true);
      const enviada = m.lista.find((x: { status: string; etapa: unknown }) => x.status === "em_aprovacao" && x.etapa);
      expect(enviada.etapa).toMatchObject({ papel: "Gestor", nivel: 1 });
    });
  });
});
