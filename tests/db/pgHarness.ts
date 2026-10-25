// Postgres 17 de verdade (embedded-postgres) com o mínimo do Supabase para aplicar TODAS as
// migrations do portal: papéis, auth.users/sessions, auth.uid()/jwt(), vault e storage.
// Usado só pelos testes de banco (npm run test:db). Não toca no Supabase compartilhado.
import EmbeddedPostgres from "embedded-postgres";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

const SUPABASE_STUB = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create role supabase_auth_admin nologin;
create role authenticator noinherit login;
grant anon, authenticated, service_role to authenticator;

create schema auth;
create schema extensions;
create schema vault;
create schema storage;
create extension pgcrypto with schema extensions;
grant usage on schema auth, extensions, storage to anon, authenticated, service_role;

create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  email_confirmed_at timestamptz,
  last_sign_in_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table auth.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  refreshed_at timestamp,
  user_agent text,
  ip inet,
  not_after timestamptz
);

-- Mesmas definições do Supabase.
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''), nullif(current_setting('request.jwt.claims', true), ''))::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
$$;
create function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'))::text
$$;
grant execute on all functions in schema auth to anon, authenticated, service_role;

create table vault.secrets (
  id uuid primary key default gen_random_uuid(),
  name text unique,
  description text not null default '',
  secret text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create view vault.decrypted_secrets as select s.*, s.secret as decrypted_secret from vault.secrets s;
create function vault.create_secret(new_secret text, new_name text default null, new_description text default '', new_key_id uuid default null)
returns uuid language sql as $$
  insert into vault.secrets (secret, name, description) values (new_secret, new_name, coalesce(new_description, '')) returning id
$$;
create function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null, new_description text default null, new_key_id uuid default null)
returns void language sql as $$
  update vault.secrets set secret = coalesce(new_secret, secret), name = coalesce(new_name, name),
    description = coalesce(new_description, description), updated_at = now() where id = secret_id
$$;

create table storage.buckets (
  id text primary key, name text not null, public boolean default false, file_size_limit bigint,
  allowed_mime_types text[], owner uuid, created_at timestamptz default now(), updated_at timestamptz default now()
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets (id), name text,
  owner uuid, metadata jsonb, created_at timestamptz default now(), updated_at timestamptz default now()
);
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable as $$
  select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1]
$$;
grant execute on function storage.foldername(text) to anon, authenticated, service_role;

create publication supabase_realtime;

-- pg_cron e pg_net: só a assinatura (os testes não executam agendamentos nem HTTP).
create schema cron;
create table cron.job (jobid bigserial primary key, jobname text unique, schedule text, command text);
create function cron.schedule(job_name text, schedule text, command text) returns bigint language sql as $$
  insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command
  returning jobid
$$;
create function cron.unschedule(job_name text) returns boolean language sql as $$
  with d as (delete from cron.job where jobname = job_name returning 1) select exists (select 1 from d)
$$;
create schema net;
create function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb,
  headers jsonb default '{}'::jsonb, timeout_milliseconds integer default 5000) returns bigint language sql as $$ select 1::bigint $$;
`;

export interface TestDb {
  /** Conexão "postgres" (dono das funções), como o SQL editor do Supabase. */
  admin: pg.Client;
  /** Abre uma conexão nova (para testes de concorrência). */
  connect(): Promise<pg.Client>;
  stop(): Promise<void>;
}

/** Empresa Modelo do Imobdesk (imobdesk.empresas). */
export const EMPRESA_MODELO = "00000000-0000-0000-0000-000000000001";

/**
 * `empresa`: contexto fixo (imobdesk.empresa_id) em todas as conexões, para os testes de um módulo rodarem numa
 * empresa só, sem montar empresas e cadastros. Padrão: a Modelo. `null` deixa sem contexto (teste de multiempresa).
 * `sqlEditor`: aplica as partes de supabase/sql-editor (1_estrutura_parte*.sql), como no ikvj, em vez das migrations.
 */
export async function startTestDb(port: number, opcoes: { empresa?: string | null; sqlEditor?: boolean } = {}): Promise<TestDb> {
  const empresa = opcoes.empresa === undefined ? EMPRESA_MODELO : opcoes.empresa;
  const dir = join(tmpdir(), `portal-sec-db-${port}-${Date.now()}`);
  const server = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "postgres", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
  await server.initialise();
  await server.start();
  await server.createDatabase("portal");

  const conectar = async () => {
    const client = new pg.Client({ host: "localhost", port, user: "postgres", password: "postgres", database: "portal" });
    await client.connect();
    return client;
  };
  const connect = async () => {
    const client = await conectar();
    if (empresa) await client.query("select set_config('imobdesk.empresa_id', $1, false)", [empresa]);
    return client;
  };

  const admin = await conectar();
  await admin.query(SUPABASE_STUB);
  const migrationsDir = join(process.cwd(), "supabase", opcoes.sqlEditor ? "sql-editor" : "migrations");
  const ordem = (nome: string) => Number(nome.match(/parte(\d+)/)?.[1] ?? 0);
  const arquivos = opcoes.sqlEditor
    ? readdirSync(migrationsDir).filter((name) => /^1_estrutura_parte\d+\.sql$/.test(name)).sort((a, b) => ordem(a) - ordem(b))
    : readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();
  for (const file of arquivos) {
    try {
      await admin.query(readFileSync(join(migrationsDir, file), "utf8"));
    } catch (error) {
      throw new Error(`Migration ${file} falhou: ${(error as Error).message}`);
    }
  }
  if (empresa) await admin.query("select set_config('imobdesk.empresa_id', $1, false)", [empresa]);

  return {
    admin,
    connect,
    async stop() {
      await admin.end().catch(() => {});
      await server.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Executa `fn` como o PostgREST faria para um usuário logado: papel `authenticated` e claims do JWT
 * em request.jwt.claims, dentro de uma transação desfeita no fim.
 */
export async function asUser<T>(client: pg.Client, claims: Record<string, unknown>, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  await client.query("begin");
  try {
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    await client.query(`set local role ${claims.role === "service_role" ? "service_role" : claims.role === "anon" ? "anon" : "authenticated"}`);
    return await fn(client);
  } finally {
    await client.query("rollback");
  }
}
