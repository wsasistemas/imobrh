-- Login: sessao_atual_confiavel() devolvia false para sessão válida ("Sua sessão expirou" logo após entrar).
--
-- Causa: no Supabase as tabelas do auth têm RLS ligada e nenhuma policy. O postgres tem BYPASSRLS e lia tudo;
-- desde a 90_multiempresa, security_sessao_valida é do imobdesk_dono (sem BYPASSRLS), que vê auth.sessions vazia.
--
-- security_sessao_valida volta ao postgres: só lê auth.sessions e security_sessions (global, sem empresa), então
-- ignorar a RLS não mistura empresas. A lista do aplicar_multiempresa() ganha o nome, senão a próxima passada
-- devolveria a função ao dono.
--
-- Pendente (outra fase): as demais funções do dono que leem auth.users/auth.sessions também recebem vazio.

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
    'criar_empresa', 'listar_empresas_wsa', 'encerrar_sessao', 'security_password_verification_hook',
    'empresa_de', 'empresas_ativas', 'empresa_por_numero', 'empresa_por_sessao_openwa', 'empresa_por_estado_oauth',
    'empresa_por_mensagem_zenvia', 'security_sessao_valida'];
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

select imobdesk.aplicar_multiempresa();

-- sessao_confiavel() é do dono e chama esta função: sem o grant, "permission denied for function".
grant execute on function imobdesk.security_sessao_valida(uuid, uuid, jsonb) to imobdesk_dono;

select pg_get_userbyid(p.proowner) as dono_security_sessao_valida
  from pg_proc p
 where p.oid = 'imobdesk.security_sessao_valida(uuid, uuid, jsonb)'::regprocedure;
