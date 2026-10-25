// Solicitações Financeiras — App Financeiro por perfil, Fase 1 (migration 20261023150000, docs/PLANO-app-financeiro-perfis.md)
// contra um Postgres real: o bloco `acesso` de sf_meu_contexto nos perfis do mockup (colaborador, gestor, Financeiro, Admin),
// o fundo fixo só para gestor (D1, P1) e a carga da permissão Aprovações para quem já aprova (D3).
import { readFileSync } from "node:fs";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser, startTestDb, type TestDb } from "./pgHarness";

let db: TestDb;
let adm: number;
let financeiro: number;
let colab: string;
let gestor: string;
let gestorSemValor: string;
let aprovSemPermissao: string;
let fin: string;
let finForaDoSetor: string;
let admin: string;

const sessoes = new Map<string, string>();
const claims = (user: string) => ({ role: "authenticated", sub: user, session_id: sessoes.get(user), amr: [{ method: "recovery", timestamp: 1 }] });

async function usuario(email: string, perfil: string, nome: string, setor: number): Promise<string> {
  const { rows } = await db.admin.query("insert into auth.users (email) values ($1) returning id", [email]);
  await db.admin.query("insert into imobdesk.usuarios (id, email, nome, perfil_key, status) values ($1, $2, $3, $4, 'active')", [rows[0].id, email, nome, perfil]);
  sessoes.set(rows[0].id, (await db.admin.query("insert into auth.sessions (user_id) values ($1) returning id", [rows[0].id])).rows[0].id as string);
  const p = await db.admin.query("insert into imobdesk.at_pessoas (nome, setor_id) values ($1, $2) returning id", [nome, setor]);
  await db.admin.query("insert into imobdesk.at_pessoa_contatos (pessoa_id, tipo, valor, principal) values ($1, 'email', $2, true)", [p.rows[0].id, email]);
  return rows[0].id as string;
}

const rpc = async (c: pg.Client, sql: string, args: unknown[] = []) => (await c.query(`select ${sql} as r`, args)).rows[0].r;
const como = <T>(u: string, fn: (c: pg.Client) => Promise<T>) => asUser(db.admin, claims(u), fn);
const recusa = (u: string, sql: string, erro: RegExp) => como(u, (c) => expect(c.query(sql)).rejects.toThrow(erro));
const acesso = (u: string) => como(u, async (c) => (await rpc(c, "imobdesk.sf_meu_contexto()")).acesso);

beforeAll(async () => {
  db = await startTestDb(54432);
  adm = Number((await db.admin.query("insert into imobdesk.at_setores (nome) values ('Administrativo Teste') returning id")).rows[0].id);
  financeiro = Number((await db.admin.query("insert into imobdesk.at_setores (nome, sf_financeiro) values ('Financeiro', true) returning id")).rows[0].id);
  colab = await usuario("colab.ac@exemplo.com.br", "operador", "Gustavo Reis", adm);
  gestor = await usuario("gestor.ac@exemplo.com.br", "operador", "Carla Mendes", adm);
  gestorSemValor = await usuario("gestor2.ac@exemplo.com.br", "operador", "Paula Nunes", adm);
  aprovSemPermissao = await usuario("aprov.ac@exemplo.com.br", "ti", "Renato Lopes", adm);
  fin = await usuario("fin.ac@exemplo.com.br", "financeiro", "Ana Lima", financeiro);
  finForaDoSetor = await usuario("fin2.ac@exemplo.com.br", "financeiro", "Bruno Fora", adm);
  admin = await usuario("admin.ac@exemplo.com.br", "admin", "Wagner Antunes", adm);
  await db.admin.query("insert into imobdesk.at_setor_gestores (setor_id, usuario_id) values ($1, $2), ($1, $3)", [adm, gestor, gestorSemValor]);
  await db.admin.query(
    "insert into imobdesk.sf_setor_aprovador (setor_id, tipo_solicitacao, ordem, papel, aprovador_id, substituto_id, condicao, alcada_minima) values ($1, 'reembolso_fundo_fixo', 1, 'Gestor', $2, $3, 'sempre', 0)",
    [adm, gestor, aprovSemPermissao],
  );
  await db.admin.query("insert into imobdesk.sf_fundo_fixo (usuario_id, valor) values ($1, 800), ($2, 500)", [gestor, colab]);
  // D3: a carga da migration roda de novo aqui, agora que há aprovadores (no banco vazio ela não marca nada).
  const sql = readFileSync("supabase/migrations/20261023150000_imobdesk_sf_acesso_perfil.sql", "utf8");
  const carga = sql.match(/insert into imobdesk\.profile_permissions[\s\S]*?do nothing;/);
  await db.admin.query("delete from imobdesk.profile_permissions where permission_id = 'sf_aprovacoes'");
  await db.admin.query("insert into imobdesk.profile_permissions (role, permission_id, enabled) values ('ti', 'sf_aprovacoes', false)");
  // A migration é anterior à multiempresa: a chave única agora começa por tenant_id.
  await db.admin.query(carga![0].replace(/on conflict \(/i, "on conflict (tenant_id, "));
});

afterAll(async () => {
  await db?.stop();
});

describe("carga da permissão Aprovações (D3)", () => {
  it("marca o perfil de quem aprova; perfil com a tela desligada fica como está", async () => {
    const { rows } = await db.admin.query(
      "select role, enabled from imobdesk.profile_permissions where permission_id = 'sf_aprovacoes' order by role",
    );
    expect(rows).toEqual([{ role: "operador", enabled: true }, { role: "ti", enabled: false }]);
  });
});

describe("bloco acesso de sf_meu_contexto", () => {
  it("colaborador: só reembolso e adiantamento", async () => {
    expect(await acesso(colab)).toEqual({
      reembolso: true, fundoFixo: false, temValorFundo: true, adiantamento: true, adiantamentoBloqueio: null,
      aprovacoes: false, conferencia: false, cadastros: false,
    });
  });

  it("gestor aprovador: fundo fixo e Aprovações", async () => {
    expect(await acesso(gestor)).toMatchObject({ fundoFixo: true, temValorFundo: true, aprovacoes: true, conferencia: false, cadastros: false });
    expect((await como(gestor, (c) => rpc(c, "imobdesk.sf_meu_contexto()"))).ehGestor).toBe(true);
  });

  it("gestor sem valor cadastrado: fundo fixo sem valor", async () => {
    expect(await acesso(gestorSemValor)).toMatchObject({ fundoFixo: true, temValorFundo: false, aprovacoes: false });
  });

  it("substituto sem a permissão no perfil não recebe Aprovações", async () => {
    expect((await acesso(aprovSemPermissao)).aprovacoes).toBe(false);
  });

  it("substituto por período vigente recebe Aprovações", async () => {
    await db.admin.query("insert into imobdesk.sf_substituicao (aprovador_id, substituto_id, de, ate) values ($1, $2, current_date, current_date)", [gestor, colab]);
    try {
      expect((await acesso(colab)).aprovacoes).toBe(true);
    } finally {
      await db.admin.query("delete from imobdesk.sf_substituicao");
    }
  });

  it("Conferência: setor financeiro e permissão; a permissão sozinha não basta", async () => {
    expect(await acesso(fin)).toMatchObject({ conferencia: true, aprovacoes: false, cadastros: false });
    expect((await acesso(finForaDoSetor)).conferencia).toBe(false);
  });

  it("Admin recebe tudo, menos o fundo fixo (não é gestor)", async () => {
    expect(await acesso(admin)).toMatchObject({ reembolso: true, adiantamento: true, aprovacoes: true, conferencia: true, cadastros: true, fundoFixo: false });
  });

  it("adiantamento bloqueado com comprovação vencida, com o motivo", async () => {
    await db.admin.query("update imobdesk.at_setores set sf_acao_comprovacao_vencida = 'avisar_bloquear' where id = $1", [adm]);
    const { rows } = await db.admin.query(
      "insert into imobdesk.sf_solicitacao (tipo, solicitante_id, setor_id, status, total_despesas, prazo_comprovacao) values ('adiantamento', $1, $2, 'comprovacao_pendente', 100, current_date - 1) returning id",
      [colab, adm],
    );
    try {
      const a = await acesso(colab);
      expect(a.adiantamento).toBe(false);
      expect(a.adiantamentoBloqueio).toMatch(/comprovação vencida/);
    } finally {
      await db.admin.query("delete from imobdesk.sf_solicitacao where id = $1", [rows[0].id]);
    }
  });
});

describe("fundo fixo só para gestor (D1, P1)", () => {
  it("quem não é gestor é recusado, mesmo com valor cadastrado; sf_minhas não oferece o cartão", async () => {
    await recusa(colab, "select imobdesk.sf_rascunho_criar('fundo_fixo')", /só para o gestor do setor/);
    expect(await como(colab, (c) => rpc(c, "imobdesk.sf_minhas()"))).toMatchObject({ temFundoFixo: false, ehGestor: false });
  });

  it("gestor sem valor é recusado com o caminho do cadastro", async () => {
    await recusa(gestorSemValor, "select imobdesk.sf_rascunho_criar('fundo_fixo')", /Cadastros financeiros › Fundo fixo/);
  });

  it("gestor com valor cria a prestação com o saldo inicial", async () => {
    await como(gestor, async (c) => {
      expect(await rpc(c, "imobdesk.sf_minhas()")).toMatchObject({ temFundoFixo: true, ehGestor: true });
      const d = await rpc(c, "imobdesk.sf_detalhe($1)", [await rpc(c, "imobdesk.sf_rascunho_criar('fundo_fixo')")]);
      expect([Number(d.valorFundoFixo), Number(d.saldoInicial)]).toEqual([800, 800]);
    });
  });

  it("Cadastros mostra quem tem fundo e não é gestor", async () => {
    const lista = await como(admin, (c) => rpc(c, "imobdesk.sf_cadastros_lista()"));
    expect(lista.fundos.map((f: { usuario: string; ehGestor: boolean }) => [f.usuario, f.ehGestor])).toEqual([["Carla Mendes", true], ["Gustavo Reis", false]]);
  });

  it("auxiliares não são chamáveis", async () => {
    await recusa(colab, `select imobdesk.sf_eh_gestor('${colab}')`, /permission denied/);
    await recusa(colab, `select imobdesk.sf_eh_aprovador('${colab}')`, /permission denied/);
  });
});
