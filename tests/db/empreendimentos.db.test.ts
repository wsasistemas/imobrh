// Empreendimentos (migration 20261012100000, docs/PLANO-empreendimentos-cftv.md) contra um Postgres real com todas
// as migrations: cadastro só Admin, fila e registro da IA (limiar, sugestões, histórico), escolha manual e o
// App do solicitante exigindo o empreendimento no CFTV.
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser, startTestDb, type TestDb } from "./pgHarness";

let db: TestDb;
let svc: pg.Client;
let admin: string;
let operador: string;
let cftv: number;
let ti: number;

/** Sessão de link de e-mail: confiável sem passar pelo gateway (ver security.db.test.ts). */
const sessoes = new Map<string, string>();
const claims = (user: string) => ({ role: "authenticated", sub: user, session_id: sessoes.get(user), amr: [{ method: "recovery", timestamp: 1 }] });

async function usuario(email: string, perfil: string): Promise<string> {
  const { rows } = await db.admin.query("insert into auth.users (email) values ($1) returning id", [email]);
  await db.admin.query("insert into imobdesk.usuarios (id, email, nome, perfil_key, status) values ($1, $2, $3, $4, 'active')", [rows[0].id, email, `Teste ${perfil}`, perfil]);
  const sid = (await db.admin.query("insert into auth.sessions (user_id) values ($1) returning id", [rows[0].id])).rows[0].id as string;
  sessoes.set(rows[0].id, sid);
  return rows[0].id as string;
}

async function ticket(setor: number, assunto: string, texto: string): Promise<number> {
  const { rows } = await db.admin.query(
    `insert into imobdesk.ch_tickets (assunto, origem, solicitante_nome, setor_id, urgencia_id, status_id)
     values ($1, 'email', 'Fulano', $2, (select id from imobdesk.ch_urgencias order by id limit 1), (select id from imobdesk.ch_status order by ordem limit 1))
     returning id`,
    [assunto, setor],
  );
  await db.admin.query("insert into imobdesk.ch_ticket_acoes (ticket_id, numero, tipo, canal, direcao, autor_nome, texto) values ($1, 1, 'publica', 'email', 'entrada', 'Fulano', $2)", [rows[0].id, texto]);
  return Number(rows[0].id);
}

const idDe = async (nome: string) => Number((await db.admin.query("select id from imobdesk.ch_empreendimentos where nome = $1", [nome])).rows[0].id);

beforeAll(async () => {
  db = await startTestDb(54406);
  svc = await db.connect();
  await svc.query("set role service_role");
  cftv = (await db.admin.query("select id from imobdesk.at_setores where lower(nome) = 'cftv'")).rows[0].id;
  ti = (await db.admin.query("select id from imobdesk.at_setores where lower(nome) = 'ti'")).rows[0].id;
  admin = await usuario("admin.emp@exemplo.com.br", "admin");
  operador = await usuario("oper.emp@exemplo.com.br", "operador");
});

afterAll(async () => {
  await svc?.end().catch(() => {});
  await db?.stop();
});

describe("cadastro", () => {
  it("traz os 81 nomes da Movidesk e o CFTV ligado (app e IA)", async () => {
    const { rows } = await db.admin.query("select count(*)::int as n from imobdesk.ch_empreendimentos");
    expect(rows[0].n).toBe(81);
    const cfg = (await db.admin.query("select pedir_no_app, ia_ligada, limiar from imobdesk.ch_empreendimento_config where setor_id = $1", [cftv])).rows[0];
    expect(cfg).toEqual({ pedir_no_app: true, ia_ligada: true, limiar: 80 });
  });

  it("Admin cria com apelidos; nome repetido é recusado; operador não altera", async () => {
    await asUser(db.admin, claims(admin), async (c) => {
      const { rows } = await c.query("select imobdesk.ch_empreendimento_salvar($1) as id", [{ nome: "  Novo   Teste ", apelidos: ["Novo", " novo ", "x"], cidade: "Rio" }]);
      const lista = (await c.query("select imobdesk.ch_empreendimentos_lista() as r")).rows[0].r;
      const e = lista.empreendimentos.find((x: { id: number }) => x.id === Number(rows[0].id));
      expect({ nome: e.nome, apelidos: e.apelidos, cidade: e.cidade }).toEqual({ nome: "Novo Teste", apelidos: ["Novo"], cidade: "Rio" });
      expect(lista.setores.find((s: { setorId: number }) => s.setorId === Number(cftv))).toMatchObject({ pedirNoApp: true, iaLigada: true, limiar: 80 });
      await expect(c.query("select imobdesk.ch_empreendimento_salvar($1)", [{ nome: "feel nature" }])).rejects.toThrow(/Já existe/);
    });
    await asUser(db.admin, claims(operador), async (c) => {
      await expect(c.query("select imobdesk.ch_empreendimento_salvar($1)", [{ nome: "Hacker" }])).rejects.toThrow(/Só Admin/);
    });
  });

  it("tabelas fechadas para authenticated; a fila da IA só para service_role", async () => {
    await asUser(db.admin, claims(admin), async (c) => {
      await expect(c.query("select * from imobdesk.ch_empreendimentos limit 1")).rejects.toThrow(/permission denied/);
    });
    await asUser(db.admin, claims(admin), async (c) => {
      await expect(c.query("select imobdesk.ch_ia_empreendimentos_pendentes(10)")).rejects.toThrow(/permission denied/);
    });
  });
});

describe("IA", () => {
  it("só o CFTV entra na fila; aplica com confiança ≥ 80 e registra no histórico", async () => {
    const t1 = await ticket(cftv, "Câmera sem imagem", "A câmera 3 da garagem do Wave Surf está apagada.");
    const t2 = await ticket(ti, "Impressora", "Não imprime.");
    const fila = (await svc.query("select imobdesk.ch_ia_empreendimentos_pendentes(50) as f")).rows[0].f as { ticketId: number; empreendimentos: unknown[] }[];
    expect(fila.map((f) => f.ticketId)).toContain(t1);
    expect(fila.map((f) => f.ticketId)).not.toContain(t2);
    expect(fila[0].empreendimentos.length).toBeGreaterThanOrEqual(81);

    const surf = await idDe("ARTE WAVE SURF RESIDENCES");
    const r = (await svc.query("select imobdesk.ch_ia_empreendimento_registrar($1, $2) as r", [t1, { empreendimentoId: surf, confianca: 94, motivo: "Wave Surf", sugestoes: [surf] }])).rows[0].r;
    expect(r.situacao).toBe("aplicado");
    const t = (await db.admin.query("select empreendimento_id, empreendimento_origem from imobdesk.ch_tickets where id = $1", [t1])).rows[0];
    expect({ ...t, empreendimento_id: Number(t.empreendimento_id) }).toEqual({ empreendimento_id: surf, empreendimento_origem: "ia" });
    const ev = (await db.admin.query("select descricao from imobdesk.ch_ticket_eventos where ticket_id = $1 and tipo = 'ia' and descricao like 'Empreendimento%'", [t1])).rows;
    expect(ev[0].descricao).toMatch(/identificado pela IA \(94%\): ARTE WAVE SURF RESIDENCES/);
    const depois = (await svc.query("select imobdesk.ch_ia_empreendimentos_pendentes(50) as f")).rows[0].f as { ticketId: number }[];
    expect(depois.map((f) => f.ticketId)).not.toContain(t1);
  });

  it("abaixo do limiar: não aplica e guarda até 3 sugestões válidas", async () => {
    const t3 = await ticket(cftv, "DVR reiniciando", "O DVR do Arte reinicia toda hora.");
    const [a, b, c, d] = await Promise.all(["CONDOMINIO ARTE WAVE", "CONDOMINIO ARTE DESIGN", "CONDOMINIO ARTE JARDIM", "ARTE WOOD RESIDENCES"].map(idDe));
    const r = (await svc.query("select imobdesk.ch_ia_empreendimento_registrar($1, $2) as r", [t3, { empreendimentoId: a, confianca: 40, sugestoes: [b, 999999, c, d] }])).rows[0].r;
    expect(r.situacao).toBe("baixa_confianca");
    const i = (await db.admin.query("select sugestoes from imobdesk.ch_ticket_ia_empreendimento where ticket_id = $1", [t3])).rows[0];
    expect(i.sugestoes.map(Number)).toEqual([a, b, c]);
    expect((await db.admin.query("select empreendimento_id from imobdesk.ch_tickets where id = $1", [t3])).rows[0].empreendimento_id).toBeNull();

    // Agente escolhe uma sugestão: fica manual, no histórico.
    await asUser(db.admin, claims(admin), async (cl) => {
      const antes = (await cl.query("select imobdesk.ch_ticket_empreendimento($1) as r", [t3])).rows[0].r;
      expect(antes.usa).toBe(true);
      expect(antes.ia.sugestoes.map((s: { id: number }) => s.id)).toEqual([a, b, c]);
      await cl.query("select imobdesk.ch_ticket_empreendimento_definir($1, $2)", [t3, b]);
      const depois = (await cl.query("select imobdesk.ch_ticket_empreendimento($1) as r", [t3])).rows[0].r;
      expect(depois.empreendimento.nome).toBe("CONDOMINIO ARTE DESIGN");
      expect(depois.origem).toBe("manual");
      const ev = (await cl.query("select imobdesk.ch_ticket_empreendimento($1) as r", [t3])).rows[0].r;
      expect(ev.empreendimento.id).toBe(b);
    });
  });

  it("erro conta tentativa; depois de 3 sai da fila", async () => {
    const t4 = await ticket(cftv, "Teste", "Sem nada.");
    for (let i = 0; i < 3; i++) await svc.query("select imobdesk.ch_ia_empreendimento_registrar($1, $2)", [t4, { erro: "falhou" }]);
    const fila = (await svc.query("select imobdesk.ch_ia_empreendimentos_pendentes(50) as f")).rows[0].f as { ticketId: number }[];
    expect(fila.map((f) => f.ticketId)).not.toContain(t4);
  });

  it("ticket criado antes de ligar a IA não entra", async () => {
    const t5 = await ticket(cftv, "Antigo", "Câmera do Nexus.");
    await db.admin.query("update imobdesk.ch_tickets set criado_em = now() - interval '1 day' where id = $1", [t5]);
    const fila = (await svc.query("select imobdesk.ch_ia_empreendimentos_pendentes(50) as f")).rows[0].f as { ticketId: number }[];
    expect(fila.map((f) => f.ticketId)).not.toContain(t5);
  });
});

describe("Lista de Tickets", () => {
  it("ch_lista_extras traz o empreendimento", async () => {
    const t6 = await ticket(cftv, "Lista", "Feel Nature.");
    await db.admin.query("update imobdesk.ch_tickets set empreendimento_id = $2, empreendimento_origem = 'manual' where id = $1", [t6, await idDe("FEEL NATURE")]);
    await asUser(db.admin, claims(admin), async (c) => {
      const x = (await c.query("select imobdesk.ch_lista_extras() as r")).rows[0].r;
      expect(x.tickets[String(t6)].empreendimento).toBe("FEEL NATURE");
    });
  });
});

describe("App do solicitante", () => {
  it("no CFTV exige o empreendimento e grava como escolha do solicitante; na TI não pede", async () => {
    await db.admin.query("update imobdesk.at_setores set cd_visivel = true, ativo = true where id in ($1, $2)", [cftv, ti]);
    const sol = await usuario("solicitante.emp@exemplo.com.br", "solicitante");
    const nature = await idDe("FEEL NATURE");
    await asUser(db.admin, claims(sol), async (c) => {
      await c.query("select imobdesk.cd_entrar(null)");
      const cfg = (await c.query("select imobdesk.cd_setor_empreendimentos($1) as r", [cftv])).rows[0].r;
      expect(cfg.pedir).toBe(true);
      expect(cfg.lista.length).toBeGreaterThanOrEqual(81);
      expect((await c.query("select imobdesk.cd_setor_empreendimentos($1) as r", [ti])).rows[0].r.pedir).toBe(false);

      await c.query("savepoint s");
      await expect(c.query("select imobdesk.cd_ticket_criar($1)", [{ setorId: cftv, descricao: "Câmera apagada" }])).rejects.toThrow(/Escolha o empreendimento/);
      await c.query("rollback to savepoint s");
      const r = (await c.query("select imobdesk.cd_ticket_criar($1) as r", [{ setorId: cftv, empreendimentoId: nature, descricao: "Câmera apagada" }])).rows[0].r;
      expect(r.empreendimento).toBe("FEEL NATURE");
      await c.query("reset role"); // mesma conexão: lê como dono e volta a ser o usuário
      const t = (await c.query("select empreendimento_origem from imobdesk.ch_tickets where id = $1", [r.id])).rows[0];
      await c.query("set local role authenticated");
      expect(t.empreendimento_origem).toBe("solicitante");

      // TI: ignora o empreendimento enviado.
      const r2 = (await c.query("select imobdesk.cd_ticket_criar($1) as r", [{ setorId: ti, empreendimentoId: nature, descricao: "Sem internet" }])).rows[0].r;
      expect(r2.empreendimento).toBeNull();
    });
  });
});
