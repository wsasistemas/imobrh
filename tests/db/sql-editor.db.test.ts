// O pacote do SQL Editor (supabase/sql-editor), na ordem em que vai ser colado no ikvj: as partes da estrutura
// e o script do 1º Super admin, que pode rodar de novo sem duplicar nada.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startTestDb, type TestDb } from "./pgHarness";

let db: TestDb;
beforeAll(async () => {
  db = await startTestDb(54462, { empresa: null, sqlEditor: true });
}, 240_000);
afterAll(async () => db?.stop());

it("as partes criam o mesmo schema das migrations", async () => {
  const { rows } = await db.admin.query(`select count(*)::int n from pg_class where relnamespace = 'imobdesk'::regnamespace and relkind = 'r'`);
  expect(rows[0].n).toBeGreaterThan(90);
});

it("2_primeiro_admin: Super admin da WSA e 1ª empresa com a configuração da Modelo; pode rodar de novo", async () => {
  const script = readFileSync(join(process.cwd(), "supabase", "sql-editor", "2_primeiro_admin.sql"), "utf8");
  await expect(db.admin.query(script)).rejects.toThrow(/não existe no Authentication/);
  await db.admin.query(`insert into auth.users (email) values ('wsasistemas.ia@gmail.com')`);
  await db.admin.query(script);
  await db.admin.query(script);
  const { rows } = await db.admin.query(`
    select e.nome, u.perfil_key, (select count(*)::int from imobdesk.admins_wsa) admins,
           (select count(*)::int from imobdesk.empresas where not modelo) empresas,
           (select count(*)::int from imobdesk.ch_status s where s.tenant_id = e.id) status
      from imobdesk.empresas e join imobdesk.usuarios u on u.tenant_id = e.id where not e.modelo`);
  expect(rows).toEqual([{ nome: "Empresa Piloto", perfil_key: "super_admin", admins: 1, empresas: 1, status: expect.any(Number) }]);
  expect(rows[0].status).toBeGreaterThan(0);
});
