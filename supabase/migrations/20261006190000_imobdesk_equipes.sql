-- Configurações › Usuários › Equipes (pedido e decisões do Wagner, 06/10/2026).
-- Equipe = grupo de atendentes dentro de um setor (ou "sem setor", equipe interna); um usuário pode estar em
-- várias equipes; líder opcional. Servirá para direcionar o chamado no processo de ticket.
-- Permissões: seção `manage_users_equipes` (tela Equipes) e `manage_users` (campo Equipes no Editar usuário).
-- Só aditiva. Leitura e escrita só por RPC.

create table if not exists imobdesk.at_equipes (
  id              bigint      generated always as identity primary key,
  nome            text        not null check (length(btrim(nome)) between 2 and 60),
  setor_id        bigint      references imobdesk.at_setores (id) on delete set null,
  descricao       text        check (length(descricao) <= 500),
  lider_id        uuid        references imobdesk.usuarios (id) on delete set null,
  ativa           boolean     not null default true,
  criado_em       timestamptz not null default now(),
  atualizado_em   timestamptz not null default now(),
  atualizado_por  uuid
);
-- Nome único dentro do setor (e entre as equipes sem setor).
create unique index if not exists at_equipes_nome_uidx on imobdesk.at_equipes (coalesce(setor_id, 0), lower(btrim(nome)));

create table if not exists imobdesk.at_equipe_membros (
  equipe_id   bigint not null references imobdesk.at_equipes (id) on delete cascade,
  usuario_id  uuid   not null references imobdesk.usuarios (id) on delete cascade,
  primary key (equipe_id, usuario_id)
);
create index if not exists at_equipe_membros_usuario_idx on imobdesk.at_equipe_membros (usuario_id);

do $$
declare
  t text;
begin
  foreach t in array array['at_equipes', 'at_equipe_membros'] loop
    execute format('alter table imobdesk.%I enable row level security', t);
    execute format('revoke all on imobdesk.%I from anon, public, authenticated', t);
    execute format('grant all on imobdesk.%I to service_role', t);
  end loop;
end;
$$;

create or replace function imobdesk.at_pode_equipes()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select imobdesk.tem_permissao('manage_users_equipes') or imobdesk.tem_permissao('manage_users');
$$;

create or replace function imobdesk.at_exigir_equipes()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not imobdesk.at_pode_equipes() then
    perform imobdesk.erro('FORBIDDEN', 'Você não tem permissão para alterar equipes.');
  end if;
  return auth.uid();
end;
$$;

create or replace function imobdesk.at_equipes_lista()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform imobdesk.at_exigir_equipes();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', e.id, 'nome', e.nome, 'setorId', e.setor_id, 'setorNome', s.nome, 'descricao', e.descricao, 'ativa', e.ativa,
      'lider', case when l.id is null then null else jsonb_build_object('id', l.id, 'nome', l.nome, 'email', l.email) end,
      'membros', coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'nome', u.nome, 'email', u.email) order by u.nome)
                           from imobdesk.at_equipe_membros m join imobdesk.usuarios u on u.id = m.usuario_id
                           where m.equipe_id = e.id), '[]')
    ) order by e.ativa desc, s.nome nulls last, e.nome)
    from imobdesk.at_equipes e
    left join imobdesk.at_setores s on s.id = e.setor_id
    left join imobdesk.usuarios l on l.id = e.lider_id
  ), '[]');
end;
$$;

-- Usuários ativos para os seletores de membro e líder.
create or replace function imobdesk.at_equipes_candidatos()
returns table (id uuid, nome text, email text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform imobdesk.at_exigir_equipes();
  return query select u.id, u.nome, u.email from imobdesk.usuarios u where u.status = 'active' order by u.nome;
end;
$$;

-- p: {id?, nome, setorId?, descricao?, liderId?, ativa, membros: [uuid]}. O líder entra como membro.
create or replace function imobdesk.at_equipe_salvar(p jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := imobdesk.at_exigir_equipes();
  v_id bigint := nullif(p ->> 'id', '')::bigint;
  v_nome text := btrim(coalesce(p ->> 'nome', ''));
  v_setor bigint := nullif(p ->> 'setorId', '')::bigint;
  v_lider uuid := nullif(p ->> 'liderId', '')::uuid;
  v_membros uuid[];
  v_antes jsonb;
begin
  if length(v_nome) not between 2 and 60 then
    perform imobdesk.erro('INVALID_INPUT', 'Informe o nome da equipe (2 a 60 letras).', 'nome');
  end if;
  if v_setor is not null and not exists (select 1 from imobdesk.at_setores s where s.id = v_setor) then
    perform imobdesk.erro('INVALID_INPUT', 'Setor não encontrado.', 'setorId');
  end if;
  if exists (select 1 from imobdesk.at_equipes e
             where coalesce(e.setor_id, 0) = coalesce(v_setor, 0) and lower(btrim(e.nome)) = lower(v_nome) and e.id is distinct from v_id) then
    perform imobdesk.erro('DUPLICATE', 'Já existe uma equipe com esse nome neste setor.', 'nome');
  end if;
  select coalesce(array_agg(distinct x::uuid), '{}') into v_membros from jsonb_array_elements_text(coalesce(p -> 'membros', '[]')) x;
  if v_lider is not null and not (v_lider = any (v_membros)) then
    v_membros := v_membros || v_lider;
  end if;
  if exists (select 1 from unnest(v_membros) m where not exists (select 1 from imobdesk.usuarios u where u.id = m and u.status = 'active')) then
    perform imobdesk.erro('INVALID_INPUT', 'Membro precisa ser um usuário ativo do portal.', 'membros');
  end if;

  if v_id is null then
    insert into imobdesk.at_equipes (nome, setor_id, descricao, lider_id, ativa, atualizado_por)
    values (v_nome, v_setor, nullif(btrim(p ->> 'descricao'), ''), v_lider, coalesce((p ->> 'ativa')::boolean, true), v_ator)
    returning id into v_id;
  else
    select to_jsonb(e) || jsonb_build_object('membros', (select coalesce(jsonb_agg(m.usuario_id), '[]') from imobdesk.at_equipe_membros m where m.equipe_id = e.id))
      into v_antes from imobdesk.at_equipes e where e.id = v_id;
    if v_antes is null then
      perform imobdesk.erro('NOT_FOUND', 'Equipe não encontrada.');
    end if;
    update imobdesk.at_equipes set nome = v_nome, setor_id = v_setor, descricao = nullif(btrim(p ->> 'descricao'), ''),
      lider_id = v_lider, ativa = coalesce((p ->> 'ativa')::boolean, ativa), atualizado_em = now(), atualizado_por = v_ator
    where id = v_id;
  end if;
  delete from imobdesk.at_equipe_membros where equipe_id = v_id and not (usuario_id = any (v_membros));
  insert into imobdesk.at_equipe_membros (equipe_id, usuario_id) select v_id, m from unnest(v_membros) m on conflict do nothing;

  perform imobdesk.registrar_auditoria(v_ator, 'usuarios', case when v_antes is null then 'create' else 'update' end,
    format('Equipe "%s" %s', v_nome, case when v_antes is null then 'criada' else 'alterada' end), v_antes,
    jsonb_build_object('nome', v_nome, 'setor', v_setor, 'lider', v_lider, 'membros', to_jsonb(v_membros)), v_id::text);
  return v_id;
end;
$$;

create or replace function imobdesk.at_equipe_excluir(p_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := imobdesk.at_exigir_equipes();
  v_antes jsonb;
begin
  select to_jsonb(e) into v_antes from imobdesk.at_equipes e where e.id = p_id;
  if v_antes is null then
    perform imobdesk.erro('NOT_FOUND', 'Equipe não encontrada.');
  end if;
  delete from imobdesk.at_equipes where id = p_id;
  perform imobdesk.registrar_auditoria(v_ator, 'usuarios', 'delete', format('Equipe "%s" excluída', v_antes ->> 'nome'), v_antes, null, p_id::text);
end;
$$;

-- Campo "Equipes" no Editar usuário: as equipes de um usuário e a troca do conjunto inteiro.
create or replace function imobdesk.at_usuario_equipes(p_usuario uuid)
returns bigint[]
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform imobdesk.at_exigir_equipes();
  return coalesce((select array_agg(m.equipe_id order by m.equipe_id) from imobdesk.at_equipe_membros m where m.usuario_id = p_usuario), '{}');
end;
$$;

create or replace function imobdesk.at_usuario_equipes_salvar(p_usuario uuid, p_equipes bigint[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := imobdesk.at_exigir_equipes();
  v_antes bigint[];
  v_nome text;
begin
  select u.nome into v_nome from imobdesk.usuarios u where u.id = p_usuario;
  if v_nome is null then
    perform imobdesk.erro('NOT_FOUND', 'Usuário não encontrado.');
  end if;
  if exists (select 1 from unnest(coalesce(p_equipes, '{}')) x where not exists (select 1 from imobdesk.at_equipes e where e.id = x)) then
    perform imobdesk.erro('INVALID_INPUT', 'Equipe não encontrada.');
  end if;
  v_antes := coalesce((select array_agg(m.equipe_id order by m.equipe_id) from imobdesk.at_equipe_membros m where m.usuario_id = p_usuario), '{}');
  delete from imobdesk.at_equipe_membros where usuario_id = p_usuario and not (equipe_id = any (coalesce(p_equipes, '{}')));
  -- Quem sai da equipe deixa de ser o líder dela.
  update imobdesk.at_equipes set lider_id = null where lider_id = p_usuario and not (id = any (coalesce(p_equipes, '{}')));
  insert into imobdesk.at_equipe_membros (equipe_id, usuario_id) select x, p_usuario from unnest(coalesce(p_equipes, '{}')) x on conflict do nothing;
  perform imobdesk.registrar_auditoria(v_ator, 'usuarios', 'update', format('Equipes de %s alteradas', v_nome),
    jsonb_build_object('equipes', to_jsonb(v_antes)), jsonb_build_object('equipes', to_jsonb(coalesce(p_equipes, '{}'))), p_usuario::text);
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'imobdesk.at_pode_equipes()', 'imobdesk.at_exigir_equipes()', 'imobdesk.at_equipes_lista()',
    'imobdesk.at_equipes_candidatos()', 'imobdesk.at_equipe_salvar(jsonb)', 'imobdesk.at_equipe_excluir(bigint)',
    'imobdesk.at_usuario_equipes(uuid)', 'imobdesk.at_usuario_equipes_salvar(uuid, bigint[])'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
