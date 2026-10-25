-- IA nos tickets — triagem por equipe (docs/PLANO-ia-triagem-solucoes.md, IA-1/IA-2, aprovado em 07/10/2026).
-- Ticket sem equipe num setor com IA ligada → a Edge imobdesk-ia (pg_cron, 1 min) classifica entre as
-- equipes e serviços do setor. Decisão do Wagner (08/10/2026), revendo a D4: modo AUTOMÁTICO a partir de 80% de
-- confiança na TI; abaixo disso o ticket fica sem equipe, em "Revisar classificação". Configurável por setor.
-- A parte "já existe solução?" (pgvector, base de conhecimento) fica para a próxima fase. Só aditiva.

-- ---------- Configuração por setor ----------
create table if not exists imobdesk.ch_ia_config (
  setor_id        bigint      primary key references imobdesk.at_setores (id) on delete cascade,
  ligada          boolean     not null default false,
  modo            text        not null default 'sugestao' check (modo in ('automatico', 'sugestao')),
  limiar          int         not null default 80 check (limiar between 50 and 100),
  ia_desde        timestamptz not null default now(),          -- tickets criados antes disto não são classificados
  atualizado_em   timestamptz not null default now(),
  atualizado_por  uuid
);

-- TI: as equipes Sistemas e Infraestrutura não têm padrão; a IA escolhe. Inclui os tickets de hoje.
insert into imobdesk.ch_ia_config (setor_id, ligada, modo, limiar, ia_desde)
select s.id, true, 'automatico', 80, date_trunc('day', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo'
from imobdesk.at_setores s where lower(s.nome) = 'ti'
on conflict (setor_id) do nothing;

-- ---------- Resultado por ticket ----------
create table if not exists imobdesk.ch_ticket_ia (
  id              bigint      generated always as identity primary key,
  ticket_id       bigint      not null references imobdesk.ch_tickets (id) on delete cascade,
  situacao        text        not null check (situacao in ('aplicado', 'sugerido', 'baixa_confianca', 'erro')),
  equipe_id       bigint      references imobdesk.at_equipes (id) on delete set null,
  servico_id      bigint      references imobdesk.ch_servicos (id) on delete set null,
  confianca       int         check (confianca between 0 and 100),
  motivo          text,
  modelo          text,
  tokens_entrada  int,
  tokens_saida    int,
  ms              int,
  erro            text,
  criado_em       timestamptz not null default now()
);
create index if not exists ch_ticket_ia_ticket_idx on imobdesk.ch_ticket_ia (ticket_id, criado_em desc);

do $$
declare
  t text;
begin
  foreach t in array array['ch_ia_config', 'ch_ticket_ia'] loop
    execute format('alter table imobdesk.%I enable row level security', t);
    execute format('revoke all on imobdesk.%I from anon, public, authenticated', t);
    execute format('grant all on imobdesk.%I to service_role', t);
  end loop;
end;
$$;

-- ---------- Fila: tickets a classificar, com as candidatas do setor ----------
create or replace function imobdesk.ch_ia_pendentes(p_limite int default 10)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with recursive arvore as (
    select s.id, s.setor_id, s.nome::text as caminho from imobdesk.ch_servicos s where s.pai_id is null and s.ativo
    union all
    select f.id, f.setor_id, a.caminho || ' › ' || f.nome from imobdesk.ch_servicos f join arvore a on a.id = f.pai_id where f.ativo
  ), fila as (
    select t.id, t.setor_id, t.assunto, cfg.modo, cfg.limiar,
           coalesce((select a.texto from imobdesk.ch_ticket_acoes a where a.ticket_id = t.id order by a.numero limit 1), '') as descricao
    from imobdesk.ch_tickets t
    join imobdesk.ch_ia_config cfg on cfg.setor_id = t.setor_id and cfg.ligada
    where t.equipe_id is null and t.excluido_em is null and t.mesclado_em_id is null and t.encerrado_em is null
      and t.criado_em >= cfg.ia_desde
      and not exists (select 1 from imobdesk.ch_ticket_ia i where i.ticket_id = t.id and i.situacao <> 'erro')
      and (select count(*) from imobdesk.ch_ticket_ia i where i.ticket_id = t.id and i.situacao = 'erro') < 3
    order by t.id
    limit greatest(1, least(p_limite, 50))
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'ticketId', f.id, 'setorId', f.setor_id, 'assunto', f.assunto, 'descricao', left(f.descricao, 20000), 'modo', f.modo, 'limiar', f.limiar,
    'equipes', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'nome', e.nome, 'descricao', e.descricao_ia) order by e.nome)
                         from imobdesk.at_equipes e where e.setor_id = f.setor_id and e.ativa), '[]'),
    'servicos', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'caminho', a.caminho, 'equipeId', imobdesk.ch_servico_equipe(a.id)) order by a.caminho)
                          from arvore a where a.setor_id = f.setor_id
                            and not exists (select 1 from imobdesk.ch_servicos x where x.pai_id = a.id and x.ativo)), '[]')
  ) order by f.id), '[]')
  from fila f;
$$;

-- ---------- Registro e aplicação ----------
/**
 * Grava o resultado da IA. Modo automático com confiança ≥ limiar e o ticket ainda sem equipe → define equipe
 * (e o serviço, se coerente com a equipe e o ticket ainda não tiver) e registra no histórico. Senão fica a sugestão.
 */
create or replace function imobdesk.ch_ia_registrar(p_ticket bigint, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t imobdesk.ch_tickets;
  cfg imobdesk.ch_ia_config;
  v_equipe bigint := nullif(p ->> 'equipeId', '')::bigint;
  v_servico bigint := nullif(p ->> 'servicoId', '')::bigint;
  v_conf int := nullif(p ->> 'confianca', '')::int;
  v_situacao text;
  v_nome_eq text;
  v_nome_sv text;
begin
  select * into t from imobdesk.ch_tickets x where x.id = p_ticket for update;
  if t.id is null then return jsonb_build_object('situacao', 'inexistente'); end if;
  select * into cfg from imobdesk.ch_ia_config c where c.setor_id = t.setor_id;

  if nullif(p ->> 'erro', '') is not null then
    insert into imobdesk.ch_ticket_ia (ticket_id, situacao, modelo, ms, erro)
    values (p_ticket, 'erro', p ->> 'modelo', nullif(p ->> 'ms', '')::int, left(p ->> 'erro', 1000));
    return jsonb_build_object('situacao', 'erro');
  end if;

  -- Equipe precisa ser do setor; serviço do setor e da mesma equipe (senão é descartado).
  if not exists (select 1 from imobdesk.at_equipes e where e.id = v_equipe and e.setor_id = t.setor_id and e.ativa) then
    insert into imobdesk.ch_ticket_ia (ticket_id, situacao, modelo, ms, erro)
    values (p_ticket, 'erro', p ->> 'modelo', nullif(p ->> 'ms', '')::int, 'Equipe fora do setor do ticket.');
    return jsonb_build_object('situacao', 'erro');
  end if;
  if v_servico is not null and not exists (
       select 1 from imobdesk.ch_servicos s where s.id = v_servico and s.setor_id = t.setor_id and s.ativo
         and coalesce(imobdesk.ch_servico_equipe(s.id), v_equipe) = v_equipe) then
    v_servico := null;
  end if;

  v_situacao := case
    when coalesce(v_conf, 0) < coalesce(cfg.limiar, 80) then 'baixa_confianca'
    when cfg.modo = 'automatico' and t.equipe_id is null then 'aplicado'
    else 'sugerido' end;

  insert into imobdesk.ch_ticket_ia (ticket_id, situacao, equipe_id, servico_id, confianca, motivo, modelo, tokens_entrada, tokens_saida, ms)
  values (p_ticket, v_situacao, v_equipe, v_servico, v_conf, left(p ->> 'motivo', 300), p ->> 'modelo',
          nullif(p ->> 'tokensEntrada', '')::int, nullif(p ->> 'tokensSaida', '')::int, nullif(p ->> 'ms', '')::int);

  v_nome_eq := (select e.nome from imobdesk.at_equipes e where e.id = v_equipe);
  v_nome_sv := (select s.nome from imobdesk.ch_servicos s where s.id = v_servico);
  if v_situacao = 'aplicado' then
    update imobdesk.ch_tickets
       set equipe_id = v_equipe, servico_id = coalesce(servico_id, v_servico)
     where id = p_ticket;
  end if;
  insert into imobdesk.ch_ticket_eventos (ticket_id, tipo, descricao, autor_nome)
  values (p_ticket, 'ia',
          format('%s pela IA (%s%%): %s%s%s',
                 case v_situacao when 'aplicado' then 'Classificado' when 'sugerido' then 'Sugestão' else 'Classificação incerta' end,
                 coalesce(v_conf, 0), v_nome_eq, case when v_nome_sv is not null then ' · ' || v_nome_sv else '' end,
                 case when nullif(btrim(p ->> 'motivo'), '') is not null then ' — ' || left(btrim(p ->> 'motivo'), 200) else '' end),
          'IA');
  return jsonb_build_object('situacao', v_situacao, 'equipe', v_nome_eq, 'servico', v_nome_sv, 'confianca', v_conf);
end;
$$;

-- ---------- Chave do agendamento (pg_cron → Edge) ----------
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'imobdesk_ia_cron') then
    perform vault.create_secret(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'imobdesk_ia_cron',
      'Chave do pg_cron para a Edge imobdesk-ia (Imobdesk)');
  end if;
end;
$$;

create or replace function imobdesk.at_ia_cron_chave()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select d.decrypted_secret from vault.decrypted_secrets d where d.name = 'imobdesk_ia_cron';
$$;

do $$
declare
  f text;
begin
  foreach f in array array['ch_ia_pendentes(int)', 'ch_ia_registrar(bigint, jsonb)', 'at_ia_cron_chave()'] loop
    execute format('revoke execute on function imobdesk.%s from public, anon, authenticated', f);
    execute format('grant execute on function imobdesk.%s to service_role', f);
  end loop;
end;
$$;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'imobdesk-ia-1min') then
    perform cron.unschedule('imobdesk-ia-1min');
  end if;
  perform cron.schedule('imobdesk-ia-1min', '* * * * *', $job$
    select net.http_post(
      url := 'https://ikvjaowvpvxojvcfwnct.supabase.co/functions/v1/imobdesk-ia',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-atendimento-chave', imobdesk.at_ia_cron_chave()),
      body := '{"acao": "triagem"}'::jsonb,
      timeout_milliseconds := 55000
    );
  $job$);
end;
$$;

-- ---------- Painel: Triagem inteligente com números reais (hoje) ----------
-- Igual à de 20261007171000, só com o bloco "triage" lendo ch_ticket_ia.
create or replace function imobdesk.ch_painel()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_eu uuid := (select auth.uid());
  v_admin boolean := imobdesk.ch_eh_admin() or imobdesk.at_supervisor();
  v_agora timestamptz := now();
  v_tokens text[] := array['--ds-team-sistemas', '--ds-team-infra', '--ds-ai', '--ds-triage-ai', '--ds-warning', '--ds-success'];
begin
  if not (imobdesk.ch_eh_admin() or imobdesk.tem_permissao('gestao_chamados_visao_geral') or imobdesk.tem_permissao('gestao_chamados_tickets')) then
    perform imobdesk.erro('FORBIDDEN', 'Sem acesso à Gestão de Chamados.');
  end if;
  return (
    with vis as (
      select t.* from imobdesk.ch_tickets t
      where t.excluido_em is null and t.mesclado_em_id is null
        and (t.encerrado_em is null or t.encerrado_em >= v_agora - interval '30 days')
        and imobdesk.ch_pode_ver_ticket(t.setor_id, t.equipe_id, t.responsavel_id)
    ), eq as (
      select e.id, e.nome, row_number() over (order by e.nome) as n from imobdesk.at_equipes e where e.ativa
    )
    select jsonb_build_object(
      'generated_at', v_agora,
      'current_user', jsonb_build_object('id', v_eu, 'name', imobdesk.ch_nome_usuario(v_eu),
                        'initials', imobdesk.ch_iniciais(imobdesk.ch_nome_usuario(v_eu))),
      'my_teams', coalesce((select jsonb_agg(e.nome order by e.nome) from eq e
                            where v_admin or exists (select 1 from imobdesk.at_equipe_membros m where m.equipe_id = e.id and m.usuario_id = v_eu)), '[]'),
      'teams', coalesce((select jsonb_agg(jsonb_build_object('name', e.nome, 'color_token', v_tokens[1 + ((e.n - 1) % 6)]) order by e.nome) from eq e), '[]'),
      'services', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.nome,
                              'team', coalesce((select e.nome from imobdesk.at_equipes e where e.id = imobdesk.ch_servico_equipe(s.id)), ''),
                              'sla_hours', coalesce((select h.solucao from imobdesk.ch_sla_horas(s.id, (select u.id from imobdesk.ch_urgencias u where u.padrao), s.setor_id) h), 0)) order by s.nome)
                            from imobdesk.ch_servicos s where s.ativo and not exists (select 1 from imobdesk.ch_servicos f where f.pai_id = s.id)), '[]'),
      'tickets', coalesce((select jsonb_agg(jsonb_build_object(
          'id', t.id, 'subject', t.assunto, 'requester', t.solicitante_nome,
          'description', coalesce((select a.texto from imobdesk.ch_ticket_acoes a where a.ticket_id = t.id order by a.numero limit 1), ''),
          'service_id', t.servico_id,
          'team', coalesce((select e.nome from imobdesk.at_equipes e where e.id = t.equipe_id), ''),
          'origin', case t.origem when 'email' then 'E-mail' when 'whatsapp' then 'WhatsApp' when 'intranet' then 'Intranet' else 'Agente' end,
          'owner', case when t.responsavel_id is null then null else jsonb_build_object('id', t.responsavel_id, 'name', imobdesk.ch_nome_usuario(t.responsavel_id),
                     'initials', imobdesk.ch_iniciais(imobdesk.ch_nome_usuario(t.responsavel_id))) end,
          'status_id', t.status_id, 'status', st.nome, 'status_categoria', st.categoria,
          'justificativa_id', t.justificativa_id, 'justificativa', (select j.nome from imobdesk.ch_status_justificativas j where j.id = t.justificativa_id),
          'prioridade', (select u.nome from imobdesk.ch_urgencias u where u.id = t.urgencia_id),
          'tags', to_jsonb(t.tags), 'recebido_em', t.recebido_em, 'criado_em', t.criado_em,
          'sla_due_minutes', coalesce(round(extract(epoch from (t.sla_solucao_ate - coalesce(t.sla_pausado_desde, v_agora))) / 60), 0),
          'opened_today', (t.criado_em at time zone 'America/Sao_Paulo')::date = (v_agora at time zone 'America/Sao_Paulo')::date,
          'closed_at', t.encerrado_em) order by t.id)
        from vis t join imobdesk.ch_status st on st.id = t.status_id), '[]'),
      'triage', (
        with hoje as (
          select t.id, t.equipe_id,
                 (select i.situacao from imobdesk.ch_ticket_ia i where i.ticket_id = t.id order by i.id desc limit 1) as ia
          from vis t where (t.criado_em at time zone 'America/Sao_Paulo')::date = (v_agora at time zone 'America/Sao_Paulo')::date
        )
        select jsonb_build_object('period', 'Hoje',
          'automatic', (select count(*) from hoje where ia = 'aplicado'),
          'total', (select count(*) from hoje),
          'by_intranet_form', 0, 'by_email_rule', 0,
          'by_ai', (select count(*) from hoje where ia = 'aplicado'),
          'manual', (select count(*) from hoje where equipe_id is null),
          'pending_review', (select count(*) from hoje where equipe_id is null and ia in ('baixa_confianca', 'sugerido')))
      ),
      'sla_health', jsonb_build_object('period', '7 dias',
                  'first_response_percent', coalesce((select round(100.0 * count(*) filter (where t.primeira_resposta_em <= t.sla_resposta_ate) / nullif(count(*), 0))
                                                      from vis t where t.primeira_resposta_em >= v_agora - interval '7 days'), 100),
                  'resolution_percent', coalesce((select round(100.0 * count(*) filter (where t.encerrado_em <= t.sla_solucao_ate) / nullif(count(*), 0))
                                                  from vis t join imobdesk.ch_status st on st.id = t.status_id
                                                  where st.categoria in ('resolvido', 'fechado') and t.encerrado_em >= v_agora - interval '7 days'), 100)),
      'inbound', (select jsonb_agg(jsonb_build_object('hour', h,
                     'today', (select count(*) from vis t where (t.criado_em at time zone 'America/Sao_Paulo')::date = (v_agora at time zone 'America/Sao_Paulo')::date
                                 and extract(hour from t.criado_em at time zone 'America/Sao_Paulo') = h),
                     'yesterday', (select count(*) from vis t where (t.criado_em at time zone 'America/Sao_Paulo')::date = (v_agora at time zone 'America/Sao_Paulo')::date - 1
                                 and extract(hour from t.criado_em at time zone 'America/Sao_Paulo') = h)) order by h)
                  from generate_series(8, 18) h)
    )
  );
end;
$$;
