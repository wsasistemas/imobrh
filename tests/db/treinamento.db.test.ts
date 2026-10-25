// Centro de Treinamento, Fase 1 (migration 20261023100000): carga do mockup, trilha pelo setor da pessoa, módulos de
// gestor só para gestor/aprovador, gabarito que não sai do banco, progresso só da própria pessoa e edição só do Admin.
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser, startTestDb, type TestDb } from "./pgHarness";

let db: TestDb;
let admin: string;
let atendente: string;
let gestor: string;
let semCadastro: string;
let fin: string;
let ti: number;
let financeiro: number;

const sessoes = new Map<string, string>();
const claims = (user: string) => ({ role: "authenticated", sub: user, session_id: sessoes.get(user), amr: [{ method: "recovery", timestamp: 1 }] });

async function usuario(email: string, nome: string, perfil = "operador"): Promise<string> {
  const { rows } = await db.admin.query("insert into auth.users (email) values ($1) returning id", [email]);
  await db.admin.query("insert into imobdesk.usuarios (id, email, nome, perfil_key, status) values ($1, $2, $3, $4, 'active')", [rows[0].id, email, nome, perfil]);
  sessoes.set(rows[0].id, (await db.admin.query("insert into auth.sessions (user_id) values ($1) returning id", [rows[0].id])).rows[0].id);
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

const meus = (u: string, setor: number | null = null) => como(u, (c) => rpc(c, "imobdesk.tr_meus_treinamentos($1)", [setor]));
const codigos = (r: { modulos: { codigo: string }[] }) => r.modulos.map((m) => m.codigo);
const moduloId = async (codigo: string) => Number((await db.admin.query("select id from imobdesk.tr_modulos where codigo = $1", [codigo])).rows[0].id);

beforeAll(async () => {
  db = await startTestDb(54431);
  ti = Number((await db.admin.query("insert into imobdesk.at_setores (nome) values ('TI -  Suporte') returning id")).rows[0].id);
  financeiro = Number((await db.admin.query("insert into imobdesk.at_setores (nome, sf_financeiro) values ('Financeiro Teste', true) returning id")).rows[0].id);
  admin = await usuario("admin.tr@exemplo.com.br", "Admin", "admin");
  atendente = await usuario("atendente.tr@exemplo.com.br", "Bruno Lima");
  gestor = await usuario("gestor.tr@exemplo.com.br", "Marina Costa");
  semCadastro = await usuario("novo.tr@exemplo.com.br", "Pessoa Nova");
  fin = await usuario("fin.tr@exemplo.com.br", "Fernanda Reis");
  await pessoa("atendente.tr@exemplo.com.br", ti);
  await pessoa("gestor.tr@exemplo.com.br", ti);
  await pessoa("fin.tr@exemplo.com.br", financeiro);
  await db.admin.query("insert into imobdesk.at_setor_gestores (setor_id, usuario_id) values ($1, $2)", [ti, gestor]);
  // Setores criados depois da migration: o Admin liga cada um à trilha.
  const trilha = async (codigo: string) => Number((await db.admin.query("select id from imobdesk.tr_trilhas where codigo = $1", [codigo])).rows[0].id);
  const tickets = await trilha("tickets");
  const fin_ = await trilha("fin");
  await gravando(admin, (c) => c.query("select imobdesk.tr_trilha_setores_salvar($1, $2)", [tickets, [ti]]));
  await gravando(admin, (c) => c.query("select imobdesk.tr_trilha_setores_salvar($1, $2)", [fin_, [financeiro]]));
});

afterAll(async () => {
  await db?.stop();
});

describe("carga inicial", () => {
  it("traz as 3 trilhas, os 11 módulos publicados e os 60 balões do mockup", async () => {
    const n = async (sql: string) => Number((await db.admin.query(sql)).rows[0].n);
    expect(await n("select count(*) as n from imobdesk.tr_trilhas")).toBe(3);
    expect(await n("select count(*) as n from imobdesk.tr_modulos where status = 'publicado'")).toBe(11);
    expect(await n("select count(*) as n from imobdesk.tr_passos")).toBe(60);
    expect(await n("select count(*) as n from imobdesk.tr_trilhas where padrao")).toBe(1);
  });
});

describe("cada pessoa vê o seu setor", () => {
  it("TI vê Gestão de Tickets, sem o Monitor (não é gestor)", async () => {
    const r = await meus(atendente);
    expect(r.trilha.codigo).toBe("tickets");
    expect(r.setor.id).toBe(ti);
    expect(codigos(r)).toEqual(["t1", "t2", "t3", "t4", "t6"]);
  });

  it("gestor do setor também vê o Monitor (P2)", async () => {
    expect(codigos(await meus(gestor))).toEqual(["t1", "t2", "t3", "t4", "t5", "t6"]);
  });

  it("Financeiro vê Solicitações Financeiras; Aprovar só aparece para aprovador cadastrado", async () => {
    expect(codigos(await meus(fin))).toEqual(["f1", "f2", "f4", "f5"]);
    await db.admin.query(
      "insert into imobdesk.sf_setor_aprovador (setor_id, tipo_solicitacao, ordem, papel, aprovador_id) values ($1, 'reembolso_fundo_fixo', 1, 'Gestor', $2)",
      [financeiro, fin]);
    expect(codigos(await meus(fin))).toEqual(["f1", "f2", "f3", "f4", "f5"]);
  });

  it("sem cadastro em Pessoas: trilha Colaborador e o aviso (P1, P3)", async () => {
    const r = await meus(semCadastro);
    expect(r.trilha.codigo).toBe("colaborador");
    expect(r.semCadastro).toBe(true);
    expect(r.setor).toBeNull();
    expect(codigos(r)).toEqual(["t6", "f1", "f2"]);
  });

  it("Admin vê como um setor, com todos os módulos da trilha; quem não é Admin não pode", async () => {
    expect(codigos(await meus(admin, ti))).toEqual(["t1", "t2", "t3", "t4", "t5", "t6"]);
    await recusa(atendente, "select imobdesk.tr_meus_treinamentos($1)", [financeiro], /Só o Admin/);
  });

  it("rascunho não aparece para ninguém na trilha", async () => {
    await db.admin.query("update imobdesk.tr_modulos set status = 'rascunho' where codigo = 't4'");
    expect(codigos(await meus(atendente))).not.toContain("t4");
    await db.admin.query("update imobdesk.tr_modulos set status = 'publicado' where codigo = 't4'");
  });
});

describe("tour e pergunta", () => {
  it("o módulo traz os balões e as opções, sem o gabarito", async () => {
    const id = await moduloId("t3");
    const r = await como(atendente, (c) => rpc(c, "imobdesk.tr_modulo($1)", [id]));
    expect(r.baloes).toHaveLength(9);
    expect(r.baloes[0]).toMatchObject({ ordem: 1, tela: "t-ticket", titulo: "Quem pediu e por onde", alvo: [29, 32, 28.6, 3.3] });
    expect(r.opcoes).toHaveLength(3);
    expect(JSON.stringify(r)).not.toMatch(/"resposta"/);
  });

  it("módulo de outra trilha é recusado", async () => {
    await recusa(atendente, "select imobdesk.tr_modulo($1)", [await moduloId("f4")], /não é da sua trilha/);
    await recusa(atendente, "select imobdesk.tr_progresso_salvar($1, 1)", [await moduloId("f4")], /não é da sua trilha/);
  });

  it("guarda o passo (limitado ao total) e retoma; resposta errada não conclui, a certa conclui", async () => {
    const id = await moduloId("t1");
    await gravando(atendente, (c) => c.query("select imobdesk.tr_progresso_salvar($1, 99)", [id]));
    let t1 = (await meus(atendente)).modulos.find((m: { codigo: string }) => m.codigo === "t1");
    expect(t1).toMatchObject({ passoAtual: 6, passos: 6, iniciado: true, concluidoEm: null });
    await gravando(atendente, (c) => c.query("select imobdesk.tr_progresso_salvar($1, 2)", [id]));

    expect(await gravando(atendente, (c) => rpc(c, "imobdesk.tr_responder($1, 2)", [id]))).toMatchObject({ certo: false, concluidoEm: null });
    const ok = await gravando(atendente, (c) => rpc(c, "imobdesk.tr_responder($1, 0)", [id]));
    expect(ok.certo).toBe(true);
    expect(ok.concluidoEm).not.toBeNull();

    // Voltar a um passo depois de concluir não desfaz a conclusão.
    await gravando(atendente, (c) => c.query("select imobdesk.tr_progresso_salvar($1, 1)", [id]));
    t1 = (await meus(atendente)).modulos.find((m: { codigo: string }) => m.codigo === "t1");
    expect(t1.passoAtual).toBe(1);
    expect(t1.concluidoEm).not.toBeNull();
    // O progresso é só dele.
    expect((await meus(gestor)).modulos.find((m: { codigo: string }) => m.codigo === "t1")).toMatchObject({ iniciado: false, concluidoEm: null });
  });

  it("sem acesso direto às tabelas", async () => {
    await recusa(atendente, "select * from imobdesk.tr_modulos", [], /permission denied/);
    await recusa(atendente, "insert into imobdesk.tr_progresso (usuario_id, modulo_id, concluido_em) values ($1, 1, now())", [atendente], /permission denied/);
  });
});

describe("Gerenciar tutoriais", () => {
  it("só o Admin abre o painel e edita", async () => {
    await recusa(atendente, "select imobdesk.tr_admin_painel()", [], /Só o Admin/);
    await recusa(atendente, "select imobdesk.tr_passo_salvar($1)", [{ moduloId: 1, tela: "t-visao", titulo: "X", texto: "Teste", alvo: [1, 1, 1, 1] }], /Só o Admin/);
    await recusa(atendente, "select imobdesk.tr_admin_modulo($1)", [await moduloId("t1")], /Só o Admin/);
  });

  it("o painel conta quem concluiu e o público de cada módulo", async () => {
    const p = await como(admin, (c) => rpc(c, "imobdesk.tr_admin_painel()"));
    expect(p.trilhas).toHaveLength(3);
    const t1 = p.modulos.find((m: { codigo: string }) => m.codigo === "t1");
    expect(t1).toMatchObject({ concluiram: 1, publico: 2, passos: 6 });
    expect(p.modulos.find((m: { codigo: string }) => m.codigo === "t5").publico).toBe(1);
    const editor = await como(admin, (c) => rpc(c, "imobdesk.tr_admin_modulo($1)", [t1.id]));
    expect(editor.resposta).toBe(0);
  });

  it("cria, altera, reordena e exclui balões", async () => {
    const id = await moduloId("t2");
    const novo = Number(await gravando(admin, (c) => rpc(c, "imobdesk.tr_passo_salvar($1)",
      [{ moduloId: id, tela: "t-tickets", titulo: "Novo balão", texto: "Explicação nova.", alvo: [10, 10, 20, 5] }])));
    let r = await como(admin, (c) => rpc(c, "imobdesk.tr_modulo($1)", [id]));
    expect(r.baloes.at(-1)).toMatchObject({ id: novo, ordem: 6, posicao: "auto" });

    await gravando(admin, (c) => c.query("select imobdesk.tr_passo_salvar($1)",
      [{ id: novo, tela: "t-tickets", titulo: "Balão editado", texto: "Outro texto.", alvo: [11, 12, 13, 14], posicao: "abaixo" }]));
    const ids: number[] = r.baloes.map((b: { id: number }) => b.id);
    await gravando(admin, (c) => c.query("select imobdesk.tr_passos_reordenar($1, $2)", [id, [novo, ...ids.slice(0, -1)]]));
    r = await como(admin, (c) => rpc(c, "imobdesk.tr_modulo($1)", [id]));
    expect(r.baloes[0]).toMatchObject({ id: novo, titulo: "Balão editado", posicao: "abaixo", alvo: [11, 12, 13, 14] });
    await recusa(admin, "select imobdesk.tr_passos_reordenar($1, $2)", [id, [novo]], /todos os balões/);

    await gravando(admin, (c) => c.query("select imobdesk.tr_passo_excluir($1)", [novo]));
    r = await como(admin, (c) => rpc(c, "imobdesk.tr_modulo($1)", [id]));
    expect(r.baloes.map((b: { ordem: number }) => b.ordem)).toEqual([1, 2, 3, 4, 5]);
  });

  it("alvo fora de 0–100% é recusado", async () => {
    await recusa(admin, "select imobdesk.tr_passo_salvar($1)",
      [{ moduloId: await moduloId("t2"), tela: "t-tickets", titulo: "Fora", texto: "Fora da tela.", alvo: [90, 10, 120, 5] }], /check/);
  });

  it("novo módulo em rascunho, ligado a uma trilha; publicado aparece para o setor", async () => {
    const tickets = Number((await db.admin.query("select id from imobdesk.tr_trilhas where codigo = 'tickets'")).rows[0].id);
    const id = Number(await gravando(admin, (c) => rpc(c, "imobdesk.tr_modulo_salvar($1)", [{
      titulo: "Gatilhos", papel: "atendente", minutos: 3, rotaDemo: "/gestao-chamados/gatilhos", pergunta: "Um gatilho serve para…",
      opcoes: ["Automatizar", "Apagar tickets"], resposta: 0, trilhas: [tickets] }])));
    expect(codigos(await meus(atendente))).not.toContain(`m${id}`);
    await gravando(admin, (c) => c.query("select imobdesk.tr_modulo_salvar($1)", [{
      id, titulo: "Gatilhos", papel: "atendente", pergunta: "Um gatilho serve para…", opcoes: ["Automatizar", "Apagar tickets"], resposta: 0, status: "publicado" }]));
    expect(codigos(await meus(atendente)).at(-1)).toBe(`m${id}`);
    await recusa(admin, "select imobdesk.tr_modulo_salvar($1)", [{ id, titulo: "Gatilhos", papel: "atendente", pergunta: "Um gatilho serve para…",
      opcoes: ["A", "B"], resposta: 5 }], /check/);
  });

  it("progresso por setor e por pessoa", async () => {
    const setores = await como(admin, (c) => rpc(c, "imobdesk.tr_progresso_por_setor()"));
    const doTi = setores.find((s: { setorId: number }) => s.setorId === ti);
    expect(doTi).toMatchObject({ trilha: "Gestão de Tickets", pessoas: 2, concluiram: 0, andamento: 1, naoComecaram: 1 });
    expect(setores.find((s: { setorId: number | null }) => s.setorId === null)).toMatchObject({ trilha: "Colaborador" });

    const pessoas = await como(admin, (c) => rpc(c, "imobdesk.tr_progresso_pessoas($1)", [ti]));
    expect(pessoas.map((p: { nome: string }) => p.nome)).toEqual(["Bruno Lima", "Marina Costa"]);
    expect(pessoas[0].modulos.find((m: { titulo: string }) => m.titulo.startsWith("Visão geral")).concluidoEm).not.toBeNull();
  });
});
