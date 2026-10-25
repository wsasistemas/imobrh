-- Imobdesk multiempresa (decisão P1 de 23/10/2026): várias empresas no mesmo schema, separadas por tenant_id.
--
-- Como funciona:
--  * toda tabela do app (menos as globais abaixo) ganha tenant_id = imobdesk.empresas.id, com default
--    imobdesk.empresa_atual(); as linhas que já existiam (carga inicial das migrations) ficam na empresa Modelo;
--  * chaves primárias, únicas e estrangeiras passam a incluir tenant_id. Por isso a cópia da Modelo para uma
--    empresa nova mantém os mesmos ids, e as configurações em JSON (visões, gatilhos, kanban) seguem válidas;
--  * RLS forçada com a policy RESTRITIVA imobdesk_tenant (tenant_id = empresa_atual()) em todas as tabelas;
--  * tabelas e funções passam ao papel imobdesk_dono, que não ignora a RLS: dentro das funções security
--    definer a empresa também é filtrada, sem reescrever as ~500 funções do portal.
--
-- Migrations futuras que criarem tabela ou função no schema terminam com: select imobdesk.aplicar_multiempresa();
-- (a coluna "tenant_id" evita confusão com at_pessoa_relacoes.empresa_id, que é a empresa de uma pessoa no cadastro).

grant create on schema imobdesk to imobdesk_dono;

-- Acesso do dono aos objetos do Supabase usados pelas funções (o postgres repassa só leitura do auth e o Vault).
do $$
declare
  v_cmd text;
begin
  foreach v_cmd in array array[
    'grant usage on schema auth, extensions, storage, vault to imobdesk_dono',
    'grant select on auth.users, auth.sessions to imobdesk_dono',
    'grant select, delete on vault.secrets, vault.decrypted_secrets to imobdesk_dono',
    'grant execute on function vault.create_secret(text, text, text, uuid), vault.update_secret(uuid, text, text, text, uuid) to imobdesk_dono',
    'grant select on storage.objects to imobdesk_dono',
    -- Só no banco de ensaio (no Supabase o create_secret/update_secret já é security definer).
    'grant insert, update on vault.secrets to imobdesk_dono'
  ] loop
    begin
      execute v_cmd;
    exception when others then
      raise notice 'imobdesk: % (%)', v_cmd, sqlerrm;
    end;
  end loop;
end;
$$;

create or replace function imobdesk.aplicar_multiempresa()
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_modelo constant uuid := '00000000-0000-0000-0000-000000000001';
  v_globais constant text[] := array['empresas', 'admins_wsa', 'usuario_preferencias', 'security_attempts', 'security_auth_control',
    'security_config', 'security_events', 'security_ip_blocks', 'security_secret', 'security_sessions'];
  -- Funções que ficam com o postgres: leem por cima da RLS de empresa de propósito, escrevem no auth ou são
  -- chamadas pelo Auth (hook). Cada uma filtra a empresa por conta própria.
  v_do_postgres constant text[] := array['empresa_atual', 'dominio_permitido', 'eh_admin_wsa', 'aplicar_multiempresa',
    'para_cada_empresa', 'empresa_copiar_modelo', 'minhas_empresas', 'trocar_empresa', 'minhas_preferencias', 'salvar_tema',
    'criar_empresa', 'listar_empresas_wsa', 'encerrar_sessao', 'security_password_verification_hook'];
  t record;
  k record;
  v_fks jsonb := '[]'::jsonb;
  v_def text;
  v_cols text;
  v_tabelas int := 0;
begin
  -- 1. tenant_id nas tabelas que ainda não têm (default constante: preenche sem disparar gatilhos).
  for t in
    select c.relname from pg_class c
     where c.relnamespace = 'imobdesk'::regnamespace and c.relkind = 'r' and not (c.relname = any (v_globais))
       and not exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped)
  loop
    execute format('alter table imobdesk.%I add column tenant_id uuid not null default %L', t.relname, v_modelo);
    execute format('alter table imobdesk.%I alter column tenant_id set default imobdesk.empresa_atual()', t.relname);
    execute format('alter table imobdesk.%I add constraint %I foreign key (tenant_id) references imobdesk.empresas (id) on delete cascade',
      t.relname, left(t.relname, 50) || '_tenant_fk');
    v_tabelas := v_tabelas + 1;
  end loop;

  -- 2. Chaves estrangeiras entre tabelas do app sem tenant_id: guarda e remove (voltam compostas no passo 5).
  for k in
    select c.conname, c.conrelid::regclass::text tabela, pg_get_constraintdef(c.oid) def
      from pg_constraint c
      join pg_class r on r.oid = c.confrelid
     where c.contype = 'f' and c.connamespace = 'imobdesk'::regnamespace
       and r.relnamespace = 'imobdesk'::regnamespace and not (r.relname = any (v_globais))
       and not exists (select 1 from pg_attribute a where a.attrelid = c.conrelid and a.attname = 'tenant_id' and a.attnum = any (c.conkey))
  loop
    v_fks := v_fks || jsonb_build_object('tabela', k.tabela, 'nome', k.conname, 'def', k.def);
    execute format('alter table %s drop constraint %I', k.tabela, k.conname);
  end loop;

  -- 3. Primárias e únicas passam a valer por empresa.
  for k in
    select c.conname, c.conrelid::regclass::text tabela, pg_get_constraintdef(c.oid) def
      from pg_constraint c
      join pg_class r on r.oid = c.conrelid
     where c.contype in ('p', 'u') and c.connamespace = 'imobdesk'::regnamespace and not (r.relname = any (v_globais))
       and not exists (select 1 from pg_attribute a where a.attrelid = c.conrelid and a.attname = 'tenant_id' and a.attnum = any (c.conkey))
  loop
    execute format('alter table %s drop constraint %I', k.tabela, k.conname);
    execute format('alter table %s add constraint %I %s', k.tabela, k.conname, regexp_replace(k.def, '\(', '(tenant_id, '));
  end loop;

  -- 4. Índices únicos soltos (parciais e por expressão) também.
  for k in
    select i.indexrelid::regclass::text idx, pg_get_indexdef(i.indexrelid) def
      from pg_index i
      join pg_class r on r.oid = i.indrelid
     where r.relnamespace = 'imobdesk'::regnamespace and i.indisunique and not (r.relname = any (v_globais))
       and not exists (select 1 from pg_constraint x where x.conindid = i.indexrelid)
       and not exists (select 1 from pg_attribute a where a.attrelid = i.indrelid and a.attname = 'tenant_id' and a.attnum = any (i.indkey::int2[]))
  loop
    execute format('drop index %s', k.idx);
    execute regexp_replace(k.def, 'USING (\w+) \(', 'USING \1 (tenant_id, ');
  end loop;

  -- 5. Estrangeiras de volta, compostas. SET NULL só nas colunas próprias (tenant_id é NOT NULL).
  --    DEFERRABLE INITIALLY IMMEDIATE: mesmo comportamento de antes, mas a cópia da Modelo pode adiar a checagem.
  for k in select * from jsonb_to_recordset(v_fks) as x(tabela text, nome text, def text)
  loop
    v_cols := substring(k.def from '^FOREIGN KEY \(([^)]*)\)');
    v_def := regexp_replace(k.def, '^FOREIGN KEY \(([^)]*)\) REFERENCES ([^(]+)\(([^)]*)\)',
                            'FOREIGN KEY (tenant_id, \1) REFERENCES \2(tenant_id, \3)');
    v_def := regexp_replace(v_def, 'ON DELETE SET (NULL|DEFAULT)', 'ON DELETE SET \1 (' || v_cols || ')');
    if v_def !~ 'DEFERRABLE' then
      v_def := v_def || ' DEFERRABLE INITIALLY IMMEDIATE';
    end if;
    execute format('alter table %s add constraint %I %s', k.tabela, k.nome, v_def);
  end loop;

  -- 6. RLS forçada: a restritiva vale para todos (inclusive o dono); a permissiva do dono libera as funções.
  for t in
    select c.relname from pg_class c
     where c.relnamespace = 'imobdesk'::regnamespace and c.relkind = 'r' and not (c.relname = any (v_globais))
  loop
    execute format('alter table imobdesk.%I enable row level security, force row level security', t.relname);
    execute format('drop policy if exists imobdesk_tenant on imobdesk.%I', t.relname);
    execute format('create policy imobdesk_tenant on imobdesk.%I as restrictive for all to public
                      using (tenant_id = (select imobdesk.empresa_atual())) with check (tenant_id = (select imobdesk.empresa_atual()))', t.relname);
    execute format('drop policy if exists imobdesk_dono on imobdesk.%I', t.relname);
    execute format('create policy imobdesk_dono on imobdesk.%I as permissive for all to imobdesk_dono using (true) with check (true)', t.relname);
  end loop;

  -- 7. ON CONFLICT (cols) nas funções: o alvo precisa incluir tenant_id (as tabelas security_* são globais).
  for k in
    select p.oid, pg_get_functiondef(p.oid) def
      from pg_proc p
     where p.pronamespace = 'imobdesk'::regnamespace and p.prokind = 'f'
       and p.prosrc ~* 'on conflict \((?!tenant_id|user_hash|session_id|ip_hash)'
  loop
    execute regexp_replace(k.def, 'on conflict \((?!tenant_id|user_hash|session_id|ip_hash)', 'on conflict (tenant_id, ', 'gi');
  end loop;

  -- 8. Dono: tabelas (e as sequências delas) e funções passam ao imobdesk_dono, menos as de v_do_postgres.
  for t in select c.relname from pg_class c where c.relnamespace = 'imobdesk'::regnamespace and c.relkind = 'r'
  loop
    execute format('alter table imobdesk.%I owner to imobdesk_dono', t.relname);
  end loop;
  for k in
    select p.oid::regprocedure::text fn, p.proname, pg_get_userbyid(p.proowner) dono
      from pg_proc p where p.pronamespace = 'imobdesk'::regnamespace
  loop
    if k.proname = any (v_do_postgres) then
      if k.dono <> 'postgres' then
        execute format('alter function %s owner to postgres', k.fn);
      end if;
    elsif k.dono <> 'imobdesk_dono' then
      execute format('alter function %s owner to imobdesk_dono', k.fn);
    end if;
  end loop;

  return format('%s tabela(s) nova(s) com tenant_id; %s chave(s) estrangeira(s) refeita(s).', v_tabelas, jsonb_array_length(v_fks));
end;
$$;

revoke all on function imobdesk.aplicar_multiempresa() from public, anon, authenticated, service_role;

-- 1ª passada: estrutura por empresa (as funções abaixo já usam tenant_id).
select imobdesk.aplicar_multiempresa();

-- Encerrar sessão escreve no auth.sessions (o dono não pode): fica com o postgres e confere a empresa aqui.
create or replace function imobdesk.encerrar_sessao(p_sessao uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := (select auth.uid());
  v_sessao record;
begin
  if not imobdesk.tem_permissao_de(v_ator, 'manage_sessions') then
    perform imobdesk.erro('FORBIDDEN', 'Você não tem permissão para esta ação.');
  end if;
  select s.id, s.user_agent, u.nome into v_sessao
  from auth.sessions s join imobdesk.usuarios u on u.id = s.user_id and u.tenant_id = imobdesk.empresa_atual()
  where s.id = p_sessao;
  if v_sessao.id is null then
    perform imobdesk.erro('NOT_FOUND', 'Sessão não encontrada ou já encerrada.');
  end if;
  if p_sessao::text = (select auth.jwt() ->> 'session_id') then
    perform imobdesk.erro('SELF_ACTION', 'Você não pode encerrar a sua própria sessão por aqui.');
  end if;

  delete from auth.sessions where id = p_sessao;  -- os refresh tokens saem junto (FK em cascata)
  perform imobdesk.registrar_auditoria(v_ator, 'sessoes', 'session_revoked',
    format('Sessão de %s encerrada (%s)', v_sessao.nome, coalesce(v_sessao.user_agent, 'dispositivo desconhecido')), null, null, p_sessao::text);
end;
$$;

-- ============================================================================== empresas

/** Agendamento por empresa: roda a função (sem argumentos) uma vez para cada empresa ativa. */
create or replace function imobdesk.para_cada_empresa(p_funcao text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  e record;
  v_n integer := 0;
begin
  if p_funcao !~ '^imobdesk\.[a-z_][a-z0-9_]*$' then
    raise exception 'Função inválida: %', p_funcao;
  end if;
  for e in select id, nome from imobdesk.empresas where ativa and not modelo order by created_at
  loop
    begin
      perform set_config('imobdesk.empresa_id', e.id::text, true);
      execute format('select %s()', p_funcao);
      v_n := v_n + 1;
    exception when others then
      raise warning 'imobdesk: % falhou na empresa % (%): %', p_funcao, e.nome, e.id, sqlerrm;
    end;
  end loop;
  perform set_config('imobdesk.empresa_id', '', true);
  return v_n;
end;
$$;
revoke all on function imobdesk.para_cada_empresa(text) from public, anon, authenticated, service_role;

/** Copia a configuração da empresa Modelo (mesmos ids) para uma empresa nova. */
create or replace function imobdesk.empresa_copiar_modelo(p_empresa uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_modelo constant uuid := '00000000-0000-0000-0000-000000000001';
  -- Dados de exemplo que ficaram na Modelo: não vão para as empresas clientes.
  v_nao_copiar constant text[] := array['ch_empreendimentos', 'cd_empreendimentos_cache', 'usuarios', 'audit_logs'];
  t record;
  v_cols text;
  v_n integer := 0;
  v_linhas integer;
begin
  perform set_config('imobdesk.empresa_id', p_empresa::text, true);
  set constraints all deferred;
  for t in
    select c.oid, c.relname from pg_class c
     where c.relnamespace = 'imobdesk'::regnamespace and c.relkind = 'r'
       and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id')
       and not (c.relname = any (v_nao_copiar))
     order by c.relname
  loop
    select string_agg(quote_ident(a.attname), ', ' order by a.attnum) into v_cols
      from pg_attribute a
     where a.attrelid = t.oid and a.attnum > 0 and not a.attisdropped and a.attgenerated = '' and a.attname <> 'tenant_id';
    -- "on conflict do nothing" pula o que um gatilho já criou (ex.: horários do setor); o Postgres não o aceita
    -- em tabela com única adiável (perfis.ordem, tr_passos), que não tem gatilho desses.
    execute format('insert into imobdesk.%I (tenant_id, %s) overriding system value select %L, %s from imobdesk.%I where tenant_id = %L %s',
      t.relname, v_cols, p_empresa, v_cols, t.relname, v_modelo,
      case when exists (select 1 from pg_constraint k where k.conrelid = t.oid and k.contype in ('p', 'u') and k.condeferrable)
           then '' else 'on conflict do nothing' end);
    get diagnostics v_linhas = row_count;
    v_n := v_n + v_linhas;
  end loop;
  set constraints all immediate;
  return v_n;
end;
$$;
revoke all on function imobdesk.empresa_copiar_modelo(uuid) from public, anon, authenticated, service_role;

/** Empresas em que o login entra (cadastro ativo), com a atual marcada. Super admin WSA vê todas. */
create or replace function imobdesk.minhas_empresas()
returns table (id uuid, nome text, slug text, perfil text, atual boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select e.id, e.nome, e.slug, u.perfil_key, e.id = imobdesk.empresa_atual()
    from imobdesk.empresas e
    left join imobdesk.usuarios u on u.tenant_id = e.id and u.id = (select auth.uid()) and u.status <> 'inactive'
   where e.ativa and not e.modelo and (u.id is not null or imobdesk.eh_admin_wsa())
   order by e.nome;
$$;

create or replace function imobdesk.trocar_empresa(p_empresa uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    perform imobdesk.erro('FORBIDDEN', 'Entre no sistema para trocar de empresa.');
  end if;
  if not exists (select 1 from imobdesk.minhas_empresas() m where m.id = p_empresa) then
    perform imobdesk.erro('FORBIDDEN', 'Você não tem acesso a esta empresa.');
  end if;
  insert into imobdesk.usuario_preferencias as p (usuario_id, empresa_id) values (v_uid, p_empresa)
  on conflict on constraint usuario_preferencias_pkey do update set empresa_id = excluded.empresa_id, updated_at = now();
end;
$$;

create or replace function imobdesk.minhas_preferencias()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'tema', coalesce((select p.tema from imobdesk.usuario_preferencias p where p.usuario_id = (select auth.uid())), 'claro'),
    'empresaId', imobdesk.empresa_atual(),
    'empresaNome', (select e.nome from imobdesk.empresas e where e.id = imobdesk.empresa_atual()),
    'adminWsa', imobdesk.eh_admin_wsa());
$$;

create or replace function imobdesk.salvar_tema(p_tema text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    perform imobdesk.erro('FORBIDDEN', 'Entre no sistema para salvar a aparência.');
  end if;
  if p_tema is null or p_tema not in ('claro', 'escuro', 'auto') then
    perform imobdesk.erro('INVALID_INPUT', 'Aparência inválida.', 'tema');
  end if;
  insert into imobdesk.usuario_preferencias as p (usuario_id, tema) values ((select auth.uid()), p_tema)
  on conflict on constraint usuario_preferencias_pkey do update set tema = excluded.tema, updated_at = now();
end;
$$;

/** Só o Super admin da WSA: cria a empresa, copia a Modelo e entra nela como Super admin. */
create or replace function imobdesk.criar_empresa(p_nome text, p_dominios text[] default '{}', p_admin_email text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_nome text := regexp_replace(btrim(coalesce(p_nome, '')), '\s+', ' ', 'g');
  v_base text;
  v_slug text;
  v_i integer := 1;
  v_id uuid;
  v_email text;
  v_dominios text[];
  v_admin record;
begin
  if not imobdesk.eh_admin_wsa() then
    perform imobdesk.erro('FORBIDDEN', 'Só o Super admin da WSA cria empresas.');
  end if;
  if length(v_nome) not between 2 and 80 then
    perform imobdesk.erro('INVALID_INPUT', 'O nome da empresa deve ter de 2 a 80 caracteres.', 'nome');
  end if;
  select coalesce(array_agg(distinct lower(btrim(d))) filter (where btrim(d) <> ''), '{}') into v_dominios from unnest(coalesce(p_dominios, '{}')) d;
  if exists (select 1 from unnest(v_dominios) d where d !~ '^[a-z0-9.-]+\.[a-z]{2,}$') then
    perform imobdesk.erro('INVALID_INPUT', 'Domínio inválido. Use só o domínio, como suaempresa.com.br.', 'dominios');
  end if;

  v_base := trim(both '-' from regexp_replace(translate(lower(v_nome), 'áàâãäéèêëíìîïóòôõöúùûüçñ', 'aaaaaeeeeiiiiooooouuuucn'), '[^a-z0-9]+', '-', 'g'));
  v_base := left(coalesce(nullif(v_base, ''), 'empresa'), 36);
  v_slug := v_base;
  while exists (select 1 from imobdesk.empresas e where e.slug = v_slug) loop
    v_i := v_i + 1;
    v_slug := v_base || '-' || v_i;
  end loop;

  insert into imobdesk.empresas (nome, slug, dominios_email, criado_por) values (v_nome, v_slug, v_dominios, v_uid) returning id into v_id;
  perform imobdesk.empresa_copiar_modelo(v_id);

  perform set_config('imobdesk.empresa_id', v_id::text, true);
  select lower(u.email) into v_email from auth.users u where u.id = v_uid;
  insert into imobdesk.usuarios (id, email, nome, perfil_key, status)
  values (v_uid, v_email, coalesce(nullif(btrim((select u.raw_user_meta_data ->> 'nome' from auth.users u where u.id = v_uid)), ''), 'Super admin WSA'),
          'super_admin', 'active');
  if nullif(btrim(p_admin_email), '') is not null and lower(btrim(p_admin_email)) <> v_email then
    select u.id, lower(u.email) email into v_admin from auth.users u where lower(u.email) = lower(btrim(p_admin_email));
    if v_admin.id is not null then
      insert into imobdesk.usuarios (id, email, nome, perfil_key, status)
      values (v_admin.id, v_admin.email, split_part(v_admin.email, '@', 1), 'admin', 'active');
    end if;
  end if;
  perform set_config('imobdesk.empresa_id', '', true);

  insert into imobdesk.usuario_preferencias as p (usuario_id, empresa_id) values (v_uid, v_id)
  on conflict on constraint usuario_preferencias_pkey do update set empresa_id = excluded.empresa_id, updated_at = now();
  return v_id;
end;
$$;

create or replace function imobdesk.listar_empresas_wsa()
returns table (id uuid, nome text, slug text, dominios text[], ativa boolean, usuarios integer, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not imobdesk.eh_admin_wsa() then
    perform imobdesk.erro('FORBIDDEN', 'Só o Super admin da WSA vê as empresas.');
  end if;
  return query
    select e.id, e.nome, e.slug, e.dominios_email, e.ativa,
           (select count(*)::int from imobdesk.usuarios u where u.tenant_id = e.id and u.status <> 'inactive'), e.created_at
      from imobdesk.empresas e where not e.modelo order by e.nome;
end;
$$;

revoke all on function imobdesk.minhas_empresas(), imobdesk.trocar_empresa(uuid), imobdesk.minhas_preferencias(),
  imobdesk.salvar_tema(text), imobdesk.criar_empresa(text, text[], text), imobdesk.listar_empresas_wsa() from public, anon;
grant execute on function imobdesk.minhas_empresas(), imobdesk.trocar_empresa(uuid), imobdesk.minhas_preferencias(),
  imobdesk.salvar_tema(text), imobdesk.criar_empresa(text, text[], text), imobdesk.listar_empresas_wsa() to authenticated;

-- ============================================================================== aplica

-- 2ª passada: só acerta o dono das funções criadas acima (o resto já está feito).
select imobdesk.aplicar_multiempresa();

-- Agendamentos que chamam funções do banco: uma vez por empresa. Os que chamam Edge Function seguem únicos
-- (a função percorre as empresas, Fase 3).
do $$
declare
  j record;
begin
  for j in
    select jobname, schedule, substring(command from 'select (imobdesk\.[a-z_]+)\(\)') funcao
      from cron.job
     where jobname like 'imobdesk-%' and command ~ '^\s*select imobdesk\.[a-z_]+\(\)\s*;?\s*$'
  loop
    perform cron.schedule(j.jobname, j.schedule, format('select imobdesk.para_cada_empresa(%L)', j.funcao));
  end loop;
end;
$$;

notify pgrst, 'reload schema';
