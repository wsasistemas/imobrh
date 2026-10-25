// Solicitações Financeiras, Fase 1 (migrations 20261017100000–100200, docs/Solicitacoes-financeiras/CONTEXTO.md) contra um
// Postgres real com todas as migrations: cargas iniciais, tabelas fechadas, contexto do usuário (setor e CPF mascarado),
// aba Aprovação financeira do setor, cadastros e a visibilidade com 4 usuários (colaborador, aprovador, financeiro, admin).
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser, startTestDb, type TestDb } from "./pgHarness";

let db: TestDb;
let admin: string;
let colab: string;
let aprov: string;
let fin: string;
let outro: string;
let obra: number;
let financeiro: number;

const sessoes = new Map<string, string>();
const claims = (user: string) => ({ role: "authenticated", sub: user, session_id: sessoes.get(user), amr: [{ method: "recovery", timestamp: 1 }] });

async function usuario(email: string, perfil: string, nome: string): Promise<string> {
  const { rows } = await db.admin.query("insert into auth.users (email) values ($1) returning id", [email]);
  await db.admin.query("insert into imobdesk.usuarios (id, email, nome, perfil_key, status) values ($1, $2, $3, $4, 'active')", [rows[0].id, email, nome, perfil]);
  const sid = (await db.admin.query("insert into auth.sessions (user_id) values ($1) returning id", [rows[0].id])).rows[0].id as string;
  sessoes.set(rows[0].id, sid);
  return rows[0].id as string;
}

/** Pessoa do cadastro de Pessoas ligada ao usuário pelo e-mail. */
async function pessoa(email: string, nome: string, setor: number, cpf: string | null) {
  const { rows } = await db.admin.query("insert into imobdesk.at_pessoas (nome, documento, setor_id) values ($1, $2, $3) returning id", [nome, cpf, setor]);
  await db.admin.query("insert into imobdesk.at_pessoa_contatos (pessoa_id, tipo, valor, principal) values ($1, 'email', $2, true)", [rows[0].id, email]);
}

async function solicitacao(solicitante: string, status: string): Promise<{ id: number; numero: string }> {
  const { rows } = await db.admin.query(
    "insert into imobdesk.sf_solicitacao (tipo, solicitante_id, setor_id, status, total_despesas) values ('reembolso', $1, $2, $3, 100) returning id, numero",
    [solicitante, obra, status],
  );
  return { id: Number(rows[0].id), numero: rows[0].numero as string };
}

const rpc = async (c: pg.Client, sql: string, args: unknown[] = []) => (await c.query(`select ${sql} as r`, args)).rows[0].r;
/** Cada recusa numa transação própria (um erro aborta a transação). */
const recusa = (u: string, sql: string, args: unknown[], erro: RegExp) => asUser(db.admin, claims(u), (c) => expect(c.query(sql, args)).rejects.toThrow(erro));
const numeros = (lista: { numero: string }[]) => lista.map((x) => x.numero).sort();

beforeAll(async () => {
  db = await startTestDb(54420);
  obra = Number((await db.admin.query("select id from imobdesk.at_setores where nome = 'Obra - Arte Wave'")).rows[0].id);
  // O setor Financeiro vem dos dados de produção; aqui ele é criado já marcado (a carga marca o existente).
  financeiro = Number((await db.admin.query("insert into imobdesk.at_setores (nome, sf_financeiro) values ('Financeiro', true) returning id")).rows[0].id);
  admin = await usuario("admin.sf@exemplo.com.br", "admin", "Admin Teste");
  colab = await usuario("colab.sf@exemplo.com.br", "solicitante", "João Silva");
  aprov = await usuario("aprov.sf@exemplo.com.br", "operador", "Marina Costa");
  fin = await usuario("fin.sf@exemplo.com.br", "operador", "Lúcia Ferraz");
  outro = await usuario("outro.sf@exemplo.com.br", "solicitante", "Outra Pessoa");
  await pessoa("colab.sf@exemplo.com.br", "João Silva", obra, "12345678900");
  await pessoa("fin.sf@exemplo.com.br", "Lúcia Ferraz", financeiro, null);
  await pessoa("aprov.sf@exemplo.com.br", "Marina Costa", obra, null);
});

afterAll(async () => {
  await db?.stop();
});

describe("cargas iniciais e acesso", () => {
  it("traz as 17 regras, as 10 categorias e as obras marcadas", async () => {
    const r = (await db.admin.query("select string_agg(codigo, ',' order by codigo) as c from imobdesk.sf_regra")).rows[0].c;
    expect(r).toBe("A01,A02,A03,A04,A05,A06,A07,R01,R02,R03,R04,R05,R06,R07,R08,R09,R10");
    expect((await db.admin.query("select count(*)::int as n from imobdesk.sf_categoria_motivo")).rows[0].n).toBe(10);
    expect((await db.admin.query("select sf_setor_obra from imobdesk.at_setores where id = $1", [obra])).rows[0].sf_setor_obra).toBe(true);
  });

  it("tabelas sf_ fechadas para authenticated, até para o Admin; auxiliares não são chamáveis", async () => {
    for (const t of ["sf_solicitacao", "sf_setor_aprovador", "sf_evento", "sf_regra"]) {
      await asUser(db.admin, claims(admin), async (c) => {
        await expect(c.query(`select * from imobdesk.${t} limit 1`)).rejects.toThrow(/permission denied/);
      });
    }
    await asUser(db.admin, claims(colab), async (c) => {
      await expect(c.query("select imobdesk.sf_pode_ver(1)")).rejects.toThrow(/permission denied/);
    });
  });

  it("número SF-AAAA-NNNN sequencial", async () => {
    const a = await solicitacao(outro, "rascunho");
    const b = await solicitacao(outro, "cancelada");
    const ano = new Date().getFullYear();
    expect(a.numero).toMatch(new RegExp(`^SF-${ano}-\\d{4}$`));
    expect(Number(b.numero.slice(-4))).toBe(Number(a.numero.slice(-4)) + 1);
  });
});

describe("contexto do usuário", () => {
  it("colaborador: setor de obra pelo e-mail da pessoa e CPF mascarado", async () => {
    await asUser(db.admin, claims(colab), async (c) => {
      const ctx = await rpc(c, "imobdesk.sf_meu_contexto()");
      expect(ctx).toMatchObject({ nome: "João Silva", cpfMascarado: "***.456.789-**", ehAdmin: false, ehFinanceiro: false });
      expect(ctx.setor).toMatchObject({ id: obra, nome: "Obra - Arte Wave", obra: true, financeiro: false });
    });
  });

  it("financeiro pelo setor; usuário sem pessoa fica sem setor", async () => {
    await asUser(db.admin, claims(fin), async (c) => {
      expect((await rpc(c, "imobdesk.sf_meu_contexto()")).ehFinanceiro).toBe(true);
    });
    await asUser(db.admin, claims(outro), async (c) => {
      expect(await rpc(c, "imobdesk.sf_meu_contexto()")).toMatchObject({ setor: null, cpfMascarado: null });
    });
  });
});

describe("aba Aprovação financeira do setor", () => {
  const config = () => ({
    setorId: obra, obra: true, financeiro: false, modoAprovacao: "sequencial", prazoHoras: 48, acaoPrazoVencido: "escalar",
    prazoComprovacaoDias: 30, acaoComprovacaoVencida: "avisar_bloquear", limiteAdiantamentosAbertos: "",
    reembolso: [
      { papel: "Gestor", aprovadorId: aprov, substitutoId: admin, alcadaMinima: 0 },
      { papel: "Diretor", aprovadorId: admin, alcadaMinima: 5000 },
    ],
    adiantamento: [
      { papel: "planejamento", aprovadorId: admin },
      { papel: "gerente", aprovadorId: aprov },
      { papel: "diretor", aprovadorId: null },
      { papel: "presidente", aprovadorId: null },
    ],
  });

  it("Admin salva e lê de volta, com o gestor do setor como sugestão", async () => {
    await db.admin.query("insert into imobdesk.at_setor_gestores (setor_id, usuario_id) values ($1, $2)", [obra, aprov]);
    await asUser(db.admin, claims(admin), async (c) => {
      await c.query("select imobdesk.sf_setor_config_salvar($1)", [config()]);
      const lido = await rpc(c, "imobdesk.sf_setor_config_obter($1)", [obra]);
      expect(lido).toMatchObject({ podeEditar: true, obra: true, prazoHoras: 48, pessoas: 2, gestores: [{ id: aprov, nome: "Marina Costa" }] });
      expect(lido.aprovadores.map((a: { tipo: string; papel: string; condicao: string }) => `${a.tipo}:${a.papel}:${a.condicao}`)).toEqual([
        "reembolso_fundo_fixo:Gestor:sempre",
        "reembolso_fundo_fixo:Diretor:valor_acima",
        "adiantamento:planejamento:obra",
        "adiantamento:gerente:sempre",
      ]);
      const resumo = (await rpc(c, "imobdesk.sf_setores_resumo()")).find((s: { setorId: number }) => s.setorId === obra);
      expect(resumo).toMatchObject({ niveisReembolso: 2, niveisAdiantamento: 2, obra: true });
    });
  });

  it("valida: diretor sem alçada, substituto igual ao aprovador, papel repetido", async () => {
    const salvar = "select imobdesk.sf_setor_config_salvar($1)";
    await recusa(admin, salvar, [{ ...config(), adiantamento: [{ papel: "diretor", aprovadorId: aprov }] }], /a partir de que valor/);
    await recusa(admin, salvar, [{ ...config(), reembolso: [{ papel: "Gestor", aprovadorId: aprov, substitutoId: aprov }] }], /substituto não pode/);
    await recusa(admin, salvar, [{ ...config(), adiantamento: [{ papel: "gerente", aprovadorId: aprov }, { papel: "gerente", aprovadorId: admin }] }], /duas vezes/);
  });

  it("só Admin altera; quem não vê Setores e números não lê", async () => {
    await asUser(db.admin, claims(aprov), async (c) => {
      await expect(c.query("select imobdesk.sf_setor_config_salvar($1)", [config()])).rejects.toThrow(/Só Admin/);
    });
    await asUser(db.admin, claims(colab), async (c) => {
      await expect(c.query("select imobdesk.sf_setor_config_obter($1)", [obra])).rejects.toThrow(/Sem acesso/);
    });
  });
});

describe("cadastros financeiros", () => {
  it("fundo fixo: o novo valor encerra o anterior", async () => {
    await asUser(db.admin, claims(admin), async (c) => {
      await c.query("select imobdesk.sf_fundo_fixo_salvar($1)", [{ usuarioId: colab, valor: 1000 }]);
      await c.query("select imobdesk.sf_fundo_fixo_salvar($1)", [{ usuarioId: colab, valor: 1500 }]);
      const lista = await rpc(c, "imobdesk.sf_cadastros_lista()");
      expect(lista.fundos.filter((f: { usuarioId: string }) => f.usuarioId === colab)).toEqual([expect.objectContaining({ valor: 1500, setor: "Obra - Arte Wave" })]);
      expect(lista.regras[0].codigo).toBe("R01");
    });
  });

  it("categoria repetida e parâmetro fora da faixa são recusados; colaborador não altera", async () => {
    await recusa(admin, "select imobdesk.sf_categoria_salvar($1)", [{ nome: " epi " }], /Já existe/);
    await recusa(admin, "select imobdesk.sf_regra_salvar($1)", [{ codigo: "R02", parametros: { limiar: 0.3 } }], /50% a 100%/);
    await asUser(db.admin, claims(admin), async (c) => {
      await c.query("select imobdesk.sf_regra_salvar($1)", [{ codigo: "R09", parametros: { dias: 10 } }]);
      const r09 = (await rpc(c, "imobdesk.sf_cadastros_lista()")).regras.find((r: { codigo: string }) => r.codigo === "R09");
      expect(r09.parametros).toEqual({ dias: 10 });
    });
    await asUser(db.admin, claims(colab), async (c) => {
      await expect(c.query("select imobdesk.sf_cadastros_lista()")).rejects.toThrow(/Só Admin/);
    });
  });
});

describe("visibilidade com 4 usuários", () => {
  it("colaborador só as próprias; aprovador onde é etapa; financeiro de em_conferencia em diante; admin tudo", async () => {
    await db.admin.query("delete from imobdesk.sf_solicitacao");
    const rascunho = await solicitacao(colab, "rascunho");
    const emAprovacao = await solicitacao(colab, "em_aprovacao");
    const conferencia = await solicitacao(colab, "em_conferencia");
    const deOutro = await solicitacao(outro, "rascunho");
    await db.admin.query("insert into imobdesk.sf_aprovacao (solicitacao_id, ciclo, nivel, papel, aprovador_id, status) values ($1, 1, 1, 'Gestor', $2, 'aguardando')", [emAprovacao.id, aprov]);

    const ver = (u: string, escopo = "todas") => asUser(db.admin, claims(u), async (c) => numeros(await rpc(c, "imobdesk.sf_solicitacoes_listar($1)", [escopo])));

    expect(await ver(colab)).toEqual([rascunho, emAprovacao, conferencia].map((s) => s.numero).sort());
    expect(await ver(aprov)).toEqual([emAprovacao.numero]);
    expect(await ver(fin)).toEqual([conferencia.numero]);
    expect(await ver(admin)).toEqual([rascunho, emAprovacao, conferencia, deOutro].map((s) => s.numero).sort());
    expect(await ver(outro)).toEqual([deOutro.numero]);
    expect(await ver(fin, "minhas")).toEqual([]);
    expect(await ver(aprov, "aprovacoes")).toEqual([emAprovacao.numero]);
    expect(await ver(admin, "financeiro")).toEqual([conferencia.numero]);
  });

  it("o evento é imutável", async () => {
    const s = await solicitacao(colab, "rascunho");
    const { rows } = await db.admin.query("insert into imobdesk.sf_evento (solicitacao_id, tipo) values ($1, 'criada') returning id", [s.id]);
    await expect(db.admin.query("update imobdesk.sf_evento set tipo = 'x' where id = $1", [rows[0].id])).rejects.toThrow(/imutável/);
  });
});
