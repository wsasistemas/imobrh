// Ensaio do schema imobdesk (Supabase ikvj da WSA): migrations de supabase/migrations num Postgres 17
// de verdade, com a separação por empresa (tenant_id + RLS forçada + funções do imobdesk_dono).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { asUser, startTestDb, type TestDb } from "./pgHarness";

const MODELO = "00000000-0000-0000-0000-000000000001";
let db: TestDb;
let q: (sql: string, params?: unknown[]) => Promise<Record<string, any>[]>;

const ids = {} as Record<"wsa" | "adminA" | "adminB" | "duplo" | "solicitante" | "outroSistema", string>;
const empresa = {} as Record<"A" | "B", string>;

const sessoes = new Map<string, string>();
// Como o PostgREST com o JWT de uma sessão registrada (sessao_confiavel exige session_id e amr).
const comoUsuario = <T>(uid: string, fn: (c: pg.Client) => Promise<T>) =>
  asUser(db.admin, { sub: uid, role: "authenticated", session_id: sessoes.get(uid), amr: [{ method: "password", timestamp: 1 }] }, fn);
const um = async (c: pg.Client, sql: string, params?: unknown[]) => (await c.query(sql, params)).rows[0];
const erroDe = async (uid: string, sql: string, params?: unknown[]) => {
  try {
    await comoUsuario(uid, (c) => c.query(sql, params));
    return "";
  } catch (error) {
    return (error as Error).message;
  }
};

async function novoLogin(email: string) {
  const id = (await q(`insert into auth.users (email) values ($1) returning id`, [email]))[0].id as string;
  const sid = (await q(`insert into auth.sessions (user_id) values ($1) returning id`, [id]))[0].id;
  // Sessão aprovada pelo gateway de login (portal-auth), como em produção.
  await q(`insert into imobdesk.security_sessions (session_id, user_id) values ($1, $2)`, [sid, id]);
  sessoes.set(id, sid);
  return id;
}

/** Cadastro direto (como o SQL editor), no contexto de uma empresa. */
async function cadastrar(tenant: string, uid: string, email: string, perfil: string) {
  await db.admin.query("begin");
  await db.admin.query("select set_config('imobdesk.empresa_id', $1, true)", [tenant]);
  await db.admin.query(`insert into imobdesk.usuarios (id, email, nome, perfil_key, status) values ($1, $2, $3, $4, 'active')`, [uid, email, `Usuário ${email}`, perfil]);
  await db.admin.query("commit");
}

beforeAll(async () => {
  db = await startTestDb(54460, { empresa: null });
  q = async (sql, params) => (await db.admin.query(sql, params)).rows;
  ids.outroSistema = await novoLogin("alguem@outro-sistema.com");
  ids.wsa = await novoLogin("wsasistemas.ia@gmail.com");
  await q(`insert into imobdesk.admins_wsa (usuario_id) values ($1)`, [ids.wsa]);
  empresa.A = await comoUsuario(ids.wsa, async (c) => {
    const id = (await um(c, `select imobdesk.criar_empresa('Construtora Alfa', '{alfa.com.br}') id`)).id;
    await c.query("commit");
    await c.query("begin");
    return id;
  });
  empresa.B = await comoUsuario(ids.wsa, async (c) => {
    const id = (await um(c, `select imobdesk.criar_empresa('Imobiliária Beta', '{beta.com.br}') id`)).id;
    await c.query("commit");
    await c.query("begin");
    return id;
  });
  ids.adminA = await novoLogin("admin@alfa.com.br");
  ids.adminB = await novoLogin("admin@beta.com.br");
  ids.duplo = await novoLogin("consultor@wsa.com.br");
  ids.solicitante = await novoLogin("maria@alfa.com.br");
  await cadastrar(empresa.A, ids.adminA, "admin@alfa.com.br", "admin");
  await cadastrar(empresa.B, ids.adminB, "admin@beta.com.br", "admin");
  await cadastrar(empresa.A, ids.duplo, "consultor@wsa.com.br", "admin");
  await cadastrar(empresa.B, ids.duplo, "consultor@wsa.com.br", "operador");
}, 240_000);
afterAll(async () => db?.stop());

describe("estrutura", () => {
  it("nada no public e anon fora do schema", async () => {
    const pub = await q(`select count(*)::int n from pg_class where relnamespace = 'public'::regnamespace`);
    expect(pub[0].n).toBe(0);
    expect((await q(`select has_schema_privilege('anon', 'imobdesk', 'usage') u`))[0].u).toBe(false);
  });

  it("toda tabela do app tem tenant_id, RLS forçada e a policy restritiva", async () => {
    const falhas = await q(`
      select c.relname from pg_class c
       where c.relnamespace = 'imobdesk'::regnamespace and c.relkind = 'r'
         and c.relname not in ('empresas','admins_wsa','usuario_preferencias') and c.relname !~ '^security_'
         and (not c.relforcerowsecurity
              or not exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id' and a.attnotnull)
              or not exists (select 1 from pg_policies p where p.schemaname = 'imobdesk' and p.tablename = c.relname
                               and p.policyname = 'imobdesk_tenant' and p.permissive = 'RESTRICTIVE'))`);
    expect(falhas.map((f) => f.relname)).toEqual([]);
  });

  it("chaves primárias, únicas e estrangeiras incluem tenant_id", async () => {
    const semTenant = await q(`
      select c.conrelid::regclass::text t, c.conname from pg_constraint c join pg_class r on r.oid = c.conrelid
       where c.connamespace = 'imobdesk'::regnamespace and c.contype in ('p','u','f')
         and (c.contype <> 'f' or c.confrelid::regclass::text like 'imobdesk.%')
         and r.relname not in ('empresas','admins_wsa','usuario_preferencias') and r.relname !~ '^security_'
         and not exists (select 1 from pg_attribute a where a.attrelid = c.conrelid and a.attname = 'tenant_id' and a.attnum = any (c.conkey))`);
    expect(semTenant.map((s) => `${s.t}.${s.conname}`)).toEqual([]);
  });

  // security_sessao_valida lê auth.sessions, que tem RLS sem policy no Supabase: só o postgres (BYPASSRLS) enxerga.
  it("funções: só as de empresa, o hook do Auth, a que escreve e a que lê sessões no auth ficam com o postgres", async () => {
    const doPostgres = await q(`select p.proname from pg_proc p where p.pronamespace = 'imobdesk'::regnamespace
                                  and pg_get_userbyid(p.proowner) <> 'imobdesk_dono' order by 1`);
    expect(doPostgres.map((f) => f.proname)).toEqual([
      "aplicar_multiempresa", "criar_empresa", "dominio_permitido", "eh_admin_wsa", "empresa_atual", "empresa_copiar_modelo",
      "empresa_de", "empresa_por_estado_oauth", "empresa_por_mensagem_zenvia", "empresa_por_numero", "empresa_por_sessao_openwa",
      "empresas_ativas", "encerrar_sessao", "listar_empresas_wsa", "minhas_empresas", "minhas_preferencias", "para_cada_empresa",
      "salvar_tema", "security_password_verification_hook", "security_sessao_valida", "trocar_empresa",
    ]);
    expect((await q(`select rolbypassrls b from pg_roles where rolname = 'imobdesk_dono'`))[0].b).toBe(false);
  });

  it("sem trava de domínio fixo, buckets e agendamentos com prefixo", async () => {
    const travaDominio = await q(`select proname from pg_proc where pronamespace = 'imobdesk'::regnamespace and prosrc ~* 'like ''%@'`);
    expect(travaDominio).toEqual([]);
    const buckets = await q(`select id from storage.buckets order by 1`);
    expect(buckets.every((b) => b.id.startsWith("imobdesk-"))).toBe(true);
    const jobs = await q(`select jobname, command from cron.job order by 1`);
    const urls = jobs.flatMap((j) => (j.command as string).match(/https:\/\/[a-z]+\.supabase\.co/g) ?? []);
    expect(jobs.every((j) => j.jobname.startsWith("imobdesk-"))).toBe(true);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u === "https://ikvjaowvpvxojvcfwnct.supabase.co")).toBe(true);
    const porEmpresa = jobs.filter((j) => /para_cada_empresa/.test(j.command)).map((j) => j.jobname);
    expect(porEmpresa).toEqual(["imobdesk-gatilhos-5min", "imobdesk-gerencial-alertas", "imobdesk-sf-comprovacao", "imobdesk-sf-prazos"]);
  });
});

describe("empresas", () => {
  it("empresa nova recebe a configuração da Modelo com os mesmos ids, sem cadastros nem empreendimentos", async () => {
    const cont = async (tabela: string, tenant: string) => (await q(`select count(*)::int n from imobdesk.${tabela} where tenant_id = $1`, [tenant]))[0].n;
    for (const tabela of ["perfis", "profile_permissions", "ch_status", "ch_urgencias", "ch_visoes", "at_setores", "tr_modulos"]) {
      expect(await cont(tabela, empresa.A), tabela).toBe(await cont(tabela, MODELO));
    }
    expect(await cont("ch_empreendimentos", empresa.A)).toBe(0);
    const iguais = await q(`select count(*)::int n from imobdesk.ch_status a join imobdesk.ch_status m on m.id = a.id and m.nome = a.nome
                             where a.tenant_id = $1 and m.tenant_id = $2`, [empresa.A, MODELO]);
    expect(iguais[0].n).toBe(await cont("ch_status", MODELO));
  });

  it("quem cria a empresa entra nela como Super admin; os outros não criam", async () => {
    const perfil = await comoUsuario(ids.wsa, async (c) => {
      await c.query(`select imobdesk.trocar_empresa($1)`, [empresa.A]);
      return (await um(c, `select imobdesk.perfil_usuario_atual() p`)).p;
    });
    expect(perfil).toBe("super_admin");
    expect(await erroDe(ids.adminA, `select imobdesk.criar_empresa('Gama')`)).toMatch(/Super admin da WSA/);
  });

  it("login em duas empresas troca pelo seletor; o perfil é o de cada empresa", async () => {
    const r = await comoUsuario(ids.duplo, async (c) => {
      const lista = (await c.query(`select nome, perfil from imobdesk.minhas_empresas() order by nome`)).rows;
      await c.query(`select imobdesk.trocar_empresa($1)`, [empresa.B]);
      const emB = (await um(c, `select imobdesk.perfil_usuario_atual() p, imobdesk.empresa_atual() e`));
      await c.query(`select imobdesk.trocar_empresa($1)`, [empresa.A]);
      const emA = (await um(c, `select imobdesk.perfil_usuario_atual() p`)).p;
      return { lista, emB, emA };
    });
    expect(r.lista).toEqual([{ nome: "Construtora Alfa", perfil: "admin" }, { nome: "Imobiliária Beta", perfil: "operador" }]);
    expect(r.emB).toEqual({ p: "operador", e: empresa.B });
    expect(r.emA).toBe("admin");
    expect(await erroDe(ids.adminA, `select imobdesk.trocar_empresa($1)`, [empresa.B])).toMatch(/não tem acesso/);
  });

  it("solicitante sem cadastro cai na empresa do domínio; login de outro sistema não cai em nenhuma", async () => {
    const sol = await comoUsuario(ids.solicitante, (c) => um(c, `select imobdesk.empresa_atual() e, imobdesk.perfil_usuario_atual() p`));
    expect(sol).toEqual({ e: empresa.A, p: null });
    const fora = await comoUsuario(ids.outroSistema, (c) => um(c, `select imobdesk.empresa_atual() e, imobdesk.dominio_permitido('alguem@outro-sistema.com') d`));
    expect(fora).toEqual({ e: null, d: false });
  });

  it("aparência fica salva no login", async () => {
    const tema = await comoUsuario(ids.adminA, async (c) => {
      await c.query(`select imobdesk.salvar_tema('escuro')`);
      return (await um(c, `select imobdesk.minhas_preferencias() p`)).p;
    });
    expect(tema).toMatchObject({ tema: "escuro", empresaId: empresa.A, empresaNome: "Construtora Alfa", adminWsa: false });
  });
});

describe("isolamento entre empresas", () => {
  it("tabelas: cada admin lê só a própria empresa (e nada da Modelo)", async () => {
    const usuariosA = await comoUsuario(ids.adminA, async (c) => (await c.query(`select email from imobdesk.usuarios order by 1`)).rows.map((u) => u.email));
    expect(usuariosA).toEqual(["admin@alfa.com.br", "consultor@wsa.com.br", "wsasistemas.ia@gmail.com"]);
    const outro = await comoUsuario(ids.outroSistema, (c) => um(c, `select count(*)::int n from imobdesk.usuarios`));
    expect(outro.n).toBe(0);
  });

  it("RPC security definer grava na empresa de quem chama e não vê a outra", async () => {
    const setor = await comoUsuario(ids.wsa, async (c) => {
      await c.query(`select imobdesk.trocar_empresa($1)`, [empresa.A]);
      const id = (await um(c, `select imobdesk.at_setor_salvar('{"nome":"Suporte Alfa"}') id`)).id;
      await c.query("commit");
      await c.query("begin");
      return id;
    });
    const dono = await q(`select tenant_id from imobdesk.at_setores where nome = 'Suporte Alfa'`);
    expect(dono).toEqual([{ tenant_id: empresa.A }]);
    const vistoPorB = await comoUsuario(ids.adminB, (c) => um(c, `select count(*)::int n from imobdesk.at_setores where nome = 'Suporte Alfa'`));
    expect(vistoPorB.n).toBe(0);
    // Mesmo nome em outra empresa é permitido (o único é por empresa).
    await cadastrar(empresa.B, ids.wsa, "wsasistemas.ia@gmail.com", "super_admin").catch(() => db.admin.query("rollback"));
    const emB = await comoUsuario(ids.wsa, async (c) => {
      await c.query(`select imobdesk.trocar_empresa($1)`, [empresa.B]);
      return (await um(c, `select imobdesk.at_setor_salvar('{"nome":"Suporte Alfa"}') id`)).id;
    });
    expect(Number(emB)).toBeGreaterThan(Number(setor));
  });

  it("ON CONFLICT reescrito: permissões do perfil por empresa", async () => {
    await comoUsuario(ids.adminA, (c) => c.query(`select imobdesk.salvar_permissoes_perfil('operador', '[{"id":"view_audit_logs","enabled":true}]')`).then(() => c.query("commit")).then(() => c.query("begin")));
    const r = await q(`select tenant_id, enabled from imobdesk.profile_permissions where role = 'operador' and permission_id = 'view_audit_logs' order by tenant_id = $1 desc`, [empresa.A]);
    const deA = r.find((x) => x.tenant_id === empresa.A);
    const deB = r.find((x) => x.tenant_id === empresa.B);
    expect(deA?.enabled).toBe(true);
    expect(deB?.enabled ?? false).toBe(false);
  });

  it("segredo do Vault por empresa", async () => {
    const token = "TokenAlfa_1234567890abcdef";
    await comoUsuario(ids.wsa, async (c) => {
      await c.query(`select imobdesk.trocar_empresa($1)`, [empresa.A]);
      await c.query(`select imobdesk.at_zenvia_salvar_token($1)`, [token]);
      await c.query("commit");
      await c.query("begin");
    });
    const nomes = (await q(`select name from vault.secrets where name like 'imobdesk_zenvia_token%'`)).map((s) => s.name);
    expect(nomes).toEqual([`imobdesk_zenvia_token_${empresa.A}`]);
    const configB = await q(`select token_segredo_id from imobdesk.at_config where tenant_id = $1`, [empresa.B]);
    expect(configB[0].token_segredo_id).toBeNull();
  });

  it("Edge Function (service_role) escolhe a empresa pelo cabeçalho x-empresa-id", async () => {
    const r = await asUser(db.admin, { role: "service_role" }, async (c) => {
      await c.query(`select set_config('request.headers', $1, true)`, [JSON.stringify({ "x-empresa-id": empresa.B })]);
      return um(c, `select imobdesk.empresa_atual() e`);
    });
    expect(r.e).toBe(empresa.B);
  });

  it("agendamento roda uma vez por empresa", async () => {
    const n = await q(`select imobdesk.para_cada_empresa('imobdesk.ch_gatilhos_tempo') n`);
    expect(n[0].n).toBe(2);
    await expect(q(`select imobdesk.para_cada_empresa('imobdesk.x(); drop table y')`)).rejects.toThrow(/inválida/);
  });
});

describe("Edge Functions descobrem a empresa", () => {
  const comoServico = <T>(fn: (c: pg.Client) => Promise<T>) => asUser(db.admin, { role: "service_role" }, fn);

  it("empresa_de: a mesma regra do usuário logado (seletor, cadastro, domínio)", async () => {
    const r = await comoServico((c) => um(c, `select imobdesk.empresa_de($1) duplo, imobdesk.empresa_de($2) sol, imobdesk.empresa_de($3) fora`,
      [ids.duplo, ids.solicitante, ids.outroSistema]));
    expect(r.duplo).not.toBeNull();
    expect(r.sol).toBe(empresa.A);
    expect(r.fora).toBeNull();
    const lista = await comoServico(async (c) => (await c.query(`select nome from imobdesk.empresas_ativas()`)).rows.map((e) => e.nome));
    expect(lista).toEqual(expect.arrayContaining(["Construtora Alfa", "Imobiliária Beta"]));
    expect(lista).not.toContain("Modelo");
  });

  it("webhook: número de WhatsApp, sessão do OpenWA e state do Google levam à empresa certa", async () => {
    await db.admin.query("begin");
    await db.admin.query("select set_config('imobdesk.empresa_id', $1, true)", [empresa.B]);
    const setor = (await db.admin.query(`select id from imobdesk.at_setores order by id limit 1`)).rows[0].id;
    await db.admin.query(`insert into imobdesk.at_numeros (setor_id, numero, openwa_sessao) values ($1, '5521999990002', 'sessao-beta')`, [setor]);
    const conta = (await db.admin.query(`insert into imobdesk.at_email_contas (nome, email) values ('Suporte Beta', 'suporte@beta.com.br') returning id`)).rows[0].id;
    await db.admin.query(`insert into imobdesk.at_email_oauth_estados (state, conta_id, usuario_id, retorno) values ('st-beta', $1, $2, 'https://x.y')`, [conta, ids.adminB]);
    await db.admin.query("commit");
    const r = await comoServico((c) => um(c, `select imobdesk.empresa_por_numero('(21) 99999-0002') num, imobdesk.empresa_por_sessao_openwa('sessao-beta') ses,
      imobdesk.empresa_por_estado_oauth('st-beta') st, imobdesk.empresa_por_numero('5511000000000') nada`));
    expect(r).toEqual({ num: empresa.B, ses: empresa.B, st: empresa.B, nada: null });
  });

  it("só o service_role descobre empresas", async () => {
    expect(await erroDe(ids.adminA, `select imobdesk.empresas_ativas()`)).toMatch(/permission denied/);
    expect(await erroDe(ids.adminA, `select imobdesk.empresa_de($1)`, [ids.adminB])).toMatch(/permission denied/);
  });
});
