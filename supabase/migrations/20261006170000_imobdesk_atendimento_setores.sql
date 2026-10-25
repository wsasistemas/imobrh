-- Gestão de Atendimento — F2 (1/3): setores, números WhatsApp, equipe, horários e configuração do canal.
-- Tudo separado por setor (adendo de 06/10/2026): cada número pertence a um setor; cada atendente a um
-- setor; cada setor tem os seus gestores; horário, mensagens automáticas e regras da fila são do setor.
-- Só aditiva. Leitura pela RLS; escrita só pelas RPCs abaixo (security definer + auditoria).
--
-- Permissões (mesmos ids do src/config/menuRegistry.ts):
--   gestao_atendimento_central     seção Central de atendimento
--   gestao_atendimento_fila        seção Fila e horários
--   gestao_atendimento_setores     seção Setores e números
--   gestao_atendimento_monitor     ação: Monitor e gestão, só nos setores em que a pessoa é gestora
--   gestao_atendimento_supervisao  ação: supervisão geral (todos os setores)

-- ---------- Configuração do canal (linha única) ----------
create table if not exists imobdesk.at_config (
  id                boolean     primary key default true check (id),
  ligado            boolean     not null default false,      -- respostas automáticas ligadas
  trava_piloto      boolean     not null default true,       -- só os telefones do piloto recebem resposta automática
  telefones_piloto  text[]      not null default '{}',
  token_segredo_id  uuid,                                     -- token da Zenvia no Vault (F3)
  token_mascara     text,
  token_definido_em timestamptz,
  verificacao       jsonb,                                    -- último "testar conexão"
  atualizado_em     timestamptz not null default now(),
  atualizado_por    uuid
);
insert into imobdesk.at_config (id) values (true) on conflict (id) do nothing;

-- ---------- Setores ----------
create table if not exists imobdesk.at_setores (
  id                          bigint      generated always as identity primary key,
  nome                        text        not null check (length(btrim(nome)) between 2 and 60),
  ativo                       boolean     not null default true,
  msg_boas_vindas             text        not null default 'Olá! Recebemos sua mensagem e em instantes alguém da nossa equipe vai te atender. 🙂'
                                          check (length(msg_boas_vindas) between 1 and 1000),
  msg_fora_horario            text        not null default 'Recebemos sua mensagem! Estamos fora do horário de atendimento. Assim que abrirmos, falamos com você.'
                                          check (length(msg_fora_horario) between 1 and 1000),
  msg_encerramento            text        not null default 'Atendimento encerrado. Se precisar de algo, é só mandar uma nova mensagem. Obrigado!'
                                          check (length(msg_encerramento) between 1 and 1000),
  limite_simultaneo           int         not null default 5 check (limite_simultaneo between 1 and 50),
  atendente_sem_resposta_min  int         not null default 30 check (atendente_sem_resposta_min between 5 and 1440),
  encerrar_apos_horas         int         not null default 23 check (encerrar_apos_horas between 1 and 23),
  alerta_fila_min             int         not null default 15 check (alerta_fila_min between 1 and 240),
  alerta_cliente_min          int         not null default 5 check (alerta_cliente_min between 1 and 240),
  criado_em                   timestamptz not null default now(),
  atualizado_em               timestamptz not null default now(),
  atualizado_por              uuid
);
create unique index if not exists at_setores_nome_uidx on imobdesk.at_setores (lower(btrim(nome)));

-- Número WhatsApp (remetente na Zenvia). Um número é de um setor só; ao sair do setor fica inativo
-- (as conversas antigas continuam apontando para ele).
create table if not exists imobdesk.at_numeros (
  id          bigint      generated always as identity primary key,
  setor_id    bigint      not null references imobdesk.at_setores (id),
  numero      text        not null unique check (numero ~ '^\d{12,13}$'),
  ativo       boolean     not null default true,
  verificacao jsonb,                                   -- {em, naConta, erro} do último teste (F3)
  criado_em   timestamptz not null default now()
);
create index if not exists at_numeros_setor_idx on imobdesk.at_numeros (setor_id);

create table if not exists imobdesk.at_setor_gestores (
  setor_id   bigint not null references imobdesk.at_setores (id) on delete cascade,
  usuario_id uuid   not null references imobdesk.usuarios (id) on delete cascade,
  primary key (setor_id, usuario_id)
);
create index if not exists at_setor_gestores_usuario_idx on imobdesk.at_setor_gestores (usuario_id);

-- Atendente: pertence a um setor só.
create table if not exists imobdesk.at_atendentes (
  usuario_id          uuid        primary key references imobdesk.usuarios (id) on delete cascade,
  setor_id            bigint      not null references imobdesk.at_setores (id),
  apto                boolean     not null default true,   -- desligado na folga
  pausa               boolean     not null default false,  -- online, mas sem receber da fila
  online_em           timestamptz,                         -- último sinal da Central aberta
  ultimo_recebido_em  timestamptz,                         -- rodízio: recebe quem está há mais tempo sem receber
  criado_em           timestamptz not null default now()
);
create index if not exists at_atendentes_setor_idx on imobdesk.at_atendentes (setor_id);

-- Horário do setor (0 = domingo, como extract(dow)). Avaliado no fuso America/Sao_Paulo.
create table if not exists imobdesk.at_horarios (
  setor_id bigint  not null references imobdesk.at_setores (id) on delete cascade,
  dia      int     not null check (dia between 0 and 6),
  aberto   boolean not null default true,
  abre     time    not null default '08:00',
  fecha    time    not null default '18:00',
  primary key (setor_id, dia),
  check (fecha > abre)
);

-- Setor novo nasce com segunda a sexta, 8h às 18h; sábado e domingo fechados.
create or replace function imobdesk.at_setor_horarios_padrao()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into imobdesk.at_horarios (setor_id, dia, aberto, abre, fecha)
  select new.id, d, d between 1 and 5, '08:00', case when d = 6 then '13:00'::time else '18:00'::time end
  from generate_series(0, 6) d
  on conflict do nothing;
  return new;
end;
$$;
drop trigger if exists at_setores_horarios_padrao on imobdesk.at_setores;
create trigger at_setores_horarios_padrao after insert on imobdesk.at_setores
  for each row execute function imobdesk.at_setor_horarios_padrao();

-- ---------- Quem vê e quem gerencia cada setor ----------
create or replace function imobdesk.at_supervisor()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select imobdesk.tem_permissao('gestao_atendimento_supervisao');
$$;

create or replace function imobdesk.at_gestor_de(p_setor bigint)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select imobdesk.at_supervisor()
      or (imobdesk.tem_permissao('gestao_atendimento_monitor')
          and exists (select 1 from imobdesk.at_setor_gestores g where g.setor_id = p_setor and g.usuario_id = auth.uid()));
$$;

create or replace function imobdesk.at_membro_de(p_setor bigint)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select imobdesk.at_gestor_de(p_setor)
      or (imobdesk.tem_permissao('gestao_atendimento_central')
          and exists (select 1 from imobdesk.at_atendentes a where a.setor_id = p_setor and a.usuario_id = auth.uid()));
$$;

do $$
declare
  t text;
begin
  foreach t in array array['at_config', 'at_setores', 'at_numeros', 'at_setor_gestores', 'at_atendentes', 'at_horarios'] loop
    execute format('alter table imobdesk.%I enable row level security', t);
    execute format('revoke all on imobdesk.%I from anon, public', t);
    execute format('revoke insert, update, delete, truncate on imobdesk.%I from authenticated', t);
    execute format('grant select on imobdesk.%I to authenticated', t);
    execute format('grant all on imobdesk.%I to service_role', t);
  end loop;

  if not exists (select 1 from pg_policies where schemaname = 'imobdesk' and tablename = 'at_config' and policyname = 'Atendimento: config só super admin') then
    create policy "Atendimento: config só super admin" on imobdesk.at_config
      for select to authenticated using ((select imobdesk.eh_super_admin()));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'imobdesk' and tablename = 'at_setores' and policyname = 'Atendimento: setores do usuário') then
    create policy "Atendimento: setores do usuário" on imobdesk.at_setores
      for select to authenticated using ((select imobdesk.at_supervisor()) or imobdesk.at_membro_de(id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'imobdesk' and tablename = 'at_numeros' and policyname = 'Atendimento: números dos setores do usuário') then
    create policy "Atendimento: números dos setores do usuário" on imobdesk.at_numeros
      for select to authenticated using ((select imobdesk.at_supervisor()) or imobdesk.at_membro_de(setor_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'imobdesk' and tablename = 'at_setor_gestores' and policyname = 'Atendimento: gestores dos setores do usuário') then
    create policy "Atendimento: gestores dos setores do usuário" on imobdesk.at_setor_gestores
      for select to authenticated using ((select imobdesk.at_supervisor()) or imobdesk.at_membro_de(setor_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'imobdesk' and tablename = 'at_atendentes' and policyname = 'Atendimento: equipe dos setores do usuário') then
    create policy "Atendimento: equipe dos setores do usuário" on imobdesk.at_atendentes
      for select to authenticated using ((select imobdesk.at_supervisor()) or imobdesk.at_membro_de(setor_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'imobdesk' and tablename = 'at_horarios' and policyname = 'Atendimento: horários dos setores do usuário') then
    create policy "Atendimento: horários dos setores do usuário" on imobdesk.at_horarios
      for select to authenticated using ((select imobdesk.at_supervisor()) or imobdesk.at_membro_de(setor_id));
  end if;
end;
$$;

-- ---------- Contexto da tela (um JSON com tudo o que o usuário pode ver) ----------
create or replace function imobdesk.at_contexto()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with eu as (
    select auth.uid() as id, imobdesk.at_supervisor() as supervisor, imobdesk.eh_super_admin() as super_admin
  ),
  vis as (
    select s.*,
      case
        when (select supervisor from eu) then 'supervisor'
        when imobdesk.at_gestor_de(s.id) then 'gestor'
        else 'atendente'
      end as papel
    from imobdesk.at_setores s
    where (select supervisor from eu) or imobdesk.at_membro_de(s.id)
  )
  select jsonb_build_object(
    'eu', (select id from eu),
    'supervisor', (select supervisor from eu),
    'superAdmin', (select super_admin from eu),
    'souAtendente', exists (select 1 from imobdesk.at_atendentes a where a.usuario_id = (select id from eu)),
    'setores', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', v.id, 'nome', v.nome, 'ativo', v.ativo, 'papel', v.papel,
        'msgBoasVindas', v.msg_boas_vindas, 'msgForaHorario', v.msg_fora_horario, 'msgEncerramento', v.msg_encerramento,
        'limiteSimultaneo', v.limite_simultaneo, 'atendenteSemRespostaMin', v.atendente_sem_resposta_min,
        'encerrarAposHoras', v.encerrar_apos_horas, 'alertaFilaMin', v.alerta_fila_min, 'alertaClienteMin', v.alerta_cliente_min,
        'numeros', coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'numero', n.numero, 'verificacao', n.verificacao) order by n.id)
                             from imobdesk.at_numeros n where n.setor_id = v.id and n.ativo), '[]'),
        'gestores', coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'nome', u.nome, 'email', u.email) order by u.nome)
                              from imobdesk.at_setor_gestores g join imobdesk.usuarios u on u.id = g.usuario_id
                              where g.setor_id = v.id), '[]'),
        'atendentes', coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'nome', u.nome, 'email', u.email, 'apto', a.apto,
                                                                    'pausa', a.pausa, 'onlineEm', a.online_em) order by u.nome)
                                from imobdesk.at_atendentes a join imobdesk.usuarios u on u.id = a.usuario_id
                                where a.setor_id = v.id), '[]'),
        'horarios', coalesce((select jsonb_agg(jsonb_build_object('dia', h.dia, 'aberto', h.aberto, 'abre', to_char(h.abre, 'HH24:MI'),
                                                                  'fecha', to_char(h.fecha, 'HH24:MI')) order by h.dia)
                              from imobdesk.at_horarios h where h.setor_id = v.id), '[]')
      ) order by v.nome)
      from vis v
    ), '[]')
  );
$$;

-- Usuários ativos do portal que podem entrar numa equipe ou na gestão (para os seletores).
create or replace function imobdesk.at_candidatos()
returns table (id uuid, nome text, email text, setor_atendente bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (imobdesk.at_supervisor()
          or exists (select 1 from imobdesk.at_setor_gestores g where g.usuario_id = auth.uid()
                     and imobdesk.tem_permissao('gestao_atendimento_monitor'))) then
    perform imobdesk.erro('FORBIDDEN', 'Só a gestão do setor escolhe a equipe.');
  end if;
  return query
    select u.id, u.nome, u.email, a.setor_id
    from imobdesk.usuarios u
    left join imobdesk.at_atendentes a on a.usuario_id = u.id
    where u.status = 'active'
    order by u.nome;
end;
$$;

-- ---------- Setores e números (supervisão geral) ----------
-- p: {id?, nome, ativo, numeros: [texto], gestores: [uuid]}. Devolve o id do setor.
create or replace function imobdesk.at_setor_salvar(p jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := auth.uid();
  v_id bigint := nullif(p ->> 'id', '')::bigint;
  v_nome text := btrim(coalesce(p ->> 'nome', ''));
  v_antes jsonb;
  v_numeros text[];
  v_num text;
  v_outro text;
  v_gestores uuid[];
begin
  if v_ator is null or not imobdesk.at_supervisor() then
    perform imobdesk.erro('FORBIDDEN', 'Só a supervisão geral cadastra setores e números.');
  end if;
  if length(v_nome) not between 2 and 60 then
    perform imobdesk.erro('INVALID_INPUT', 'Informe o nome do setor (2 a 60 letras).', 'nome');
  end if;
  if exists (select 1 from imobdesk.at_setores s where lower(btrim(s.nome)) = lower(v_nome) and s.id is distinct from v_id) then
    perform imobdesk.erro('DUPLICATE', 'Já existe um setor com esse nome.', 'nome');
  end if;

  -- Números: só dígitos; com 10 ou 11 dígitos, assume o DDI 55.
  select coalesce(array_agg(distinct d), '{}') into v_numeros
  from (select case when length(x) in (10, 11) then '55' || x else x end d
        from (select regexp_replace(e, '\D', '', 'g') x from jsonb_array_elements_text(coalesce(p -> 'numeros', '[]')) e) a
        where x <> '') b;
  foreach v_num in array v_numeros loop
    if v_num !~ '^\d{12,13}$' then
      perform imobdesk.erro('INVALID_INPUT', format('Número inválido: %s. Use DDI + DDD + número (ex.: 5521999990002).', v_num), 'numeros');
    end if;
    select s.nome into v_outro from imobdesk.at_numeros n join imobdesk.at_setores s on s.id = n.setor_id
    where n.numero = v_num and n.ativo and n.setor_id is distinct from v_id;
    if v_outro is not null then
      perform imobdesk.erro('DUPLICATE', format('O número %s já pertence ao setor %s.', v_num, v_outro), 'numeros');
    end if;
  end loop;

  select coalesce(array_agg(distinct g::uuid), '{}') into v_gestores from jsonb_array_elements_text(coalesce(p -> 'gestores', '[]')) g;
  if exists (select 1 from unnest(v_gestores) g where not exists (select 1 from imobdesk.usuarios u where u.id = g and u.status = 'active')) then
    perform imobdesk.erro('INVALID_INPUT', 'Gestor precisa ser um usuário ativo do portal.', 'gestores');
  end if;

  if v_id is null then
    insert into imobdesk.at_setores (nome, ativo, atualizado_por)
    values (v_nome, coalesce((p ->> 'ativo')::boolean, true), v_ator) returning id into v_id;
  else
    select to_jsonb(s) into v_antes from imobdesk.at_setores s where s.id = v_id;
    if v_antes is null then
      perform imobdesk.erro('NOT_FOUND', 'Setor não encontrado.');
    end if;
    update imobdesk.at_setores
      set nome = v_nome, ativo = coalesce((p ->> 'ativo')::boolean, ativo), atualizado_em = now(), atualizado_por = v_ator
      where id = v_id;
  end if;

  update imobdesk.at_numeros set ativo = false where setor_id = v_id and ativo and not (numero = any (v_numeros));
  insert into imobdesk.at_numeros (setor_id, numero)
  select v_id, x from unnest(v_numeros) x
  on conflict (numero) do update set setor_id = excluded.setor_id, ativo = true, verificacao = null;

  delete from imobdesk.at_setor_gestores where setor_id = v_id and not (usuario_id = any (v_gestores));
  insert into imobdesk.at_setor_gestores (setor_id, usuario_id) select v_id, g from unnest(v_gestores) g on conflict do nothing;

  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', case when v_antes is null then 'create' else 'update' end,
    format('Setor de atendimento "%s" %s', v_nome, case when v_antes is null then 'criado' else 'alterado' end),
    v_antes, jsonb_build_object('nome', v_nome, 'ativo', coalesce((p ->> 'ativo')::boolean, true), 'numeros', to_jsonb(v_numeros), 'gestores', to_jsonb(v_gestores)),
    v_id::text);
  return v_id;
end;
$$;

-- ---------- Configuração do setor (gestão do setor) ----------
-- p: {setorId, msgBoasVindas, msgForaHorario, msgEncerramento, limiteSimultaneo, atendenteSemRespostaMin,
--     encerrarAposHoras, alertaFilaMin, alertaClienteMin, horarios: [{dia, aberto, abre, fecha}]}
create or replace function imobdesk.at_setor_config_salvar(p jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := auth.uid();
  v_setor bigint := (p ->> 'setorId')::bigint;
  v_antes jsonb;
  h jsonb;
begin
  if v_ator is null or v_setor is null or not imobdesk.at_gestor_de(v_setor) then
    perform imobdesk.erro('FORBIDDEN', 'Só a gestão do setor altera a fila e os horários.');
  end if;
  select to_jsonb(s) into v_antes from imobdesk.at_setores s where s.id = v_setor;
  if v_antes is null then
    perform imobdesk.erro('NOT_FOUND', 'Setor não encontrado.');
  end if;
  begin
    update imobdesk.at_setores s set
      msg_boas_vindas = coalesce(nullif(btrim(p ->> 'msgBoasVindas'), ''), s.msg_boas_vindas),
      msg_fora_horario = coalesce(nullif(btrim(p ->> 'msgForaHorario'), ''), s.msg_fora_horario),
      msg_encerramento = coalesce(nullif(btrim(p ->> 'msgEncerramento'), ''), s.msg_encerramento),
      limite_simultaneo = coalesce((p ->> 'limiteSimultaneo')::int, s.limite_simultaneo),
      atendente_sem_resposta_min = coalesce((p ->> 'atendenteSemRespostaMin')::int, s.atendente_sem_resposta_min),
      encerrar_apos_horas = coalesce((p ->> 'encerrarAposHoras')::int, s.encerrar_apos_horas),
      alerta_fila_min = coalesce((p ->> 'alertaFilaMin')::int, s.alerta_fila_min),
      alerta_cliente_min = coalesce((p ->> 'alertaClienteMin')::int, s.alerta_cliente_min),
      atualizado_em = now(), atualizado_por = v_ator
    where s.id = v_setor;
  exception when check_violation then
    perform imobdesk.erro('INVALID_INPUT', 'Valor fora do permitido: limite de 1 a 50, encerramento de 1 a 23 h, alertas de 1 a 240 min e mensagens de até 1.000 letras.');
  end;
  for h in select * from jsonb_array_elements(coalesce(p -> 'horarios', '[]')) loop
    if (h ->> 'aberto')::boolean and (h ->> 'fecha')::time <= (h ->> 'abre')::time then
      perform imobdesk.erro('INVALID_INPUT', 'O horário de fechar precisa ser depois do de abrir.', 'horarios');
    end if;
    update imobdesk.at_horarios set aberto = (h ->> 'aberto')::boolean,
      abre = coalesce((h ->> 'abre')::time, abre), fecha = coalesce((h ->> 'fecha')::time, fecha)
    where setor_id = v_setor and dia = (h ->> 'dia')::int;
  end loop;
  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', 'update', format('Fila e horários do setor "%s" alterados', v_antes ->> 'nome'),
    v_antes, (select to_jsonb(s) from imobdesk.at_setores s where s.id = v_setor), v_setor::text);
end;
$$;

-- ---------- Equipe do setor ----------
-- p: {usuarioId, setorId, apto?}. Atendente de outro setor só a supervisão geral pode mover.
create or replace function imobdesk.at_atendente_salvar(p jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := auth.uid();
  v_usuario uuid := (p ->> 'usuarioId')::uuid;
  v_setor bigint := (p ->> 'setorId')::bigint;
  v_atual bigint;
  v_nome text;
begin
  if v_ator is null or v_setor is null or not imobdesk.at_gestor_de(v_setor) then
    perform imobdesk.erro('FORBIDDEN', 'Só a gestão do setor altera a equipe.');
  end if;
  select u.nome into v_nome from imobdesk.usuarios u where u.id = v_usuario and u.status = 'active';
  if v_nome is null then
    perform imobdesk.erro('INVALID_INPUT', 'Escolha um usuário ativo do portal.', 'usuarioId');
  end if;
  select a.setor_id into v_atual from imobdesk.at_atendentes a where a.usuario_id = v_usuario;
  if v_atual is not null and v_atual <> v_setor and not imobdesk.at_supervisor() then
    perform imobdesk.erro('DUPLICATE', format('%s já é atendente de outro setor. Só a supervisão geral pode mudar de setor.', v_nome), 'usuarioId');
  end if;
  insert into imobdesk.at_atendentes (usuario_id, setor_id, apto)
  values (v_usuario, v_setor, coalesce((p ->> 'apto')::boolean, true))
  on conflict (usuario_id) do update set setor_id = excluded.setor_id, apto = coalesce((p ->> 'apto')::boolean, imobdesk.at_atendentes.apto);
  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', case when v_atual is null then 'create' else 'update' end,
    format('Atendente %s %s', v_nome, case when v_atual is null then 'incluído na equipe' when v_atual <> v_setor then 'mudou de setor' else 'alterado' end),
    case when v_atual is null then null else jsonb_build_object('setor', v_atual) end, p, v_usuario::text);
end;
$$;

create or replace function imobdesk.at_atendente_remover(p_usuario uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := auth.uid();
  v_setor bigint;
  v_nome text;
begin
  select a.setor_id, u.nome into v_setor, v_nome
  from imobdesk.at_atendentes a join imobdesk.usuarios u on u.id = a.usuario_id
  where a.usuario_id = p_usuario;
  if v_setor is null then
    perform imobdesk.erro('NOT_FOUND', 'Atendente não encontrado.');
  end if;
  if v_ator is null or not imobdesk.at_gestor_de(v_setor) then
    perform imobdesk.erro('FORBIDDEN', 'Só a gestão do setor altera a equipe.');
  end if;
  delete from imobdesk.at_atendentes where usuario_id = p_usuario;
  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', 'delete', format('Atendente %s removido da equipe', v_nome),
    jsonb_build_object('setor', v_setor), null, p_usuario::text);
end;
$$;

-- ---------- Do próprio atendente ----------
-- Sinal de presença da Central aberta (a cada minuto).
create or replace function imobdesk.at_ping()
returns boolean
language sql
security definer
set search_path = ''
as $$
  update imobdesk.at_atendentes set online_em = now() where usuario_id = auth.uid() returning true;
$$;

create or replace function imobdesk.at_minha_pausa(p_pausa boolean)
returns void
language sql
security definer
set search_path = ''
as $$
  update imobdesk.at_atendentes set pausa = coalesce(p_pausa, false), online_em = now() where usuario_id = auth.uid();
$$;

-- ---------- Configuração do canal (tela Zenvia, só super admin) ----------
-- p: {ligado?, travaPiloto?, telefonesPiloto?: [texto]}
create or replace function imobdesk.at_config_salvar(p jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := auth.uid();
  v_antes jsonb;
  v_tels text[];
begin
  if v_ator is null or not imobdesk.eh_super_admin() then
    perform imobdesk.erro('FORBIDDEN', 'Só o super admin altera a conexão do WhatsApp.');
  end if;
  select coalesce(array_agg(d) filter (where d ~ '^\d{12,13}$'), '{}') into v_tels
  from (select case when length(regexp_replace(x, '\D', '', 'g')) in (10, 11) then '55' else '' end || regexp_replace(x, '\D', '', 'g') d
        from jsonb_array_elements_text(coalesce(p -> 'telefonesPiloto', '[]')) x) s;
  select to_jsonb(c) - 'verificacao' - 'token_segredo_id' into v_antes from imobdesk.at_config c where c.id;
  update imobdesk.at_config c set
    ligado = coalesce((p ->> 'ligado')::boolean, c.ligado),
    trava_piloto = coalesce((p ->> 'travaPiloto')::boolean, c.trava_piloto),
    telefones_piloto = case when p ? 'telefonesPiloto' then v_tels else c.telefones_piloto end,
    atualizado_em = now(), atualizado_por = v_ator
  where c.id;
  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', 'update', 'Configuração do WhatsApp do atendimento alterada',
    v_antes, (select to_jsonb(c) - 'verificacao' - 'token_segredo_id' from imobdesk.at_config c where c.id), 'at_config');
end;
$$;

-- ---------- Execução: só logado; as funções internas não ficam expostas ao anon ----------
do $$
declare
  f text;
begin
  foreach f in array array[
    'imobdesk.at_setor_horarios_padrao()',
    'imobdesk.at_supervisor()', 'imobdesk.at_gestor_de(bigint)', 'imobdesk.at_membro_de(bigint)',
    'imobdesk.at_contexto()', 'imobdesk.at_candidatos()', 'imobdesk.at_setor_salvar(jsonb)',
    'imobdesk.at_setor_config_salvar(jsonb)', 'imobdesk.at_atendente_salvar(jsonb)',
    'imobdesk.at_atendente_remover(uuid)', 'imobdesk.at_ping()', 'imobdesk.at_minha_pausa(boolean)',
    'imobdesk.at_config_salvar(jsonb)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
  revoke execute on function imobdesk.at_setor_horarios_padrao() from authenticated;
end;
$$;

do $$
begin
  if to_regclass('acessos.aplicativos') is not null then
    if exists (select 1 from acessos.aplicativos a where a.schema_name = 'imobdesk' and a.controle_ativo) then
      perform acessos.aplicar_protecao('imobdesk', true);
    end if;
  end if;
end;
$$;

notify pgrst, 'reload schema';
