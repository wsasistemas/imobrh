-- Gestão de Atendimento — F2 (3/3): Monitor do gestor. Indicadores do período (com o período anterior
-- equivalente), acompanhamento de atendentes e conversas abertas. Só para a supervisão geral (todos os
-- setores) e para o gestor (só os setores dele). Só aditiva.
--
-- Definições (aprovadas em 06/10/2026):
--   atendida          ticket encerrado no período que alguém assumiu
--   resolvida no 1º   atendida sem transferência, sem voltar à fila e sem o cliente voltar em 24 h
--   fora do horário   entrou na fila com o setor fechado ou sem atendente online
--   espera            da entrada na fila até alguém assumir
--   atendimento       de assumir até encerrar

-- Setores que quem chama pode monitorar (p_setor null = todos os permitidos).
create or replace function imobdesk.at_monitor_setores(p_setor bigint default null)
returns bigint[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v bigint[];
begin
  if imobdesk.at_supervisor() then
    select coalesce(array_agg(s.id), '{}') into v from imobdesk.at_setores s where p_setor is null or s.id = p_setor;
  elsif imobdesk.tem_permissao('gestao_atendimento_monitor') then
    select coalesce(array_agg(g.setor_id), '{}') into v from imobdesk.at_setor_gestores g
    where g.usuario_id = auth.uid() and (p_setor is null or g.setor_id = p_setor);
  else
    v := '{}';
  end if;
  if coalesce(cardinality(v), 0) = 0 then
    perform imobdesk.erro('FORBIDDEN', 'O Monitor é da gestão do setor e da supervisão geral.');
  end if;
  return v;
end;
$$;

-- Números de uma janela [ini, fim) (interna).
create or replace function imobdesk.at_indicadores_janela(p_ini timestamptz, p_fim timestamptz, p_setores bigint[])
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with t as (select * from imobdesk.at_atendimentos a where a.setor_id = any (p_setores)),
  enc as (select * from t where t.encerrado_em >= p_ini and t.encerrado_em < p_fim and t.assumido_em is not null)
  select jsonb_build_object(
    'atendidas', (select count(*) from enc),
    'resolvidas1o', (select count(*) from enc where enc.transferencias = 0 and not enc.devolvido_fila and not enc.reaberto_em_24h),
    'foraHorario', (select count(*) from t where t.entrou_fila_em >= p_ini and t.entrou_fila_em < p_fim and t.fora_horario),
    'esperaMediaSeg', (select round(avg(extract(epoch from (t.assumido_em - t.entrou_fila_em)))) from t
                       where t.assumido_em >= p_ini and t.assumido_em < p_fim),
    'atendimentoMedioSeg', (select round(avg(extract(epoch from (enc.encerrado_em - enc.assumido_em)))) from enc)
  );
$$;

-- p_periodo: hoje | semana | mes. O anterior é a mesma duração a partir do início do período anterior
-- (ex.: "este mês até agora" × "mês passado até o mesmo dia e hora").
create or replace function imobdesk.at_monitor_indicadores(p_periodo text, p_setor bigint default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_setores bigint[] := imobdesk.at_monitor_setores(p_setor);
  v_unidade text := case p_periodo when 'hoje' then 'day' when 'semana' then 'week' when 'mes' then 'month' end;
  v_tz text := 'America/Sao_Paulo';
  v_ini timestamptz;
  v_ini_ant timestamptz;
  v_dur interval;
begin
  if v_unidade is null then
    perform imobdesk.erro('INVALID_INPUT', 'Período inválido (hoje, semana ou mes).');
  end if;
  v_ini := date_trunc(v_unidade, now() at time zone v_tz) at time zone v_tz;
  v_dur := now() - v_ini;
  v_ini_ant := date_trunc(v_unidade, (v_ini - interval '1 second') at time zone v_tz) at time zone v_tz;
  return jsonb_build_object(
    'inicio', v_ini,
    'atual', imobdesk.at_indicadores_janela(v_ini, now(), v_setores),
    'anterior', imobdesk.at_indicadores_janela(v_ini_ant, v_ini_ant + v_dur, v_setores)
  );
end;
$$;

-- Acompanhamento de atendentes: online = sinal da Central nos últimos 3 min; disponível = apto, sem pausa,
-- online e abaixo do limite do setor.
create or replace function imobdesk.at_monitor_atendentes(p_setor bigint default null)
returns table (
  usuario_id uuid, nome text, setor_id bigint, setor_nome text, online boolean, apto boolean, pausa boolean,
  em_atendimento int, limite int, atendidas_hoje int, tempo_medio_seg numeric
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_setores bigint[] := imobdesk.at_monitor_setores(p_setor);
  v_hoje timestamptz := date_trunc('day', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo';
begin
  return query
    select a.usuario_id, u.nome, a.setor_id, s.nome,
           coalesce(a.online_em > now() - interval '3 minutes', false), a.apto, a.pausa,
           (select count(*)::int from imobdesk.at_conversas c where c.atendente_id = a.usuario_id and c.modo = 'atendente'),
           s.limite_simultaneo,
           (select count(*)::int from imobdesk.at_atendimentos t
             where t.atendente_id = a.usuario_id and t.encerrado_em >= v_hoje and t.assumido_em is not null),
           (select round(avg(extract(epoch from (t.encerrado_em - t.assumido_em)))) from imobdesk.at_atendimentos t
             where t.atendente_id = a.usuario_id and t.encerrado_em >= v_hoje and t.assumido_em is not null)
    from imobdesk.at_atendentes a
    join imobdesk.usuarios u on u.id = a.usuario_id
    join imobdesk.at_setores s on s.id = a.setor_id
    where a.setor_id = any (v_setores)
    order by s.nome, u.nome;
end;
$$;

-- Conversas aguardando (fila) e em atendimento, com o ticket e os tempos.
create or replace function imobdesk.at_monitor_conversas(p_setor bigint default null)
returns table (
  conversa_id bigint, ticket bigint, setor_id bigint, setor_nome text, nome_contato text, telefone text, numero text,
  modo text, ultima_previa text, fila_desde timestamptz, atendente_id uuid, atendente_nome text, atendente_desde timestamptz,
  ultima_msg_cliente_em timestamptz, ultima_msg_atendente_em timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_setores bigint[] := imobdesk.at_monitor_setores(p_setor);
begin
  return query
    select c.id, c.atendimento_id, c.setor_id, s.nome, c.nome_contato, c.telefone, n.numero,
           c.modo, c.ultima_previa, c.fila_desde, c.atendente_id, u.nome, c.atendente_desde,
           c.ultima_msg_cliente_em, c.ultima_msg_atendente_em
    from imobdesk.at_conversas c
    join imobdesk.at_setores s on s.id = c.setor_id
    join imobdesk.at_numeros n on n.id = c.numero_id
    left join imobdesk.usuarios u on u.id = c.atendente_id
    where c.setor_id = any (v_setores) and c.modo in ('fila', 'atendente')
    order by c.modo, coalesce(c.fila_desde, c.atendente_desde);
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'imobdesk.at_monitor_setores(bigint)', 'imobdesk.at_monitor_indicadores(text, bigint)',
    'imobdesk.at_monitor_atendentes(bigint)', 'imobdesk.at_monitor_conversas(bigint)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
  revoke execute on function imobdesk.at_indicadores_janela(timestamptz, timestamptz, bigint[]) from public, anon, authenticated;
  grant execute on function imobdesk.at_indicadores_janela(timestamptz, timestamptz, bigint[]) to service_role;
end;
$$;

notify pgrst, 'reload schema';
