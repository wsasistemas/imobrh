// Solicitações Financeiras, Fase 3 (migration 20261017120000): decisão do aprovador nos três modos, devolução com novo
// ciclo, reprovação, comentário obrigatório, substituto por período, job de prazos (lembrete 25% e escalonamento),
// notificações (sino + fila de e-mail), fila do aprovador e a visibilidade "Todas do setor".
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser, startTestDb, type TestDb } from "./pgHarness";

let db: TestDb;
let admin: string;
let colab: string;
let gestor: string;
let diretor: string;
let substituto: string;
let fin: string;
let obra: number;
let financeiro: number;
let sha = 1000;

const sessoes = new Map<string, string>();
const claims = (user: string) => ({ role: "authenticated", sub: user, session_id: sessoes.get(user), amr: [{ method: "recovery", timestamp: 1 }] });

async function usuario(email: string, nome: string): Promise<string> {
  const { rows } = await db.admin.query("insert into auth.users (email) values ($1) returning id", [email]);
  await db.admin.query("insert into imobdesk.usuarios (id, email, nome, perfil_key, status) values ($1, $2, $3, 'operador', 'active')", [rows[0].id, email, nome]);
  const sid = (await db.admin.query("insert into auth.sessions (user_id) values ($1) returning id", [rows[0].id])).rows[0].id as string;
  sessoes.set(rows[0].id, sid);
  return rows[0].id as string;
}

async function pessoa(email: string, setor: number) {
  const { rows } = await db.admin.query("insert into imobdesk.at_pessoas (nome, setor_id) values ($1, $2) returning id", [email, setor]);
  await db.admin.query("insert into imobdesk.at_pessoa_contatos (pessoa_id, tipo, valor, principal) values ($1, 'email', $2, true)", [rows[0].id, email]);
}

const rpc = async (c: pg.Client, sql: string, args: unknown[] = []) => (await c.query(`select ${sql} as r`, args)).rows[0].r;
const como = <T>(u: string, fn: (c: pg.Client) => Promise<T>) => asUser(db.admin, claims(u), fn);
const recusa = (u: string, sql: string, args: unknown[], erro: RegExp) => como(u, (c) => expect(c.query(sql, args)).rejects.toThrow(erro));

/** Executa como o usuário e grava (sem rollback). */
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

async function configurar(modo: string) {
  await gravando(admin, (c) => c.query("select imobdesk.sf_setor_config_salvar($1)", [{
    setorId: obra, obra: true, modoAprovacao: modo, prazoHoras: 48, acaoPrazoVencido: "escalar",
    reembolso: [{ papel: "Gestor", aprovadorId: gestor, substitutoId: substituto, alcadaMinima: 0 }, { papel: "Diretor", aprovadorId: diretor, alcadaMinima: 0 }],
    adiantamento: [],
  }]));
}

/** Rascunho completo enviado pelo colaborador. */
async function enviada(valor = 100): Promise<number> {
  return gravando(colab, async (c) => {
    const id = Number(await rpc(c, "imobdesk.sf_rascunho_criar('reembolso')"));
    const d = await rpc(c, "imobdesk.sf_detalhe($1)", [id]);
    const m = (await rpc(c, "imobdesk.sf_rascunho_salvar($1)", [{ id, periodoDe: d.periodoDe, periodoAte: d.periodoAte,
      itens: [{ chave: "a", data: d.periodoDe, valor, descricao: "Uber", motivo: "Transporte" }] }])).itens;
    await rpc(c, "imobdesk.sf_anexo_registrar($1)", [{ solicitacaoId: id, itemId: m[0].id, path: `${colab}/${id}/a.pdf`, nome: "a.pdf",
      mime: "application/pdf", tamanho: 10, sha256: (sha++).toString(16).padStart(64, "b") }]);
    await rpc(c, "imobdesk.sf_enviar($1, true)", [id]);
    return id;
  });
}

const decidir = (u: string, id: number, decisao: string, comentario: string | null = null) =>
  gravando(u, (c) => rpc(c, "imobdesk.sf_decidir_aprovacao($1, $2, $3)", [id, decisao, comentario]));
const status = async (id: number) => (await db.admin.query("select status, pagar_ate from imobdesk.sf_solicitacao where id = $1", [id])).rows[0];
const etapas = async (id: number) =>
  (await db.admin.query("select ciclo, nivel, status from imobdesk.sf_aprovacao where solicitacao_id = $1 order by ciclo, nivel", [id])).rows.map((r) => `${r.ciclo}.${r.nivel}:${r.status}`);
const avisos = async (u: string) => (await db.admin.query("select titulo, link from imobdesk.ch_notificacoes where usuario_id = $1 order by id", [u])).rows;

beforeAll(async () => {
  db = await startTestDb(54422);
  obra = Number((await db.admin.query("select id from imobdesk.at_setores where nome = 'Obra - Arte Wave'")).rows[0].id);
  financeiro = Number((await db.admin.query("insert into imobdesk.at_setores (nome, sf_financeiro) values ('Financeiro', true) returning id")).rows[0].id);
  const { rows } = await db.admin.query("insert into auth.users (email) values ('admin.apr@exemplo.com.br') returning id");
  admin = rows[0].id;
  await db.admin.query("insert into imobdesk.usuarios (id, email, nome, perfil_key, status) values ($1, 'admin.apr@exemplo.com.br', 'Admin', 'admin', 'active')", [admin]);
  sessoes.set(admin, (await db.admin.query("insert into auth.sessions (user_id) values ($1) returning id", [admin])).rows[0].id);
  colab = await usuario("colab.apr@exemplo.com.br", "João Silva");
  gestor = await usuario("gestor.apr@exemplo.com.br", "Marina Costa");
  diretor = await usuario("diretor.apr@exemplo.com.br", "Roberto Alves");
  substituto = await usuario("sub.apr@exemplo.com.br", "Ana Prado");
  fin = await usuario("fin.apr@exemplo.com.br", "Lúcia Ferraz");
  await pessoa("colab.apr@exemplo.com.br", obra);
  await pessoa("fin.apr@exemplo.com.br", financeiro);
});

afterAll(async () => {
  await db?.stop();
});

describe("sequencial", () => {
  it("gestor aprova → libera o diretor; diretor aprova → conferência com pagar até em 15 dias; avisos em cada etapa", async () => {
    await configurar("sequencial");
    const id = await enviada();
    expect(await etapas(id)).toEqual(["1.1:aguardando", "1.2:pendente"]);
    expect((await avisos(gestor)).at(-1)).toMatchObject({ link: `/financeiro/solicitacoes/${id}` });
    await recusa(diretor, "select imobdesk.sf_decidir_aprovacao($1, 'aprovar', null)", [id], /não está aguardando a sua aprovação/);
    expect(await decidir(gestor, id, "aprovar")).toMatchObject({ status: "em_aprovacao", proximo: "Diretor" });
    expect(await etapas(id)).toEqual(["1.1:aprovado", "1.2:aguardando"]);
    expect(await decidir(diretor, id, "aprovar")).toMatchObject({ status: "em_conferencia" });
    const s = await status(id);
    expect(s.status).toBe("em_conferencia");
    expect(Math.round((new Date(s.pagar_ate).getTime() - Date.now()) / 86_400_000)).toBeGreaterThanOrEqual(14);
    expect((await avisos(fin)).some((a: { titulo: string }) => a.titulo.startsWith("Chegou na conferência"))).toBe(true);
    expect((await avisos(colab)).map((a: { titulo: string }) => a.titulo.split(":")[0])).toEqual(expect.arrayContaining(["Enviada para aprovação", "Gestor aprovou", "Aprovada, foi para o Financeiro"]));
    const fila = (await db.admin.query("select count(*)::int as n from imobdesk.sf_email_fila where solicitacao_id = $1", [id])).rows[0].n;
    expect(fila).toBeGreaterThan(3);
  });

  it("devolver exige comentário e reabre; o reenvio abre ciclo 2 do nível 1", async () => {
    await configurar("sequencial");
    const id = await enviada();
    await recusa(gestor, "select imobdesk.sf_decidir_aprovacao($1, 'devolver', '  ')", [id], /motivo/);
    await decidir(gestor, id, "devolver", "Falta o comprovante do Uber");
    expect((await status(id)).status).toBe("devolvida");
    expect(await etapas(id)).toEqual(["1.1:devolvido", "1.2:nao_exigido"]);
    expect((await avisos(colab)).at(-1).titulo).toMatch(/^Devolvida para ajuste/);
    await gravando(colab, (c) => c.query("select imobdesk.sf_enviar($1, true)", [id]));
    expect(await etapas(id)).toEqual(["1.1:devolvido", "1.2:nao_exigido", "2.1:aguardando", "2.2:pendente"]);
  });

  it("reprovar encerra", async () => {
    await configurar("sequencial");
    const id = await enviada();
    await decidir(gestor, id, "reprovar", "Despesa pessoal");
    expect((await status(id)).status).toBe("reprovada");
  });
});

describe("paralelo e qualquer um", () => {
  it("paralelo: os dois aguardam; só conclui quando os dois aprovarem", async () => {
    await configurar("paralelo");
    const id = await enviada();
    expect(await etapas(id)).toEqual(["1.1:aguardando", "1.2:aguardando"]);
    await decidir(diretor, id, "aprovar");
    expect((await status(id)).status).toBe("em_aprovacao");
    await decidir(gestor, id, "aprovar");
    expect((await status(id)).status).toBe("em_conferencia");
  });

  it("qualquer um: o primeiro que aprova conclui; o outro fica pulado", async () => {
    await configurar("qualquer_um");
    const id = await enviada();
    await decidir(diretor, id, "aprovar");
    expect((await status(id)).status).toBe("em_conferencia");
    expect(await etapas(id)).toEqual(["1.1:pulado", "1.2:aprovado"]);
  });

  it("o modo fica congelado no envio", async () => {
    await configurar("sequencial");
    const id = await enviada();
    await configurar("qualquer_um");
    await decidir(gestor, id, "aprovar");
    expect((await status(id)).status).toBe("em_aprovacao");
  });
});

describe("substitutos e prazos", () => {
  it("substituto da etapa decide; substituto por período também e vê a fila", async () => {
    await configurar("sequencial");
    const id = await enviada();
    await decidir(substituto, id, "aprovar");
    expect(await etapas(id)).toEqual(["1.1:aprovado", "1.2:aguardando"]);
    const hoje = new Date().toISOString().slice(0, 10);
    await gravando(diretor, (c) => c.query("select imobdesk.sf_substituto_definir($1)", [{ substitutoId: fin, de: hoje, ate: hoje }]));
    const fila = await como(fin, (c) => rpc(c, "imobdesk.sf_aprovacoes_fila('aguardando')"));
    expect(fila.lista.find((x: { id: number }) => x.id === id)).toMatchObject({ substitutoDe: "Roberto Alves" });
    await decidir(fin, id, "aprovar");
    expect((await status(id)).status).toBe("em_conferencia");
  });

  it("só aprovador define substituto", async () => {
    const hoje = new Date().toISOString().slice(0, 10);
    await recusa(colab, "select imobdesk.sf_substituto_definir($1)", [{ substitutoId: fin, de: hoje, ate: hoje }], /Só aprovadores/);
  });

  it("job: lembrete com 25% do prazo e escalonamento ao substituto quando vence (uma vez)", async () => {
    await configurar("sequencial");
    const id = await enviada();
    await db.admin.query("update imobdesk.sf_aprovacao set iniciado_em = now() - interval '40 hours', prazo_em = now() + interval '8 hours' where solicitacao_id = $1 and nivel = 1", [id]);
    expect(await rpc(db.admin, "imobdesk.sf_prazos_job()")).toMatchObject({ lembretes: 1 });
    await db.admin.query("update imobdesk.sf_aprovacao set prazo_em = now() - interval '1 hour' where solicitacao_id = $1 and nivel = 1", [id]);
    expect(await rpc(db.admin, "imobdesk.sf_prazos_job()")).toMatchObject({ escalados: 1 });
    expect(await rpc(db.admin, "imobdesk.sf_prazos_job()")).toMatchObject({ escalados: 0, lembretes: 0 });
    expect((await avisos(substituto)).at(-1).titulo).toMatch(/^Prazo vencido, aprovação escalada/);
  });
});

describe("leitura", () => {
  it("fila do aprovador, aba do setor e extras do detalhe", async () => {
    await configurar("sequencial");
    const id = await enviada();
    await como(gestor, async (c) => {
      const f = await rpc(c, "imobdesk.sf_aprovacoes_fila('aguardando')");
      expect(f.ehAprovador).toBe(true);
      expect(f.lista.find((x: { id: number }) => x.id === id)).toMatchObject({ nivel: 1, de: 2, papel: "Gestor", solicitante: "João Silva" });
      const ex = await rpc(c, "imobdesk.sf_detalhe_extra($1)", [id]);
      expect(ex).toMatchObject({ podeDecidir: true, etapa: { nivel: 1, papel: "Gestor" } });
    });
    await como(diretor, async (c) => {
      const setor = await rpc(c, "imobdesk.sf_aprovacoes_fila('setor')");
      expect(setor.lista.some((x: { id: number }) => x.id === id)).toBe(true);
      expect((await rpc(c, "imobdesk.sf_detalhe_extra($1)", [id])).podeDecidir).toBe(false);
    });
  });

  it("e-mail: a fila sai pela conta do setor financeiro e marca falha após 3 tentativas", async () => {
    const r = await rpc(db.admin, "imobdesk.sf_email_para_enviar(5)");
    expect(r.conta).toBeNull();
    const item = r.itens[0];
    for (let i = 0; i < 3; i++) await db.admin.query("select imobdesk.sf_email_resultado($1, false, 'sem conta')", [item.id]);
    expect((await db.admin.query("select status from imobdesk.sf_email_fila where id = $1", [item.id])).rows[0].status).toBe("falha");
  });

  it("o sino devolve o link", async () => {
    await como(colab, async (c) => {
      const s = await rpc(c, "imobdesk.ch_notificacoes_lista()");
      expect(s.itens[0].link).toMatch(/^\/financeiro\/solicitacoes\/\d+$/);
    });
  });
});
