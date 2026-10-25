-- Imobdesk Fase 3: as Edge Functions (service_role) passam a saber a empresa de cada chamada.
--  * portalContext: a empresa de quem chama (empresa_de), a mesma regra de empresa_atual() para o usuário logado;
--  * agendamentos: percorrem empresas_ativas() e chamam o banco com o cabeçalho x-empresa-id;
--  * webhooks: a empresa sai do número que recebeu (Zenvia), da sessão do OpenWA ou da mensagem (status da Zenvia);
--  * retorno do Google: a empresa sai do state de uso único.
-- Todas leem por cima da RLS de empresa (dono postgres) e só o service_role executa. Aditiva.

/** Empresa de um login: a escolhida no topo (se ainda tem acesso), o primeiro cadastro ativo ou o domínio do e-mail. */
create or replace function imobdesk.empresa_de(p_usuario uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_empresa uuid;
  v_email text;
begin
  if p_usuario is null then
    return null;
  end if;

  select p.empresa_id into v_empresa
    from imobdesk.usuario_preferencias p
    join imobdesk.empresas e on e.id = p.empresa_id and e.ativa and not e.modelo
   where p.usuario_id = p_usuario
     and (exists (select 1 from imobdesk.usuarios u
                   where u.tenant_id = p.empresa_id and u.id = p_usuario and u.status <> 'inactive')
          or exists (select 1 from imobdesk.admins_wsa a where a.usuario_id = p_usuario));
  if v_empresa is not null then
    return v_empresa;
  end if;

  select u.tenant_id into v_empresa
    from imobdesk.usuarios u
    join imobdesk.empresas e on e.id = u.tenant_id and e.ativa and not e.modelo
   where u.id = p_usuario and u.status <> 'inactive'
   order by u.created_at
   limit 1;
  if v_empresa is not null then
    return v_empresa;
  end if;

  select lower(u.email) into v_email from auth.users u where u.id = p_usuario;
  select e.id into v_empresa
    from imobdesk.empresas e
   where e.ativa and not e.modelo and split_part(v_email, '@', 2) = any (e.dominios_email)
   order by e.created_at
   limit 1;
  return v_empresa;
end;
$$;

-- empresa_atual() passa a usar a mesma regra (uma fonte só).
create or replace function imobdesk.empresa_atual()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_papel text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
                           nullif(current_setting('request.jwt.claim.role', true), ''));
  v_empresa uuid;
begin
  v_empresa := nullif(current_setting('imobdesk.empresa_id', true), '')::uuid;
  if v_empresa is not null or v_papel is null then
    return v_empresa;
  end if;
  if v_papel = 'service_role' then
    return nullif(nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-empresa-id', '')::uuid;
  end if;
  return imobdesk.empresa_de((select auth.uid()));
end;
$$;

create or replace function imobdesk.empresas_ativas()
returns table (id uuid, nome text)
language sql
stable
security definer
set search_path = ''
as $$
  select e.id, e.nome from imobdesk.empresas e where e.ativa and not e.modelo order by e.created_at;
$$;

/** Empresa do número de WhatsApp que recebeu a mensagem (só dígitos; 10 ou 11 dígitos ganham o 55). */
create or replace function imobdesk.empresa_por_numero(p_numero text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select n.tenant_id
    from imobdesk.at_numeros n
    join imobdesk.empresas e on e.id = n.tenant_id and e.ativa and not e.modelo
   where n.numero = (select case when length(d) in (10, 11) then '55' || d else d end
                       from (select regexp_replace(coalesce(p_numero, ''), '\D', '', 'g') d) x)
   order by n.ativo desc, n.id desc
   limit 1;
$$;

create or replace function imobdesk.empresa_por_sessao_openwa(p_sessao text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select n.tenant_id
    from imobdesk.at_numeros n
    join imobdesk.empresas e on e.id = n.tenant_id and e.ativa and not e.modelo
   where n.openwa_sessao = p_sessao
   order by n.ativo desc, n.id desc
   limit 1;
$$;

create or replace function imobdesk.empresa_por_estado_oauth(p_state text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select s.tenant_id from imobdesk.at_email_oauth_estados s where s.state = p_state and s.expira_em >= now();
$$;

/** Status da Zenvia chega só com o id da mensagem enviada. */
create or replace function imobdesk.empresa_por_mensagem_zenvia(p_zenvia_id text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.tenant_id from imobdesk.at_mensagens m where m.zenvia_id = p_zenvia_id order by m.id desc limit 1;
$$;

revoke all on function imobdesk.empresa_de(uuid), imobdesk.empresas_ativas(), imobdesk.empresa_por_numero(text),
  imobdesk.empresa_por_sessao_openwa(text), imobdesk.empresa_por_estado_oauth(text), imobdesk.empresa_por_mensagem_zenvia(text)
  from public, anon, authenticated;
grant execute on function imobdesk.empresa_de(uuid), imobdesk.empresas_ativas(), imobdesk.empresa_por_numero(text),
  imobdesk.empresa_por_sessao_openwa(text), imobdesk.empresa_por_estado_oauth(text), imobdesk.empresa_por_mensagem_zenvia(text)
  to service_role;

-- As funções acima ficam com o postgres (lista de aplicar_multiempresa atualizada).
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
    'empresa_por_mensagem_zenvia'];
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

notify pgrst, 'reload schema';
