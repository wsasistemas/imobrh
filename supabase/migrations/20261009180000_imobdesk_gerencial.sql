-- Gestão de Chamados › Gerencial (docs/PLANO-gerencial.md): visão gerencial e estratégica dos tickets.
-- Só aditiva: permissão nova (copiada de quem já administra), tabela de metas, a RPC de dados e os
-- alertas automáticos no sino (pg_cron, dias úteis às 8h). Nada muda nas tabelas de ticket.

-- ---------- Permissão: quem já tem o menu Gestão de Chamados e administra (admin, ti) ----------
insert into imobdesk.profile_permissions (role, permission_id, enabled)
select v.role, 'gestao_chamados_gerencial', true
from (values ('admin'), ('ti')) as v(role)
where exists (select 1 from imobdesk.perfis p where p.key = v.role)
on conflict (role, permission_id) do nothing;

create or replace function imobdesk.ch_gerencial_pode()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select imobdesk.ch_eh_admin() or imobdesk.tem_permissao('gestao_chamados_gerencial');
$$;

-- ---------- Metas e limites (semáforos, alertas e projeções) ----------
create table if not exists imobdesk.ch_gerencial_metas (
  chave          text        primary key,
  valor          numeric     not null,
  descricao      text        not null,
  atualizado_em  timestamptz not null default now(),
  atualizado_por uuid
);
alter table imobdesk.ch_gerencial_metas enable row level security;
revoke all on imobdesk.ch_gerencial_metas from anon, public, authenticated;
grant all on imobdesk.ch_gerencial_metas to service_role;

insert into imobdesk.ch_gerencial_metas (chave, valor, descricao) values
  ('sla_solucao_pct',        85, 'Meta: % de tickets resolvidos dentro do prazo de solução'),
  ('sla_resposta_pct',       90, 'Meta: % de tickets com a 1ª resposta dentro do prazo'),
  ('tmr_horas',              24, 'Meta: tempo médio de resolução (horas corridas)'),
  ('tpr_horas',               4, 'Meta: tempo médio até a 1ª resposta (horas corridas)'),
  ('reabertura_pct_max',      5, 'Limite: % de tickets reabertos depois de resolvidos'),
  ('backlog_max',            50, 'Limite: tickets abertos ao mesmo tempo'),
  ('vencidos_max',            5, 'Limite: tickets abertos com SLA vencido'),
  ('sem_responsavel_max',     5, 'Limite: tickets abertos sem responsável'),
  ('parado_dias',             7, 'Limite: dias sem nenhuma ação num ticket aberto'),
  ('crescimento_alerta_pct', 20, 'Alerta quando as entradas crescem mais que isto em relação ao período anterior')
on conflict (chave) do nothing;

create or replace function imobdesk.ch_gerencial_metas()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not imobdesk.ch_gerencial_pode() then
    perform imobdesk.erro('FORBIDDEN', 'Sem acesso à visão gerencial.');
  end if;
  return coalesce((select jsonb_object_agg(m.chave, m.valor) from imobdesk.ch_gerencial_metas m), '{}'::jsonb);
end;
$$;

/** Só Admin e Super admin mudam metas. p = {chave: valor, ...}; só chaves já cadastradas. */
create or replace function imobdesk.ch_gerencial_metas_salvar(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := (select auth.uid());
  r record;
  v_antes jsonb;
begin
  if not imobdesk.ch_eh_admin() then
    perform imobdesk.erro('FORBIDDEN', 'Só Admin e Super admin alteram metas.');
  end if;
  if jsonb_typeof(p) is distinct from 'object' then
    perform imobdesk.erro('INVALID_INPUT', 'Metas inválidas.');
  end if;
  v_antes := imobdesk.ch_gerencial_metas();
  for r in select key, value from jsonb_each(p) loop
    if jsonb_typeof(r.value) <> 'number' or (r.value::text)::numeric < 0 then
      perform imobdesk.erro('INVALID_INPUT', format('Valor inválido para %s.', r.key), r.key);
    end if;
    update imobdesk.ch_gerencial_metas m
    set valor = (r.value::text)::numeric, atualizado_em = now(), atualizado_por = v_ator
    where m.chave = r.key;
    if not found then
      perform imobdesk.erro('INVALID_INPUT', format('Meta desconhecida: %s.', r.key), r.key);
    end if;
  end loop;
  perform imobdesk.registrar_auditoria(v_ator, 'gerencial', 'metas_alteradas', 'Metas da visão gerencial alteradas',
    v_antes, imobdesk.ch_gerencial_metas(), null);
  return imobdesk.ch_gerencial_metas();
end;
$$;

-- ---------- Dados: todos os tickets que a pessoa pode ver, enxutos, dos últimos p_meses ----------
/**
 * {generated_at, metas, tickets: [{id, criadoEm, assumidoEm, primeiraRespostaEm, encerradoEm, slaRespostaAte,
 *  slaSolucaoAte, slaManual, slaPausadoDesde, ultimaAcaoEm, status, categoriaStatus, setor, equipe, servico,
 *  categoria, urgencia, origem, responsavelId, responsavel, solicitante, departamento, reaberturas, acoesPublicas, ia}]}
 * Ficam de fora excluídos e mesclados. Tickets abertos entram sempre, mesmo que antigos.
 * Os cálculos (KPIs, séries, projeções, alertas) são feitos no front a partir destas linhas.
 */
create or replace function imobdesk.ch_gerencial(p_meses int default 13)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_meses int := least(greatest(coalesce(p_meses, 13), 1), 36);
  v_agora timestamptz := now();
  v_inicio timestamptz := date_trunc('month', (v_agora at time zone 'America/Sao_Paulo') - make_interval(months => v_meses - 1)) at time zone 'America/Sao_Paulo';
begin
  if not imobdesk.ch_gerencial_pode() then
    perform imobdesk.erro('FORBIDDEN', 'Sem acesso à visão gerencial.');
  end if;
  return (
    with encerra as (
      select s.id from imobdesk.ch_status s where s.categoria in ('resolvido', 'fechado', 'cancelado')
    ), vis as (
      select t.* from imobdesk.ch_tickets t
      where t.excluido_em is null and t.mesclado_em_id is null
        and (t.encerrado_em is null or t.criado_em >= v_inicio or t.encerrado_em >= v_inicio)
        and imobdesk.ch_pode_ver_ticket(t.setor_id, t.equipe_id, t.responsavel_id)
    )
    select jsonb_build_object(
      'generated_at', v_agora,
      'inicio', v_inicio,
      'metas', coalesce((select jsonb_object_agg(m.chave, m.valor) from imobdesk.ch_gerencial_metas m), '{}'::jsonb),
      'tickets', coalesce((select jsonb_agg(jsonb_build_object(
          'id', t.id,
          'assunto', t.assunto,
          'criadoEm', t.criado_em,
          'assumidoEm', t.assumido_em,
          'primeiraRespostaEm', t.primeira_resposta_em,
          'encerradoEm', t.encerrado_em,
          'slaRespostaAte', t.sla_resposta_ate,
          'slaSolucaoAte', t.sla_solucao_ate,
          'slaManual', t.sla_manual,
          'slaPausadoDesde', t.sla_pausado_desde,
          'ultimaAcaoEm', (select max(a.criado_em) from imobdesk.ch_ticket_acoes a where a.ticket_id = t.id),
          'status', st.nome,
          'categoriaStatus', st.categoria,
          'setor', (select s.nome from imobdesk.at_setores s where s.id = t.setor_id),
          'equipe', (select e.nome from imobdesk.at_equipes e where e.id = t.equipe_id),
          'servico', (select s.nome from imobdesk.ch_servicos s where s.id = t.servico_id),
          'categoria', (select c.nome from imobdesk.ch_categorias c where c.id = t.categoria_id),
          'urgencia', (select u.nome from imobdesk.ch_urgencias u where u.id = t.urgencia_id),
          'origem', t.origem,
          'responsavelId', t.responsavel_id,
          'responsavel', case when t.responsavel_id is null then null else imobdesk.ch_nome_usuario(t.responsavel_id) end,
          'solicitante', t.solicitante_nome,
          'departamento', (select e.nome from imobdesk.at_pessoa_relacoes r
                           join imobdesk.at_pessoas e on e.id = r.empresa_id and e.tipo = 'departamento'
                           where r.pessoa_id = t.solicitante_pessoa_id order by e.nome limit 1),
          -- Reaberto = saiu de um status encerrado para um não encerrado.
          'reaberturas', (select count(*) from imobdesk.ch_ticket_eventos ev
                          where ev.ticket_id = t.id and ev.tipo = 'status'
                            and (ev.de ->> 'statusId')::bigint in (select id from encerra)
                            and (ev.para ->> 'statusId')::bigint not in (select id from encerra)),
          'acoesPublicas', (select count(*) from imobdesk.ch_ticket_acoes a where a.ticket_id = t.id and a.tipo = 'publica'),
          'ia', (select i.situacao from imobdesk.ch_ticket_ia i where i.ticket_id = t.id order by i.id desc limit 1)
        ) order by t.id)
        from vis t join imobdesk.ch_status st on st.id = t.status_id), '[]'::jsonb)
    )
  );
end;
$$;

-- ---------- Alertas no sino: dias úteis às 8h (America/Sao_Paulo) para quem tem a visão gerencial ----------
/**
 * Confere os limites (metas) sobre os tickets abertos e avisa, no sino, cada pessoa com acesso à visão gerencial
 * (só o que ela pode ver). Um aviso por regra por dia. Devolve quantos avisos foram criados.
 */
create or replace function imobdesk.ch_gerencial_alertas_notificar()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  u record;
  v_total int := 0;
  v_vencidos int;
  v_sem_resp int;
  v_backlog int;
  v_parados int;
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_lim_vencidos numeric := (select valor from imobdesk.ch_gerencial_metas where chave = 'vencidos_max');
  v_lim_sem_resp numeric := (select valor from imobdesk.ch_gerencial_metas where chave = 'sem_responsavel_max');
  v_lim_backlog numeric := (select valor from imobdesk.ch_gerencial_metas where chave = 'backlog_max');
  v_lim_parado numeric := (select valor from imobdesk.ch_gerencial_metas where chave = 'parado_dias');
begin
  for u in
    select us.id
    from imobdesk.usuarios us
    where us.status = 'active'
      and (us.perfil_key in ('admin', 'super_admin') or imobdesk.tem_permissao_de(us.id, 'gestao_chamados_gerencial'))
  loop
    -- Só o que a pessoa pode ver: admin/supervisão vê tudo; gestor, o setor; agente com a permissão, as equipes.
    with vis as (
      select t.* from imobdesk.ch_tickets t
      join imobdesk.ch_status st on st.id = t.status_id
      where t.excluido_em is null and t.mesclado_em_id is null and t.encerrado_em is null
        and st.categoria not in ('resolvido', 'fechado', 'cancelado')
        and (imobdesk.perfil_de(u.id) in ('admin', 'super_admin')
             or imobdesk.tem_permissao_de(u.id, 'gestao_atendimento_supervisao')
             or t.responsavel_id = u.id
             or exists (select 1 from imobdesk.at_setor_gestores g where g.setor_id = t.setor_id and g.usuario_id = u.id)
             or (t.equipe_id is not null and exists (select 1 from imobdesk.at_equipe_membros m where m.equipe_id = t.equipe_id and m.usuario_id = u.id)))
    )
    select count(*) filter (where t.sla_solucao_ate < now() and t.sla_pausado_desde is null),
           count(*) filter (where t.responsavel_id is null),
           count(*),
           count(*) filter (where coalesce((select max(a.criado_em) from imobdesk.ch_ticket_acoes a where a.ticket_id = t.id), t.criado_em) < now() - make_interval(days => v_lim_parado::int))
      into v_vencidos, v_sem_resp, v_backlog, v_parados
    from vis t;

    if v_vencidos > v_lim_vencidos then
      v_total := v_total + imobdesk.ch_gerencial_aviso(u.id, v_hoje, 'Gerencial: SLA vencido acima do limite',
        format('%s tickets abertos com o prazo de solução vencido (limite: %s).', v_vencidos, v_lim_vencidos));
    end if;
    if v_sem_resp > v_lim_sem_resp then
      v_total := v_total + imobdesk.ch_gerencial_aviso(u.id, v_hoje, 'Gerencial: tickets sem responsável',
        format('%s tickets abertos sem responsável (limite: %s).', v_sem_resp, v_lim_sem_resp));
    end if;
    if v_backlog > v_lim_backlog then
      v_total := v_total + imobdesk.ch_gerencial_aviso(u.id, v_hoje, 'Gerencial: backlog acima do limite',
        format('%s tickets abertos ao mesmo tempo (limite: %s).', v_backlog, v_lim_backlog));
    end if;
    if v_parados > 0 then
      v_total := v_total + imobdesk.ch_gerencial_aviso(u.id, v_hoje, 'Gerencial: tickets parados',
        format('%s tickets abertos há mais de %s dias sem nenhuma ação.', v_parados, v_lim_parado));
    end if;
  end loop;
  return v_total;
end;
$$;

/** Um aviso por regra por dia e por pessoa (o título identifica a regra). Devolve 1 se criou. */
create or replace function imobdesk.ch_gerencial_aviso(p_usuario uuid, p_dia date, p_titulo text, p_texto text)
returns int
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from imobdesk.ch_notificacoes n
             where n.usuario_id = p_usuario and n.titulo = p_titulo and (n.criado_em at time zone 'America/Sao_Paulo')::date = p_dia) then
    return 0;
  end if;
  insert into imobdesk.ch_notificacoes (usuario_id, ticket_id, titulo, texto) values (p_usuario, null, p_titulo, p_texto);
  return 1;
end;
$$;

/** "Enviar alertas agora" (tela Alertas): só Admin e Super admin. */
create or replace function imobdesk.ch_gerencial_alertas_enviar()
returns int
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not imobdesk.ch_eh_admin() then
    perform imobdesk.erro('FORBIDDEN', 'Só Admin e Super admin disparam os alertas.');
  end if;
  return imobdesk.ch_gerencial_alertas_notificar();
end;
$$;

-- ---------- Permissões de execução ----------
do $$
declare
  f text;
begin
  foreach f in array array['ch_gerencial_pode()', 'ch_gerencial_metas()', 'ch_gerencial_metas_salvar(jsonb)', 'ch_gerencial(int)', 'ch_gerencial_alertas_enviar()'] loop
    execute format('revoke execute on function imobdesk.%s from public, anon', f);
    execute format('grant execute on function imobdesk.%s to authenticated, service_role', f);
  end loop;
  foreach f in array array['ch_gerencial_alertas_notificar()', 'ch_gerencial_aviso(uuid, date, text, text)'] loop
    execute format('revoke execute on function imobdesk.%s from public, anon, authenticated', f);
    execute format('grant execute on function imobdesk.%s to service_role', f);
  end loop;
end;
$$;

-- ---------- pg_cron: dias úteis às 8h de São Paulo (11h UTC) ----------
do $$
begin
  if to_regnamespace('cron') is null then
    return;
  end if;
  if exists (select 1 from cron.job where jobname = 'imobdesk-gerencial-alertas') then
    perform cron.unschedule('imobdesk-gerencial-alertas');
  end if;
  perform cron.schedule('imobdesk-gerencial-alertas', '0 11 * * 1-5', 'select imobdesk.ch_gerencial_alertas_notificar()');
end;
$$;

notify pgrst, 'reload schema';
