-- Imobdesk · parte 4 de 4 (20261017120000_imobdesk_sf_aprovacao.sql … 20261024000200_imobdesk_empresa_edge.sql).
-- Cole no SQL Editor do ikvj e rode. Tudo numa transação.
begin;

-- ======================================== 20261017120000_imobdesk_sf_aprovacao.sql
-- Solicitações Financeiras, Fase 3: aprovação (CONTEXTO.md, seções 2, 4 e 6; telas 5 e 6).
-- Decisão do aprovador (aprovar, devolver, reprovar; comentário obrigatório nos dois últimos) nos três modos
-- (sequencial, paralelo, qualquer um, congelado no envio), substituto por período, job de prazos (lembrete com 25% do
-- prazo e escalonamento ao substituto) e notificações: aviso no sino do portal (ch_notificacoes, agora com link) e
-- e-mail pela conta padrão do setor financeiro (fila sf_email_fila; Edge Function imobdesk-sf-email).
-- Só aditiva: colunas, tabelas, gatilhos e funções novas; sf_pode_ver e ch_notificacoes_lista redefinidas com acréscimos.

-- ---------- Colunas ----------
alter table imobdesk.sf_solicitacao add column if not exists modo_aprovacao text
  check (modo_aprovacao in ('sequencial', 'paralelo', 'qualquer_um'));
alter table imobdesk.sf_aprovacao add column if not exists iniciado_em timestamptz;
alter table imobdesk.ch_notificacoes add column if not exists link text check (link ~ '^/');

-- Modo congelado no envio (como a cadeia): vem do setor quando a solicitação entra em aprovação.
create or replace function imobdesk.sf_solicitacao_modo()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'em_aprovacao' and old.status is distinct from 'em_aprovacao' then
    new.modo_aprovacao := coalesce((select s.sf_modo_aprovacao from imobdesk.at_setores s where s.id = new.setor_id), 'sequencial');
  end if;
  return new;
end;
$$;
drop trigger if exists sf_solicitacao_modo on imobdesk.sf_solicitacao;
create trigger sf_solicitacao_modo before update of status on imobdesk.sf_solicitacao
  for each row execute function imobdesk.sf_solicitacao_modo();

-- Quando a etapa passa a "aguardando": início da contagem do prazo.
create or replace function imobdesk.sf_aprovacao_inicio()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'aguardando' and (tg_op = 'INSERT' or old.status is distinct from 'aguardando') then
    new.iniciado_em := now();
  end if;
  return new;
end;
$$;
drop trigger if exists sf_aprovacao_inicio on imobdesk.sf_aprovacao;
create trigger sf_aprovacao_inicio before insert or update of status on imobdesk.sf_aprovacao
  for each row execute function imobdesk.sf_aprovacao_inicio();

-- ---------- Substituto por período ----------
create table if not exists imobdesk.sf_substituicao (
  id             bigint      generated always as identity primary key,
  aprovador_id   uuid        not null references imobdesk.usuarios (id) on delete cascade,
  substituto_id  uuid        not null references imobdesk.usuarios (id) on delete cascade,
  de             date        not null,
  ate            date        not null,
  criado_em      timestamptz not null default now(),
  check (ate >= de),
  check (substituto_id <> aprovador_id)
);
create index if not exists sf_substituicao_aprovador_idx on imobdesk.sf_substituicao (aprovador_id, de, ate);
create index if not exists sf_substituicao_substituto_idx on imobdesk.sf_substituicao (substituto_id, de, ate);

-- ---------- Fila de e-mail ----------
create table if not exists imobdesk.sf_email_fila (
  id              bigint      generated always as identity primary key,
  usuario_id      uuid        references imobdesk.usuarios (id) on delete cascade,
  para            text        not null,
  assunto         text        not null,
  texto           text        not null,
  solicitacao_id  bigint      references imobdesk.sf_solicitacao (id) on delete cascade,
  status          text        not null default 'pendente' check (status in ('pendente', 'enviado', 'falha')),
  tentativas      int         not null default 0,
  erro            text,
  criado_em       timestamptz not null default now(),
  enviado_em      timestamptz
);
create index if not exists sf_email_fila_pendente_idx on imobdesk.sf_email_fila (criado_em) where status = 'pendente';

do $$
declare
  t text;
begin
  foreach t in array array['sf_substituicao', 'sf_email_fila'] loop
    execute format('alter table imobdesk.%I enable row level security', t);
    execute format('revoke all on imobdesk.%I from anon, public, authenticated', t);
    execute format('grant all on imobdesk.%I to service_role', t);
  end loop;
end;
$$;

-- ---------- Quem decide ----------

/** O usuário responde por este aprovador hoje (substituto por período)? */
create or replace function imobdesk.sf_responde_por(p_usuario uuid, p_aprovador uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_usuario = p_aprovador
      or exists (select 1 from imobdesk.sf_substituicao x
                 where x.aprovador_id = p_aprovador and x.substituto_id = p_usuario and current_date between x.de and x.ate);
$$;

/**
 * Visibilidade (redefinida com acréscimos): solicitante; admin; quem é ou foi etapa (aprovador, substituto da etapa ou
 * substituto por período); aprovador cadastrado no setor (aba "Todas do setor", fora o rascunho); financeiro de
 * em_conferencia em diante.
 */
create or replace function imobdesk.sf_pode_ver(p_solicitacao bigint)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from imobdesk.sf_solicitacao s
    where s.id = p_solicitacao
      and (s.solicitante_id = (select auth.uid())
           or imobdesk.ch_eh_admin()
           or exists (select 1 from imobdesk.sf_aprovacao a
                      where a.solicitacao_id = s.id
                        and ((select auth.uid()) = a.substituto_id or imobdesk.sf_responde_por((select auth.uid()), a.aprovador_id)))
           or (s.status <> 'rascunho' and exists (select 1 from imobdesk.sf_setor_aprovador sa
                                                   where sa.setor_id = s.setor_id and sa.ativo and (select auth.uid()) in (sa.aprovador_id, sa.substituto_id)))
           or (imobdesk.sf_status_financeiro(s.status) and imobdesk.sf_eh_financeiro((select auth.uid()))))
  );
$$;

/** Etapa do ciclo atual que o usuário pode decidir agora (nulo se nenhuma). */
create or replace function imobdesk.sf_etapa_do_usuario(p_solicitacao bigint, p_usuario uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select a.id
  from imobdesk.sf_aprovacao a
  join imobdesk.sf_solicitacao s on s.id = a.solicitacao_id and a.ciclo = s.ciclo
  where a.solicitacao_id = p_solicitacao and s.status = 'em_aprovacao' and a.status = 'aguardando'
    and (p_usuario = a.substituto_id or imobdesk.sf_responde_por(p_usuario, a.aprovador_id))
  order by a.nivel
  limit 1;
$$;

-- ---------- Notificações ----------

/** Aviso no sino do portal + e-mail (fila). */
create or replace function imobdesk.sf_notificar(p_usuario uuid, p_solicitacao bigint, p_titulo text, p_texto text, p_link text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
  v_link text := coalesce(p_link, '/financeiro/solicitacoes/' || p_solicitacao);
begin
  if p_usuario is null then return; end if;
  select u.email into v_email from imobdesk.usuarios u where u.id = p_usuario and u.status = 'active';
  if v_email is null then return; end if;
  insert into imobdesk.ch_notificacoes (usuario_id, titulo, texto, link) values (p_usuario, left(p_titulo, 200), left(coalesce(p_texto, ''), 600), v_link);
  insert into imobdesk.sf_email_fila (usuario_id, para, assunto, texto, solicitacao_id)
  values (p_usuario, v_email, left(p_titulo, 200),
          coalesce(p_texto, '') || E'\n\nAbra no Imobdesk: ' || v_link || E'\n\nMensagem automática das Solicitações Financeiras.',
          p_solicitacao);
end;
$$;

create or replace function imobdesk.sf_notificar_financeiro(p_solicitacao bigint, p_titulo text, p_texto text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  u record;
begin
  for u in select x.id from imobdesk.usuarios x where x.status = 'active' and imobdesk.sf_eh_financeiro(x.id) loop
    perform imobdesk.sf_notificar(u.id, p_solicitacao, p_titulo, p_texto, '/financeiro/solicitacoes/' || p_solicitacao);
  end loop;
end;
$$;

create or replace function imobdesk.sf_rotulo(p_solicitacao bigint)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select s.numero || ' · ' || case s.tipo when 'reembolso' then 'Reembolso' when 'fundo_fixo' then 'Fundo fixo' else 'Adiantamento' end
         || ' · R$ ' || translate(to_char(coalesce(s.valor_adiantamento, s.total_despesas), 'FM999,999,990.00'), ',.', '.,') || ' · ' || u.nome
  from imobdesk.sf_solicitacao s join imobdesk.usuarios u on u.id = s.solicitante_id
  where s.id = p_solicitacao;
$$;

/** Etapa passou a "aguardando": avisa o aprovador. */
create or replace function imobdesk.sf_aprovacao_avisar()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'aguardando' and (tg_op = 'INSERT' or old.status is distinct from 'aguardando') then
    perform imobdesk.sf_notificar(new.aprovador_id, new.solicitacao_id, 'Aprovação pendente: ' || imobdesk.sf_rotulo(new.solicitacao_id),
      format('Você é a etapa %s (%s). Prazo: %s.', new.nivel, new.papel, coalesce(to_char(new.prazo_em at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI'), 'sem prazo')));
  end if;
  return null;
end;
$$;
drop trigger if exists sf_aprovacao_avisar on imobdesk.sf_aprovacao;
create trigger sf_aprovacao_avisar after insert or update of status on imobdesk.sf_aprovacao
  for each row execute function imobdesk.sf_aprovacao_avisar();

/** Mudança de status da solicitação: avisa o solicitante e, ao chegar na conferência, o Financeiro. */
create or replace function imobdesk.sf_status_avisar()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rot text := imobdesk.sf_rotulo(new.id);
  v_coment text;
begin
  if new.status is not distinct from old.status then return null; end if;
  select a.comentario into v_coment from imobdesk.sf_aprovacao a
  where a.solicitacao_id = new.id and a.ciclo = new.ciclo and a.status in ('devolvido', 'reprovado') order by a.decidido_em desc nulls last limit 1;
  case new.status
    when 'em_aprovacao' then
      perform imobdesk.sf_notificar(new.solicitante_id, new.id, 'Enviada para aprovação: ' || v_rot, 'Você será avisado a cada etapa.');
    when 'devolvida' then
      perform imobdesk.sf_notificar(new.solicitante_id, new.id, 'Devolvida para ajuste: ' || v_rot,
        'Comentário: ' || coalesce(v_coment, '—') || E'\nCorrija e envie de novo: a aprovação recomeça do nível 1.');
    when 'reprovada' then
      perform imobdesk.sf_notificar(new.solicitante_id, new.id, 'Reprovada: ' || v_rot, 'Comentário: ' || coalesce(v_coment, '—'));
    when 'em_conferencia' then
      perform imobdesk.sf_notificar(new.solicitante_id, new.id, 'Aprovada, foi para o Financeiro: ' || v_rot,
        case when new.pagar_ate is not null then 'Pagamento até ' || to_char(new.pagar_ate, 'DD/MM/YYYY') || '.' else 'Conferência financeira.' end);
      perform imobdesk.sf_notificar_financeiro(new.id, 'Chegou na conferência: ' || v_rot,
        case when new.pagar_ate is not null then 'Pagar até ' || to_char(new.pagar_ate, 'DD/MM/YYYY') || '.' else '' end);
    when 'pendencia_solicitante' then
      perform imobdesk.sf_notificar(new.solicitante_id, new.id, 'Pendência na conferência: ' || v_rot, 'O Financeiro pediu um ajuste.');
    when 'lancamento_gerado' then
      perform imobdesk.sf_notificar(new.solicitante_id, new.id, 'Lançamento gerado no SIENGE: ' || v_rot, '');
    when 'pagamento_programado' then
      perform imobdesk.sf_notificar(new.solicitante_id, new.id, 'Pagamento programado: ' || v_rot,
        case when new.pagar_ate is not null then 'Até ' || to_char(new.pagar_ate, 'DD/MM/YYYY') || '.' else '' end);
    when 'paga' then
      perform imobdesk.sf_notificar(new.solicitante_id, new.id, 'Paga: ' || v_rot, '');
    else
      null;
  end case;
  return null;
end;
$$;
drop trigger if exists sf_status_avisar on imobdesk.sf_solicitacao;
create trigger sf_status_avisar after update of status on imobdesk.sf_solicitacao
  for each row execute function imobdesk.sf_status_avisar();

-- ---------- Decisão ----------

/** Última aprovação do ciclo: vai para a conferência; reembolso e fundo fixo, pagar até = hoje + 15 dias. */
create or replace function imobdesk.sf_concluir_aprovacao(p_solicitacao bigint)
returns void
language sql
security definer
set search_path = ''
as $$
  update imobdesk.sf_solicitacao
     set status = 'em_conferencia', etapa_atual = null, ultima_aprovacao_em = now(), atualizado_em = now(),
         pagar_ate = case when tipo in ('reembolso', 'fundo_fixo') then current_date + 15 else vencimento end
   where id = p_solicitacao;
$$;

/**
 * Aprovar, devolver (volta ao colaborador; o reenvio abre ciclo novo do nível 1) ou reprovar (fim).
 * Sequencial: libera o próximo nível exigido. Paralelo: conclui quando todos aprovarem. Qualquer um: o 1º que aprovar conclui.
 */
create or replace function imobdesk.sf_decidir_aprovacao(p_id bigint, p_decisao text, p_comentario text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.sf_exigir_login();
  v_etapa bigint := imobdesk.sf_etapa_do_usuario(p_id, v_uid);
  e imobdesk.sf_aprovacao;
  s imobdesk.sf_solicitacao;
  v_coment text := nullif(btrim(coalesce(p_comentario, '')), '');
  v_prox imobdesk.sf_aprovacao;
  v_prazo int;
  v_total int;
begin
  if p_decisao not in ('aprovar', 'devolver', 'reprovar') then
    perform imobdesk.erro('INVALID_INPUT', 'Decisão inválida.', 'decisao');
  end if;
  if v_etapa is null then
    perform imobdesk.erro('FORBIDDEN', 'Esta solicitação não está aguardando a sua aprovação.');
  end if;
  if p_decisao <> 'aprovar' and v_coment is null then
    perform imobdesk.erro('INVALID_INPUT', 'Escreva o motivo para devolver ou reprovar.', 'comentario');
  end if;
  select * into e from imobdesk.sf_aprovacao where id = v_etapa for update;
  select * into s from imobdesk.sf_solicitacao where id = p_id for update;

  update imobdesk.sf_aprovacao
     set status = case p_decisao when 'aprovar' then 'aprovado' when 'devolver' then 'devolvido' else 'reprovado' end,
         comentario = left(v_coment, 2000), decidido_em = now(), decidido_por = v_uid
   where id = v_etapa;
  perform imobdesk.sf_registrar_evento(p_id, 'aprovacao_' || p_decisao,
    jsonb_build_object('nivel', e.nivel, 'papel', e.papel, 'comentario', v_coment, 'emNomeDe', case when v_uid <> e.aprovador_id then e.aprovador_id end));

  if p_decisao <> 'aprovar' then
    -- Fecha o ciclo: as demais etapas deixam de valer.
    update imobdesk.sf_aprovacao set status = 'nao_exigido', prazo_em = null
     where solicitacao_id = p_id and ciclo = s.ciclo and status in ('aguardando', 'pendente');
    update imobdesk.sf_solicitacao set status = case p_decisao when 'devolver' then 'devolvida' else 'reprovada' end,
           etapa_atual = null, atualizado_em = now()
     where id = p_id;
    return jsonb_build_object('status', case p_decisao when 'devolver' then 'devolvida' else 'reprovada' end);
  end if;

  select count(*) into v_total from imobdesk.sf_aprovacao where solicitacao_id = p_id and ciclo = s.ciclo and status not in ('nao_exigido', 'pulado');
  if coalesce(s.modo_aprovacao, 'sequencial') = 'qualquer_um' then
    update imobdesk.sf_aprovacao set status = 'pulado', prazo_em = null
     where solicitacao_id = p_id and ciclo = s.ciclo and status in ('aguardando', 'pendente');
  end if;

  if exists (select 1 from imobdesk.sf_aprovacao where solicitacao_id = p_id and ciclo = s.ciclo and status = 'aguardando') then
    -- Paralelo: ainda faltam aprovadores.
    perform imobdesk.sf_notificar(s.solicitante_id, p_id, format('%s aprovou: %s', e.papel, imobdesk.sf_rotulo(p_id)), 'Aguardando os demais aprovadores.');
    return jsonb_build_object('status', 'em_aprovacao');
  end if;

  select * into v_prox from imobdesk.sf_aprovacao
  where solicitacao_id = p_id and ciclo = s.ciclo and status = 'pendente' order by nivel limit 1;
  if v_prox.id is not null then
    select st.sf_prazo_horas into v_prazo from imobdesk.at_setores st where st.id = s.setor_id;
    update imobdesk.sf_aprovacao set status = 'aguardando', prazo_em = now() + make_interval(hours => coalesce(v_prazo, 48)) where id = v_prox.id;
    update imobdesk.sf_solicitacao set etapa_atual = v_prox.nivel, atualizado_em = now() where id = p_id;
    perform imobdesk.sf_notificar(s.solicitante_id, p_id, format('%s aprovou: %s', e.papel, imobdesk.sf_rotulo(p_id)),
      format('Etapa %s de %s concluída. Próxima: %s.', e.nivel, v_total, v_prox.papel));
    return jsonb_build_object('status', 'em_aprovacao', 'proximo', v_prox.papel);
  end if;

  perform imobdesk.sf_concluir_aprovacao(p_id);
  return jsonb_build_object('status', 'em_conferencia');
end;
$$;

-- ---------- Substituto por período (o próprio aprovador define) ----------
create or replace function imobdesk.sf_substituto_definir(p jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.sf_exigir_login();
  v_sub uuid := nullif(p ->> 'substitutoId', '')::uuid;
  v_de date := nullif(p ->> 'de', '')::date;
  v_ate date := nullif(p ->> 'ate', '')::date;
  v_id bigint;
begin
  if not exists (select 1 from imobdesk.sf_setor_aprovador a where a.ativo and a.aprovador_id = v_uid) then
    perform imobdesk.erro('FORBIDDEN', 'Só aprovadores definem substituto.');
  end if;
  if v_sub is null or v_sub = v_uid or not exists (select 1 from imobdesk.usuarios u where u.id = v_sub and u.status = 'active') then
    perform imobdesk.erro('INVALID_INPUT', 'Escolha outra pessoa ativa como substituta.', 'substitutoId');
  end if;
  if v_de is null or v_ate is null or v_ate < v_de then
    perform imobdesk.erro('INVALID_INPUT', 'Informe o período (fim igual ou depois do início).', 'ate');
  end if;
  if v_ate < current_date then perform imobdesk.erro('INVALID_INPUT', 'O período já terminou.', 'ate'); end if;
  insert into imobdesk.sf_substituicao (aprovador_id, substituto_id, de, ate) values (v_uid, v_sub, v_de, v_ate) returning id into v_id;
  perform imobdesk.registrar_auditoria(v_uid, 'financeiro', 'update', 'Substituto de aprovação definido', null, p, v_id::text);
  return v_id;
end;
$$;

create or replace function imobdesk.sf_substituto_remover(p_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from imobdesk.sf_substituicao where id = p_id and aprovador_id = imobdesk.sf_exigir_login();
  if not found then perform imobdesk.erro('NOT_FOUND', 'Substituição não encontrada.'); end if;
end;
$$;

-- ---------- Leitura: fila do aprovador e extras do detalhe ----------

/**
 * Tela 5. Abas: 'aguardando' (etapas aguardando o usuário, incluindo como substituto), 'aprovadas' (decididas por ele)
 * e 'setor' (todas dos setores em que ele é aprovador, fora rascunho).
 */
create or replace function imobdesk.sf_aprovacoes_fila(p_aba text default 'aguardando')
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.sf_exigir_login();
begin
  return jsonb_build_object(
    'contagem', (select count(*) from imobdesk.sf_solicitacao s where imobdesk.sf_etapa_do_usuario(s.id, v_uid) is not null),
    'ehAprovador', exists (select 1 from imobdesk.sf_setor_aprovador a where a.ativo and v_uid in (a.aprovador_id, a.substituto_id))
                   or exists (select 1 from imobdesk.sf_substituicao x where x.substituto_id = v_uid and current_date between x.de and x.ate),
    'substituicoes', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'substituto', u.nome, 'de', x.de, 'ate', x.ate) order by x.de)
                               from imobdesk.sf_substituicao x join imobdesk.usuarios u on u.id = x.substituto_id
                               where x.aprovador_id = v_uid and x.ate >= current_date), '[]'),
    'usuarios', coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'nome', u.nome) order by u.nome)
                          from imobdesk.usuarios u where u.status = 'active' and u.id <> v_uid), '[]'),
    'lista', coalesce((
      select jsonb_agg(x order by (x ->> 'prazoEm') nulls last, (x ->> 'atualizadoEm') desc)
      from (
        select jsonb_build_object(
          'id', s.id, 'numero', s.numero, 'tipo', s.tipo, 'status', s.status, 'solicitante', us.nome,
          'setor', (select st.nome from imobdesk.at_setores st where st.id = s.setor_id),
          'valor', coalesce(s.valor_adiantamento, s.total_despesas), 'atualizadoEm', s.atualizado_em,
          'nivel', a.nivel, 'papel', a.papel,
          'de', (select count(*) from imobdesk.sf_aprovacao b where b.solicitacao_id = s.id and b.ciclo = s.ciclo and b.status not in ('nao_exigido', 'pulado')),
          'desde', a.iniciado_em, 'prazoEm', a.prazo_em, 'escaladoEm', a.escalado_em,
          'substitutoDe', case when a.aprovador_id <> v_uid then (select u.nome from imobdesk.usuarios u where u.id = a.aprovador_id) end,
          'alertas', (select count(*) from imobdesk.sf_regra_resultado r where r.solicitacao_id = s.id and r.resultado <> 'ok'),
          'decisao', d.status, 'decididoEm', d.decidido_em) x
        from imobdesk.sf_solicitacao s
        join imobdesk.usuarios us on us.id = s.solicitante_id
        left join lateral (select * from imobdesk.sf_aprovacao a0
                           where a0.solicitacao_id = s.id and a0.ciclo = s.ciclo and a0.status = 'aguardando' order by a0.nivel limit 1) a on true
        left join lateral (select * from imobdesk.sf_aprovacao d0
                           where d0.solicitacao_id = s.id and d0.decidido_por = v_uid order by d0.decidido_em desc limit 1) d on true
        where case coalesce(p_aba, 'aguardando')
                when 'aguardando' then imobdesk.sf_etapa_do_usuario(s.id, v_uid) is not null
                when 'aprovadas' then d.id is not null
                else s.status <> 'rascunho' and exists (select 1 from imobdesk.sf_setor_aprovador sa
                                                        where sa.setor_id = s.setor_id and sa.ativo and v_uid in (sa.aprovador_id, sa.substituto_id))
              end
        limit 200
      ) q), '[]')
  );
end;
$$;

/** Tela 6: o que o detalhe precisa além de sf_detalhe (decisão, checagens gravadas no envio). */
create or replace function imobdesk.sf_detalhe_extra(p_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.sf_exigir_login();
  v_etapa bigint;
begin
  if not imobdesk.sf_pode_ver(p_id) then perform imobdesk.erro('NOT_FOUND', 'Solicitação não encontrada.'); end if;
  v_etapa := imobdesk.sf_etapa_do_usuario(p_id, v_uid);
  return jsonb_build_object(
    'podeDecidir', v_etapa is not null,
    'etapa', (select jsonb_build_object('nivel', a.nivel, 'papel', a.papel, 'prazoEm', a.prazo_em,
                                        'emNomeDe', case when a.aprovador_id <> v_uid then (select u.nome from imobdesk.usuarios u where u.id = a.aprovador_id) end)
              from imobdesk.sf_aprovacao a where a.id = v_etapa),
    'regras', coalesce((select jsonb_agg(jsonb_build_object('codigo', r.regra_codigo, 'nome', g.nome, 'resultado', r.resultado, 'detalhe', r.detalhe, 'itemId', r.item_id)
                                         order by r.regra_codigo)
                        from imobdesk.sf_regra_resultado r join imobdesk.sf_regra g on g.codigo = r.regra_codigo
                        where r.solicitacao_id = p_id), '[]')
  );
end;
$$;

-- ---------- Job de prazos (pg_cron, 30 min) ----------
/**
 * Lembrete quando falta 25% do prazo; vencido: "escalar" avisa o substituto (que já pode decidir) e "lembrar" avisa de
 * novo o aprovador. Cada aviso uma vez por etapa (lembrete_em, escalado_em).
 */
create or replace function imobdesk.sf_prazos_job()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a record;
  v_lembretes int := 0;
  v_escalados int := 0;
begin
  for a in
    select x.*, st.sf_acao_prazo_vencido as acao
    from imobdesk.sf_aprovacao x
    join imobdesk.sf_solicitacao s on s.id = x.solicitacao_id and s.ciclo = x.ciclo and s.status = 'em_aprovacao'
    join imobdesk.at_setores st on st.id = s.setor_id
    where x.status = 'aguardando' and x.prazo_em is not null
  loop
    if a.escalado_em is null and now() > a.prazo_em then
      if a.acao = 'escalar' and a.substituto_id is not null then
        perform imobdesk.sf_notificar(a.substituto_id, a.solicitacao_id, 'Prazo vencido, aprovação escalada para você: ' || imobdesk.sf_rotulo(a.solicitacao_id),
          format('A etapa %s (%s) venceu. Como substituto, você pode decidir.', a.nivel, a.papel));
      end if;
      perform imobdesk.sf_notificar(a.aprovador_id, a.solicitacao_id, 'Prazo vencido: ' || imobdesk.sf_rotulo(a.solicitacao_id),
        format('A etapa %s (%s) venceu em %s.', a.nivel, a.papel, to_char(a.prazo_em at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI')));
      update imobdesk.sf_aprovacao set escalado_em = now(), lembrete_em = coalesce(lembrete_em, now()) where id = a.id;
      perform imobdesk.sf_registrar_evento(a.solicitacao_id, 'prazo_vencido', jsonb_build_object('nivel', a.nivel, 'acao', a.acao));
      v_escalados := v_escalados + 1;
    elsif a.lembrete_em is null and a.iniciado_em is not null and now() >= a.prazo_em - (a.prazo_em - a.iniciado_em) * 0.25 then
      perform imobdesk.sf_notificar(a.aprovador_id, a.solicitacao_id, 'Lembrete de aprovação: ' || imobdesk.sf_rotulo(a.solicitacao_id),
        format('Prazo até %s.', to_char(a.prazo_em at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI')));
      update imobdesk.sf_aprovacao set lembrete_em = now() where id = a.id;
      v_lembretes := v_lembretes + 1;
    end if;
  end loop;
  return jsonb_build_object('lembretes', v_lembretes, 'escalados', v_escalados);
end;
$$;

-- ---------- Envio de e-mail (Edge Function imobdesk-sf-email) ----------
/** Conta remetente: a conta padrão (Google) do setor financeiro. */
create or replace function imobdesk.sf_email_para_enviar(p_limite int default 30)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'conta', (select jsonb_build_object('id', c.id, 'email', c.email, 'remetente', coalesce(nullif(btrim(c.nome_remetente), ''), c.nome))
              from imobdesk.at_email_contas c join imobdesk.at_setores s on s.id = c.setor_id
              where s.sf_financeiro and c.habilitada and c.modo = 'oauth_google' and c.oauth_segredo_id is not null
              order by c.padrao_do_setor desc, c.id limit 1),
    'itens', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'para', f.para, 'assunto', f.assunto, 'texto', f.texto) order by f.criado_em)
                       from (select * from imobdesk.sf_email_fila where status = 'pendente' order by criado_em limit greatest(1, least(p_limite, 100))) f), '[]'));
$$;

create or replace function imobdesk.sf_email_resultado(p_id bigint, p_ok boolean, p_erro text)
returns void
language sql
security definer
set search_path = ''
as $$
  update imobdesk.sf_email_fila
     set tentativas = tentativas + 1,
         status = case when p_ok then 'enviado' when tentativas + 1 >= 3 then 'falha' else 'pendente' end,
         erro = case when p_ok then null else left(p_erro, 1000) end,
         enviado_em = case when p_ok then now() end
   where id = p_id;
$$;

-- ---------- Sino do portal com link (redefinida com o campo novo) ----------
create or replace function imobdesk.ch_notificacoes_lista()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'naoLidas', (select count(*) from imobdesk.ch_notificacoes n where n.usuario_id = (select auth.uid()) and n.lida_em is null),
    'itens', coalesce((select jsonb_agg(x) from (
       select jsonb_build_object('id', n.id, 'ticketId', n.ticket_id, 'titulo', n.titulo, 'texto', n.texto, 'link', n.link, 'lida', n.lida_em is not null, 'criadoEm', n.criado_em) x
         from imobdesk.ch_notificacoes n where n.usuario_id = (select auth.uid())
        order by n.criado_em desc limit 30) s), '[]'));
$$;

-- ---------- Permissões ----------
do $$
declare
  f text;
begin
  foreach f in array array['sf_decidir_aprovacao(bigint, text, text)', 'sf_substituto_definir(jsonb)', 'sf_substituto_remover(bigint)',
                           'sf_aprovacoes_fila(text)', 'sf_detalhe_extra(bigint)', 'ch_notificacoes_lista()'] loop
    execute format('revoke execute on function imobdesk.%s from public, anon', f);
    execute format('grant execute on function imobdesk.%s to authenticated, service_role', f);
  end loop;
  foreach f in array array['sf_solicitacao_modo()', 'sf_aprovacao_inicio()', 'sf_responde_por(uuid, uuid)', 'sf_etapa_do_usuario(bigint, uuid)',
                           'sf_notificar(uuid, bigint, text, text, text)', 'sf_notificar_financeiro(bigint, text, text)', 'sf_rotulo(bigint)',
                           'sf_aprovacao_avisar()', 'sf_status_avisar()', 'sf_concluir_aprovacao(bigint)', 'sf_prazos_job()',
                           'sf_email_para_enviar(int)', 'sf_email_resultado(bigint, boolean, text)'] loop
    execute format('revoke execute on function imobdesk.%s from public, anon, authenticated', f);
    execute format('grant execute on function imobdesk.%s to service_role', f);
  end loop;
end;
$$;

-- ---------- Agendamentos ----------
do $$
begin
  if exists (select 1 from cron.job where jobname = 'imobdesk-sf-prazos') then
    perform cron.unschedule('imobdesk-sf-prazos');
  end if;
  perform cron.schedule('imobdesk-sf-prazos', '*/30 * * * *', 'select imobdesk.sf_prazos_job()');
  if exists (select 1 from cron.job where jobname = 'imobdesk-sf-email') then
    perform cron.unschedule('imobdesk-sf-email');
  end if;
  perform cron.schedule('imobdesk-sf-email', '*/5 * * * *', $job$
    select net.http_post(
      url := 'https://ikvjaowvpvxojvcfwnct.supabase.co/functions/v1/imobdesk-sf-email',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-atendimento-chave', imobdesk.at_email_cron_chave()),
      body := '{"acao": "ciclo"}'::jsonb,
      timeout_milliseconds := 55000
    );
  $job$);
end;
$$;

notify pgrst, 'reload schema';

-- ======================================== 20261017130000_imobdesk_sf_ocr.sql
-- Solicitações Financeiras, Fase 4: leitura dos comprovantes (CONTEXTO.md, seção 5; telas 11 e 12).
-- A Edge Function imobdesk-sf-ocr transcreve o comprovante (API da Anthropic, chave no secret ANTHROPIC_API_KEY)
-- e grava aqui. Princípio: a IA NÃO sugere data, valor nem favorecido; campo com legibilidade abaixo do limiar da R02
-- volta nulo e o anexo fica "ilegivel". A única sugestão é o motivo, entre as categorias ativas.
-- Fluxo "adicionar por comprovante": o anexo entra sem linha (item_id nulo), é lido e, ao confirmar, vira linha com
-- origem ocr_confirmado (ou ocr_editado, se a pessoa mudou data, valor ou favorecido).
-- Checagens que dependem da leitura: R02, R04, R05, R06 (CNPJ + data + valor) e R07. sf_checagens redefinida com acréscimos.

-- ---------- Para a Edge Function ----------

/** Quem pede a leitura: o dono da solicitação editável. Devolve o que a função precisa. */
create or replace function imobdesk.sf_ocr_pedido(p_anexo bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a imobdesk.sf_anexo;
  s imobdesk.sf_solicitacao;
begin
  select * into a from imobdesk.sf_anexo where id = p_anexo;
  if not found then perform imobdesk.erro('NOT_FOUND', 'Anexo não encontrado.'); end if;
  s := imobdesk.sf_exigir_editavel(a.solicitacao_id);
  update imobdesk.sf_anexo set ocr_status = 'lendo' where id = p_anexo;
  return jsonb_build_object(
    'anexoId', a.id, 'path', a.storage_path, 'mime', a.mime, 'tamanho', a.tamanho,
    'modo', case a.finalidade when 'documento_origem' then 'pedido_compra' when 'comprovacao' then 'comprovacao' else 'comprovante' end,
    'periodoDe', s.periodo_de, 'periodoAte', s.periodo_ate,
    'limiar', coalesce((select (r.parametros ->> 'limiar')::numeric from imobdesk.sf_regra r where r.codigo = 'R02'), 0.80),
    'categorias', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'nome', c.nome, 'descricao', c.descricao, 'palavrasChave', c.palavras_chave)
                                             order by c.ordem, c.nome)
                            from imobdesk.sf_categoria_motivo c where c.ativo), '[]')
  );
end;
$$;

/** Resultado da leitura (só service_role). Status: lido, ilegivel (campo-chave abaixo do limiar) ou erro. */
create or replace function imobdesk.sf_ocr_registrar(p_anexo bigint, p_status text, p_json jsonb, p_erro text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_status not in ('lido', 'ilegivel', 'erro') then
    perform imobdesk.erro('INVALID_INPUT', 'Status de leitura inválido.');
  end if;
  update imobdesk.sf_anexo
     set ocr_status = p_status,
         ocr_json = case when p_status = 'erro' then jsonb_build_object('erro', left(coalesce(p_erro, 'Falha na leitura'), 500)) else p_json end,
         ocr_confianca = case when p_status = 'erro' then null
                              else least((p_json -> 'legibilidade' ->> 'data')::numeric, (p_json -> 'legibilidade' ->> 'valor')::numeric,
                                         (p_json -> 'legibilidade' ->> 'favorecido')::numeric) end,
         chave_acesso = case when coalesce(p_json ->> 'chave_acesso', '') ~ '^\d{44}$' then p_json ->> 'chave_acesso' end
   where id = p_anexo;
  perform imobdesk.sf_registrar_evento((select a.solicitacao_id from imobdesk.sf_anexo a where a.id = p_anexo),
                                                 'ocr_' || p_status, jsonb_build_object('anexoId', p_anexo));
end;
$$;

-- ---------- Para a tela ----------

/** Fila de leitura: anexos ainda sem linha, com o resultado da leitura. */
create or replace function imobdesk.sf_fila_leitura(p_solicitacao bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not imobdesk.sf_pode_ver(p_solicitacao) then perform imobdesk.erro('NOT_FOUND', 'Solicitação não encontrada.'); end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'nome', a.nome_arquivo, 'path', a.storage_path, 'mime', a.mime,
                                                       'status', a.ocr_status, 'ocr', a.ocr_json, 'criadoEm', a.criado_em) order by a.id)
                   from imobdesk.sf_anexo a
                   where a.solicitacao_id = p_solicitacao and a.item_id is null and a.finalidade = 'comprovante'), '[]');
end;
$$;

/**
 * Confirma a leitura: cria a linha a partir do anexo e liga o anexo a ela. Origem: ocr_confirmado se data, valor e
 * favorecido batem com o que foi lido; senão ocr_editado.
 */
create or replace function imobdesk.sf_linha_do_comprovante(p jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  a imobdesk.sf_anexo;
  s imobdesk.sf_solicitacao;
  v_data date := nullif(p ->> 'data', '')::date;
  v_valor numeric(14,2) := nullif(p ->> 'valor', '')::numeric;
  v_desc text := left(nullif(btrim(p ->> 'descricao'), ''), 200);
  v_cat bigint := nullif(p ->> 'categoriaId', '')::bigint;
  v_motivo text := left(nullif(btrim(p ->> 'motivo'), ''), 200);
  v_item bigint;
  v_lido jsonb;
begin
  select * into a from imobdesk.sf_anexo where id = nullif(p ->> 'anexoId', '')::bigint;
  if not found then perform imobdesk.erro('NOT_FOUND', 'Comprovante não encontrado.'); end if;
  s := imobdesk.sf_exigir_editavel(a.solicitacao_id);
  if a.item_id is not null then perform imobdesk.erro('INVALID_INPUT', 'Este comprovante já virou linha.'); end if;
  if v_data is null or v_valor is null or v_valor <= 0 or v_desc is null then
    perform imobdesk.erro('INVALID_INPUT', 'Preencha data, valor e favorecido para criar a linha.', 'itens');
  end if;
  if v_cat is not null then
    select c.nome into v_motivo from imobdesk.sf_categoria_motivo c where c.id = v_cat and c.ativo;
    v_motivo := coalesce(left(nullif(btrim(p ->> 'motivo'), ''), 200), v_motivo);
  end if;
  v_lido := a.ocr_json;
  insert into imobdesk.sf_item (solicitacao_id, ordem, data, valor, descricao_favorecido, motivo, categoria_id, origem)
  values (s.id, coalesce((select max(i.ordem) from imobdesk.sf_item i where i.solicitacao_id = s.id), 0) + 1,
          v_data, v_valor, v_desc, v_motivo, v_cat,
          case when a.ocr_status in ('lido', 'ilegivel')
                    and v_data is not distinct from nullif(v_lido ->> 'data', '')::date
                    and v_valor is not distinct from nullif(v_lido ->> 'valor_total', '')::numeric
                    and lower(v_desc) is not distinct from lower(nullif(btrim(v_lido ->> 'favorecido'), ''))
               then 'ocr_confirmado'
               when a.ocr_status in ('lido', 'ilegivel') then 'ocr_editado'
               else 'manual' end)
  returning id into v_item;
  update imobdesk.sf_anexo set item_id = v_item where id = a.id;
  perform imobdesk.sf_recalcular(s.id);
  perform imobdesk.sf_registrar_evento(s.id, 'linha_do_comprovante', jsonb_build_object('itemId', v_item, 'anexoId', a.id));
  return v_item;
end;
$$;

-- ---------- Checagens (redefinida: acrescenta as que dependem da leitura) ----------
create or replace function imobdesk.sf_checagens(p_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s imobdesk.sf_solicitacao;
  v_res jsonb := '[]';
  r record;
  v_dias int;
  v_sev text;
  v_par jsonb;
begin
  select * into s from imobdesk.sf_solicitacao where id = p_id;
  if not found or not imobdesk.sf_pode_ver(p_id) then perform imobdesk.erro('NOT_FOUND', 'Solicitação não encontrada.'); end if;

  -- R01 comprovante em cada linha
  select severidade into v_sev from imobdesk.sf_regra where codigo = 'R01' and ativo;
  if v_sev is not null then
    for r in select i.id, i.ordem from imobdesk.sf_item i where i.solicitacao_id = p_id
               and not exists (select 1 from imobdesk.sf_anexo a where a.item_id = i.id and a.finalidade = 'comprovante') loop
      v_res := v_res || jsonb_build_object('codigo', 'R01', 'itemId', r.id, 'resultado', v_sev, 'detalhe', format('Linha %s sem comprovante', r.ordem));
    end loop;
  end if;
  -- R02 legibilidade (comprovante lido com campo-chave abaixo do limiar)
  select severidade, parametros into v_sev, v_par from imobdesk.sf_regra where codigo = 'R02' and ativo;
  if v_sev is not null then
    for r in select i.id, i.ordem from imobdesk.sf_item i join imobdesk.sf_anexo a on a.item_id = i.id
             where i.solicitacao_id = p_id and a.ocr_status = 'ilegivel' loop
      v_res := v_res || jsonb_build_object('codigo', 'R02', 'itemId', r.id, 'resultado', v_sev,
                                           'detalhe', format('Linha %s: comprovante com legibilidade abaixo de %s%%', r.ordem, round(coalesce((v_par ->> 'limiar')::numeric, 0.8) * 100)));
    end loop;
  end if;
  -- R03 data no período
  select severidade into v_sev from imobdesk.sf_regra where codigo = 'R03' and ativo;
  if v_sev is not null and s.periodo_de is not null and s.periodo_ate is not null then
    for r in select i.id, i.ordem, i.data from imobdesk.sf_item i where i.solicitacao_id = p_id and i.data is not null
               and (i.data < s.periodo_de or i.data > s.periodo_ate) loop
      v_res := v_res || jsonb_build_object('codigo', 'R03', 'itemId', r.id, 'resultado', v_sev,
                                           'detalhe', format('Linha %s: %s fora do período', r.ordem, to_char(r.data, 'DD/MM/YYYY')));
    end loop;
  end if;
  -- R04 valor lido = declarado (com tolerância)
  select severidade, parametros into v_sev, v_par from imobdesk.sf_regra where codigo = 'R04' and ativo;
  if v_sev is not null then
    for r in select i.id, i.ordem, i.valor, (a.ocr_json ->> 'valor_total')::numeric as lido
             from imobdesk.sf_item i join imobdesk.sf_anexo a on a.item_id = i.id
             where i.solicitacao_id = p_id and a.ocr_status in ('lido', 'ilegivel') and (a.ocr_json ->> 'valor_total') is not null
               and abs(i.valor - (a.ocr_json ->> 'valor_total')::numeric) > coalesce((v_par ->> 'tolerancia')::numeric, 0) loop
      v_res := v_res || jsonb_build_object('codigo', 'R04', 'itemId', r.id, 'resultado', v_sev,
                                           'detalhe', format('Linha %s: declarado %s, comprovante %s', r.ordem, r.valor, r.lido));
    end loop;
  end if;
  -- R05 documento fiscal com CNPJ/CPF do emissor
  select severidade into v_sev from imobdesk.sf_regra where codigo = 'R05' and ativo;
  if v_sev is not null then
    for r in select i.id, i.ordem from imobdesk.sf_item i join imobdesk.sf_anexo a on a.item_id = i.id
             where i.solicitacao_id = p_id and a.ocr_status in ('lido', 'ilegivel')
               and (coalesce(a.ocr_json ->> 'tipo_documento', 'outro') = 'outro' or coalesce(a.ocr_json ->> 'cnpj_cpf_emissor', '') !~ '^\d{11}$|^\d{14}$') loop
      v_res := v_res || jsonb_build_object('codigo', 'R05', 'itemId', r.id, 'resultado', v_sev,
                                           'detalhe', format('Linha %s: sem documento fiscal com CNPJ/CPF do emissor', r.ordem));
    end loop;
  end if;
  -- R06 duplicidade: mesmo arquivo, ou mesmo CNPJ + data + valor lidos, em outra solicitação ativa
  select severidade into v_sev from imobdesk.sf_regra where codigo = 'R06' and ativo;
  if v_sev is not null then
    for r in select distinct on (a.id) a.item_id, a.nome_arquivo, o.numero
             from imobdesk.sf_anexo a
             join imobdesk.sf_anexo b on b.solicitacao_id <> a.solicitacao_id
                  and (b.sha256 = a.sha256
                       or (a.ocr_json ->> 'cnpj_cpf_emissor' is not null and a.ocr_json ->> 'data' is not null and a.ocr_json ->> 'valor_total' is not null
                           and b.ocr_json ->> 'cnpj_cpf_emissor' = a.ocr_json ->> 'cnpj_cpf_emissor'
                           and b.ocr_json ->> 'data' = a.ocr_json ->> 'data'
                           and (b.ocr_json ->> 'valor_total')::numeric = (a.ocr_json ->> 'valor_total')::numeric))
             join imobdesk.sf_solicitacao o on o.id = b.solicitacao_id and o.status not in ('cancelada', 'reprovada')
             where a.solicitacao_id = p_id and a.item_id is not null loop
      v_res := v_res || jsonb_build_object('codigo', 'R06', 'itemId', r.item_id, 'resultado', v_sev,
                                           'detalhe', format('%s já usado na %s', r.nome_arquivo, r.numero));
    end loop;
  end if;
  -- R07 itens proibidos (lista do admin) nos itens lidos, e alertas da leitura
  select severidade, parametros into v_sev, v_par from imobdesk.sf_regra where codigo = 'R07' and ativo;
  if v_sev is not null then
    for r in select distinct i.id, i.ordem, x.palavra
             from imobdesk.sf_item i
             join imobdesk.sf_anexo a on a.item_id = i.id
             cross join lateral jsonb_array_elements(coalesce(a.ocr_json -> 'itens', '[]')) it
             cross join lateral jsonb_array_elements_text(coalesce(v_par -> 'itens_proibidos', '[]')) x(palavra)
             where i.solicitacao_id = p_id and length(btrim(x.palavra)) >= 3
               and position(lower(btrim(x.palavra)) in lower(coalesce(it ->> 'descricao', ''))) > 0 loop
      v_res := v_res || jsonb_build_object('codigo', 'R07', 'itemId', r.id, 'resultado', v_sev,
                                           'detalhe', format('Linha %s: item "%s" na lista de proibidos', r.ordem, r.palavra));
    end loop;
  end if;
  -- R08 teto da categoria
  select severidade into v_sev from imobdesk.sf_regra where codigo = 'R08' and ativo;
  if v_sev is not null then
    for r in select i.id, i.ordem, c.nome from imobdesk.sf_item i
             join imobdesk.sf_categoria_motivo c on c.id = i.categoria_id
             where i.solicitacao_id = p_id and c.teto_valor is not null and i.valor > c.teto_valor loop
      v_res := v_res || jsonb_build_object('codigo', 'R08', 'itemId', r.id, 'resultado', v_sev, 'detalhe', format('Linha %s acima do teto de %s', r.ordem, r.nome));
    end loop;
  end if;
  -- R09 prazo de envio
  select severidade, (parametros ->> 'dias')::int into v_sev, v_dias from imobdesk.sf_regra where codigo = 'R09' and ativo;
  if v_sev is not null and v_dias is not null and s.periodo_ate is not null and current_date > s.periodo_ate + v_dias then
    v_res := v_res || jsonb_build_object('codigo', 'R09', 'itemId', null, 'resultado', v_sev, 'detalhe', format('Enviada %s dias após o fim do período', current_date - s.periodo_ate));
  end if;
  -- R10 saldo do fundo fixo
  select severidade into v_sev from imobdesk.sf_regra where codigo = 'R10' and ativo;
  if v_sev is not null and s.tipo = 'fundo_fixo' and s.total_despesas > coalesce(s.saldo_inicial, 0) then
    v_res := v_res || jsonb_build_object('codigo', 'R10', 'itemId', null, 'resultado', v_sev, 'detalhe', 'Despesas acima do saldo inicial do fundo fixo');
  end if;
  return v_res;
end;
$$;

-- ---------- Rascunho (redefinida: p.conhecidos evita apagar linha criada no meio de um salvamento) ----------
create or replace function imobdesk.sf_rascunho_salvar(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s imobdesk.sf_solicitacao := imobdesk.sf_exigir_editavel(nullif(p ->> 'id', '')::bigint);
  v_item jsonb;
  v_ids bigint[] := '{}';
  v_item_id bigint;
  v_ordem int := 0;
  v_de date := nullif(p ->> 'periodoDe', '')::date;
  v_ate date := nullif(p ->> 'periodoAte', '')::date;
  v_mapa jsonb := '[]';
begin
  if v_de is not null and v_ate is not null and v_ate < v_de then
    perform imobdesk.erro('INVALID_INPUT', 'O fim do período é antes do início.', 'periodoAte');
  end if;
  if jsonb_array_length(coalesce(p -> 'itens', '[]')) > 200 then
    perform imobdesk.erro('INVALID_INPUT', 'No máximo 200 linhas por solicitação.', 'itens');
  end if;
  update imobdesk.sf_solicitacao
     set competencia = coalesce(date_trunc('month', nullif(p ->> 'competencia', '')::date)::date, competencia),
         periodo_de = v_de, periodo_ate = v_ate,
         centro_custo = left(nullif(btrim(p ->> 'centroCusto'), ''), 60),
         atualizado_em = now()
   where id = s.id;

  for v_item in select value from jsonb_array_elements(coalesce(p -> 'itens', '[]')) loop
    v_ordem := v_ordem + 1;
    v_item_id := nullif(v_item ->> 'id', '')::bigint;
    if nullif(v_item ->> 'valor', '')::numeric < 0 then
      perform imobdesk.erro('INVALID_INPUT', format('Linha %s: valor negativo.', v_ordem), 'itens');
    end if;
    if v_item_id is not null and exists (select 1 from imobdesk.sf_item i where i.id = v_item_id and i.solicitacao_id = s.id) then
      update imobdesk.sf_item
         set ordem = v_ordem, data = nullif(v_item ->> 'data', '')::date, valor = nullif(v_item ->> 'valor', '')::numeric,
             descricao_favorecido = left(nullif(btrim(v_item ->> 'descricao'), ''), 200), motivo = left(nullif(btrim(v_item ->> 'motivo'), ''), 200),
             categoria_id = nullif(v_item ->> 'categoriaId', '')::bigint, atualizado_em = now(),
             -- Linha que veio da leitura e foi alterada passa a "ocr_editado" (Fase 4).
             origem = case when origem = 'ocr_confirmado' and (data is distinct from nullif(v_item ->> 'data', '')::date
                                                               or valor is distinct from nullif(v_item ->> 'valor', '')::numeric) then 'ocr_editado' else origem end
       where id = v_item_id;
    else
      insert into imobdesk.sf_item (solicitacao_id, ordem, data, valor, descricao_favorecido, motivo, categoria_id)
      values (s.id, v_ordem, nullif(v_item ->> 'data', '')::date, nullif(v_item ->> 'valor', '')::numeric,
              left(nullif(btrim(v_item ->> 'descricao'), ''), 200), left(nullif(btrim(v_item ->> 'motivo'), ''), 200),
              nullif(v_item ->> 'categoriaId', '')::bigint)
      returning id into v_item_id;
    end if;
    v_ids := v_ids || v_item_id;
    v_mapa := v_mapa || jsonb_build_object('chave', v_item ->> 'chave', 'id', v_item_id);
  end loop;

  -- Só apaga as linhas que a tela conhecia (p.conhecidos) e tirou da lista: uma linha criada no meio do caminho
  -- (ex.: confirmada a partir do comprovante enquanto o rascunho salvava) não some. Sem p.conhecidos, vale a lista toda.
  delete from imobdesk.sf_anexo a using imobdesk.sf_item i
   where a.item_id = i.id and i.solicitacao_id = s.id and not (i.id = any (v_ids))
     and (p -> 'conhecidos' is null or i.id in (select x::bigint from jsonb_array_elements_text(p -> 'conhecidos') x));
  delete from imobdesk.sf_item i where i.solicitacao_id = s.id and not (i.id = any (v_ids))
     and (p -> 'conhecidos' is null or i.id in (select x::bigint from jsonb_array_elements_text(p -> 'conhecidos') x));
  perform imobdesk.sf_recalcular(s.id);
  -- A tela troca a chave provisória de cada linha nova pelo id gravado.
  return jsonb_build_object('itens', v_mapa);
end;
$$;

-- ---------- Permissões ----------
do $$
declare
  f text;
begin
  foreach f in array array['sf_ocr_pedido(bigint)', 'sf_fila_leitura(bigint)', 'sf_linha_do_comprovante(jsonb)', 'sf_checagens(bigint)'] loop
    execute format('revoke execute on function imobdesk.%s from public, anon', f);
    execute format('grant execute on function imobdesk.%s to authenticated, service_role', f);
  end loop;
  execute 'revoke execute on function imobdesk.sf_ocr_registrar(bigint, text, jsonb, text) from public, anon, authenticated';
  execute 'grant execute on function imobdesk.sf_ocr_registrar(bigint, text, jsonb, text) to service_role';
end;
$$;

notify pgrst, 'reload schema';

-- ======================================== 20261017140000_imobdesk_sf_conferencia.sql
-- Solicitações Financeiras, Fase 5 (parte 1): conferência financeira (CONTEXTO.md, seções 1, 2 e 5; telas 8 e 9).
-- Fila do Financeiro com contadores por etapa; conferência item a item (aceitar, pedir ajuste, glosar; aceitar item com
-- alerta exige observação; glosa sai do pagamento: valor_a_pagar = total − glosas); pendência do solicitante (ele
-- responde e troca o comprovante dos itens em ajuste, volta para a conferência sem nova aprovação); pagamento programado
-- e paga. O lançamento no SIENGE (lancamento_gerado) entra depois da aprovação dos endpoints (Fase 5, parte 2).
-- Permissão nova `sf_conferencia` (tela Conferência financeira) para o perfil do Financeiro; a regra de dados continua:
-- só quem é do setor financeiro (ou admin) confere. Só aditiva.

insert into imobdesk.profile_permissions (role, permission_id, enabled)
values ('admin', 'sf_conferencia', true)
on conflict (role, permission_id) do nothing;

create or replace function imobdesk.sf_exigir_financeiro()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.sf_exigir_login();
begin
  if not (imobdesk.ch_eh_admin() or imobdesk.sf_eh_financeiro(v_uid)) then
    perform imobdesk.erro('FORBIDDEN', 'Só o setor Financeiro confere as solicitações.');
  end if;
  return v_uid;
end;
$$;

-- ---------- Tela 8: fila do Financeiro ----------
create or replace function imobdesk.sf_conferencia_fila()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_mes date := date_trunc('month', current_date)::date;
begin
  perform imobdesk.sf_exigir_financeiro();
  return jsonb_build_object(
    'kpis', (select jsonb_build_object(
               'aConferir', count(*) filter (where s.status = 'em_conferencia'),
               'aConferirValor', coalesce(sum(s.valor_a_pagar) filter (where s.status = 'em_conferencia'), 0),
               'pendencia', count(*) filter (where s.status = 'pendencia_solicitante'),
               'lancamentoGerado', count(*) filter (where s.status = 'lancamento_gerado'),
               'pagamentoProgramado', count(*) filter (where s.status = 'pagamento_programado'),
               'aComprovar', count(*) filter (where s.status in ('comprovacao_pendente', 'comprovacao_em_conferencia')),
               'aComprovarVencidos', count(*) filter (where s.status = 'comprovacao_pendente' and s.prazo_comprovacao < current_date),
               'pagasMes', count(*) filter (where s.status in ('paga', 'encerrada') and s.atualizado_em >= v_mes),
               'pagasMesValor', coalesce(sum(s.valor_a_pagar) filter (where s.status in ('paga', 'encerrada') and s.atualizado_em >= v_mes), 0))
             from imobdesk.sf_solicitacao s where imobdesk.sf_status_financeiro(s.status)),
    'lista', coalesce((select jsonb_agg(jsonb_build_object(
                 'id', s.id, 'numero', s.numero, 'tipo', s.tipo, 'status', s.status, 'solicitante', u.nome,
                 'setor', (select st.nome from imobdesk.at_setores st where st.id = s.setor_id),
                 'valor', coalesce(s.valor_adiantamento, s.total_despesas), 'valorAPagar', s.valor_a_pagar,
                 'ultimaAprovacaoEm', s.ultima_aprovacao_em, 'pagarAte', s.pagar_ate, 'vencimento', s.vencimento,
                 'itens', (select count(*) from imobdesk.sf_item i where i.solicitacao_id = s.id),
                 'resolvidos', (select count(*) from imobdesk.sf_item i where i.solicitacao_id = s.id and i.status_conferencia in ('aceito', 'glosado')))
               order by s.ultima_aprovacao_em nulls last, s.id)
               from imobdesk.sf_solicitacao s join imobdesk.usuarios u on u.id = s.solicitante_id
               where s.status in ('em_conferencia', 'pendencia_solicitante', 'lancamento_gerado', 'pagamento_programado',
                                  'comprovacao_pendente', 'comprovacao_em_conferencia', 'devolucao_pendente')
                  or (s.status in ('paga', 'encerrada') and s.atualizado_em >= v_mes)), '[]')
  );
end;
$$;

-- ---------- Tela 9: itens da conferência ----------
create or replace function imobdesk.sf_conferencia_itens(p_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not imobdesk.sf_pode_ver(p_id) then perform imobdesk.erro('NOT_FOUND', 'Solicitação não encontrada.'); end if;
  return jsonb_build_object(
    'podeConferir', (imobdesk.ch_eh_admin() or imobdesk.sf_eh_financeiro((select auth.uid())))
                    and exists (select 1 from imobdesk.sf_solicitacao s where s.id = p_id and s.status = 'em_conferencia'),
    'itens', coalesce((select jsonb_agg(jsonb_build_object(
                 'id', i.id, 'ordem', i.ordem, 'data', i.data, 'valor', i.valor, 'descricao', i.descricao_favorecido, 'motivo', i.motivo,
                 'origem', i.origem, 'status', i.status_conferencia, 'valorGlosado', i.valor_glosado, 'obs', i.obs_conferente,
                 'anexos', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'nome', a.nome_arquivo, 'path', a.storage_path, 'mime', a.mime,
                                                                          'ocrStatus', a.ocr_status, 'ocr', a.ocr_json) order by a.id desc)
                                     from imobdesk.sf_anexo a where a.item_id = i.id), '[]'),
                 'regras', coalesce((select jsonb_agg(jsonb_build_object('codigo', x ->> 'codigo', 'resultado', x ->> 'resultado', 'detalhe', x ->> 'detalhe'))
                                     from jsonb_array_elements(imobdesk.sf_checagens(p_id)) x
                                     where (x ->> 'itemId')::bigint = i.id), '[]'))
               order by i.ordem)
               from imobdesk.sf_item i where i.solicitacao_id = p_id), '[]'),
    'gerais', coalesce((select jsonb_agg(x) from jsonb_array_elements(imobdesk.sf_checagens(p_id)) x where x ->> 'itemId' is null), '[]')
  );
end;
$$;

/** Recalcula glosas e valor a pagar. */
create or replace function imobdesk.sf_recalcular_glosa(p_id bigint)
returns void
language sql
security definer
set search_path = ''
as $$
  update imobdesk.sf_solicitacao s
     set valor_glosado = g.glosa, valor_a_pagar = s.total_despesas - g.glosa, atualizado_em = now()
    from (select coalesce(sum(i.valor_glosado), 0)::numeric(14,2) as glosa from imobdesk.sf_item i where i.solicitacao_id = p_id) g
   where s.id = p_id;
$$;

/**
 * Decisão por item: aceitar (com alerta, exige observação), ajuste (pede correção ao solicitante; exige observação)
 * ou glosar (retira o valor do pagamento; exige valor e observação).
 */
create or replace function imobdesk.sf_decidir_item(p_item bigint, p_decisao text, p_valor_glosa numeric default null, p_obs text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.sf_exigir_financeiro();
  i imobdesk.sf_item;
  s imobdesk.sf_solicitacao;
  v_obs text := nullif(btrim(coalesce(p_obs, '')), '');
  v_alerta boolean;
begin
  select * into i from imobdesk.sf_item where id = p_item;
  if not found then perform imobdesk.erro('NOT_FOUND', 'Item não encontrado.'); end if;
  select * into s from imobdesk.sf_solicitacao where id = i.solicitacao_id;
  if s.status <> 'em_conferencia' then perform imobdesk.erro('INVALID_INPUT', 'A solicitação não está em conferência.'); end if;
  if p_decisao not in ('aceitar', 'ajuste', 'glosar') then perform imobdesk.erro('INVALID_INPUT', 'Decisão inválida.', 'decisao'); end if;
  select exists (select 1 from jsonb_array_elements(imobdesk.sf_checagens(s.id)) x
                 where (x ->> 'itemId')::bigint = p_item and x ->> 'resultado' <> 'ok') into v_alerta;
  if v_obs is null and (p_decisao <> 'aceitar' or v_alerta) then
    perform imobdesk.erro('INVALID_INPUT', case when p_decisao = 'aceitar' then 'Item com alerta: escreva a observação para aceitar.' else 'Escreva a observação.' end, 'obs');
  end if;
  if p_decisao = 'glosar' and (p_valor_glosa is null or p_valor_glosa <= 0 or p_valor_glosa > i.valor) then
    perform imobdesk.erro('INVALID_INPUT', 'Informe o valor glosado (maior que zero e até o valor do item).', 'valorGlosa');
  end if;
  update imobdesk.sf_item
     set status_conferencia = case p_decisao when 'aceitar' then 'aceito' when 'ajuste' then 'ajuste' else 'glosado' end,
         valor_glosado = case when p_decisao = 'glosar' then round(p_valor_glosa, 2) else 0 end,
         obs_conferente = left(v_obs, 1000), atualizado_em = now()
   where id = p_item;
  perform imobdesk.sf_recalcular_glosa(s.id);
  perform imobdesk.sf_registrar_evento(s.id, 'item_' || p_decisao,
    jsonb_build_object('itemId', p_item, 'ordem', i.ordem, 'glosa', case when p_decisao = 'glosar' then p_valor_glosa end, 'obs', v_obs));
  return jsonb_build_object('valorAPagar', (select x.valor_a_pagar from imobdesk.sf_solicitacao x where x.id = s.id));
end;
$$;

/** Devolve ao solicitante os itens marcados "ajuste" (status pendencia_solicitante). */
create or replace function imobdesk.sf_pedir_ajuste(p_id bigint, p_comentario text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.sf_exigir_financeiro();
begin
  if nullif(btrim(coalesce(p_comentario, '')), '') is null then
    perform imobdesk.erro('INVALID_INPUT', 'Escreva o que o solicitante precisa ajustar.', 'comentario');
  end if;
  if not exists (select 1 from imobdesk.sf_solicitacao where id = p_id and status = 'em_conferencia') then
    perform imobdesk.erro('INVALID_INPUT', 'A solicitação não está em conferência.');
  end if;
  if not exists (select 1 from imobdesk.sf_item where solicitacao_id = p_id and status_conferencia = 'ajuste') then
    perform imobdesk.erro('INVALID_INPUT', 'Marque ao menos um item como "Pedir ajuste".');
  end if;
  perform imobdesk.sf_registrar_evento(p_id, 'pendencia_aberta', jsonb_build_object('comentario', left(p_comentario, 2000)));
  update imobdesk.sf_solicitacao set status = 'pendencia_solicitante', atualizado_em = now() where id = p_id;
end;
$$;

/** O solicitante troca o comprovante de um item em ajuste (o arquivo já está no Storage). */
create or replace function imobdesk.sf_pendencia_anexar(p jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.sf_exigir_login();
  i imobdesk.sf_item;
  s imobdesk.sf_solicitacao;
  v_id bigint;
  v_path text := p ->> 'path';
begin
  select * into i from imobdesk.sf_item where id = nullif(p ->> 'itemId', '')::bigint;
  if not found then perform imobdesk.erro('NOT_FOUND', 'Item não encontrado.'); end if;
  select * into s from imobdesk.sf_solicitacao where id = i.solicitacao_id;
  if s.solicitante_id <> v_uid or s.status <> 'pendencia_solicitante' or i.status_conferencia <> 'ajuste' then
    perform imobdesk.erro('INVALID_INPUT', 'Só dá para trocar o comprovante dos itens com ajuste pedido.');
  end if;
  if v_path is null or split_part(v_path, '/', 1) <> v_uid::text or split_part(v_path, '/', 2) <> s.id::text then
    perform imobdesk.erro('INVALID_INPUT', 'Arquivo fora da pasta da solicitação.', 'path');
  end if;
  if coalesce(p ->> 'sha256', '') !~ '^[0-9a-f]{64}$' or coalesce((p ->> 'tamanho')::bigint, 0) not between 1 and 10485760
     or coalesce(p ->> 'mime', '') not in ('image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp', 'application/pdf') then
    perform imobdesk.erro('INVALID_INPUT', 'Arquivo inválido (JPG, PNG, HEIC ou PDF até 10 MB).');
  end if;
  insert into imobdesk.sf_anexo (solicitacao_id, item_id, finalidade, storage_path, nome_arquivo, mime, tamanho, sha256, criado_por)
  values (s.id, i.id, 'comprovante', v_path, left(coalesce(nullif(p ->> 'nome', ''), 'arquivo'), 200), p ->> 'mime', (p ->> 'tamanho')::bigint, lower(p ->> 'sha256'), v_uid)
  returning id into v_id;
  perform imobdesk.sf_registrar_evento(s.id, 'pendencia_anexo', jsonb_build_object('itemId', i.id, 'anexoId', v_id));
  return v_id;
end;
$$;

/** O solicitante responde a pendência: volta para a conferência e os itens em ajuste voltam a "pendente". */
create or replace function imobdesk.sf_pendencia_responder(p_id bigint, p_resposta text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.sf_exigir_login();
begin
  if not exists (select 1 from imobdesk.sf_solicitacao where id = p_id and solicitante_id = v_uid and status = 'pendencia_solicitante') then
    perform imobdesk.erro('NOT_FOUND', 'Pendência não encontrada.');
  end if;
  if nullif(btrim(coalesce(p_resposta, '')), '') is null then
    perform imobdesk.erro('INVALID_INPUT', 'Escreva a resposta para o Financeiro.', 'resposta');
  end if;
  update imobdesk.sf_item set status_conferencia = 'pendente', atualizado_em = now() where solicitacao_id = p_id and status_conferencia = 'ajuste';
  perform imobdesk.sf_registrar_evento(p_id, 'pendencia_respondida', jsonb_build_object('resposta', left(p_resposta, 2000)));
  update imobdesk.sf_solicitacao set status = 'em_conferencia', atualizado_em = now() where id = p_id;
  perform imobdesk.sf_notificar_financeiro(p_id, 'Pendência respondida: ' || imobdesk.sf_rotulo(p_id), left(p_resposta, 300));
end;
$$;

-- ---------- Pagamento ----------
/** Depois do lançamento: o Financeiro programa a data do pagamento. */
create or replace function imobdesk.sf_programar_pagamento(p_id bigint, p_data date)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.sf_exigir_financeiro();
begin
  if p_data is null or p_data < current_date then perform imobdesk.erro('INVALID_INPUT', 'Informe a data do pagamento (hoje ou depois).', 'data'); end if;
  if not exists (select 1 from imobdesk.sf_solicitacao where id = p_id and status = 'lancamento_gerado') then
    perform imobdesk.erro('INVALID_INPUT', 'Só dá para programar o pagamento depois do lançamento no SIENGE.');
  end if;
  update imobdesk.sf_solicitacao set pagar_ate = p_data, status = 'pagamento_programado', atualizado_em = now() where id = p_id;
  perform imobdesk.sf_registrar_evento(p_id, 'pagamento_programado', jsonb_build_object('data', p_data));
end;
$$;

/** Pagamento feito. Adiantamento segue para a comprovação (Fase 5B); os demais terminam aqui. */
create or replace function imobdesk.sf_marcar_paga(p_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.sf_exigir_financeiro();
  s imobdesk.sf_solicitacao;
begin
  select * into s from imobdesk.sf_solicitacao where id = p_id;
  if not found or s.status <> 'pagamento_programado' then
    perform imobdesk.erro('INVALID_INPUT', 'Só dá para marcar como paga depois de programar o pagamento.');
  end if;
  update imobdesk.sf_solicitacao set status = 'paga', atualizado_em = now() where id = p_id;
  perform imobdesk.sf_registrar_evento(p_id, 'paga');
  if s.tipo = 'adiantamento' then
    update imobdesk.sf_solicitacao set status = 'comprovacao_pendente', status_comprovacao = 'pendente', atualizado_em = now() where id = p_id;
  end if;
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array['sf_conferencia_fila()', 'sf_conferencia_itens(bigint)', 'sf_decidir_item(bigint, text, numeric, text)', 'sf_pedir_ajuste(bigint, text)',
                           'sf_pendencia_anexar(jsonb)', 'sf_pendencia_responder(bigint, text)', 'sf_programar_pagamento(bigint, date)', 'sf_marcar_paga(bigint)'] loop
    execute format('revoke execute on function imobdesk.%s from public, anon', f);
    execute format('grant execute on function imobdesk.%s to authenticated, service_role', f);
  end loop;
  foreach f in array array['sf_exigir_financeiro()', 'sf_recalcular_glosa(bigint)'] loop
    execute format('revoke execute on function imobdesk.%s from public, anon, authenticated', f);
    execute format('grant execute on function imobdesk.%s to service_role', f);
  end loop;
end;
$$;

notify pgrst, 'reload schema';

-- ======================================== 20261017150000_imobdesk_sf_sienge.sql
-- Solicitações Financeiras, Fase 5 (parte 2): integração SIENGE (CONTEXTO.md, seção 6; pedido do Wagner, 17/10/2026).
-- Configurações › Integrações › SIENGE: subdomínio, usuário e senha da API (senha no Vault) e os padrões do título
-- (empresa pagadora, tipo de documento, indexador, plano financeiro por tipo, centro de custo padrão). O botão
-- "Lançamento no SIENGE" da conferência chama a Edge Function imobdesk-sf-sienge, que cria o título a pagar
-- (POST /bills), anexa o PDF do formulário e os comprovantes e grava o número do título. Idempotente pelo número SF-…:
-- antes de criar, procura o título com o mesmo documentNumber. Credor inexistente = erro claro, sem cadastro automático.
-- Só aditiva.

create table if not exists imobdesk.sf_sienge_config (
  id                    boolean       primary key default true check (id),
  ativo                 boolean       not null default false,
  ambiente              text          not null default 'homologacao' check (ambiente in ('homologacao', 'producao')),
  subdominio            text          check (subdominio ~ '^[a-z0-9-]{2,60}$'),
  usuario               text          check (length(usuario) <= 120),
  senha_segredo_id      uuid,
  senha_definida_em     timestamptz,
  empresa_id            int           check (empresa_id > 0),
  tipo_documento        text          check (length(tipo_documento) between 1 and 10),
  indexador_id          int           check (indexador_id >= 0),
  plano_reembolso       text          check (plano_reembolso ~ '^\d{1,9}$'),
  plano_fundo_fixo      text          check (plano_fundo_fixo ~ '^\d{1,9}$'),
  plano_adiantamento    text          check (plano_adiantamento ~ '^\d{1,9}$'),
  centro_custo_padrao   int           check (centro_custo_padrao > 0),
  ultimo_teste          jsonb,
  atualizado_em         timestamptz   not null default now(),
  atualizado_por        uuid
);
insert into imobdesk.sf_sienge_config (id) values (true) on conflict (id) do nothing;

alter table imobdesk.sf_solicitacao add column if not exists sienge_status text check (sienge_status in ('lancando', 'erro'));
alter table imobdesk.sf_solicitacao add column if not exists sienge_erro text;
alter table imobdesk.sf_solicitacao add column if not exists sienge_credor_id int;
alter table imobdesk.sf_solicitacao add column if not exists sienge_centro_custo int;
alter table imobdesk.sf_solicitacao add column if not exists sienge_plano text;

do $$
begin
  execute 'alter table imobdesk.sf_sienge_config enable row level security';
  execute 'revoke all on imobdesk.sf_sienge_config from anon, public, authenticated';
  execute 'grant all on imobdesk.sf_sienge_config to service_role';
end;
$$;

-- ---------- Tela da integração (Admin e Super admin) ----------
create or replace function imobdesk.sf_sienge_config_ler()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c imobdesk.sf_sienge_config;
begin
  perform imobdesk.sf_exigir_admin();
  select * into c from imobdesk.sf_sienge_config where id;
  return jsonb_build_object(
    'ativo', c.ativo, 'ambiente', c.ambiente, 'subdominio', c.subdominio, 'usuario', c.usuario,
    'senhaDefinida', c.senha_segredo_id is not null, 'senhaDefinidaEm', c.senha_definida_em,
    'empresaId', c.empresa_id, 'tipoDocumento', c.tipo_documento, 'indexadorId', c.indexador_id,
    'planoReembolso', c.plano_reembolso, 'planoFundoFixo', c.plano_fundo_fixo, 'planoAdiantamento', c.plano_adiantamento,
    'centroCustoPadrao', c.centro_custo_padrao, 'ultimoTeste', c.ultimo_teste, 'atualizadoEm', c.atualizado_em);
end;
$$;

create or replace function imobdesk.sf_sienge_config_salvar(p jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := imobdesk.sf_exigir_admin();
  v_sub text := lower(nullif(btrim(p ->> 'subdominio'), ''));
  v_plano text;
begin
  if v_sub is not null and v_sub !~ '^[a-z0-9-]{2,60}$' then
    perform imobdesk.erro('INVALID_INPUT', 'O subdomínio é só o nome do cliente no endereço (ex.: em api.sienge.com.br/suaempresa/…, é "suaempresa").', 'subdominio');
  end if;
  foreach v_plano in array array[p ->> 'planoReembolso', p ->> 'planoFundoFixo', p ->> 'planoAdiantamento'] loop
    if nullif(btrim(v_plano), '') is not null and btrim(v_plano) !~ '^\d{1,9}$' then
      perform imobdesk.erro('INVALID_INPUT', 'O plano financeiro vai sem máscara, só números (ex.: 2010101).', 'planos');
    end if;
  end loop;
  if coalesce((p ->> 'ativo')::boolean, false) and (v_sub is null or nullif(btrim(p ->> 'usuario'), '') is null
       or nullif(p ->> 'empresaId', '') is null or nullif(btrim(p ->> 'tipoDocumento'), '') is null or nullif(p ->> 'indexadorId', '') is null) then
    perform imobdesk.erro('INVALID_INPUT', 'Para ativar, preencha subdomínio, usuário, empresa, tipo de documento e indexador.', 'ativo');
  end if;
  if coalesce((p ->> 'ativo')::boolean, false) and not exists (select 1 from imobdesk.sf_sienge_config where id and senha_segredo_id is not null) then
    perform imobdesk.erro('INVALID_INPUT', 'Para ativar, salve a senha da API.', 'ativo');
  end if;
  update imobdesk.sf_sienge_config
     set ativo = coalesce((p ->> 'ativo')::boolean, false),
         ambiente = case when p ->> 'ambiente' = 'producao' then 'producao' else 'homologacao' end,
         subdominio = v_sub,
         usuario = left(nullif(btrim(p ->> 'usuario'), ''), 120),
         empresa_id = nullif(p ->> 'empresaId', '')::int,
         tipo_documento = upper(left(nullif(btrim(p ->> 'tipoDocumento'), ''), 10)),
         indexador_id = nullif(p ->> 'indexadorId', '')::int,
         plano_reembolso = nullif(btrim(p ->> 'planoReembolso'), ''),
         plano_fundo_fixo = nullif(btrim(p ->> 'planoFundoFixo'), ''),
         plano_adiantamento = nullif(btrim(p ->> 'planoAdiantamento'), ''),
         centro_custo_padrao = nullif(p ->> 'centroCustoPadrao', '')::int,
         atualizado_em = now(), atualizado_por = v_ator
   where id;
  perform imobdesk.registrar_auditoria(v_ator, 'integracoes', 'update', 'SIENGE: configuração salva', null, p - 'senha', 'sienge');
end;
$$;

/** Senha da API no Vault (nunca volta para a tela). */
create or replace function imobdesk.sf_sienge_senha_salvar(p_senha text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := imobdesk.sf_exigir_admin();
  v_id uuid;
begin
  if length(coalesce(p_senha, '')) < 4 then perform imobdesk.erro('INVALID_INPUT', 'Informe a senha da API do SIENGE.', 'senha'); end if;
  select senha_segredo_id into v_id from imobdesk.sf_sienge_config where id;
  if v_id is null or not exists (select 1 from vault.secrets where id = v_id) then
    v_id := vault.create_secret(p_senha, 'imobdesk_sienge_senha_' || replace(gen_random_uuid()::text, '-', ''), 'Senha da API SIENGE (Imobdesk)');
  else
    perform vault.update_secret(v_id, p_senha);
  end if;
  update imobdesk.sf_sienge_config set senha_segredo_id = v_id, senha_definida_em = now(), ultimo_teste = null,
         atualizado_em = now(), atualizado_por = v_ator where id;
  perform imobdesk.registrar_auditoria(v_ator, 'integracoes', 'update', 'SIENGE: senha da API salva no cofre', null, null, 'sienge');
end;
$$;

-- ---------- Para a Edge Function (service_role) ----------
create or replace function imobdesk.sf_sienge_credenciais()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'ativo', c.ativo, 'ambiente', c.ambiente, 'subdominio', c.subdominio, 'usuario', c.usuario,
    'senha', (select d.decrypted_secret from vault.decrypted_secrets d where d.id = c.senha_segredo_id),
    'empresaId', c.empresa_id, 'tipoDocumento', c.tipo_documento, 'indexadorId', c.indexador_id,
    'planoReembolso', c.plano_reembolso, 'planoFundoFixo', c.plano_fundo_fixo, 'planoAdiantamento', c.plano_adiantamento,
    'centroCustoPadrao', c.centro_custo_padrao)
  from imobdesk.sf_sienge_config c where c.id;
$$;

create or replace function imobdesk.sf_sienge_teste_registrar(p jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  update imobdesk.sf_sienge_config set ultimo_teste = p || jsonb_build_object('em', now()) where id;
$$;

/** Quem pode lançar e consultar listas do SIENGE: Financeiro ou admin (checado com o token da pessoa). */
create or replace function imobdesk.sf_sienge_pode_usar()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.sf_exigir_login();
begin
  return jsonb_build_object('admin', imobdesk.ch_eh_admin(),
                            'financeiro', imobdesk.ch_eh_admin() or imobdesk.sf_eh_financeiro(v_uid));
end;
$$;

/**
 * Pedido de lançamento (chamado com o token do conferente): confere Financeiro, status em_conferencia, todos os itens
 * resolvidos, e trava ("lancando") contra clique duplo. Devolve o que a função precisa (CPF completo só aqui).
 */
create or replace function imobdesk.sf_lancamento_pedido(p_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.sf_exigir_financeiro();
  s imobdesk.sf_solicitacao;
  v_doc text;
begin
  select * into s from imobdesk.sf_solicitacao where id = p_id for update;
  if not found then perform imobdesk.erro('NOT_FOUND', 'Solicitação não encontrada.'); end if;
  if s.status <> 'em_conferencia' then perform imobdesk.erro('INVALID_INPUT', 'A solicitação não está em conferência.'); end if;
  if s.sienge_status = 'lancando' and s.atualizado_em > now() - interval '3 minutes' then
    perform imobdesk.erro('INVALID_INPUT', 'O lançamento já está em andamento. Aguarde.');
  end if;
  if exists (select 1 from imobdesk.sf_item i where i.solicitacao_id = p_id and i.status_conferencia not in ('aceito', 'glosado')) then
    perform imobdesk.erro('INVALID_INPUT', 'Resolva todos os itens (aceitar ou glosar) antes do lançamento.');
  end if;
  if coalesce(s.valor_a_pagar, 0) <= 0 then perform imobdesk.erro('INVALID_INPUT', 'Valor a pagar zerado: não há o que lançar.'); end if;
  select p.documento into v_doc from imobdesk.at_pessoas p where p.id = s.pessoa_id;
  if coalesce(v_doc, '') !~ '^\d{11}$|^\d{14}$' then
    perform imobdesk.erro('INVALID_INPUT', 'O solicitante está sem CPF no cadastro de Pessoas: sem ele não dá para achar o credor no SIENGE.');
  end if;
  update imobdesk.sf_solicitacao set sienge_status = 'lancando', sienge_erro = null, atualizado_em = now() where id = p_id;
  return jsonb_build_object(
    'id', s.id, 'numero', s.numero, 'tipo', s.tipo, 'cpf', v_doc, 'solicitante', (select u.nome from imobdesk.usuarios u where u.id = s.solicitante_id),
    'setor', (select st.nome from imobdesk.at_setores st where st.id = s.setor_id),
    'centroCusto', s.centro_custo, 'centroCustoSetor', (select st.sf_centro_custo_padrao from imobdesk.at_setores st where st.id = s.setor_id),
    'competencia', s.competencia, 'periodoDe', s.periodo_de, 'periodoAte', s.periodo_ate, 'enviadoEm', s.enviado_em,
    'ultimaAprovacaoEm', s.ultima_aprovacao_em, 'pagarAte', s.pagar_ate, 'vencimento', s.vencimento,
    'total', s.total_despesas, 'glosado', s.valor_glosado, 'aPagar', s.valor_a_pagar, 'siengeId', s.sienge_lancamento_id,
    'anexos', coalesce((select jsonb_agg(jsonb_build_object('path', a.storage_path, 'nome', a.nome_arquivo, 'mime', a.mime, 'ordem', i.ordem) order by i.ordem, a.id)
                        from imobdesk.sf_anexo a join imobdesk.sf_item i on i.id = a.item_id
                        where a.solicitacao_id = s.id and i.status_conferencia in ('aceito', 'glosado')), '[]'));
end;
$$;

/** Resultado do lançamento (service_role). Sucesso: lancamento_gerado com o número do título. */
create or replace function imobdesk.sf_lancamento_registrar(p_id bigint, p_ok boolean, p_titulo text, p_erro text, p_detalhe jsonb default '{}')
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_ok then
    update imobdesk.sf_solicitacao
       set status = 'lancamento_gerado', sienge_lancamento_id = p_titulo, sienge_status = null, sienge_erro = null,
           sienge_credor_id = nullif(p_detalhe ->> 'credorId', '')::int, sienge_centro_custo = nullif(p_detalhe ->> 'centroCusto', '')::int,
           sienge_plano = p_detalhe ->> 'plano', atualizado_em = now()
     where id = p_id;
    insert into imobdesk.sf_evento (solicitacao_id, tipo, ator_id, payload)
    values (p_id, 'lancamento_sienge', nullif(p_detalhe ->> 'atorId', '')::uuid, p_detalhe || jsonb_build_object('titulo', p_titulo));
  else
    update imobdesk.sf_solicitacao set sienge_status = 'erro', sienge_erro = left(p_erro, 1000), atualizado_em = now() where id = p_id;
    insert into imobdesk.sf_evento (solicitacao_id, tipo, ator_id, payload)
    values (p_id, 'lancamento_sienge_erro', nullif(p_detalhe ->> 'atorId', '')::uuid, jsonb_build_object('erro', left(p_erro, 1000)));
  end if;
end;
$$;

/** Dados para o PDF do formulário (quem vê a solicitação). CPF completo só no PDF, conforme a seção 6. */
create or replace function imobdesk.sf_pdf_dados(p_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  d jsonb;
begin
  d := imobdesk.sf_detalhe(p_id);
  return d || jsonb_build_object('cpf', (select p.documento from imobdesk.at_pessoas p join imobdesk.sf_solicitacao s on s.pessoa_id = p.id where s.id = p_id));
end;
$$;

/** Situação do lançamento para a conferência e o detalhe (quem vê a solicitação). */
create or replace function imobdesk.sf_sienge_situacao(p_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not imobdesk.sf_pode_ver(p_id) then perform imobdesk.erro('NOT_FOUND', 'Solicitação não encontrada.'); end if;
  return (select jsonb_build_object('titulo', s.sienge_lancamento_id, 'status', s.sienge_status, 'erro', s.sienge_erro,
                                    'credorId', s.sienge_credor_id, 'centroCusto', s.sienge_centro_custo, 'plano', s.sienge_plano,
                                    'configurada', (select c.ativo from imobdesk.sf_sienge_config c where c.id),
                                    'ambiente', (select c.ambiente from imobdesk.sf_sienge_config c where c.id))
          from imobdesk.sf_solicitacao s where s.id = p_id);
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array['sf_sienge_config_ler()', 'sf_sienge_config_salvar(jsonb)', 'sf_sienge_senha_salvar(text)', 'sf_sienge_pode_usar()',
                           'sf_lancamento_pedido(bigint)', 'sf_pdf_dados(bigint)', 'sf_sienge_situacao(bigint)'] loop
    execute format('revoke execute on function imobdesk.%s from public, anon', f);
    execute format('grant execute on function imobdesk.%s to authenticated, service_role', f);
  end loop;
  foreach f in array array['sf_sienge_credenciais()', 'sf_sienge_teste_registrar(jsonb)', 'sf_lancamento_registrar(bigint, boolean, text, text, jsonb)'] loop
    execute format('revoke execute on function imobdesk.%s from public, anon, authenticated', f);
    execute format('grant execute on function imobdesk.%s to service_role', f);
  end loop;
end;
$$;

notify pgrst, 'reload schema';

-- ======================================== 20261017160000_imobdesk_sf_adiantamento.sql
-- Solicitações Financeiras, Fase 5B: adiantamento de numerário (CONTEXTO.md, seções 2, 3, 4, 5, 6 e 9; telas 13, 14 e 15).
-- Formulário do adiantamento (modelo padrão) com documento de origem lido pela IA (modo pedido_compra), rateio por
-- tarefa (A05), valor = linha única em sf_item (a conferência item a item e o lançamento reaproveitam a Fase 5),
-- cadeia sequencial Planejamento → Gerente → Diretor → Presidente (sf_montar_cadeia, Fase 2), checagens A01–A06,
-- comprovação (NF/recibo lido no modo comprovacao; A07; acerto: ≥ adiantado encerra e o saldo do pedido vira título
-- contra a nota; menor vira devolução pendente), lembretes D-7/D-1 e bloqueio por comprovação vencida.
-- Só aditiva: colunas novas e funções novas ou redefinidas com acréscimos.

-- ---------- Colunas ----------
alter table imobdesk.sf_solicitacao add column if not exists pedido_data date;
alter table imobdesk.sf_solicitacao add column if not exists pedido_fornecedor text check (length(pedido_fornecedor) <= 160);
alter table imobdesk.sf_solicitacao add column if not exists pedido_fornecedor_doc text check (pedido_fornecedor_doc ~ '^\d{11}$|^\d{14}$');
alter table imobdesk.sf_solicitacao add column if not exists pedido_condicao text check (length(pedido_condicao) <= 200);
alter table imobdesk.sf_solicitacao add column if not exists pago_em timestamptz;
alter table imobdesk.sf_solicitacao add column if not exists comprovacao_aviso7_em timestamptz;
alter table imobdesk.sf_solicitacao add column if not exists comprovacao_aviso1_em timestamptz;
alter table imobdesk.sf_solicitacao add column if not exists comprovacao_vencida_em timestamptz;
alter table imobdesk.sf_solicitacao add column if not exists sienge_saldo_id text;
alter table imobdesk.sf_solicitacao add column if not exists sienge_saldo_erro text;
alter table imobdesk.sf_comprovacao add column if not exists emitente_nome text check (length(emitente_nome) <= 160);
alter table imobdesk.sf_comprovacao add column if not exists numero_documento text check (length(numero_documento) <= 60);
alter table imobdesk.sf_comprovacao add column if not exists referencia text check (length(referencia) <= 120);
alter table imobdesk.sf_comprovacao add column if not exists chave_acesso text check (chave_acesso ~ '^\d{44}$');
alter table imobdesk.sf_comprovacao add column if not exists status text not null default 'enviada'
  check (status in ('enviada', 'aceita', 'devolucao', 'ajuste'));
alter table imobdesk.sf_comprovacao add column if not exists obs text check (length(obs) <= 1000);

-- ---------- Apoio ----------
/** R$ no formato brasileiro, sem o símbolo (1.316,80). */
create or replace function imobdesk.sf_br(p numeric)
returns text
language sql
immutable
set search_path = ''
as $$
  select translate(to_char(coalesce(p, 0), 'FM999,999,990.00'), ',.', '.,');
$$;

/** Modo congelado no envio (redefinida): adiantamento é sempre sequencial (CONTEXTO.md, seção 4). */
create or replace function imobdesk.sf_solicitacao_modo()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'em_aprovacao' and old.status is distinct from 'em_aprovacao' then
    new.modo_aprovacao := case when new.tipo = 'adiantamento' then 'sequencial'
                               else coalesce((select s.sf_modo_aprovacao from imobdesk.at_setores s where s.id = new.setor_id), 'sequencial') end;
  end if;
  return new;
end;
$$;

-- ---------- Rascunho (redefinida: aceita adiantamento) ----------
/** Cria o rascunho. Fundo fixo traz o valor e o saldo inicial; adiantamento é recusado com comprovação vencida (A06). */
create or replace function imobdesk.sf_rascunho_criar(p_tipo text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.sf_exigir_login();
  v_setor bigint := imobdesk.sf_setor_do_usuario(v_uid);
  v_fundo numeric(14,2);
  v_ant imobdesk.sf_solicitacao;
  v_saldo numeric(14,2);
  v_id bigint;
  v_mes date := date_trunc('month', current_date)::date;
  st imobdesk.at_setores;
begin
  if p_tipo not in ('reembolso', 'fundo_fixo', 'adiantamento') then
    perform imobdesk.erro('INVALID_INPUT', 'Tipo de solicitação inválido.', 'tipo');
  end if;
  if v_setor is null then
    perform imobdesk.erro('INVALID_INPUT', 'Seu cadastro de Pessoas está sem setor. Peça ao administrador para definir o seu setor.');
  end if;
  select * into st from imobdesk.at_setores where id = v_setor;
  if p_tipo = 'adiantamento' then
    if st.sf_acao_comprovacao_vencida = 'avisar_bloquear' and exists (
         select 1 from imobdesk.sf_solicitacao s
         where s.solicitante_id = v_uid and s.tipo = 'adiantamento' and s.status = 'comprovacao_pendente' and s.prazo_comprovacao < current_date) then
      perform imobdesk.erro('INVALID_INPUT', 'Você tem adiantamento com comprovação vencida. Envie a comprovação antes de pedir outro adiantamento.');
    end if;
    insert into imobdesk.sf_solicitacao (tipo, solicitante_id, pessoa_id, setor_id, competencia, centro_custo, obra, forma_pagamento, tipo_conta,
                                                   total_despesas, valor_a_pagar)
    values ('adiantamento', v_uid, imobdesk.sf_pessoa_do_usuario(v_uid), v_setor, v_mes, st.sf_centro_custo_padrao,
            case when st.sf_setor_obra then st.nome end, 'deposito', 'corrente', 0, 0)
    returning id into v_id;
    perform imobdesk.sf_registrar_evento(v_id, 'criada', jsonb_build_object('tipo', p_tipo));
    return v_id;
  end if;
  if p_tipo = 'fundo_fixo' then
    select f.valor into v_fundo from imobdesk.sf_fundo_fixo f where f.usuario_id = v_uid and f.ativo;
    if v_fundo is null then
      perform imobdesk.erro('INVALID_INPUT', 'Você não tem fundo fixo cadastrado. Peça ao administrador para cadastrar o valor do seu caixinha.');
    end if;
    select * into v_ant from imobdesk.sf_solicitacao s
    where s.solicitante_id = v_uid and s.tipo = 'fundo_fixo' and s.status not in ('rascunho', 'cancelada', 'reprovada')
    order by s.enviado_em desc nulls last, s.id desc limit 1;
    v_saldo := case when v_ant.id is null then v_fundo
                    else coalesce(v_ant.saldo_final, 0) + case when v_ant.status in ('paga', 'encerrada') then coalesce(v_ant.valor_a_pagar, 0) else 0 end end;
  end if;
  insert into imobdesk.sf_solicitacao (tipo, solicitante_id, pessoa_id, setor_id, competencia, periodo_de, periodo_ate, centro_custo,
                                                 valor_fundo_fixo, saldo_inicial, saldo_final, total_despesas, valor_a_pagar)
  values (p_tipo, v_uid, imobdesk.sf_pessoa_do_usuario(v_uid), v_setor, v_mes, v_mes, (v_mes + interval '1 month - 1 day')::date,
          st.sf_centro_custo_padrao, v_fundo, v_saldo, v_saldo, 0, 0)
  returning id into v_id;
  perform imobdesk.sf_registrar_evento(v_id, 'criada', jsonb_build_object('tipo', p_tipo));
  return v_id;
end;
$$;

-- ---------- Adiantamento: gravar o formulário (tela 13) ----------
/**
 * Grava o formulário do adiantamento (rascunho automático). O valor vira a linha única (sf_item) que a conferência
 * item a item e o lançamento usam; o rateio por tarefa é refeito a cada gravação; prazo de comprovação = vencimento +
 * prazo do setor. Valida só formato: a completude é checada no envio.
 */
create or replace function imobdesk.sf_adiantamento_salvar(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s imobdesk.sf_solicitacao := imobdesk.sf_exigir_editavel(nullif(p ->> 'id', '')::bigint);
  v_valor numeric(14,2) := nullif(p ->> 'valor', '')::numeric;
  v_doc text := nullif(regexp_replace(coalesce(p ->> 'favorecidoDoc', ''), '\D', '', 'g'), '');
  v_pdoc text := nullif(regexp_replace(coalesce(p ->> 'pedidoFornecedorDoc', ''), '\D', '', 'g'), '');
  v_pval numeric(14,2) := nullif(p ->> 'pedidoValor', '')::numeric;
  v_pct numeric(5,2) := nullif(p ->> 'pedidoPercentual', '')::numeric;
  v_forma text := nullif(p ->> 'formaPagamento', '');
  v_tconta text := nullif(p ->> 'tipoConta', '');
  v_venc date := nullif(p ->> 'vencimento', '')::date;
  v_prazo date;
  v_item bigint;
  r jsonb;
  v_n int := 0;
begin
  if s.tipo <> 'adiantamento' then perform imobdesk.erro('INVALID_INPUT', 'Esta solicitação não é um adiantamento.'); end if;
  if v_valor is not null and v_valor <= 0 then perform imobdesk.erro('INVALID_INPUT', 'O valor precisa ser maior que zero.', 'valor'); end if;
  if v_doc is not null and v_doc !~ '^\d{11}$|^\d{14}$' then perform imobdesk.erro('INVALID_INPUT', 'CPF/CNPJ do favorecido inválido.', 'favorecidoDoc'); end if;
  if v_pdoc is not null and v_pdoc !~ '^\d{11}$|^\d{14}$' then perform imobdesk.erro('INVALID_INPUT', 'CNPJ do fornecedor inválido.', 'pedidoFornecedorDoc'); end if;
  if v_pval is not null and v_pval <= 0 then perform imobdesk.erro('INVALID_INPUT', 'Valor do pedido inválido.', 'pedidoValor'); end if;
  if v_pct is not null and (v_pct <= 0 or v_pct > 100) then perform imobdesk.erro('INVALID_INPUT', 'Percentual entre 0 e 100.', 'pedidoPercentual'); end if;
  if v_forma is not null and v_forma not in ('deposito', 'boleto', 'cheque', 'dinheiro') then perform imobdesk.erro('INVALID_INPUT', 'Forma de pagamento inválida.', 'formaPagamento'); end if;
  if v_tconta is not null and v_tconta not in ('corrente', 'poupanca') then perform imobdesk.erro('INVALID_INPUT', 'Tipo de conta inválido.', 'tipoConta'); end if;
  if jsonb_array_length(coalesce(p -> 'rateio', '[]')) > 50 then perform imobdesk.erro('INVALID_INPUT', 'No máximo 50 tarefas no rateio.', 'rateio'); end if;
  v_prazo := v_venc + (select coalesce(st.sf_prazo_comprovacao_dias, 30) from imobdesk.at_setores st where st.id = s.setor_id);

  update imobdesk.sf_solicitacao
     set obra = left(nullif(btrim(p ->> 'obra'), ''), 160), conta_caixa = left(nullif(btrim(p ->> 'contaCaixa'), ''), 40),
         conta_pagamento = left(nullif(btrim(p ->> 'contaPagamento'), ''), 120), centro_custo = left(nullif(btrim(p ->> 'centroCusto'), ''), 60),
         centro_apuracao = left(nullif(btrim(p ->> 'centroApuracao'), ''), 60), valor_adiantamento = v_valor,
         favorecido = left(nullif(btrim(p ->> 'favorecido'), ''), 160), favorecido_doc = v_doc, finalidade = left(nullif(btrim(p ->> 'finalidade'), ''), 500),
         forma_pagamento = v_forma, banco = left(nullif(btrim(p ->> 'banco'), ''), 60), agencia = left(nullif(btrim(p ->> 'agencia'), ''), 20),
         conta = left(nullif(btrim(p ->> 'conta'), ''), 30), tipo_conta = v_tconta, vencimento = v_venc, prazo_comprovacao = v_prazo,
         pedido_numero = left(nullif(btrim(p ->> 'pedidoNumero'), ''), 40), pedido_data = nullif(p ->> 'pedidoData', '')::date,
         pedido_fornecedor = left(nullif(btrim(p ->> 'pedidoFornecedor'), ''), 160), pedido_fornecedor_doc = v_pdoc,
         pedido_valor = v_pval, pedido_percentual = v_pct, pedido_condicao = left(nullif(btrim(p ->> 'pedidoCondicao'), ''), 200),
         atualizado_em = now()
   where id = s.id;

  -- Linha única: data do preenchimento, valor, favorecido e finalidade.
  select i.id into v_item from imobdesk.sf_item i where i.solicitacao_id = s.id order by i.id limit 1;
  if v_item is null then
    insert into imobdesk.sf_item (solicitacao_id, ordem, data, valor, descricao_favorecido, motivo)
    values (s.id, 1, (s.criado_em at time zone 'America/Sao_Paulo')::date, v_valor,
            left(nullif(btrim(p ->> 'favorecido'), ''), 200), left(nullif(btrim(p ->> 'finalidade'), ''), 200))
    returning id into v_item;
  else
    update imobdesk.sf_item
       set valor = v_valor, descricao_favorecido = left(nullif(btrim(p ->> 'favorecido'), ''), 200),
           motivo = left(nullif(btrim(p ->> 'finalidade'), ''), 200), atualizado_em = now()
     where id = v_item;
  end if;
  update imobdesk.sf_anexo set item_id = v_item where solicitacao_id = s.id and finalidade = 'documento_origem' and item_id is null;

  delete from imobdesk.sf_rateio where solicitacao_id = s.id;
  for r in select value from jsonb_array_elements(coalesce(p -> 'rateio', '[]')) loop
    v_n := v_n + 1;
    if nullif(btrim(r ->> 'tarefa'), '') is null and nullif(r ->> 'porcentagem', '') is null then continue; end if;
    if nullif(btrim(r ->> 'tarefa'), '') is null or length(btrim(r ->> 'tarefa')) > 40 then
      perform imobdesk.erro('INVALID_INPUT', format('Rateio, linha %s: informe a tarefa (até 40 caracteres).', v_n), 'rateio');
    end if;
    if coalesce(nullif(r ->> 'porcentagem', '')::numeric, 0) <= 0 or (r ->> 'porcentagem')::numeric > 100 then
      perform imobdesk.erro('INVALID_INPUT', format('Rateio, linha %s: porcentagem entre 0 e 100.', v_n), 'rateio');
    end if;
    insert into imobdesk.sf_rateio (solicitacao_id, tarefa, porcentagem, valor)
    values (s.id, btrim(r ->> 'tarefa'), round((r ->> 'porcentagem')::numeric, 2), round(coalesce(v_valor, 0) * (r ->> 'porcentagem')::numeric / 100, 2));
  end loop;

  perform imobdesk.sf_recalcular(s.id);
  return jsonb_build_object('itemId', v_item, 'prazoComprovacao', v_prazo);
end;
$$;

/** Completude do adiantamento no envio (mensagem com o campo para a tela marcar). */
create or replace function imobdesk.sf_adiantamento_validar(p_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  s imobdesk.sf_solicitacao;
begin
  select * into s from imobdesk.sf_solicitacao where id = p_id;
  if s.obra is null then perform imobdesk.erro('INVALID_INPUT', 'Informe a obra (empresa pagadora).', 'obra'); end if;
  if s.centro_custo is null then perform imobdesk.erro('INVALID_INPUT', 'Informe o centro de custo.', 'centroCusto'); end if;
  if coalesce(s.valor_adiantamento, 0) <= 0 then perform imobdesk.erro('INVALID_INPUT', 'Informe o valor do adiantamento.', 'valor'); end if;
  if s.favorecido is null then perform imobdesk.erro('INVALID_INPUT', 'Informe o favorecido.', 'favorecido'); end if;
  if s.favorecido_doc is null then perform imobdesk.erro('INVALID_INPUT', 'Informe o CPF/CNPJ do favorecido.', 'favorecidoDoc'); end if;
  if s.finalidade is null then perform imobdesk.erro('INVALID_INPUT', 'Informe a finalidade.', 'finalidade'); end if;
  if s.forma_pagamento is null then perform imobdesk.erro('INVALID_INPUT', 'Escolha a forma de pagamento.', 'formaPagamento'); end if;
  if s.forma_pagamento = 'deposito' and (s.banco is null or s.agencia is null or s.conta is null or s.tipo_conta is null) then
    perform imobdesk.erro('INVALID_INPUT', 'Para depósito, informe banco, agência, conta e tipo de conta.', 'banco');
  end if;
  if s.vencimento is null or s.vencimento < current_date then
    perform imobdesk.erro('INVALID_INPUT', 'Informe o vencimento (hoje ou depois).', 'vencimento');
  end if;
  if not exists (select 1 from imobdesk.sf_item i where i.solicitacao_id = p_id) then
    perform imobdesk.erro('INVALID_INPUT', 'Grave o formulário antes de enviar.');
  end if;
  update imobdesk.sf_anexo a set item_id = (select min(i.id) from imobdesk.sf_item i where i.solicitacao_id = p_id)
   where a.solicitacao_id = p_id and a.finalidade = 'documento_origem' and a.item_id is null;
end;
$$;

-- ---------- Checagens A01–A06 ----------
/** Regras do adiantamento (todas aparecem, com "ok" quando passam, como no mockup). Não grava. */
create or replace function imobdesk.sf_checagens_adiantamento(p_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s imobdesk.sf_solicitacao;
  st imobdesk.at_setores;
  v_res jsonb := '[]';
  v_sev text;
  v_n int;
  v_lim numeric(14,2);
  v_soma numeric;
  v_abertos int;
  v_outro text;
  v_vencida text;
  v_prob text[];
  add_ok boolean;
begin
  select * into s from imobdesk.sf_solicitacao where id = p_id;
  select * into st from imobdesk.at_setores where id = s.setor_id;

  -- A01 documento de origem
  select severidade into v_sev from imobdesk.sf_regra where codigo = 'A01' and ativo;
  if v_sev is not null then
    select count(*) into v_n from imobdesk.sf_anexo a where a.solicitacao_id = p_id and a.finalidade = 'documento_origem';
    v_res := v_res || jsonb_build_object('codigo', 'A01', 'itemId', null, 'resultado', case when v_n > 0 then 'ok' else v_sev end,
                                         'detalhe', case when v_n > 0 then format('%s documento%s anexado%s', v_n, case when v_n > 1 then 's' else '' end, case when v_n > 1 then 's' else '' end)
                                                         else 'Anexe o pedido de compras, a proposta ou o e-mail' end);
  end if;
  -- A02 valor até o pedido × percentual
  select severidade into v_sev from imobdesk.sf_regra where codigo = 'A02' and ativo;
  if v_sev is not null then
    if s.pedido_valor is null or s.pedido_percentual is null or s.valor_adiantamento is null then
      v_res := v_res || jsonb_build_object('codigo', 'A02', 'itemId', null, 'resultado', v_sev, 'detalhe', 'Informe o valor do pedido e o percentual da condição');
    else
      v_lim := round(s.pedido_valor * s.pedido_percentual / 100, 2);
      v_res := v_res || jsonb_build_object('codigo', 'A02', 'itemId', null, 'resultado', case when s.valor_adiantamento <= v_lim then 'ok' else v_sev end,
        'detalhe', format('%s %s %s × %s%%', imobdesk.sf_br(s.valor_adiantamento), case when s.valor_adiantamento = v_lim then '=' when s.valor_adiantamento < v_lim then '≤' else '>' end,
                          imobdesk.sf_br(s.pedido_valor), trim(trailing ',' from trim(trailing '0' from replace(s.pedido_percentual::text, '.', ',')))));
    end if;
  end if;
  -- A03 CNPJ do favorecido = fornecedor do pedido
  select severidade into v_sev from imobdesk.sf_regra where codigo = 'A03' and ativo;
  if v_sev is not null then
    v_res := v_res || jsonb_build_object('codigo', 'A03', 'itemId', null,
      'resultado', case when s.favorecido_doc is not null and s.favorecido_doc = s.pedido_fornecedor_doc then 'ok' else v_sev end,
      'detalhe', case when s.pedido_fornecedor_doc is null then 'CNPJ do fornecedor do pedido não informado'
                      when s.favorecido_doc is distinct from s.pedido_fornecedor_doc then 'CPF/CNPJ do favorecido diferente do fornecedor do pedido'
                      else 'CNPJ igual ao do fornecedor' end);
  end if;
  -- A05 rateio fecha 100%
  select severidade into v_sev from imobdesk.sf_regra where codigo = 'A05' and ativo;
  if v_sev is not null then
    select coalesce(sum(r.porcentagem), 0), count(*) into v_soma, v_n from imobdesk.sf_rateio r where r.solicitacao_id = p_id;
    v_res := v_res || jsonb_build_object('codigo', 'A05', 'itemId', null, 'resultado', case when v_n > 0 and v_soma = 100 then 'ok' else v_sev end,
      'detalhe', case when v_n = 0 then 'Inclua ao menos uma tarefa' else 'Soma ' || trim(trailing ',' from trim(trailing '0' from replace(v_soma::text, '.', ','))) || '%' end);
  end if;
  -- A06 pedido sem outro adiantamento em aberto; abaixo do limite por pessoa; sem comprovação vencida
  select severidade into v_sev from imobdesk.sf_regra where codigo = 'A06' and ativo;
  if v_sev is not null then
    v_prob := '{}';
    if s.pedido_numero is not null then
      select o.numero into v_outro from imobdesk.sf_solicitacao o
      where o.id <> p_id and o.tipo = 'adiantamento' and o.pedido_numero = s.pedido_numero
        and o.status not in ('rascunho', 'cancelada', 'reprovada', 'encerrada') limit 1;
      if v_outro is not null then v_prob := v_prob || format('Pedido %s já tem o adiantamento %s em aberto', s.pedido_numero, v_outro); end if;
    end if;
    select count(*) into v_abertos from imobdesk.sf_solicitacao o
    where o.id <> p_id and o.solicitante_id = s.solicitante_id and o.tipo = 'adiantamento' and o.status not in ('rascunho', 'cancelada', 'reprovada', 'encerrada');
    if st.sf_limite_adiantamentos_abertos is not null and v_abertos + 1 > st.sf_limite_adiantamentos_abertos then
      v_prob := v_prob || format('Você já tem %s adiantamento%s em aberto (limite %s)', v_abertos, case when v_abertos > 1 then 's' else '' end, st.sf_limite_adiantamentos_abertos);
    end if;
    if st.sf_acao_comprovacao_vencida = 'avisar_bloquear' then
      select o.numero into v_vencida from imobdesk.sf_solicitacao o
      where o.id <> p_id and o.solicitante_id = s.solicitante_id and o.tipo = 'adiantamento' and o.status = 'comprovacao_pendente' and o.prazo_comprovacao < current_date limit 1;
      if v_vencida is not null then v_prob := v_prob || format('Comprovação do %s vencida', v_vencida); end if;
    end if;
    v_res := v_res || jsonb_build_object('codigo', 'A06', 'itemId', null, 'resultado', case when cardinality(v_prob) = 0 then 'ok' else v_sev end,
      'detalhe', case when cardinality(v_prob) > 0 then array_to_string(v_prob, ' · ')
                      else concat_ws(' · ', case when s.pedido_numero is not null then 'Pedido sem outro adiantamento' end,
                                     format('você tem %s de %s', v_abertos + 1, coalesce(st.sf_limite_adiantamentos_abertos::text, 'sem limite'))) end);
  end if;
  return v_res;
end;
$$;

-- ---------- Comprovação (tela 15) ----------

/** Anexa a NF/recibo da comprovação (o arquivo já está no Storage). */
create or replace function imobdesk.sf_comprovacao_anexar(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.sf_exigir_login();
  s imobdesk.sf_solicitacao;
  v_path text := p ->> 'path';
  v_id bigint;
begin
  select * into s from imobdesk.sf_solicitacao where id = nullif(p ->> 'solicitacaoId', '')::bigint;
  if not found or s.solicitante_id <> v_uid then perform imobdesk.erro('NOT_FOUND', 'Solicitação não encontrada.'); end if;
  if s.status <> 'comprovacao_pendente' then perform imobdesk.erro('INVALID_INPUT', 'Este adiantamento não está aguardando comprovação.'); end if;
  if v_path is null or split_part(v_path, '/', 1) <> v_uid::text or split_part(v_path, '/', 2) <> s.id::text then
    perform imobdesk.erro('INVALID_INPUT', 'Arquivo fora da pasta da solicitação.', 'path');
  end if;
  if coalesce(lower(p ->> 'sha256'), '') !~ '^[0-9a-f]{64}$' or coalesce((p ->> 'tamanho')::bigint, 0) not between 1 and 10485760
     or coalesce(p ->> 'mime', '') not in ('image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp', 'application/pdf') then
    perform imobdesk.erro('INVALID_INPUT', 'Arquivo inválido (JPG, PNG, HEIC ou PDF até 10 MB).');
  end if;
  insert into imobdesk.sf_anexo (solicitacao_id, finalidade, storage_path, nome_arquivo, mime, tamanho, sha256, criado_por)
  values (s.id, 'comprovacao', v_path, left(coalesce(nullif(p ->> 'nome', ''), 'arquivo'), 200), p ->> 'mime', (p ->> 'tamanho')::bigint, lower(p ->> 'sha256'), v_uid)
  returning id into v_id;
  perform imobdesk.sf_registrar_evento(s.id, 'comprovacao_anexo', jsonb_build_object('anexoId', v_id, 'nome', p ->> 'nome'));
  return jsonb_build_object('id', v_id);
end;
$$;

/** Tira o arquivo da comprovação ainda não enviada (a tela apaga do Storage com o caminho devolvido). */
create or replace function imobdesk.sf_comprovacao_anexo_remover(p_id bigint)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  a imobdesk.sf_anexo;
begin
  select * into a from imobdesk.sf_anexo where id = p_id and finalidade = 'comprovacao';
  if not found or not exists (select 1 from imobdesk.sf_solicitacao s where s.id = a.solicitacao_id and s.solicitante_id = (select auth.uid())
                                                                                  and s.status = 'comprovacao_pendente')
     or exists (select 1 from imobdesk.sf_comprovacao c where c.anexo_id = p_id) then
    perform imobdesk.erro('NOT_FOUND', 'Arquivo não encontrado.');
  end if;
  delete from imobdesk.sf_anexo where id = p_id;
  return a.storage_path;
end;
$$;

/**
 * A07 para os dados informados (prévia na tela e gravação no envio): emitente = favorecido, emissão depois do
 * pagamento e até o prazo, valor ≥ adiantado, nota não usada antes (chave de acesso, arquivo ou CNPJ + número).
 */
create or replace function imobdesk.sf_comprovacao_checar(p_id bigint, p jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s imobdesk.sf_solicitacao;
  a imobdesk.sf_anexo;
  v_sev text;
  v_doc text := nullif(regexp_replace(coalesce(p ->> 'emitenteDoc', ''), '\D', '', 'g'), '');
  v_emissao date := nullif(p ->> 'emissao', '')::date;
  v_valor numeric(14,2) := nullif(p ->> 'valor', '')::numeric;
  v_num text := nullif(btrim(p ->> 'numero'), '');
  v_pago date;
  v_usada text;
  v_res jsonb := '[]';
begin
  select * into s from imobdesk.sf_solicitacao where id = p_id;
  if not found or not imobdesk.sf_pode_ver(p_id) or s.tipo <> 'adiantamento' then
    perform imobdesk.erro('NOT_FOUND', 'Solicitação não encontrada.');
  end if;
  select severidade into v_sev from imobdesk.sf_regra where codigo = 'A07' and ativo;
  if v_sev is null then return v_res; end if;
  select * into a from imobdesk.sf_anexo x where x.id = nullif(p ->> 'anexoId', '')::bigint and x.solicitacao_id = p_id;
  v_pago := coalesce((s.pago_em at time zone 'America/Sao_Paulo')::date,
                     (select (e.criado_em at time zone 'America/Sao_Paulo')::date from imobdesk.sf_evento e where e.solicitacao_id = p_id and e.tipo = 'paga' order by e.id desc limit 1));

  v_res := v_res || jsonb_build_object('codigo', 'A07', 'nome', 'Emitente = favorecido',
    'resultado', case when v_doc is not null and v_doc = s.favorecido_doc then 'ok' else v_sev end,
    'detalhe', case when v_doc is null then 'Informe o CNPJ/CPF do emitente' when v_doc = s.favorecido_doc then 'CNPJ igual ao do adiantamento' else 'Emitente diferente do favorecido' end);
  v_res := v_res || jsonb_build_object('codigo', 'A07', 'nome', 'Emissão após o pagamento',
    'resultado', case when v_emissao is not null and v_pago is not null and v_emissao >= v_pago then 'ok' else v_sev end,
    'detalhe', case when v_emissao is null then 'Informe a emissão' when v_pago is null then 'Pagamento sem data'
                    else to_char(v_emissao, 'DD/MM') || case when v_emissao >= v_pago then ' ≥ ' else ' < ' end || to_char(v_pago, 'DD/MM') end);
  v_res := v_res || jsonb_build_object('codigo', 'A07', 'nome', 'Dentro do prazo',
    'resultado', case when s.prazo_comprovacao is not null and current_date <= s.prazo_comprovacao and (v_emissao is null or v_emissao <= s.prazo_comprovacao) then 'ok' else v_sev end,
    'detalhe', 'até ' || coalesce(to_char(s.prazo_comprovacao, 'DD/MM/YYYY'), '—'));
  v_res := v_res || jsonb_build_object('codigo', 'A07', 'nome', 'Valor ≥ adiantado',
    'resultado', case when v_valor is not null and v_valor >= s.valor_adiantamento then 'ok' else v_sev end,
    'detalhe', case when v_valor is null then 'Informe o valor da nota'
                    else imobdesk.sf_br(v_valor) || case when v_valor >= s.valor_adiantamento then ' ≥ ' else ' < ' end || imobdesk.sf_br(s.valor_adiantamento)
                         || case when v_valor < s.valor_adiantamento then ' · devolução de R$ ' || imobdesk.sf_br(s.valor_adiantamento - v_valor) else '' end end);
  select o.numero into v_usada
  from imobdesk.sf_comprovacao c join imobdesk.sf_solicitacao o on o.id = c.solicitacao_id
  where c.solicitacao_id <> p_id and c.status <> 'ajuste'
    and ((a.chave_acesso is not null and c.chave_acesso = a.chave_acesso)
         or (v_num is not null and v_doc is not null and c.emitente_doc = v_doc and c.numero_documento = v_num))
  limit 1;
  if v_usada is null and a.id is not null then
    select o.numero into v_usada from imobdesk.sf_anexo b join imobdesk.sf_solicitacao o on o.id = b.solicitacao_id
    where b.solicitacao_id <> p_id and o.status not in ('cancelada', 'reprovada')
      and (b.sha256 = a.sha256 or (a.chave_acesso is not null and b.chave_acesso = a.chave_acesso)) limit 1;
  end if;
  v_res := v_res || jsonb_build_object('codigo', 'A07', 'nome', 'Nota não usada antes',
    'resultado', case when v_usada is null then 'ok' else v_sev end,
    'detalhe', case when v_usada is not null then 'Já usada na ' || v_usada when a.chave_acesso is not null then 'Chave de acesso inédita' else 'Arquivo e número inéditos' end);
  return v_res;
end;
$$;

/** Envia a comprovação ao Financeiro: grava sf_comprovacao com o acerto e as checagens A07. */
create or replace function imobdesk.sf_enviar_comprovacao(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.sf_exigir_login();
  s imobdesk.sf_solicitacao;
  a imobdesk.sf_anexo;
  v_doc text := nullif(regexp_replace(coalesce(p ->> 'emitenteDoc', ''), '\D', '', 'g'), '');
  v_valor numeric(14,2) := nullif(p ->> 'valor', '')::numeric;
  v_emissao date := nullif(p ->> 'emissao', '')::date;
  v_tipo text := coalesce(nullif(p ->> 'tipoDocumento', ''), 'outro');
  v_checks jsonb;
begin
  select * into s from imobdesk.sf_solicitacao where id = nullif(p ->> 'id', '')::bigint for update;
  if not found or s.solicitante_id <> v_uid then perform imobdesk.erro('NOT_FOUND', 'Solicitação não encontrada.'); end if;
  if s.status <> 'comprovacao_pendente' then perform imobdesk.erro('INVALID_INPUT', 'Este adiantamento não está aguardando comprovação.'); end if;
  select * into a from imobdesk.sf_anexo x where x.id = nullif(p ->> 'anexoId', '')::bigint and x.solicitacao_id = s.id and x.finalidade = 'comprovacao';
  if not found then perform imobdesk.erro('INVALID_INPUT', 'Anexe a nota fiscal, o recibo ou a foto.', 'anexo'); end if;
  if v_tipo not in ('nfe', 'nfce', 'cupom', 'recibo', 'outro') then perform imobdesk.erro('INVALID_INPUT', 'Tipo de documento inválido.', 'tipoDocumento'); end if;
  if v_emissao is null then perform imobdesk.erro('INVALID_INPUT', 'Informe a emissão.', 'emissao'); end if;
  if coalesce(v_doc, '') !~ '^\d{11}$|^\d{14}$' then perform imobdesk.erro('INVALID_INPUT', 'Informe o CNPJ/CPF do emitente.', 'emitenteDoc'); end if;
  if coalesce(v_valor, 0) <= 0 then perform imobdesk.erro('INVALID_INPUT', 'Informe o valor da nota.', 'valor'); end if;
  v_checks := imobdesk.sf_comprovacao_checar(s.id, p);
  insert into imobdesk.sf_comprovacao (solicitacao_id, anexo_id, tipo_documento, emitente_doc, emitente_nome, emissao, valor, numero_documento,
                                                 referencia, chave_acesso, saldo_devolver, saldo_pagar, status)
  values (s.id, a.id, v_tipo, v_doc, left(nullif(btrim(p ->> 'emitente'), ''), 160), v_emissao, v_valor, left(nullif(btrim(p ->> 'numero'), ''), 60),
          left(nullif(btrim(p ->> 'referencia'), ''), 120), a.chave_acesso,
          greatest(s.valor_adiantamento - v_valor, 0), greatest(v_valor - s.valor_adiantamento, 0), 'enviada');
  delete from imobdesk.sf_regra_resultado where solicitacao_id = s.id and regra_codigo = 'A07';
  insert into imobdesk.sf_regra_resultado (solicitacao_id, regra_codigo, resultado, detalhe)
  select s.id, 'A07', x ->> 'resultado', (x ->> 'nome') || ': ' || (x ->> 'detalhe') from jsonb_array_elements(v_checks) x;
  update imobdesk.sf_solicitacao set status = 'comprovacao_em_conferencia', status_comprovacao = 'enviada', atualizado_em = now() where id = s.id;
  perform imobdesk.sf_registrar_evento(s.id, 'comprovacao_enviada', jsonb_build_object('valor', v_valor, 'anexoId', a.id));
  return jsonb_build_object('acerto', case when v_valor >= s.valor_adiantamento then 'comprovado' else 'devolucao' end,
                            'saldoPagar', greatest(v_valor - s.valor_adiantamento, 0), 'saldoDevolver', greatest(s.valor_adiantamento - v_valor, 0));
end;
$$;

/**
 * Financeiro decide a comprovação: aceitar (≥ adiantado: encerra; menor: devolução pendente da diferença) ou pedir
 * ajuste (volta para o colaborador enviar de novo). Aceitar com alerta da A07 exige observação.
 */
create or replace function imobdesk.sf_decidir_comprovacao(p_id bigint, p_decisao text, p_obs text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.sf_exigir_financeiro();
  s imobdesk.sf_solicitacao;
  c imobdesk.sf_comprovacao;
  v_obs text := nullif(btrim(coalesce(p_obs, '')), '');
  v_novo text;
begin
  select * into s from imobdesk.sf_solicitacao where id = p_id for update;
  if not found or s.status <> 'comprovacao_em_conferencia' then perform imobdesk.erro('INVALID_INPUT', 'A comprovação não está em conferência.'); end if;
  if p_decisao not in ('aceitar', 'ajuste') then perform imobdesk.erro('INVALID_INPUT', 'Decisão inválida.', 'decisao'); end if;
  select * into c from imobdesk.sf_comprovacao x where x.solicitacao_id = p_id order by x.id desc limit 1;
  if v_obs is null and (p_decisao = 'ajuste' or exists (select 1 from imobdesk.sf_regra_resultado r
                                                        where r.solicitacao_id = p_id and r.regra_codigo = 'A07' and r.resultado <> 'ok')) then
    perform imobdesk.erro('INVALID_INPUT', case when p_decisao = 'ajuste' then 'Escreva o que o colaborador precisa ajustar.' else 'Comprovação com alerta: escreva a observação para aceitar.' end, 'obs');
  end if;
  if p_decisao = 'ajuste' then
    update imobdesk.sf_comprovacao set status = 'ajuste', obs = left(v_obs, 1000), conferida_por = v_uid, conferida_em = now() where id = c.id;
    update imobdesk.sf_solicitacao set status = 'comprovacao_pendente', status_comprovacao = 'pendente', atualizado_em = now() where id = p_id;
    perform imobdesk.sf_registrar_evento(p_id, 'comprovacao_ajuste', jsonb_build_object('obs', v_obs));
    return jsonb_build_object('status', 'comprovacao_pendente');
  end if;
  v_novo := case when c.valor >= s.valor_adiantamento then 'encerrada' else 'devolucao_pendente' end;
  update imobdesk.sf_comprovacao set status = case when v_novo = 'encerrada' then 'aceita' else 'devolucao' end, obs = left(v_obs, 1000),
         conferida_por = v_uid, conferida_em = now() where id = c.id;
  update imobdesk.sf_solicitacao set status = v_novo, status_comprovacao = case when v_novo = 'encerrada' then 'aceita' else 'devolucao' end,
         atualizado_em = now() where id = p_id;
  perform imobdesk.sf_registrar_evento(p_id, case when v_novo = 'encerrada' then 'comprovacao_aceita' else 'devolucao_pendente' end,
    jsonb_build_object('valor', c.valor, 'saldoPagar', c.saldo_pagar, 'saldoDevolver', c.saldo_devolver, 'obs', v_obs));
  return jsonb_build_object('status', v_novo, 'saldoPagar', c.saldo_pagar, 'saldoDevolver', c.saldo_devolver);
end;
$$;

/** O Financeiro confirma que a diferença foi devolvida: encerra. */
create or replace function imobdesk.sf_confirmar_devolucao(p_id bigint, p_obs text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.sf_exigir_financeiro();
begin
  if not exists (select 1 from imobdesk.sf_solicitacao where id = p_id and status = 'devolucao_pendente') then
    perform imobdesk.erro('INVALID_INPUT', 'Não há devolução pendente nesta solicitação.');
  end if;
  update imobdesk.sf_solicitacao set status = 'encerrada', atualizado_em = now() where id = p_id;
  perform imobdesk.sf_registrar_evento(p_id, 'devolucao_recebida', jsonb_build_object('obs', left(nullif(btrim(coalesce(p_obs, '')), ''), 1000)));
end;
$$;

-- ---------- Pagamento (redefinida: grava a data do pagamento) ----------
create or replace function imobdesk.sf_marcar_paga(p_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.sf_exigir_financeiro();
  s imobdesk.sf_solicitacao;
begin
  select * into s from imobdesk.sf_solicitacao where id = p_id;
  if not found or s.status <> 'pagamento_programado' then
    perform imobdesk.erro('INVALID_INPUT', 'Só dá para marcar como paga depois de programar o pagamento.');
  end if;
  update imobdesk.sf_solicitacao set status = 'paga', pago_em = now(), atualizado_em = now() where id = p_id;
  perform imobdesk.sf_registrar_evento(p_id, 'paga');
  if s.tipo = 'adiantamento' then
    update imobdesk.sf_solicitacao set status = 'comprovacao_pendente', status_comprovacao = 'pendente', atualizado_em = now() where id = p_id;
  end if;
end;
$$;

-- ---------- Dados do adiantamento para as telas e o PDF ----------
create or replace function imobdesk.sf_adiantamento_dados(p_id bigint)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'obra', s.obra, 'contaCaixa', s.conta_caixa, 'contaPagamento', s.conta_pagamento, 'centroCusto', s.centro_custo, 'centroApuracao', s.centro_apuracao,
    'valor', s.valor_adiantamento, 'favorecido', s.favorecido, 'favorecidoDoc', s.favorecido_doc, 'finalidade', s.finalidade,
    'formaPagamento', s.forma_pagamento, 'banco', s.banco, 'agencia', s.agencia, 'conta', s.conta, 'tipoConta', s.tipo_conta,
    'vencimento', s.vencimento, 'prazoComprovacao', s.prazo_comprovacao, 'dataPreenchimento', (s.criado_em at time zone 'America/Sao_Paulo')::date,
    'pedidoNumero', s.pedido_numero, 'pedidoData', s.pedido_data, 'pedidoFornecedor', s.pedido_fornecedor, 'pedidoFornecedorDoc', s.pedido_fornecedor_doc,
    'pedidoValor', s.pedido_valor, 'pedidoPercentual', s.pedido_percentual, 'pedidoCondicao', s.pedido_condicao,
    'statusComprovacao', s.status_comprovacao, 'pagoEm', s.pago_em, 'siengeSaldoId', s.sienge_saldo_id, 'siengeSaldoErro', s.sienge_saldo_erro,
    'prazoDias', st.sf_prazo_comprovacao_dias, 'setorObra', coalesce(st.sf_setor_obra, false),
    'ehSolicitante', s.solicitante_id = (select auth.uid()),
    'rateio', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'tarefa', r.tarefa, 'porcentagem', r.porcentagem, 'valor', r.valor) order by r.id)
                        from imobdesk.sf_rateio r where r.solicitacao_id = s.id), '[]'),
    'documentos', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'nome', a.nome_arquivo, 'path', a.storage_path, 'mime', a.mime,
                                                                'status', a.ocr_status, 'ocr', a.ocr_json) order by a.id)
                            from imobdesk.sf_anexo a where a.solicitacao_id = s.id and a.finalidade = 'documento_origem'), '[]'),
    'arquivosComprovacao', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'nome', a.nome_arquivo, 'path', a.storage_path, 'mime', a.mime,
                                                                         'status', a.ocr_status, 'ocr', a.ocr_json,
                                                                         'enviado', exists (select 1 from imobdesk.sf_comprovacao c where c.anexo_id = a.id)) order by a.id)
                                     from imobdesk.sf_anexo a where a.solicitacao_id = s.id and a.finalidade = 'comprovacao'), '[]'),
    'comprovacoes', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'anexoId', c.anexo_id, 'tipoDocumento', c.tipo_documento, 'emitente', c.emitente_nome,
                                                                  'emitenteDoc', c.emitente_doc, 'emissao', c.emissao, 'valor', c.valor, 'numero', c.numero_documento,
                                                                  'referencia', c.referencia, 'saldoPagar', c.saldo_pagar, 'saldoDevolver', c.saldo_devolver,
                                                                  'status', c.status, 'obs', c.obs, 'conferidaEm', c.conferida_em, 'criadoEm', c.criado_em) order by c.id desc)
                              from imobdesk.sf_comprovacao c where c.solicitacao_id = s.id), '[]'),
    'checagensComprovacao', coalesce((select jsonb_agg(jsonb_build_object('codigo', r.regra_codigo, 'resultado', r.resultado, 'detalhe', r.detalhe) order by r.id)
                                      from imobdesk.sf_regra_resultado r where r.solicitacao_id = s.id and r.regra_codigo = 'A07'), '[]'),
    'obras', case when s.status in ('rascunho', 'devolvida') then coalesce((select jsonb_agg(x.nome order by x.nome) from imobdesk.at_setores x
                                                                            where x.ativo and x.sf_setor_obra), '[]') end
  )
  from imobdesk.sf_solicitacao s left join imobdesk.at_setores st on st.id = s.setor_id
  where s.id = p_id;
$$;

-- ---------- SIENGE ----------
/**
 * Pedido de lançamento (redefinida): no adiantamento o credor é o favorecido (CPF/CNPJ do formulário) e vão junto o
 * rateio por tarefa e o documento de origem; nos demais, o colaborador pelo CPF de Pessoas.
 */
create or replace function imobdesk.sf_lancamento_pedido(p_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.sf_exigir_financeiro();
  s imobdesk.sf_solicitacao;
  v_doc text;
begin
  select * into s from imobdesk.sf_solicitacao where id = p_id for update;
  if not found then perform imobdesk.erro('NOT_FOUND', 'Solicitação não encontrada.'); end if;
  if s.status <> 'em_conferencia' then perform imobdesk.erro('INVALID_INPUT', 'A solicitação não está em conferência.'); end if;
  if s.sienge_status = 'lancando' and s.atualizado_em > now() - interval '3 minutes' then
    perform imobdesk.erro('INVALID_INPUT', 'O lançamento já está em andamento. Aguarde.');
  end if;
  if exists (select 1 from imobdesk.sf_item i where i.solicitacao_id = p_id and i.status_conferencia not in ('aceito', 'glosado')) then
    perform imobdesk.erro('INVALID_INPUT', 'Resolva todos os itens (aceitar ou glosar) antes do lançamento.');
  end if;
  if coalesce(s.valor_a_pagar, 0) <= 0 then perform imobdesk.erro('INVALID_INPUT', 'Valor a pagar zerado: não há o que lançar.'); end if;
  if s.tipo = 'adiantamento' then
    v_doc := s.favorecido_doc;
    if coalesce(v_doc, '') !~ '^\d{11}$|^\d{14}$' then
      perform imobdesk.erro('INVALID_INPUT', 'O favorecido está sem CPF/CNPJ: sem ele não dá para achar o credor no SIENGE.');
    end if;
  else
    select p.documento into v_doc from imobdesk.at_pessoas p where p.id = s.pessoa_id;
    if coalesce(v_doc, '') !~ '^\d{11}$|^\d{14}$' then
      perform imobdesk.erro('INVALID_INPUT', 'O solicitante está sem CPF no cadastro de Pessoas: sem ele não dá para achar o credor no SIENGE.');
    end if;
  end if;
  update imobdesk.sf_solicitacao set sienge_status = 'lancando', sienge_erro = null, atualizado_em = now() where id = p_id;
  return jsonb_build_object(
    'id', s.id, 'numero', s.numero, 'tipo', s.tipo, 'cpf', v_doc, 'solicitante', (select u.nome from imobdesk.usuarios u where u.id = s.solicitante_id),
    'favorecido', s.favorecido, 'finalidade', s.finalidade, 'pedidoNumero', s.pedido_numero, 'obra', s.obra,
    'setor', (select st.nome from imobdesk.at_setores st where st.id = s.setor_id),
    'centroCusto', s.centro_custo, 'centroCustoSetor', (select st.sf_centro_custo_padrao from imobdesk.at_setores st where st.id = s.setor_id),
    'competencia', s.competencia, 'periodoDe', s.periodo_de, 'periodoAte', s.periodo_ate, 'enviadoEm', s.enviado_em,
    'ultimaAprovacaoEm', s.ultima_aprovacao_em, 'pagarAte', s.pagar_ate, 'vencimento', s.vencimento,
    'total', s.total_despesas, 'glosado', s.valor_glosado, 'aPagar', s.valor_a_pagar, 'siengeId', s.sienge_lancamento_id,
    'rateio', coalesce((select jsonb_agg(jsonb_build_object('tarefa', r.tarefa, 'porcentagem', r.porcentagem) order by r.id)
                        from imobdesk.sf_rateio r where r.solicitacao_id = s.id), '[]'),
    'anexos', coalesce((select jsonb_agg(jsonb_build_object('path', a.storage_path, 'nome', a.nome_arquivo, 'mime', a.mime, 'ordem', i.ordem, 'finalidade', a.finalidade)
                                         order by i.ordem, a.id)
                        from imobdesk.sf_anexo a join imobdesk.sf_item i on i.id = a.item_id
                        where a.solicitacao_id = s.id and i.status_conferencia in ('aceito', 'glosado')), '[]'));
end;
$$;

/** Saldo do pedido contra a nota (comprovado > adiantado, já encerrado): pedido do 2º lançamento, com trava. */
create or replace function imobdesk.sf_lancamento_saldo_pedido(p_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.sf_exigir_financeiro();
  s imobdesk.sf_solicitacao;
  c imobdesk.sf_comprovacao;
  a imobdesk.sf_anexo;
begin
  select * into s from imobdesk.sf_solicitacao where id = p_id for update;
  if not found or s.tipo <> 'adiantamento' or s.status <> 'encerrada' then
    perform imobdesk.erro('INVALID_INPUT', 'O saldo só é lançado depois da comprovação aceita.');
  end if;
  select * into c from imobdesk.sf_comprovacao x where x.solicitacao_id = p_id and x.status = 'aceita' order by x.id desc limit 1;
  if c.id is null or c.saldo_pagar <= 0 then perform imobdesk.erro('INVALID_INPUT', 'Não há saldo do pedido a lançar.'); end if;
  if s.sienge_saldo_id is not null then perform imobdesk.erro('INVALID_INPUT', 'O saldo já foi lançado no SIENGE (título ' || s.sienge_saldo_id || ').'); end if;
  if s.sienge_status = 'lancando' and s.atualizado_em > now() - interval '3 minutes' then
    perform imobdesk.erro('INVALID_INPUT', 'O lançamento já está em andamento. Aguarde.');
  end if;
  select * into a from imobdesk.sf_anexo x where x.id = c.anexo_id;
  update imobdesk.sf_solicitacao set sienge_status = 'lancando', sienge_saldo_erro = null, atualizado_em = now() where id = p_id;
  return jsonb_build_object('id', s.id, 'numero', s.numero, 'tipo', s.tipo, 'cpf', s.favorecido_doc, 'solicitante', s.favorecido, 'favorecido', s.favorecido,
    'finalidade', s.finalidade, 'pedidoNumero', s.pedido_numero, 'obra', s.obra, 'setor', null, 'competencia', null,
    'ultimaAprovacaoEm', c.emissao, 'pagarAte', null, 'vencimento', null, 'total', c.saldo_pagar, 'glosado', 0, 'aPagar', c.saldo_pagar,
    'notaNumero', c.numero_documento, 'notaEmissao', c.emissao, 'centroCusto', s.sienge_centro_custo, 'plano', s.sienge_plano,
    'rateio', coalesce((select jsonb_agg(jsonb_build_object('tarefa', r.tarefa, 'porcentagem', r.porcentagem) order by r.id)
                        from imobdesk.sf_rateio r where r.solicitacao_id = s.id), '[]'),
    'anexos', case when a.id is null then '[]'::jsonb
                   else jsonb_build_array(jsonb_build_object('path', a.storage_path, 'nome', a.nome_arquivo, 'mime', a.mime, 'ordem', 1, 'finalidade', 'comprovacao')) end);
end;
$$;

create or replace function imobdesk.sf_lancamento_saldo_registrar(p_id bigint, p_ok boolean, p_titulo text, p_erro text, p_detalhe jsonb default '{}')
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_ok then
    update imobdesk.sf_solicitacao set sienge_saldo_id = p_titulo, sienge_status = null, sienge_saldo_erro = null, atualizado_em = now() where id = p_id;
    insert into imobdesk.sf_evento (solicitacao_id, tipo, ator_id, payload)
    values (p_id, 'lancamento_saldo_sienge', nullif(p_detalhe ->> 'atorId', '')::uuid, p_detalhe || jsonb_build_object('titulo', p_titulo));
  else
    update imobdesk.sf_solicitacao set sienge_status = 'erro', sienge_saldo_erro = left(p_erro, 1000), atualizado_em = now() where id = p_id;
    insert into imobdesk.sf_evento (solicitacao_id, tipo, ator_id, payload)
    values (p_id, 'lancamento_saldo_sienge_erro', nullif(p_detalhe ->> 'atorId', '')::uuid, jsonb_build_object('erro', left(p_erro, 1000)));
  end if;
end;
$$;

-- ---------- Job da comprovação (pg_cron, diário 08:00 de Brasília) ----------
/** Lembretes D-7 e D-1; vencida: marca, avisa o solicitante e os gestores do setor (e bloqueia novos adiantamentos). */
create or replace function imobdesk.sf_comprovacao_job()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s record;
  g record;
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_lemb int := 0;
  v_venc int := 0;
  v_link text;
begin
  for s in select x.* from imobdesk.sf_solicitacao x
           where x.tipo = 'adiantamento' and x.status = 'comprovacao_pendente' and x.prazo_comprovacao is not null loop
    v_link := '/financeiro/solicitacoes/' || s.id || '/comprovacao';
    if v_hoje > s.prazo_comprovacao then
      if s.comprovacao_vencida_em is null then
        update imobdesk.sf_solicitacao set status_comprovacao = 'vencida', comprovacao_vencida_em = now() where id = s.id;
        perform imobdesk.sf_notificar(s.solicitante_id, s.id, 'Comprovação vencida: ' || imobdesk.sf_rotulo(s.id),
          'O prazo terminou em ' || to_char(s.prazo_comprovacao, 'DD/MM/YYYY') || '. Novos adiantamentos ficam bloqueados até você enviar a comprovação.', v_link);
        for g in select distinct sg.usuario_id from imobdesk.at_setor_gestores sg where sg.setor_id = s.setor_id and sg.usuario_id <> s.solicitante_id loop
          perform imobdesk.sf_notificar(g.usuario_id, s.id, 'Comprovação vencida no seu setor: ' || imobdesk.sf_rotulo(s.id),
            'Prazo terminou em ' || to_char(s.prazo_comprovacao, 'DD/MM/YYYY') || '.');
        end loop;
        perform imobdesk.sf_registrar_evento(s.id, 'comprovacao_vencida', jsonb_build_object('prazo', s.prazo_comprovacao));
        v_venc := v_venc + 1;
      end if;
    elsif s.prazo_comprovacao - v_hoje <= 1 then
      if s.comprovacao_aviso1_em is null then
        perform imobdesk.sf_notificar(s.solicitante_id, s.id, 'Comprovação vence amanhã: ' || imobdesk.sf_rotulo(s.id),
          'Envie a nota fiscal ou o recibo até ' || to_char(s.prazo_comprovacao, 'DD/MM/YYYY') || '.', v_link);
        update imobdesk.sf_solicitacao set comprovacao_aviso1_em = now(), comprovacao_aviso7_em = coalesce(comprovacao_aviso7_em, now()) where id = s.id;
        v_lemb := v_lemb + 1;
      end if;
    elsif s.prazo_comprovacao - v_hoje <= 7 and s.comprovacao_aviso7_em is null then
      perform imobdesk.sf_notificar(s.solicitante_id, s.id, 'Comprovação vence em ' || (s.prazo_comprovacao - v_hoje) || ' dias: ' || imobdesk.sf_rotulo(s.id),
        'Envie a nota fiscal ou o recibo até ' || to_char(s.prazo_comprovacao, 'DD/MM/YYYY') || '.', v_link);
      update imobdesk.sf_solicitacao set comprovacao_aviso7_em = now() where id = s.id;
      v_lemb := v_lemb + 1;
    end if;
  end loop;
  return jsonb_build_object('lembretes', v_lemb, 'vencidas', v_venc);
end;
$$;

-- ---------- Checagens (redefinida: adiantamento usa A01–A06) ----------
create or replace function imobdesk.sf_checagens(p_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s imobdesk.sf_solicitacao;
  v_res jsonb := '[]';
  r record;
  v_dias int;
  v_sev text;
  v_par jsonb;
begin
  select * into s from imobdesk.sf_solicitacao where id = p_id;
  if not found or not imobdesk.sf_pode_ver(p_id) then perform imobdesk.erro('NOT_FOUND', 'Solicitação não encontrada.'); end if;
  if s.tipo = 'adiantamento' then
    return imobdesk.sf_checagens_adiantamento(p_id);
  end if;

  -- R01 comprovante em cada linha
  select severidade into v_sev from imobdesk.sf_regra where codigo = 'R01' and ativo;
  if v_sev is not null then
    for r in select i.id, i.ordem from imobdesk.sf_item i where i.solicitacao_id = p_id
               and not exists (select 1 from imobdesk.sf_anexo a where a.item_id = i.id and a.finalidade = 'comprovante') loop
      v_res := v_res || jsonb_build_object('codigo', 'R01', 'itemId', r.id, 'resultado', v_sev, 'detalhe', format('Linha %s sem comprovante', r.ordem));
    end loop;
  end if;
  -- R02 legibilidade (comprovante lido com campo-chave abaixo do limiar)
  select severidade, parametros into v_sev, v_par from imobdesk.sf_regra where codigo = 'R02' and ativo;
  if v_sev is not null then
    for r in select i.id, i.ordem from imobdesk.sf_item i join imobdesk.sf_anexo a on a.item_id = i.id
             where i.solicitacao_id = p_id and a.ocr_status = 'ilegivel' loop
      v_res := v_res || jsonb_build_object('codigo', 'R02', 'itemId', r.id, 'resultado', v_sev,
                                           'detalhe', format('Linha %s: comprovante com legibilidade abaixo de %s%%', r.ordem, round(coalesce((v_par ->> 'limiar')::numeric, 0.8) * 100)));
    end loop;
  end if;
  -- R03 data no período
  select severidade into v_sev from imobdesk.sf_regra where codigo = 'R03' and ativo;
  if v_sev is not null and s.periodo_de is not null and s.periodo_ate is not null then
    for r in select i.id, i.ordem, i.data from imobdesk.sf_item i where i.solicitacao_id = p_id and i.data is not null
               and (i.data < s.periodo_de or i.data > s.periodo_ate) loop
      v_res := v_res || jsonb_build_object('codigo', 'R03', 'itemId', r.id, 'resultado', v_sev,
                                           'detalhe', format('Linha %s: %s fora do período', r.ordem, to_char(r.data, 'DD/MM/YYYY')));
    end loop;
  end if;
  -- R04 valor lido = declarado (com tolerância)
  select severidade, parametros into v_sev, v_par from imobdesk.sf_regra where codigo = 'R04' and ativo;
  if v_sev is not null then
    for r in select i.id, i.ordem, i.valor, (a.ocr_json ->> 'valor_total')::numeric as lido
             from imobdesk.sf_item i join imobdesk.sf_anexo a on a.item_id = i.id
             where i.solicitacao_id = p_id and a.ocr_status in ('lido', 'ilegivel') and (a.ocr_json ->> 'valor_total') is not null
               and abs(i.valor - (a.ocr_json ->> 'valor_total')::numeric) > coalesce((v_par ->> 'tolerancia')::numeric, 0) loop
      v_res := v_res || jsonb_build_object('codigo', 'R04', 'itemId', r.id, 'resultado', v_sev,
                                           'detalhe', format('Linha %s: declarado %s, comprovante %s', r.ordem, r.valor, r.lido));
    end loop;
  end if;
  -- R05 documento fiscal com CNPJ/CPF do emissor
  select severidade into v_sev from imobdesk.sf_regra where codigo = 'R05' and ativo;
  if v_sev is not null then
    for r in select i.id, i.ordem from imobdesk.sf_item i join imobdesk.sf_anexo a on a.item_id = i.id
             where i.solicitacao_id = p_id and a.ocr_status in ('lido', 'ilegivel')
               and (coalesce(a.ocr_json ->> 'tipo_documento', 'outro') = 'outro' or coalesce(a.ocr_json ->> 'cnpj_cpf_emissor', '') !~ '^\d{11}$|^\d{14}$') loop
      v_res := v_res || jsonb_build_object('codigo', 'R05', 'itemId', r.id, 'resultado', v_sev,
                                           'detalhe', format('Linha %s: sem documento fiscal com CNPJ/CPF do emissor', r.ordem));
    end loop;
  end if;
  -- R06 duplicidade: mesmo arquivo, ou mesmo CNPJ + data + valor lidos, em outra solicitação ativa
  select severidade into v_sev from imobdesk.sf_regra where codigo = 'R06' and ativo;
  if v_sev is not null then
    for r in select distinct on (a.id) a.item_id, a.nome_arquivo, o.numero
             from imobdesk.sf_anexo a
             join imobdesk.sf_anexo b on b.solicitacao_id <> a.solicitacao_id
                  and (b.sha256 = a.sha256
                       or (a.ocr_json ->> 'cnpj_cpf_emissor' is not null and a.ocr_json ->> 'data' is not null and a.ocr_json ->> 'valor_total' is not null
                           and b.ocr_json ->> 'cnpj_cpf_emissor' = a.ocr_json ->> 'cnpj_cpf_emissor'
                           and b.ocr_json ->> 'data' = a.ocr_json ->> 'data'
                           and (b.ocr_json ->> 'valor_total')::numeric = (a.ocr_json ->> 'valor_total')::numeric))
             join imobdesk.sf_solicitacao o on o.id = b.solicitacao_id and o.status not in ('cancelada', 'reprovada')
             where a.solicitacao_id = p_id and a.item_id is not null loop
      v_res := v_res || jsonb_build_object('codigo', 'R06', 'itemId', r.item_id, 'resultado', v_sev,
                                           'detalhe', format('%s já usado na %s', r.nome_arquivo, r.numero));
    end loop;
  end if;
  -- R07 itens proibidos (lista do admin) nos itens lidos, e alertas da leitura
  select severidade, parametros into v_sev, v_par from imobdesk.sf_regra where codigo = 'R07' and ativo;
  if v_sev is not null then
    for r in select distinct i.id, i.ordem, x.palavra
             from imobdesk.sf_item i
             join imobdesk.sf_anexo a on a.item_id = i.id
             cross join lateral jsonb_array_elements(coalesce(a.ocr_json -> 'itens', '[]')) it
             cross join lateral jsonb_array_elements_text(coalesce(v_par -> 'itens_proibidos', '[]')) x(palavra)
             where i.solicitacao_id = p_id and length(btrim(x.palavra)) >= 3
               and position(lower(btrim(x.palavra)) in lower(coalesce(it ->> 'descricao', ''))) > 0 loop
      v_res := v_res || jsonb_build_object('codigo', 'R07', 'itemId', r.id, 'resultado', v_sev,
                                           'detalhe', format('Linha %s: item "%s" na lista de proibidos', r.ordem, r.palavra));
    end loop;
  end if;
  -- R08 teto da categoria
  select severidade into v_sev from imobdesk.sf_regra where codigo = 'R08' and ativo;
  if v_sev is not null then
    for r in select i.id, i.ordem, c.nome from imobdesk.sf_item i
             join imobdesk.sf_categoria_motivo c on c.id = i.categoria_id
             where i.solicitacao_id = p_id and c.teto_valor is not null and i.valor > c.teto_valor loop
      v_res := v_res || jsonb_build_object('codigo', 'R08', 'itemId', r.id, 'resultado', v_sev, 'detalhe', format('Linha %s acima do teto de %s', r.ordem, r.nome));
    end loop;
  end if;
  -- R09 prazo de envio
  select severidade, (parametros ->> 'dias')::int into v_sev, v_dias from imobdesk.sf_regra where codigo = 'R09' and ativo;
  if v_sev is not null and v_dias is not null and s.periodo_ate is not null and current_date > s.periodo_ate + v_dias then
    v_res := v_res || jsonb_build_object('codigo', 'R09', 'itemId', null, 'resultado', v_sev, 'detalhe', format('Enviada %s dias após o fim do período', current_date - s.periodo_ate));
  end if;
  -- R10 saldo do fundo fixo
  select severidade into v_sev from imobdesk.sf_regra where codigo = 'R10' and ativo;
  if v_sev is not null and s.tipo = 'fundo_fixo' and s.total_despesas > coalesce(s.saldo_inicial, 0) then
    v_res := v_res || jsonb_build_object('codigo', 'R10', 'itemId', null, 'resultado', v_sev, 'detalhe', 'Despesas acima do saldo inicial do fundo fixo');
  end if;
  return v_res;
end;
$$;

-- ---------- Envio (redefinida: completude do adiantamento; adiantamento sem período e sempre sequencial) ----------
create or replace function imobdesk.sf_enviar(p_id bigint, p_aceite boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s imobdesk.sf_solicitacao := imobdesk.sf_exigir_editavel(p_id);
  v_uid uuid := (select auth.uid());
  v_checks jsonb;
  v_bloq jsonb;
  v_ciclo int;
  v_modo text;
  v_prazo int;
  v_falta int;
  v_exigidos int;
  v_primeiro int;
  c record;
  v_headers json := nullif(current_setting('request.headers', true), '')::json;
begin
  if not coalesce(p_aceite, false) then
    perform imobdesk.erro('INVALID_INPUT', 'Marque o aceite eletrônico para enviar.', 'aceite');
  end if;
  if s.setor_id is null then
    perform imobdesk.erro('INVALID_INPUT', 'Seu cadastro de Pessoas está sem setor. Peça ao administrador para definir o seu setor.');
  end if;
  if s.tipo = 'adiantamento' then
    perform imobdesk.sf_adiantamento_validar(p_id);
  end if;
  if not exists (select 1 from imobdesk.sf_item i where i.solicitacao_id = p_id) then
    perform imobdesk.erro('INVALID_INPUT', 'Inclua ao menos uma despesa.', 'itens');
  end if;
  select count(*) into v_falta from imobdesk.sf_item i
  where i.solicitacao_id = p_id and (i.data is null or i.valor is null or i.valor <= 0 or i.descricao_favorecido is null or i.motivo is null);
  if v_falta > 0 then
    perform imobdesk.erro('INVALID_INPUT', format('Preencha data, valor, %s e motivo em todas as linhas (%s incompleta%s).',
                                                         case when s.tipo = 'fundo_fixo' then 'favorecido' else 'descrição' end, v_falta,
                                                         case when v_falta > 1 then 's' else '' end), 'itens');
  end if;
  if s.tipo <> 'adiantamento' and (s.periodo_de is null or s.periodo_ate is null) then
    perform imobdesk.erro('INVALID_INPUT', 'Informe o período.', 'periodoDe');
  end if;

  perform imobdesk.sf_recalcular(p_id);
  select * into s from imobdesk.sf_solicitacao where id = p_id;
  v_checks := imobdesk.sf_checagens(p_id);
  select jsonb_agg(x) into v_bloq from jsonb_array_elements(v_checks) x where x ->> 'resultado' = 'bloqueio';
  if v_bloq is not null then
    perform imobdesk.erro('INVALID_INPUT', (v_bloq -> 0 ->> 'codigo') || ': ' || (v_bloq -> 0 ->> 'detalhe')
                                    || case when jsonb_array_length(v_bloq) > 1 then format(' (e mais %s)', jsonb_array_length(v_bloq) - 1) else '' end);
  end if;

  -- Cadeia congelada
  select st.sf_modo_aprovacao, st.sf_prazo_horas into v_modo, v_prazo from imobdesk.at_setores st where st.id = s.setor_id;
  if s.tipo = 'adiantamento' then v_modo := 'sequencial'; end if;
  v_ciclo := case when s.status = 'devolvida' then s.ciclo + 1 else s.ciclo end;
  select count(*) filter (where exigido and not pulado), min(nivel) filter (where exigido and not pulado) into v_exigidos, v_primeiro
  from imobdesk.sf_montar_cadeia(s.setor_id, s.tipo, s.total_despesas, v_uid);
  if coalesce(v_exigidos, 0) = 0 then
    perform imobdesk.erro('INVALID_INPUT', 'O seu setor ainda não tem aprovador para este valor. Avise o administrador (Setores e números › Aprovação financeira).');
  end if;
  delete from imobdesk.sf_aprovacao where solicitacao_id = p_id and ciclo = v_ciclo;  -- reenvio no mesmo ciclo não duplica
  for c in select * from imobdesk.sf_montar_cadeia(s.setor_id, s.tipo, s.total_despesas, v_uid) loop
    insert into imobdesk.sf_aprovacao (solicitacao_id, ciclo, nivel, papel, aprovador_id, substituto_id, status, prazo_em)
    values (p_id, v_ciclo, c.nivel, c.papel, c.aprovador_id, c.substituto_id,
            case when not c.exigido then 'nao_exigido'
                 when c.pulado then 'pulado'
                 when v_modo <> 'sequencial' or c.nivel = v_primeiro then 'aguardando'
                 else 'pendente' end,
            case when c.exigido and not c.pulado and (v_modo <> 'sequencial' or c.nivel = v_primeiro) then now() + make_interval(hours => v_prazo) end);
  end loop;

  delete from imobdesk.sf_regra_resultado where solicitacao_id = p_id;
  insert into imobdesk.sf_regra_resultado (solicitacao_id, item_id, regra_codigo, resultado, detalhe)
  select p_id, nullif(x ->> 'itemId', '')::bigint, x ->> 'codigo', x ->> 'resultado', x ->> 'detalhe' from jsonb_array_elements(v_checks) x;

  update imobdesk.sf_solicitacao
     set status = 'em_aprovacao', ciclo = v_ciclo, etapa_atual = v_primeiro, enviado_em = now(), atualizado_em = now(),
         aceite_em = now(),
         aceite_ip = nullif(btrim(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1)), ''),
         aceite_user_agent = left(v_headers ->> 'user-agent', 400)
   where id = p_id;
  perform imobdesk.sf_registrar_evento(p_id, case when s.status = 'devolvida' then 'reenviada' else 'enviada' end,
                                                 jsonb_build_object('ciclo', v_ciclo, 'total', s.total_despesas, 'aceite', true));
  return jsonb_build_object('status', 'em_aprovacao', 'ciclo', v_ciclo, 'alertas', (select count(*) from jsonb_array_elements(v_checks) x where x ->> 'resultado' = 'alerta'));
end;
$$;

-- ---------- Detalhe (redefinida: acrescenta o bloco do adiantamento) ----------
create or replace function imobdesk.sf_detalhe(p_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s imobdesk.sf_solicitacao;
  v_uid uuid := imobdesk.sf_exigir_login();
  v_doc text;
begin
  select * into s from imobdesk.sf_solicitacao where id = p_id;
  if not found or not imobdesk.sf_pode_ver(p_id) then perform imobdesk.erro('NOT_FOUND', 'Solicitação não encontrada.'); end if;
  select p.documento into v_doc from imobdesk.at_pessoas p where p.id = s.pessoa_id;
  return jsonb_build_object(
    'id', s.id, 'numero', s.numero, 'tipo', s.tipo, 'status', s.status, 'ciclo', s.ciclo,
    'podeEditar', s.solicitante_id = v_uid and s.status in ('rascunho', 'devolvida'),
    'podeCancelar', s.solicitante_id = v_uid and (s.status in ('rascunho', 'devolvida')
                    or (s.status = 'em_aprovacao' and not exists (select 1 from imobdesk.sf_aprovacao a where a.solicitacao_id = s.id and a.ciclo = s.ciclo and a.status = 'aprovado'))),
    'solicitante', jsonb_build_object('id', s.solicitante_id, 'nome', (select u.nome from imobdesk.usuarios u where u.id = s.solicitante_id),
                                      'cpfMascarado', case when v_doc ~ '^\d{11}$' then '***.' || substr(v_doc, 4, 3) || '.' || substr(v_doc, 7, 3) || '-**' end),
    'setor', (select jsonb_build_object('id', st.id, 'nome', st.nome) from imobdesk.at_setores st where st.id = s.setor_id),
    'competencia', s.competencia, 'periodoDe', s.periodo_de, 'periodoAte', s.periodo_ate, 'centroCusto', s.centro_custo,
    'valorFundoFixo', s.valor_fundo_fixo, 'saldoInicial', s.saldo_inicial, 'totalDespesas', s.total_despesas, 'saldoFinal', s.saldo_final,
    'valorGlosado', s.valor_glosado, 'valorAPagar', s.valor_a_pagar, 'pagarAte', s.pagar_ate,
    'enviadoEm', s.enviado_em, 'aceiteEm', s.aceite_em, 'criadoEm', s.criado_em, 'atualizadoEm', s.atualizado_em,
    'itens', coalesce((select jsonb_agg(jsonb_build_object(
                'id', i.id, 'ordem', i.ordem, 'data', i.data, 'valor', i.valor, 'descricao', i.descricao_favorecido, 'motivo', i.motivo,
                'categoriaId', i.categoria_id, 'origem', i.origem, 'statusConferencia', i.status_conferencia,
                'anexos', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'nome', a.nome_arquivo, 'path', a.storage_path, 'mime', a.mime, 'tamanho', a.tamanho)
                                                     order by a.id)
                                    from imobdesk.sf_anexo a where a.item_id = i.id), '[]'))
              order by i.ordem) from imobdesk.sf_item i where i.solicitacao_id = s.id), '[]'),
    'aprovacoes', coalesce((select jsonb_agg(jsonb_build_object(
                'ciclo', a.ciclo, 'nivel', a.nivel, 'papel', a.papel, 'status', a.status, 'comentario', a.comentario,
                'aprovador', (select u.nome from imobdesk.usuarios u where u.id = a.aprovador_id),
                'substituto', (select u.nome from imobdesk.usuarios u where u.id = a.substituto_id),
                'prazoEm', a.prazo_em, 'decididoEm', a.decidido_em)
              order by a.ciclo, a.nivel) from imobdesk.sf_aprovacao a where a.solicitacao_id = s.id), '[]'),
    'eventos', coalesce((select jsonb_agg(jsonb_build_object('tipo', e.tipo, 'em', e.criado_em, 'payload', e.payload,
                                                              'ator', (select u.nome from imobdesk.usuarios u where u.id = e.ator_id))
              order by e.criado_em) from imobdesk.sf_evento e where e.solicitacao_id = s.id), '[]'),
    -- Painel "Quem vai aprovar": a cadeia que o envio aplicaria agora (até enviar).
    'cadeiaPrevista', case when s.status in ('rascunho', 'devolvida') then coalesce((
              select jsonb_agg(jsonb_build_object('nivel', c.nivel, 'papel', c.papel, 'exigido', c.exigido, 'pulado', c.pulado, 'motivo', c.motivo,
                                                  'aprovador', (select u.nome from imobdesk.usuarios u where u.id = c.aprovador_id),
                                                  'substituto', (select u.nome from imobdesk.usuarios u where u.id = c.substituto_id))
                     order by c.nivel)
              from imobdesk.sf_montar_cadeia(s.setor_id, s.tipo, s.total_despesas, s.solicitante_id) c), '[]') end,
    'categorias', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'nome', c.nome) order by c.ordem, c.nome)
                            from imobdesk.sf_categoria_motivo c where c.ativo), '[]')
  ) || case when s.tipo = 'adiantamento' then jsonb_build_object('adiantamento', imobdesk.sf_adiantamento_dados(s.id)) else '{}'::jsonb end;
end;
$$;

-- ---------- Avisos de status (redefinida: comprovação, devolução e encerramento) ----------
create or replace function imobdesk.sf_status_avisar()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rot text := imobdesk.sf_rotulo(new.id);
  v_coment text;
begin
  if new.status is not distinct from old.status then return null; end if;
  select a.comentario into v_coment from imobdesk.sf_aprovacao a
  where a.solicitacao_id = new.id and a.ciclo = new.ciclo and a.status in ('devolvido', 'reprovado') order by a.decidido_em desc nulls last limit 1;
  case new.status
    when 'em_aprovacao' then
      perform imobdesk.sf_notificar(new.solicitante_id, new.id, 'Enviada para aprovação: ' || v_rot, 'Você será avisado a cada etapa.');
    when 'devolvida' then
      perform imobdesk.sf_notificar(new.solicitante_id, new.id, 'Devolvida para ajuste: ' || v_rot,
        'Comentário: ' || coalesce(v_coment, '—') || E'\nCorrija e envie de novo: a aprovação recomeça do nível 1.');
    when 'reprovada' then
      perform imobdesk.sf_notificar(new.solicitante_id, new.id, 'Reprovada: ' || v_rot, 'Comentário: ' || coalesce(v_coment, '—'));
    when 'em_conferencia' then
      perform imobdesk.sf_notificar(new.solicitante_id, new.id, 'Aprovada, foi para o Financeiro: ' || v_rot,
        case when new.pagar_ate is not null then 'Pagamento até ' || to_char(new.pagar_ate, 'DD/MM/YYYY') || '.' else 'Conferência financeira.' end);
      perform imobdesk.sf_notificar_financeiro(new.id, 'Chegou na conferência: ' || v_rot,
        case when new.pagar_ate is not null then 'Pagar até ' || to_char(new.pagar_ate, 'DD/MM/YYYY') || '.' else '' end);
    when 'pendencia_solicitante' then
      perform imobdesk.sf_notificar(new.solicitante_id, new.id, 'Pendência na conferência: ' || v_rot, 'O Financeiro pediu um ajuste.');
    when 'lancamento_gerado' then
      perform imobdesk.sf_notificar(new.solicitante_id, new.id, 'Lançamento gerado no SIENGE: ' || v_rot, '');
    when 'pagamento_programado' then
      perform imobdesk.sf_notificar(new.solicitante_id, new.id, 'Pagamento programado: ' || v_rot,
        case when new.pagar_ate is not null then 'Até ' || to_char(new.pagar_ate, 'DD/MM/YYYY') || '.' else '' end);
    when 'paga' then
      perform imobdesk.sf_notificar(new.solicitante_id, new.id, 'Paga: ' || v_rot, '');
    when 'comprovacao_pendente' then
      perform imobdesk.sf_notificar(new.solicitante_id, new.id, 'Envie a comprovação: ' || v_rot,
        'Anexe a nota fiscal ou o recibo até ' || coalesce(to_char(new.prazo_comprovacao, 'DD/MM/YYYY'), '—') || '.', '/financeiro/solicitacoes/' || new.id || '/comprovacao');
    when 'comprovacao_em_conferencia' then
      perform imobdesk.sf_notificar_financeiro(new.id, 'Comprovação para conferir: ' || v_rot, '');
    when 'devolucao_pendente' then
      perform imobdesk.sf_notificar(new.solicitante_id, new.id, 'Devolução pendente: ' || v_rot,
        'A comprovação ficou abaixo do adiantado. Devolva a diferença de R$ '
        || imobdesk.sf_br((select c.saldo_devolver from imobdesk.sf_comprovacao c where c.solicitacao_id = new.id order by c.id desc limit 1))
        || ' ao Financeiro.');
    when 'encerrada' then
      perform imobdesk.sf_notificar(new.solicitante_id, new.id, 'Adiantamento encerrado: ' || v_rot, '');
    else
      null;
  end case;
  return null;
end;
$$;

-- ---------- Leitura (redefinida: lê também a NF da comprovação) ----------
create or replace function imobdesk.sf_ocr_pedido(p_anexo bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a imobdesk.sf_anexo;
  s imobdesk.sf_solicitacao;
begin
  select * into a from imobdesk.sf_anexo where id = p_anexo;
  if not found then perform imobdesk.erro('NOT_FOUND', 'Anexo não encontrado.'); end if;
  if a.finalidade = 'comprovacao' then
    select * into s from imobdesk.sf_solicitacao x where x.id = a.solicitacao_id;
    if s.solicitante_id is distinct from (select auth.uid()) or s.status <> 'comprovacao_pendente' then
      perform imobdesk.erro('NOT_FOUND', 'Anexo não encontrado.');
    end if;
  else
    s := imobdesk.sf_exigir_editavel(a.solicitacao_id);
  end if;
  update imobdesk.sf_anexo set ocr_status = 'lendo' where id = p_anexo;
  return jsonb_build_object(
    'anexoId', a.id, 'path', a.storage_path, 'mime', a.mime, 'tamanho', a.tamanho,
    'modo', case a.finalidade when 'documento_origem' then 'pedido_compra' when 'comprovacao' then 'comprovacao' else 'comprovante' end,
    'periodoDe', s.periodo_de, 'periodoAte', s.periodo_ate,
    'limiar', coalesce((select (r.parametros ->> 'limiar')::numeric from imobdesk.sf_regra r where r.codigo = 'R02'), 0.80),
    'categorias', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'nome', c.nome, 'descricao', c.descricao, 'palavrasChave', c.palavras_chave)
                                             order by c.ordem, c.nome)
                            from imobdesk.sf_categoria_motivo c where c.ativo), '[]')
  );
end;
$$;

-- ---------- Permissões ----------
do $$
declare
  f text;
begin
  foreach f in array array['sf_rascunho_criar(text)', 'sf_adiantamento_salvar(jsonb)', 'sf_comprovacao_anexar(jsonb)', 'sf_comprovacao_anexo_remover(bigint)',
                           'sf_comprovacao_checar(bigint, jsonb)', 'sf_enviar_comprovacao(jsonb)', 'sf_decidir_comprovacao(bigint, text, text)',
                           'sf_confirmar_devolucao(bigint, text)', 'sf_marcar_paga(bigint)', 'sf_lancamento_pedido(bigint)', 'sf_lancamento_saldo_pedido(bigint)',
                           'sf_checagens(bigint)', 'sf_enviar(bigint, boolean)', 'sf_detalhe(bigint)', 'sf_ocr_pedido(bigint)'] loop
    execute format('revoke execute on function imobdesk.%s from public, anon', f);
    execute format('grant execute on function imobdesk.%s to authenticated, service_role', f);
  end loop;
  foreach f in array array['sf_br(numeric)', 'sf_solicitacao_modo()', 'sf_adiantamento_validar(bigint)', 'sf_checagens_adiantamento(bigint)',
                           'sf_adiantamento_dados(bigint)', 'sf_lancamento_saldo_registrar(bigint, boolean, text, text, jsonb)', 'sf_comprovacao_job()',
                           'sf_status_avisar()'] loop
    execute format('revoke execute on function imobdesk.%s from public, anon, authenticated', f);
    execute format('grant execute on function imobdesk.%s to service_role', f);
  end loop;
end;
$$;

-- ---------- Agendamento ----------
do $$
begin
  if exists (select 1 from cron.job where jobname = 'imobdesk-sf-comprovacao') then
    perform cron.unschedule('imobdesk-sf-comprovacao');
  end if;
  perform cron.schedule('imobdesk-sf-comprovacao', '0 11 * * *', 'select imobdesk.sf_comprovacao_job()');
end;
$$;

notify pgrst, 'reload schema';

-- ======================================== 20261017170000_imobdesk_sf_perfil_financeiro.sql
-- Solicitações Financeiras: o perfil "Financeiro" abre a tela Conferência financeira (pedido do Wagner, 17/10/2026,
-- junto com o resumo financeiro da Página Inicial). Só a permissão de tela: a regra de dados continua igual
-- (sf_exigir_financeiro: só quem é do setor marcado como financeiro, ou admin, confere). Aditiva.
insert into imobdesk.profile_permissions (role, permission_id, enabled)
select 'financeiro', 'sf_conferencia', true
where exists (select 1 from imobdesk.perfis p where p.key = 'financeiro')
on conflict (role, permission_id) do nothing;

-- ======================================== 20261023100000_imobdesk_treinamento.sql
-- Centro de Treinamento: tour por balões sobre as telas do sistema (docs/PLANO-centro-treinamento.md, Fase 1;
-- mockup aprovado em 20/10/2026). Trilhas por setor, módulos com balões e pergunta final, progresso por pessoa.
-- Regras: cada pessoa vê a trilha do próprio setor (sf_setor_do_usuario); setor sem trilha ou sem cadastro → trilha
-- padrão "Colaborador"; módulos de gestor só para gestor do setor ou aprovador; o gabarito nunca sai do banco.
-- Só aditiva: tabelas, permissão, funções e carga inicial novas. Nada é apagado nem trocado.

-- ======================================================================= permissão

-- Centro de Treinamento › Gerenciar tutoriais: só Admin (Super admin passa por ch_eh_admin()).
insert into imobdesk.profile_permissions (role, permission_id, enabled)
values ('admin', 'centro_treinamento_gerenciar', true)
on conflict (role, permission_id) do nothing;

-- ======================================================================= estrutura

create table if not exists imobdesk.tr_trilhas (
  id            bigint      generated by default as identity primary key,
  codigo        text        not null unique check (codigo ~ '^[a-z][a-z0-9_]{1,30}$'),
  nome          text        not null check (length(btrim(nome)) between 3 and 60),
  descricao     text        not null default '' check (length(descricao) <= 200),
  padrao        boolean     not null default false,   -- trilha de quem não tem setor ou tem setor sem trilha
  ordem         int         not null default 0,
  atualizado_em timestamptz not null default now()
);
create unique index if not exists tr_trilhas_padrao_uidx on imobdesk.tr_trilhas (padrao) where padrao;

create table if not exists imobdesk.tr_trilha_setores (
  trilha_id bigint not null references imobdesk.tr_trilhas (id) on delete cascade,
  setor_id  bigint not null references imobdesk.at_setores (id) on delete cascade,
  primary key (setor_id)                                 -- um setor segue uma trilha só
);
create index if not exists tr_trilha_setores_trilha_idx on imobdesk.tr_trilha_setores (trilha_id);

create table if not exists imobdesk.tr_modulos (
  id            bigint      generated by default as identity primary key,
  codigo        text        not null unique check (codigo ~ '^[a-z0-9_]{1,30}$'),
  titulo        text        not null check (length(btrim(titulo)) between 3 and 90),
  descricao     text        not null default '' check (length(descricao) <= 240),
  papel         text        not null check (papel in ('atendente', 'solicitante', 'gestor', 'financeiro')),
  restricao     text        check (restricao in ('gestor_setor', 'aprovador')),   -- P2: só quem tem esse papel vê
  minutos       int         not null default 3 check (minutos between 1 and 60),
  rota_demo     text        not null default '/' check (rota_demo ~ '^/'),
  celular       boolean     not null default false,
  pergunta      text        not null check (length(btrim(pergunta)) between 5 and 200),
  opcoes        jsonb       not null check (jsonb_typeof(opcoes) = 'array' and jsonb_array_length(opcoes) between 2 and 5),
  resposta      int         not null check (resposta >= 0),
  status        text        not null default 'rascunho' check (status in ('rascunho', 'publicado')),
  ordem         int         not null default 0,
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  atualizado_por uuid,
  check (resposta < jsonb_array_length(opcoes))
);

create table if not exists imobdesk.tr_trilha_modulos (
  trilha_id bigint not null references imobdesk.tr_trilhas (id) on delete cascade,
  modulo_id bigint not null references imobdesk.tr_modulos (id) on delete cascade,
  ordem     int    not null default 0,
  primary key (trilha_id, modulo_id)
);
create index if not exists tr_trilha_modulos_modulo_idx on imobdesk.tr_trilha_modulos (modulo_id);

create table if not exists imobdesk.tr_passos (
  id            bigint      generated by default as identity primary key,
  modulo_id     bigint      not null references imobdesk.tr_modulos (id) on delete cascade,
  ordem         int         not null,
  tela          text        not null check (tela ~ '^[a-z0-9-]{1,40}$'),   -- public/treinamento/<tela>.webp
  titulo        text        not null check (length(btrim(titulo)) between 2 and 60),
  texto         text        not null check (length(btrim(texto)) between 2 and 400),
  -- Contorno do botão explicado: [x, y, largura, altura] em % da tela capturada.
  alvo          numeric[]   not null check (array_length(alvo, 1) = 4 and 0 <= all (alvo) and 100 >= all (alvo)),
  posicao       text        not null default 'auto' check (posicao in ('auto', 'direita', 'esquerda', 'abaixo', 'acima')),
  atualizado_em timestamptz not null default now(),
  unique (modulo_id, ordem) deferrable initially deferred
);

create table if not exists imobdesk.tr_progresso (
  usuario_id    uuid        not null references imobdesk.usuarios (id) on delete cascade,
  modulo_id     bigint      not null references imobdesk.tr_modulos (id) on delete cascade,
  passo_atual   int         not null default 0 check (passo_atual >= 0),
  iniciado_em   timestamptz not null default now(),
  concluido_em  timestamptz,
  atualizado_em timestamptz not null default now(),
  primary key (usuario_id, modulo_id)
);
create index if not exists tr_progresso_modulo_idx on imobdesk.tr_progresso (modulo_id);

alter table imobdesk.tr_trilhas enable row level security;
alter table imobdesk.tr_trilha_setores enable row level security;
alter table imobdesk.tr_modulos enable row level security;
alter table imobdesk.tr_trilha_modulos enable row level security;
alter table imobdesk.tr_passos enable row level security;
alter table imobdesk.tr_progresso enable row level security;
revoke all on imobdesk.tr_trilhas, imobdesk.tr_trilha_setores, imobdesk.tr_modulos,
              imobdesk.tr_trilha_modulos, imobdesk.tr_passos, imobdesk.tr_progresso
  from anon, authenticated;

-- ======================================================================= helpers

/** Usuário do portal logado e ativo. */
create or replace function imobdesk.tr_exigir_login()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null or imobdesk.perfil_usuario_atual() is null then
    perform imobdesk.erro('FORBIDDEN', 'Entre no portal para ver os treinamentos.');
  end if;
  return (select auth.uid());
end;
$$;

create or replace function imobdesk.tr_eh_gestor()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select imobdesk.ch_eh_admin() or imobdesk.tem_permissao('centro_treinamento_gerenciar');
$$;

create or replace function imobdesk.tr_exigir_gestor()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not imobdesk.tr_eh_gestor() then
    perform imobdesk.erro('FORBIDDEN', 'Só o Admin gerencia os tutoriais.');
  end if;
  return (select auth.uid());
end;
$$;

/** Trilha de um setor: a ligada a ele ou a padrão ("Colaborador"). */
create or replace function imobdesk.tr_trilha_do_setor(p_setor bigint)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select ts.trilha_id from imobdesk.tr_trilha_setores ts where ts.setor_id = p_setor),
                  (select t.id from imobdesk.tr_trilhas t where t.padrao));
$$;

/** P2: módulo com restrição só aparece para quem é gestor de setor (ou supervisão) ou aprovador/substituto cadastrado. */
create or replace function imobdesk.tr_atende_restricao(p_usuario uuid, p_restricao text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case p_restricao
    when 'gestor_setor' then exists (select 1 from imobdesk.at_setor_gestores g where g.usuario_id = p_usuario)
                          or exists (select 1 from imobdesk.usuarios u
                                     join imobdesk.profile_permissions pp on pp.role = u.perfil_key
                                     where u.id = p_usuario and pp.permission_id = 'gestao_atendimento_supervisao' and pp.enabled)
    when 'aprovador' then exists (select 1 from imobdesk.sf_setor_aprovador a
                                  where a.ativo and (a.aprovador_id = p_usuario or a.substituto_id = p_usuario))
    else true
  end;
$$;

/** Módulos que a pessoa vê numa trilha: publicados e dentro da restrição. Admin vendo como setor enxerga todos. */
create or replace function imobdesk.tr_modulos_visiveis(p_usuario uuid, p_trilha bigint, p_todos boolean default false)
returns setof bigint
language sql
stable
security definer
set search_path = ''
as $$
  select m.id
  from imobdesk.tr_trilha_modulos tm
  join imobdesk.tr_modulos m on m.id = tm.modulo_id
  where tm.trilha_id = p_trilha and m.status = 'publicado'
    and (p_todos or m.restricao is null or imobdesk.tr_atende_restricao(p_usuario, m.restricao))
  order by tm.ordem, m.ordem, m.id;
$$;

create or replace function imobdesk.tr_pode_ver_modulo(p_usuario uuid, p_modulo bigint)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select imobdesk.tr_eh_gestor()
      or p_modulo in (select imobdesk.tr_modulos_visiveis(p_usuario,
                        imobdesk.tr_trilha_do_setor(imobdesk.sf_setor_do_usuario(p_usuario))));
$$;

create or replace function imobdesk.tr_modulo_resumo(p_modulo bigint, p_usuario uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', m.id, 'codigo', m.codigo, 'titulo', m.titulo, 'descricao', m.descricao, 'papel', m.papel, 'restricao', m.restricao,
    'minutos', m.minutos, 'rotaDemo', m.rota_demo, 'celular', m.celular, 'status', m.status,
    'passos', (select count(*) from imobdesk.tr_passos p where p.modulo_id = m.id),
    'capa', (select p.tela from imobdesk.tr_passos p where p.modulo_id = m.id order by p.ordem limit 1),
    'passoAtual', coalesce(pr.passo_atual, 0), 'concluidoEm', pr.concluido_em, 'iniciado', pr.usuario_id is not null)
  from imobdesk.tr_modulos m
  left join imobdesk.tr_progresso pr on pr.modulo_id = m.id and pr.usuario_id = p_usuario
  where m.id = p_modulo;
$$;

-- ======================================================================= quem faz o treinamento

/**
 * Meus treinamentos: a trilha do setor da pessoa e os módulos dela, com o progresso.
 * p_setor (só Admin): ver como as pessoas de um setor veem, com todos os módulos da trilha.
 */
create or replace function imobdesk.tr_meus_treinamentos(p_setor bigint default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.tr_exigir_login();
  v_simula boolean := p_setor is not null;
  v_setor bigint;
  v_trilha bigint;
begin
  if v_simula then
    perform imobdesk.tr_exigir_gestor();
    v_setor := p_setor;
  else
    v_setor := imobdesk.sf_setor_do_usuario(v_uid);
  end if;
  v_trilha := imobdesk.tr_trilha_do_setor(v_setor);
  return jsonb_build_object(
    'setor', (select jsonb_build_object('id', s.id, 'nome', s.nome) from imobdesk.at_setores s where s.id = v_setor),
    'semCadastro', not v_simula and imobdesk.sf_pessoa_do_usuario(v_uid) is null,
    'trilha', (select jsonb_build_object('id', t.id, 'codigo', t.codigo, 'nome', t.nome, 'descricao', t.descricao, 'padrao', t.padrao)
               from imobdesk.tr_trilhas t where t.id = v_trilha),
    'modulos', coalesce((select jsonb_agg(imobdesk.tr_modulo_resumo(x.id, v_uid))
                         from imobdesk.tr_modulos_visiveis(v_uid, v_trilha, v_simula) as x (id)), '[]'));
end;
$$;

/** O módulo para o tour: passos e opções da pergunta, sem o gabarito. */
create or replace function imobdesk.tr_modulo(p_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.tr_exigir_login();
begin
  if not exists (select 1 from imobdesk.tr_modulos m where m.id = p_id) then
    perform imobdesk.erro('NOT_FOUND', 'Treinamento não encontrado.');
  end if;
  if not imobdesk.tr_pode_ver_modulo(v_uid, p_id) then
    perform imobdesk.erro('FORBIDDEN', 'Este treinamento não é da sua trilha.');
  end if;
  return imobdesk.tr_modulo_resumo(p_id, v_uid) || (
    select jsonb_build_object(
      'pergunta', m.pergunta, 'opcoes', m.opcoes,
      'baloes', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'ordem', p.ordem, 'tela', p.tela, 'titulo', p.titulo,
                                                              'texto', p.texto, 'alvo', to_jsonb(p.alvo), 'posicao', p.posicao) order by p.ordem)
                          from imobdesk.tr_passos p where p.modulo_id = m.id), '[]'))
    from imobdesk.tr_modulos m where m.id = p_id);
end;
$$;

/** Guarda em que passo a pessoa parou (retoma em qualquer computador). Não desfaz a conclusão. */
create or replace function imobdesk.tr_progresso_salvar(p_modulo bigint, p_passo int)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.tr_exigir_login();
  v_total int;
begin
  if not imobdesk.tr_pode_ver_modulo(v_uid, p_modulo) then
    perform imobdesk.erro('FORBIDDEN', 'Este treinamento não é da sua trilha.');
  end if;
  select count(*) into v_total from imobdesk.tr_passos p where p.modulo_id = p_modulo;
  insert into imobdesk.tr_progresso (usuario_id, modulo_id, passo_atual)
  values (v_uid, p_modulo, least(greatest(coalesce(p_passo, 0), 0), v_total))
  on conflict (usuario_id, modulo_id) do update set passo_atual = excluded.passo_atual, atualizado_em = now();
end;
$$;

/** Responde a pergunta final. Acertou: o módulo fica concluído. O gabarito é conferido aqui, nunca vai para a tela. */
create or replace function imobdesk.tr_responder(p_modulo bigint, p_opcao int)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.tr_exigir_login();
  v_certo boolean;
  v_total int;
begin
  if not imobdesk.tr_pode_ver_modulo(v_uid, p_modulo) then
    perform imobdesk.erro('FORBIDDEN', 'Este treinamento não é da sua trilha.');
  end if;
  select m.resposta = p_opcao into v_certo from imobdesk.tr_modulos m where m.id = p_modulo;
  v_certo := coalesce(v_certo, false);
  if v_certo then
    select count(*) into v_total from imobdesk.tr_passos p where p.modulo_id = p_modulo;
    insert into imobdesk.tr_progresso (usuario_id, modulo_id, passo_atual, concluido_em)
    values (v_uid, p_modulo, v_total, now())
    on conflict (usuario_id, modulo_id) do update
      set passo_atual = excluded.passo_atual, atualizado_em = now(),
          concluido_em = coalesce(imobdesk.tr_progresso.concluido_em, excluded.concluido_em);
  end if;
  return jsonb_build_object('certo', v_certo,
    'concluidoEm', (select pr.concluido_em from imobdesk.tr_progresso pr where pr.usuario_id = v_uid and pr.modulo_id = p_modulo));
end;
$$;

-- ======================================================================= Gerenciar tutoriais (Admin)

/** Pessoas do portal (ativas, fora do perfil Solicitante) com o setor e a trilha de cada uma. */
create or replace function imobdesk.tr_pessoas_trilha()
returns table (usuario_id uuid, nome text, setor_id bigint, trilha_id bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select u.id, u.nome, x.setor_id, imobdesk.tr_trilha_do_setor(x.setor_id)
  from imobdesk.usuarios u
  cross join lateral (select imobdesk.sf_setor_do_usuario(u.id) as setor_id) x
  where u.status = 'active' and u.perfil_key is distinct from 'solicitante';
$$;

create or replace function imobdesk.tr_admin_painel()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform imobdesk.tr_exigir_gestor();
  return jsonb_build_object(
    'trilhas', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'codigo', t.codigo, 'nome', t.nome, 'descricao', t.descricao, 'padrao', t.padrao,
                                                             'setores', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'nome', s.nome) order by s.nome)
                                                                                  from imobdesk.tr_trilha_setores ts join imobdesk.at_setores s on s.id = ts.setor_id
                                                                                  where ts.trilha_id = t.id), '[]'),
                                                             'modulos', coalesce((select jsonb_agg(tm.modulo_id order by tm.ordem) from imobdesk.tr_trilha_modulos tm where tm.trilha_id = t.id), '[]'))
                                          order by t.ordem, t.id)
                         from imobdesk.tr_trilhas t), '[]'),
    'modulos', coalesce((select jsonb_agg(imobdesk.tr_modulo_resumo(m.id, null)
                                          || jsonb_build_object('concluiram', (select count(*) from imobdesk.tr_progresso pr where pr.modulo_id = m.id and pr.concluido_em is not null),
                                                                'publico', (select count(*) from imobdesk.tr_pessoas_trilha() p
                                                                            join imobdesk.tr_trilha_modulos tm on tm.trilha_id = p.trilha_id and tm.modulo_id = m.id
                                                                            where m.restricao is null or imobdesk.tr_atende_restricao(p.usuario_id, m.restricao)))
                                          order by m.ordem, m.id)
                         from imobdesk.tr_modulos m), '[]'),
    'setores', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'nome', s.nome) order by s.nome)
                         from imobdesk.at_setores s where s.ativo), '[]'));
end;
$$;

/** Módulo completo para o editor, com o gabarito. */
create or replace function imobdesk.tr_admin_modulo(p_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform imobdesk.tr_exigir_gestor();
  if not exists (select 1 from imobdesk.tr_modulos m where m.id = p_id) then
    perform imobdesk.erro('NOT_FOUND', 'Módulo não encontrado.');
  end if;
  return imobdesk.tr_modulo(p_id)
      || (select jsonb_build_object('resposta', m.resposta,
                                    'trilhas', coalesce((select jsonb_agg(tm.trilha_id) from imobdesk.tr_trilha_modulos tm where tm.modulo_id = m.id), '[]'))
          from imobdesk.tr_modulos m where m.id = p_id);
end;
$$;

/** Cria ou altera um módulo e as trilhas em que ele aparece. */
create or replace function imobdesk.tr_modulo_salvar(p jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.tr_exigir_gestor();
  v_id bigint := nullif(p ->> 'id', '')::bigint;
  v_codigo text;
begin
  if v_id is null then
    v_codigo := coalesce(nullif(btrim(p ->> 'codigo'), ''), 'novo_' || substr(md5(random()::text), 1, 12));
    insert into imobdesk.tr_modulos (codigo, titulo, descricao, papel, restricao, minutos, rota_demo, celular, pergunta, opcoes, resposta, status, ordem, atualizado_por)
    values (v_codigo, btrim(p ->> 'titulo'), coalesce(p ->> 'descricao', ''), p ->> 'papel', nullif(p ->> 'restricao', ''),
            coalesce((p ->> 'minutos')::int, 3), coalesce(nullif(p ->> 'rotaDemo', ''), '/'), coalesce((p ->> 'celular')::boolean, false),
            btrim(p ->> 'pergunta'), p -> 'opcoes', (p ->> 'resposta')::int, coalesce(p ->> 'status', 'rascunho'),
            coalesce((select max(ordem) from imobdesk.tr_modulos), 0) + 1, v_uid)
    returning id into v_id;
    if nullif(btrim(p ->> 'codigo'), '') is null then
      update imobdesk.tr_modulos set codigo = 'm' || v_id where id = v_id;   -- código estável a partir do id
    end if;
  else
    update imobdesk.tr_modulos set
      titulo = btrim(p ->> 'titulo'), descricao = coalesce(p ->> 'descricao', ''), papel = p ->> 'papel', restricao = nullif(p ->> 'restricao', ''),
      minutos = coalesce((p ->> 'minutos')::int, minutos), rota_demo = coalesce(nullif(p ->> 'rotaDemo', ''), rota_demo),
      celular = coalesce((p ->> 'celular')::boolean, celular), pergunta = btrim(p ->> 'pergunta'), opcoes = p -> 'opcoes',
      resposta = (p ->> 'resposta')::int, status = coalesce(p ->> 'status', status), atualizado_em = now(), atualizado_por = v_uid
    where id = v_id;
    if not found then
      perform imobdesk.erro('NOT_FOUND', 'Módulo não encontrado.');
    end if;
  end if;
  if p ? 'trilhas' then
    delete from imobdesk.tr_trilha_modulos tm
    where tm.modulo_id = v_id and tm.trilha_id not in (select (jsonb_array_elements_text(p -> 'trilhas'))::bigint);
    insert into imobdesk.tr_trilha_modulos (trilha_id, modulo_id, ordem)
    select t::bigint, v_id, (select coalesce(max(x.ordem), 0) + 1 from imobdesk.tr_trilha_modulos x where x.trilha_id = t::bigint)
    from jsonb_array_elements_text(p -> 'trilhas') t
    on conflict (trilha_id, modulo_id) do nothing;
  end if;
  return v_id;
end;
$$;

/** Cria ou altera um balão. Sem ordem: entra no fim do módulo. */
create or replace function imobdesk.tr_passo_salvar(p jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint := nullif(p ->> 'id', '')::bigint;
  v_modulo bigint := nullif(p ->> 'moduloId', '')::bigint;
  v_alvo numeric[] := array(select jsonb_array_elements_text(p -> 'alvo')::numeric);
begin
  perform imobdesk.tr_exigir_gestor();
  if v_id is null then
    if not exists (select 1 from imobdesk.tr_modulos m where m.id = v_modulo) then
      perform imobdesk.erro('NOT_FOUND', 'Módulo não encontrado.');
    end if;
    insert into imobdesk.tr_passos (modulo_id, ordem, tela, titulo, texto, alvo, posicao)
    values (v_modulo, (select coalesce(max(x.ordem), 0) + 1 from imobdesk.tr_passos x where x.modulo_id = v_modulo),
            p ->> 'tela', btrim(p ->> 'titulo'), btrim(p ->> 'texto'), v_alvo, coalesce(nullif(p ->> 'posicao', ''), 'auto'))
    returning id into v_id;
  else
    update imobdesk.tr_passos set
      tela = p ->> 'tela', titulo = btrim(p ->> 'titulo'), texto = btrim(p ->> 'texto'), alvo = v_alvo,
      posicao = coalesce(nullif(p ->> 'posicao', ''), 'auto'), atualizado_em = now()
    where id = v_id
    returning modulo_id into v_modulo;
    if v_modulo is null then
      perform imobdesk.erro('NOT_FOUND', 'Balão não encontrado.');
    end if;
  end if;
  update imobdesk.tr_modulos set atualizado_em = now() where id = v_modulo;
  return v_id;
end;
$$;

create or replace function imobdesk.tr_passo_excluir(p_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_modulo bigint;
begin
  perform imobdesk.tr_exigir_gestor();
  delete from imobdesk.tr_passos where id = p_id returning modulo_id into v_modulo;
  if v_modulo is null then
    perform imobdesk.erro('NOT_FOUND', 'Balão não encontrado.');
  end if;
  -- Fecha o buraco na numeração.
  update imobdesk.tr_passos p set ordem = x.n
  from (select id, row_number() over (order by ordem) as n from imobdesk.tr_passos where modulo_id = v_modulo) x
  where p.id = x.id and p.ordem <> x.n;
end;
$$;

/** Nova ordem dos balões: a lista completa dos ids do módulo. */
create or replace function imobdesk.tr_passos_reordenar(p_modulo bigint, p_ids bigint[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform imobdesk.tr_exigir_gestor();
  if (select array_agg(id order by id) from imobdesk.tr_passos where modulo_id = p_modulo)
     is distinct from (select array_agg(i order by i) from unnest(p_ids) i) then
    perform imobdesk.erro('VALIDATION', 'A lista precisa ter todos os balões do módulo, uma vez cada.');
  end if;
  update imobdesk.tr_passos p set ordem = x.n
  from unnest(p_ids) with ordinality as x (id, n)
  where p.id = x.id;
end;
$$;

/** Liga setores a uma trilha (cada setor segue uma trilha só; os que saem voltam para a padrão). */
create or replace function imobdesk.tr_trilha_setores_salvar(p_trilha bigint, p_setores bigint[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform imobdesk.tr_exigir_gestor();
  if not exists (select 1 from imobdesk.tr_trilhas t where t.id = p_trilha) then
    perform imobdesk.erro('NOT_FOUND', 'Trilha não encontrada.');
  end if;
  delete from imobdesk.tr_trilha_setores where trilha_id = p_trilha and setor_id <> all (coalesce(p_setores, '{}'));
  insert into imobdesk.tr_trilha_setores (trilha_id, setor_id)
  select p_trilha, s from unnest(coalesce(p_setores, '{}')) s
  on conflict (setor_id) do update set trilha_id = excluded.trilha_id;
end;
$$;

/** Progresso por setor: pessoas, quem concluiu tudo, quem está no meio e quem não começou. */
create or replace function imobdesk.tr_progresso_por_setor()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform imobdesk.tr_exigir_gestor();
  return coalesce((
    select jsonb_agg(jsonb_build_object('setorId', g.setor_id, 'setor', coalesce(s.nome, 'Sem setor'), 'trilha', t.nome, 'pessoas', g.pessoas,
                                        'concluiram', g.concluiram, 'andamento', g.andamento, 'naoComecaram', g.pessoas - g.concluiram - g.andamento)
                     order by s.nome nulls last)
    from (
      select p.setor_id, p.trilha_id, count(*) as pessoas,
             count(*) filter (where e.total > 0 and e.feitos = e.total) as concluiram,
             count(*) filter (where e.mexeu and not (e.total > 0 and e.feitos = e.total)) as andamento
      from imobdesk.tr_pessoas_trilha() p
      cross join lateral (
        select count(*) as total,
               count(*) filter (where pr.concluido_em is not null) as feitos,
               bool_or(pr.usuario_id is not null) as mexeu
        from imobdesk.tr_modulos_visiveis(p.usuario_id, p.trilha_id) as v (id)
        left join imobdesk.tr_progresso pr on pr.modulo_id = v.id and pr.usuario_id = p.usuario_id) e
      group by p.setor_id, p.trilha_id) g
    left join imobdesk.at_setores s on s.id = g.setor_id
    join imobdesk.tr_trilhas t on t.id = g.trilha_id), '[]');
end;
$$;

/** "Ver pessoas" de um setor (null = sem setor): cada módulo da trilha com passo atual e conclusão. */
create or replace function imobdesk.tr_progresso_pessoas(p_setor bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform imobdesk.tr_exigir_gestor();
  return coalesce((
    select jsonb_agg(jsonb_build_object('usuarioId', p.usuario_id, 'nome', p.nome,
                     'modulos', coalesce((select jsonb_agg(jsonb_build_object('id', v.id, 'titulo', m.titulo, 'passoAtual', coalesce(pr.passo_atual, 0),
                                                                             'passos', (select count(*) from imobdesk.tr_passos x where x.modulo_id = v.id),
                                                                             'concluidoEm', pr.concluido_em))
                                          from imobdesk.tr_modulos_visiveis(p.usuario_id, p.trilha_id) as v (id)
                                          join imobdesk.tr_modulos m on m.id = v.id
                                          left join imobdesk.tr_progresso pr on pr.modulo_id = v.id and pr.usuario_id = p.usuario_id), '[]'))
                     order by p.nome)
    from imobdesk.tr_pessoas_trilha() p
    where p.setor_id is not distinct from p_setor), '[]');
end;
$$;

-- ======================================================================= carga inicial (conteúdo do mockup aprovado)

insert into imobdesk.tr_trilhas (codigo, nome, descricao, padrao, ordem) values
  ('tickets', 'Gestão de Tickets', 'Atender, acompanhar e gerir os chamados do seu setor.', false, 1),
  ('fin', 'Solicitações Financeiras', 'Quem pede, quem aprova e quem administra: do reembolso ao pagamento.', false, 2),
  ('colaborador', 'Colaborador', 'Abrir um chamado e pedir um reembolso, no computador ou no celular.', true, 3)
on conflict (codigo) do nothing;

-- D3: TI, Administrativo e CFTV → Gestão de Tickets; Financeiro → Solicitações Financeiras. Os demais seguem a padrão.
insert into imobdesk.tr_trilha_setores (trilha_id, setor_id)
select t.id, s.id
from imobdesk.at_setores s
join imobdesk.tr_trilhas t
  on t.codigo = case when s.sf_financeiro or lower(btrim(s.nome)) = 'financeiro' then 'fin'
                     when lower(btrim(s.nome)) ~ '^ti(\s|$|\s*-)' or lower(btrim(s.nome)) in ('cftv', 'administrativo', 'administração', 'administracao') then 'tickets'
                end
on conflict (setor_id) do nothing;

-- 11 módulos e 60 balões: textos, alvos e perguntas copiados de docs/mockups/centro-treinamento.html (MODULOS e QUIZ).
insert into imobdesk.tr_modulos (codigo, titulo, descricao, papel, restricao, minutos, rota_demo, celular, pergunta, opcoes, resposta, status, ordem) values
  ('t1', 'Visão geral: o painel da sua equipe', 'O que olhar primeiro ao começar o dia: prazos vencidos, tickets sem dono e a triagem.', 'atendente', null, 4, '/gestao-chamados/visao-geral', false, 'O cartão vermelho "SLA vencido" mostra…', '["Tickets já fora do prazo","Tickets novos de hoje","Tickets sem categoria"]'::jsonb, 0, 'publicado', 1),
  ('t2', 'A fila de tickets: Kanban e visões', 'Colunas por situação, busca, visões da equipe e como ler o prazo de cada cartão.', 'atendente', null, 5, '/gestao-chamados/tickets', false, 'Para atender um ticket da fila, você…', '["Clica no cartão","Arrasta para Pré-fechamento","Liga para o solicitante"]'::jsonb, 0, 'publicado', 2),
  ('t3', 'Atender um ticket do começo ao fim', 'Serviço, responsável, resposta ao solicitante, solução reaproveitada e status.', 'atendente', null, 7, '/gestao-chamados/tickets/48231', false, 'O que define a equipe e o prazo de SLA do ticket?', '["A urgência","O serviço","As tags"]'::jsonb, 1, 'publicado', 3),
  ('t4', 'Conversas de WhatsApp', 'A fila do setor, assumir uma conversa e acompanhar quem está com quem.', 'atendente', null, 4, '/gestao-chamados/conversas', false, 'Onde ficam as conversas esperando atendimento?', '["No filtro Na fila","Em Encerradas","No Monitor"]'::jsonb, 0, 'publicado', 4),
  ('t5', 'Monitor de atendimento', 'Para gestores: indicadores do mês e a situação de cada atendente em tempo real.', 'gestor', 'gestor_setor', 4, '/gestao-chamados/monitor', false, 'Quem vê o Monitor de atendimento?', '["Todos os atendentes","Gestores do setor e a supervisão geral","Só o solicitante"]'::jsonb, 1, 'publicado', 5),
  ('t6', 'Como o colaborador abre um chamado', 'O App do solicitante no celular ou no computador: setor, chamado e acompanhamento.', 'solicitante', null, 3, '/app', true, 'Antes de abrir um chamado no App do solicitante, o colaborador…', '["Escolhe o setor","Liga para a TI","Manda um e-mail"]'::jsonb, 0, 'publicado', 6),
  ('f1', 'Pedir um reembolso de despesas', 'Do botão Novo reembolso ao envio, com o comprovante lido automaticamente.', 'solicitante', null, 6, '/financeiro/nova', false, 'Seu pedido voltou como Devolvida. O que fazer?', '["Abrir outro pedido","Ler o comentário, corrigir e reenviar","Esperar o Financeiro"]'::jsonb, 1, 'publicado', 7),
  ('f2', 'Pelo celular: comprovante pela câmera', 'Reembolso e fundo fixo no App do solicitante, com a foto do cupom na hora.', 'solicitante', null, 3, '/app/financeiro', true, 'Sem internet no celular, o comprovante…', '["Se perde","Fica no rascunho e sincroniza depois","Vai por e-mail"]'::jsonb, 1, 'publicado', 8),
  ('f3', 'Aprovar, devolver ou reprovar', 'Para aprovadores: a fila, os prazos, o substituto e a decisão.', 'gestor', 'aprovador', 4, '/financeiro/aprovacoes', false, 'Para devolver ou reprovar, é obrigatório…', '["Escrever o motivo no comentário","Anexar um PDF","Avisar o Financeiro"]'::jsonb, 0, 'publicado', 9),
  ('f4', 'Conferência item a item', 'Fila do Financeiro, comprovante ao lado do declarado, aceitar, pedir ajuste ou glosar.', 'financeiro', null, 6, '/financeiro/conferencia', false, 'Valor do comprovante menor que o declarado. No item, você pode…', '["Glosar a diferença","Lançar no SIENGE mesmo assim","Apagar o item"]'::jsonb, 0, 'publicado', 10),
  ('f5', 'Lançamento no SIENGE e pagamento', 'Gerar o título, programar e marcar como paga.', 'financeiro', null, 4, '/financeiro/conferencia', false, 'Depois do Lançamento no SIENGE, o pedido vai para…', '["Rascunho","Pagamento programado","Aprovação do gestor"]'::jsonb, 1, 'publicado', 11)
on conflict (codigo) do nothing;

insert into imobdesk.tr_passos (modulo_id, ordem, tela, titulo, texto, alvo)
select m.id, v.ordem, v.tela, v.titulo, v.texto, v.alvo
from (values
  ('t1', 1, 't-visao', 'Comece pela Visão geral', 'É o painel da sua equipe: tudo o que precisa de atenção hoje, num lugar só.', array[1, 22.8, 18.2, 3.9]::numeric[]),
  ('t1', 2, 't-visao', 'Os números do dia', 'Sem responsável, SLA vencido, vencem hoje, em atendimento. Clique num cartão para ver a lista dele.', array[21.5, 48, 76.5, 14.6]::numeric[]),
  ('t1', 3, 't-visao', 'SLA vencido', 'O cartão vermelho conta os tickets que já passaram do prazo. Eles são a prioridade.', array[34.5, 48.4, 12, 14.2]::numeric[]),
  ('t1', 4, 't-visao', 'Meus, equipe ou todos', 'Troque o recorte do painel. Os filtros de equipe e origem ficam à direita.', array[21.5, 41.6, 17.8, 5]::numeric[]),
  ('t1', 5, 't-visao', 'Novo ticket', 'Abre um ticket na hora, por exemplo para um pedido que chegou por telefone.', array[89.2, 32, 8.7, 4.6]::numeric[]),
  ('t1', 6, 't-visao', 'Precisa de ação agora', 'A lista já vem em ordem: vencidos primeiro, depois o próximo prazo de SLA.', array[21.5, 74.6, 54, 25.4]::numeric[]),
  ('t2', 1, 't-tickets', 'A fila em colunas', 'A fazer, Aguardando, Em atendimento e Pré-fechamento. Cada cartão é um ticket.', array[21.5, 41.2, 77.3, 58.8]::numeric[]),
  ('t2', 2, 't-tickets', 'Escolha a visão', 'A visão filtra a fila da sua equipe, em Kanban ou em lista.', array[21.6, 29.8, 19.8, 4.8]::numeric[]),
  ('t2', 3, 't-tickets', 'Busque', 'Digite o número, parte do assunto ou o nome do solicitante.', array[42, 29.6, 18.2, 4.9]::numeric[]),
  ('t2', 4, 't-tickets', 'Leia o cartão', 'Número, quem pediu, o assunto e o prazo. A etiqueta vermelha avisa que o SLA venceu; as iniciais são do responsável.', array[61.5, 61.9, 17.4, 12]::numeric[]),
  ('t2', 5, 't-tickets', 'Abra o ticket', 'Clique no cartão para atender. No próximo módulo abrimos este, o 48231.', array[61.5, 61.9, 17.4, 12]::numeric[]),
  ('t3', 1, 't-ticket', 'Quem pediu e por onde', 'Número, solicitante e canal (aqui, e-mail). Seguir avisa você de cada novidade do ticket.', array[29, 32, 28.6, 3.3]::numeric[]),
  ('t3', 2, 't-ticket', 'Status do ticket', 'Mostra e muda a situação: Em atendimento, Aguardando, Resolvido…', array[68.5, 31.1, 19.7, 4.8]::numeric[]),
  ('t3', 3, 't-ticket', 'Classifique pelo serviço', 'O serviço define a equipe e o prazo de SLA. Ele é obrigatório para enviar a resposta.', array[23, 64.6, 22.4, 12.6]::numeric[]),
  ('t3', 4, 't-ticket2', 'Assuma o ticket', 'Em Responsável, escolha você mesmo. Acima, a Previsão de solução mostra quanto falta, ou quanto já venceu.', array[23, 57.6, 22.4, 16]::numeric[]),
  ('t3', 5, 't-ticket', 'Já resolveram antes?', 'O portal acha tickets parecidos. Se servir, clique em Usar esta solução na resposta e ajuste o texto.', array[48.3, 80.2, 47.9, 17]::numeric[]),
  ('t3', 6, 't-ticket', 'Responda ou anote', 'Responder ao solicitante vai para ele. Nota interna fica só para a equipe.', array[48.6, 48.6, 19.3, 3.4]::numeric[]),
  ('t3', 7, 't-ticket', 'Escreva a resposta', 'A resposta sai pelo mesmo canal em que o pedido chegou.', array[48.3, 51.6, 47.9, 14.8]::numeric[]),
  ('t3', 8, 't-ticket', 'Escolha o status e envie', 'Marque o Status após enviar, por exemplo Resolvido, e clique em Adicionar ação.', array[48.9, 67.2, 46.6, 10.6]::numeric[]),
  ('t3', 9, 't-ticket2', 'Tudo fica no histórico', 'Cada resposta, nota e mudança de status entra aqui, com data e autor.', array[48.3, 47, 47.9, 22.5]::numeric[]),
  ('t4', 1, 't-conversas', 'WhatsApp ao vivo', 'As conversas do seu setor chegam aqui. À esquerda a lista; à direita, o chat e o ticket da conversa.', array[21.7, 38.5, 76.1, 61.5]::numeric[]),
  ('t4', 2, 't-conversas', 'Quantos esperam', 'Conta as conversas na fila, sem ninguém atendendo.', array[91.6, 32.6, 6.2, 4.3]::numeric[]),
  ('t4', 3, 't-conversas', 'Filtre a lista', 'Na fila: quem espera. Comigo: as suas. Com outro atendente: as dos colegas.', array[22.4, 45, 21.6, 7.4]::numeric[]),
  ('t4', 4, 't-conversas', 'Assuma a conversa', 'Na fila e o número vermelho mostram quem espera e quantas mensagens não lidas há. Clique para assumir.', array[21.7, 60.8, 22.9, 7.6]::numeric[]),
  ('t4', 5, 't-conversas', 'Lista ou Kanban', 'Veja as conversas em lista ou num quadro por situação.', array[21.7, 32.6, 20.8, 4.2]::numeric[]),
  ('t5', 1, 't-monitor', 'Escolha o setor', 'Você vê os setores em que é gestor; a supervisão geral vê todos.', array[21.7, 32, 16.7, 4.9]::numeric[]),
  ('t5', 2, 't-monitor', 'Os indicadores', 'Atendidas, resolvidas no 1º atendimento, tempo médio de espera e de atendimento, com a variação do período.', array[21.7, 38.2, 37.5, 50.8]::numeric[]),
  ('t5', 3, 't-monitor', 'Período', 'Troque entre hoje, semana e mês.', array[46, 39.6, 9.1, 4.6]::numeric[]),
  ('t5', 4, 't-monitor', 'A equipe agora', 'Cada atendente: online, disponível, em atendimento e quantas conversas tem. Laranja é pausa; vermelho, ausente.', array[60.3, 38.2, 37.6, 61]::numeric[]),
  ('t6', 1, 'app-home', 'O App do solicitante', 'É o app em que qualquer colaborador abre chamados, com o e-mail corporativo.', array[4, 6, 92, 34]::numeric[]),
  ('t6', 2, 'app-home', '1. Escolha o setor', 'Toque em Setor e escolha quem vai atender: TI, Administrativo ou CFTV.', array[4.8, 44.5, 28.5, 13.2]::numeric[]),
  ('t6', 3, 'app-home', '2. Abra o chamado', 'Descreva o problema e, se ajudar, anexe uma foto.', array[35.9, 44.5, 28.6, 13.2]::numeric[]),
  ('t6', 4, 'app-home', '3. Acompanhe', 'Em Meus chamados você vê as respostas da equipe.', array[66.8, 44.5, 28.6, 13.2]::numeric[]),
  ('f1', 1, 'f-minhas', 'Minhas solicitações', 'Seus pedidos e a etapa de cada um.', array[21.6, 21.2, 13.2, 3.9]::numeric[]),
  ('f1', 2, 'f-minhas', 'Contadores por situação', 'Rascunhos, em aprovação, devolvidas, no Financeiro, a comprovar e pagas no mês.', array[21.6, 60.2, 76.3, 13.6]::numeric[]),
  ('f1', 3, 'f-nova', 'Novo reembolso', 'Gastou do seu bolso a serviço da empresa? Comece aqui. Paga em até 15 dias após a última aprovação.', array[23.1, 48.5, 11.8, 5]::numeric[]),
  ('f1', 4, 'f-reembolso', 'Seus dados já vêm', 'Nome, CPF e setor vêm do cadastro e não se editam aqui.', array[21.7, 48, 51, 15.9]::numeric[]),
  ('f1', 5, 'f-reembolso', 'Quem vai aprovar', 'A cadeia de aprovação do seu setor, na ordem.', array[74.2, 48, 23.6, 30.2]::numeric[]),
  ('f1', 6, 'f-reembolso', 'Rascunho automático', 'Tudo é salvo sozinho. Pode sair e voltar depois.', array[21.5, 40.4, 14.5, 2.6]::numeric[]),
  ('f1', 7, 'f-reembolso', 'Antes de enviar', 'Confira as checagens e marque a declaração de aceite. O aceite substitui a assinatura.', array[74.2, 80, 23.6, 18]::numeric[]),
  ('f1', 8, 'f-detalhe', 'Acompanhe', 'A linha do tempo mostra cada etapa: gestor, conferência, SIENGE e pagamento.', array[74.2, 41.8, 23.6, 35]::numeric[]),
  ('f2', 1, 'app-home', 'Toque em Financeiro', 'No App do solicitante do celular, o Financeiro fica na tela inicial.', array[4.8, 58.8, 28.5, 13.2]::numeric[]),
  ('f2', 2, 'app-fin', 'Reembolso ou fundo fixo', 'Escolha e fotografe o cupom na hora. Sem internet, o rascunho sincroniza quando a rede voltar.', array[4.8, 9.6, 90.4, 13.6]::numeric[]),
  ('f2', 3, 'app-fin', 'Devolvida para ajuste', 'Abra, leia o comentário do aprovador, corrija e reenvie.', array[4.8, 60.4, 90.4, 10.8]::numeric[]),
  ('f3', 1, 'f-aprov', 'Aguardando mim', 'O que espera pela sua decisão, com o prazo de cada etapa.', array[21.6, 39.5, 13.4, 5.3]::numeric[]),
  ('f3', 2, 'f-aprov', 'Prazo vencido', 'Faltando 25% do prazo você recebe um lembrete; vencido, a etapa vai para o substituto.', array[70.3, 66.8, 10.2, 3.8]::numeric[]),
  ('f3', 3, 'f-aprov', 'Definir substituto', 'Vai sair de férias? Indique quem aprova no seu lugar.', array[85.6, 31, 12.2, 4.4]::numeric[]),
  ('f3', 4, 'f-aprov', 'Abrir', 'Abre o pedido com as despesas e as checagens automáticas.', array[92.5, 53.3, 4.8, 4.5]::numeric[]),
  ('f3', 5, 'f-aprov-det', 'Comentário', 'Obrigatório para devolver ou reprovar: explique o que precisa mudar.', array[22.8, 81.4, 48.9, 5]::numeric[]),
  ('f3', 6, 'f-aprov-det', 'Decida', 'Reprovar encerra. Devolver para ajuste volta ao solicitante. Aprovar segue para a próxima etapa.', array[39.8, 87.6, 31.9, 5.6]::numeric[]),
  ('f4', 1, 'f-conf', 'A fila do Financeiro', 'Os contadores de cada etapa. Comece por A conferir.', array[21.6, 39.6, 76.3, 13.4]::numeric[]),
  ('f4', 2, 'f-conf', 'Pagar até', 'O limite de pagamento de cada pedido. Ordem: aprovação mais antiga primeiro.', array[63.8, 71.4, 11, 21]::numeric[]),
  ('f4', 3, 'f-conf-det', 'Os itens', 'Cada despesa é um item. O alerta laranja indica uma regra a conferir.', array[21.7, 41.8, 17.3, 42.4]::numeric[]),
  ('f4', 4, 'f-conf-det', 'O comprovante', 'Abre aqui dentro, com zoom, girar e tela cheia.', array[40.1, 41.8, 30.2, 42.3]::numeric[]),
  ('f4', 5, 'f-conf-det', 'Declarado × comprovante', 'O que o solicitante informou ao lado do que está no comprovante.', array[71.5, 41.8, 26.5, 30.2]::numeric[]),
  ('f4', 6, 'f-conf-det', 'Decida o item', 'Aceitar, Pedir ajuste ao solicitante ou Glosar o valor.', array[72.6, 92.8, 20.6, 5.6]::numeric[]),
  ('f5', 1, 'f-conf-det', 'Totais', 'Total, glosas e valor a pagar, já com os descontos.', array[22.6, 85.2, 34, 4.4]::numeric[]),
  ('f5', 2, 'f-conf-det', 'Devolver ao solicitante', 'Se faltar algo que só ele resolve, devolva com o motivo.', array[66.2, 88.4, 13, 4.4]::numeric[]),
  ('f5', 3, 'f-conf-det', 'Lançamento no SIENGE', 'Libera quando todos os itens estão resolvidos. Cria o título a pagar com os padrões configurados.', array[80.9, 87.6, 15.8, 5.6]::numeric[]),
  ('f5', 4, 'f-conf', 'Pagamento programado', 'Depois do lançamento, o pedido vem para cá. Quando pagar, marque como paga e o solicitante é avisado.', array[60.2, 39.6, 12.1, 13.4]::numeric[])
) v (codigo, ordem, tela, titulo, texto, alvo)
join imobdesk.tr_modulos m on m.codigo = v.codigo
where not exists (select 1 from imobdesk.tr_passos x where x.modulo_id = m.id);

insert into imobdesk.tr_trilha_modulos (trilha_id, modulo_id, ordem)
select t.id, m.id, v.ordem
from (values ('tickets', 't1', 1), ('tickets', 't2', 2), ('tickets', 't3', 3), ('tickets', 't4', 4), ('tickets', 't5', 5), ('tickets', 't6', 6),
             ('fin', 'f1', 1), ('fin', 'f2', 2), ('fin', 'f3', 3), ('fin', 'f4', 4), ('fin', 'f5', 5),
             ('colaborador', 't6', 1), ('colaborador', 'f1', 2), ('colaborador', 'f2', 3)) v (trilha, modulo, ordem)
join imobdesk.tr_trilhas t on t.codigo = v.trilha
join imobdesk.tr_modulos m on m.codigo = v.modulo
on conflict (trilha_id, modulo_id) do nothing;

-- ======================================================================= permissões das funções

do $$
declare
  f text;
begin
  foreach f in array array['tr_meus_treinamentos(bigint)', 'tr_modulo(bigint)', 'tr_progresso_salvar(bigint, int)', 'tr_responder(bigint, int)',
                           'tr_admin_painel()', 'tr_admin_modulo(bigint)', 'tr_modulo_salvar(jsonb)', 'tr_passo_salvar(jsonb)', 'tr_passo_excluir(bigint)',
                           'tr_passos_reordenar(bigint, bigint[])', 'tr_trilha_setores_salvar(bigint, bigint[])',
                           'tr_progresso_por_setor()', 'tr_progresso_pessoas(bigint)'] loop
    execute format('revoke execute on function imobdesk.%s from public, anon', f);
    execute format('grant execute on function imobdesk.%s to authenticated, service_role', f);
  end loop;
  -- Internas: só chamadas pelas funções acima.
  foreach f in array array['tr_exigir_login()', 'tr_eh_gestor()', 'tr_exigir_gestor()', 'tr_trilha_do_setor(bigint)', 'tr_atende_restricao(uuid, text)',
                           'tr_modulos_visiveis(uuid, bigint, boolean)', 'tr_pode_ver_modulo(uuid, bigint)', 'tr_modulo_resumo(bigint, uuid)',
                           'tr_pessoas_trilha()'] loop
    execute format('revoke execute on function imobdesk.%s from public, anon, authenticated', f);
    execute format('grant execute on function imobdesk.%s to service_role', f);
  end loop;
end;
$$;

-- Permissões por aplicativo (Central): tabelas novas com a mesma proteção das outras, se o controle estiver ligado.
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

-- ======================================== 20261023150000_imobdesk_sf_acesso_perfil.sql
-- Solicitações Financeiras — App Financeiro por perfil, Fase 1 (docs/PLANO-app-financeiro-perfis.md, decisões D1–D5 e P1
-- aprovadas pelo Wagner em 23/10/2026). Aditiva: uma função nova e quatro redefinições que mantêm os campos de hoje.
--   D1: gestor de setor = Gestão do setor em Setores e números (at_setor_gestores). Só ele presta contas do fundo fixo.
--   D2/D3: Aprovações = aprovador ou substituto + permissão sf_aprovacoes; Conferência = setor financeiro + permissão
--          sf_conferencia; Cadastros = Admin. A regra fica no bloco `acesso` de sf_meu_contexto, lido pelo app e pelo portal.
--   P1: a prestação de contas já criada segue até o fim; o fundo fixo novo de quem não é gestor é recusado; Cadastros
--       mostra quem tem fundo e não é gestor.

-- ---------- Gestor do setor ----------
/** A pessoa está em "Gestão do setor" de algum setor ativo. */
create or replace function imobdesk.sf_eh_gestor(p_usuario uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from imobdesk.at_setor_gestores g join imobdesk.at_setores s on s.id = g.setor_id
                 where g.usuario_id = p_usuario and s.ativo);
$$;

/** Aprovador ou substituto ativo na aba Aprovação financeira, ou substituto por período vigente. */
create or replace function imobdesk.sf_eh_aprovador(p_usuario uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from imobdesk.sf_setor_aprovador a where a.ativo and p_usuario in (a.aprovador_id, a.substituto_id))
      or exists (select 1 from imobdesk.sf_substituicao x where x.substituto_id = p_usuario and current_date between x.de and x.ate);
$$;

-- ---------- Contexto (redefinida: acrescenta ehGestor e o bloco acesso) ----------
/**
 * Quem é o usuário e o que ele pode abrir nas Solicitações Financeiras. O bloco `acesso` é a regra única de quem vê o
 * quê, no app (App do solicitante › Financeiro) e no menu do portal. As RPCs de cada tela continuam conferindo o papel.
 */
create or replace function imobdesk.sf_meu_contexto()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.sf_exigir_login();
  v_pessoa bigint := imobdesk.sf_pessoa_do_usuario(v_uid);
  v_doc text;
  v_setor record;
  v_admin boolean := imobdesk.ch_eh_admin();
  v_financeiro boolean := imobdesk.sf_eh_financeiro(v_uid);
  v_gestor boolean := imobdesk.sf_eh_gestor(v_uid);
  v_bloqueio text;
begin
  select p.documento into v_doc from imobdesk.at_pessoas p where p.id = v_pessoa;
  select s.id, s.nome, s.sf_setor_obra, s.sf_financeiro, s.sf_acao_comprovacao_vencida into v_setor
  from imobdesk.at_setores s where s.id = imobdesk.sf_setor_do_usuario(v_uid);
  -- Mesma regra da A06 em sf_rascunho_criar.
  if v_setor.sf_acao_comprovacao_vencida = 'avisar_bloquear' and exists (
       select 1 from imobdesk.sf_solicitacao s
       where s.solicitante_id = v_uid and s.tipo = 'adiantamento' and s.status = 'comprovacao_pendente' and s.prazo_comprovacao < current_date) then
    v_bloqueio := 'Você tem adiantamento com comprovação vencida. Envie a comprovação antes de pedir outro adiantamento.';
  end if;
  return jsonb_build_object(
    'usuarioId', v_uid,
    'nome', (select u.nome from imobdesk.usuarios u where u.id = v_uid),
    'pessoaId', v_pessoa,
    -- CPF completo só no PDF e no SIENGE.
    'cpfMascarado', case when v_doc ~ '^\d{11}$' then '***.' || substr(v_doc, 4, 3) || '.' || substr(v_doc, 7, 3) || '-**' end,
    'setor', case when v_setor.id is null then null
                  else jsonb_build_object('id', v_setor.id, 'nome', v_setor.nome, 'obra', v_setor.sf_setor_obra, 'financeiro', v_setor.sf_financeiro) end,
    'ehAdmin', v_admin,
    'ehFinanceiro', v_financeiro,
    'ehAprovador', exists (select 1 from imobdesk.sf_setor_aprovador a where a.ativo and v_uid in (a.aprovador_id, a.substituto_id)),
    'ehGestor', v_gestor,
    'acesso', jsonb_build_object(
      'reembolso', v_setor.id is not null,
      'fundoFixo', v_setor.id is not null and v_gestor,
      'temValorFundo', exists (select 1 from imobdesk.sf_fundo_fixo f where f.usuario_id = v_uid and f.ativo),
      'adiantamento', v_setor.id is not null and v_bloqueio is null,
      'adiantamentoBloqueio', v_bloqueio,
      'aprovacoes', v_admin or (imobdesk.sf_eh_aprovador(v_uid) and imobdesk.tem_permissao('sf_aprovacoes')),
      'conferencia', v_admin or (v_financeiro and imobdesk.tem_permissao('sf_conferencia')),
      'cadastros', v_admin
    )
  );
end;
$$;

-- ---------- Minhas solicitações (redefinida: fundo fixo só para gestor) ----------
/** Tela 1: contadores e histórico do próprio colaborador. temFundoFixo = gestor do setor com valor cadastrado. */
create or replace function imobdesk.sf_minhas()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.sf_exigir_login();
  v_mes date := date_trunc('month', current_date)::date;
  v_gestor boolean := imobdesk.sf_eh_gestor(v_uid);
begin
  return jsonb_build_object(
    'kpis', (select jsonb_build_object(
               'rascunho', count(*) filter (where s.status = 'rascunho'),
               'emAprovacao', count(*) filter (where s.status = 'em_aprovacao'),
               'devolvida', count(*) filter (where s.status in ('devolvida', 'pendencia_solicitante')),
               'noFinanceiro', count(*) filter (where s.status in ('em_conferencia', 'lancamento_gerado', 'pagamento_programado')),
               'aComprovar', count(*) filter (where s.status = 'comprovacao_pendente'),
               'pagasMes', count(*) filter (where s.status in ('paga', 'encerrada') and s.atualizado_em >= v_mes),
               'pagasMesValor', coalesce(sum(s.valor_a_pagar) filter (where s.status in ('paga', 'encerrada') and s.atualizado_em >= v_mes), 0))
             from imobdesk.sf_solicitacao s where s.solicitante_id = v_uid),
    'temFundoFixo', v_gestor and exists (select 1 from imobdesk.sf_fundo_fixo f where f.usuario_id = v_uid and f.ativo),
    'ehGestor', v_gestor,
    'temSetor', imobdesk.sf_setor_do_usuario(v_uid) is not null,
    'lista', coalesce((select jsonb_agg(jsonb_build_object(
                 'id', s.id, 'numero', s.numero, 'tipo', s.tipo, 'status', s.status, 'competencia', s.competencia, 'vencimento', s.vencimento,
                 'valor', coalesce(s.valor_adiantamento, s.total_despesas), 'pagarAte', s.pagar_ate, 'atualizadoEm', s.atualizado_em,
                 'etapa', (select jsonb_build_object('papel', a.papel, 'nivel', a.nivel,
                                                     'de', (select count(*) from imobdesk.sf_aprovacao b where b.solicitacao_id = s.id and b.ciclo = s.ciclo and b.status not in ('nao_exigido', 'pulado')))
                           from imobdesk.sf_aprovacao a where a.solicitacao_id = s.id and a.ciclo = s.ciclo and a.status = 'aguardando'
                           order by a.nivel limit 1))
               order by s.atualizado_em desc)
               from imobdesk.sf_solicitacao s where s.solicitante_id = v_uid and s.status <> 'cancelada'), '[]')
  );
end;
$$;

-- ---------- Rascunho (redefinida a partir da Fase 5B: fundo fixo só para gestor) ----------
/** Cria o rascunho. Fundo fixo exige gestor do setor e traz o valor e o saldo inicial; adiantamento é recusado com comprovação vencida (A06). */
create or replace function imobdesk.sf_rascunho_criar(p_tipo text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.sf_exigir_login();
  v_setor bigint := imobdesk.sf_setor_do_usuario(v_uid);
  v_fundo numeric(14,2);
  v_ant imobdesk.sf_solicitacao;
  v_saldo numeric(14,2);
  v_id bigint;
  v_mes date := date_trunc('month', current_date)::date;
  st imobdesk.at_setores;
begin
  if p_tipo not in ('reembolso', 'fundo_fixo', 'adiantamento') then
    perform imobdesk.erro('INVALID_INPUT', 'Tipo de solicitação inválido.', 'tipo');
  end if;
  if v_setor is null then
    perform imobdesk.erro('INVALID_INPUT', 'Seu cadastro de Pessoas está sem setor. Peça ao administrador para definir o seu setor.');
  end if;
  select * into st from imobdesk.at_setores where id = v_setor;
  if p_tipo = 'adiantamento' then
    if st.sf_acao_comprovacao_vencida = 'avisar_bloquear' and exists (
         select 1 from imobdesk.sf_solicitacao s
         where s.solicitante_id = v_uid and s.tipo = 'adiantamento' and s.status = 'comprovacao_pendente' and s.prazo_comprovacao < current_date) then
      perform imobdesk.erro('INVALID_INPUT', 'Você tem adiantamento com comprovação vencida. Envie a comprovação antes de pedir outro adiantamento.');
    end if;
    insert into imobdesk.sf_solicitacao (tipo, solicitante_id, pessoa_id, setor_id, competencia, centro_custo, obra, forma_pagamento, tipo_conta,
                                                   total_despesas, valor_a_pagar)
    values ('adiantamento', v_uid, imobdesk.sf_pessoa_do_usuario(v_uid), v_setor, v_mes, st.sf_centro_custo_padrao,
            case when st.sf_setor_obra then st.nome end, 'deposito', 'corrente', 0, 0)
    returning id into v_id;
    perform imobdesk.sf_registrar_evento(v_id, 'criada', jsonb_build_object('tipo', p_tipo));
    return v_id;
  end if;
  if p_tipo = 'fundo_fixo' then
    -- D1: só o gestor do setor. A prestação já criada segue (as demais RPCs não olham o gestor).
    if not imobdesk.sf_eh_gestor(v_uid) then
      perform imobdesk.erro('FORBIDDEN', 'O fundo fixo é só para o gestor do setor (Gestão do setor em Setores e números).');
    end if;
    select f.valor into v_fundo from imobdesk.sf_fundo_fixo f where f.usuario_id = v_uid and f.ativo;
    if v_fundo is null then
      perform imobdesk.erro('INVALID_INPUT', 'Você não tem fundo fixo cadastrado. Peça ao Financeiro para cadastrar em Cadastros financeiros › Fundo fixo.');
    end if;
    select * into v_ant from imobdesk.sf_solicitacao s
    where s.solicitante_id = v_uid and s.tipo = 'fundo_fixo' and s.status not in ('rascunho', 'cancelada', 'reprovada')
    order by s.enviado_em desc nulls last, s.id desc limit 1;
    v_saldo := case when v_ant.id is null then v_fundo
                    else coalesce(v_ant.saldo_final, 0) + case when v_ant.status in ('paga', 'encerrada') then coalesce(v_ant.valor_a_pagar, 0) else 0 end end;
  end if;
  insert into imobdesk.sf_solicitacao (tipo, solicitante_id, pessoa_id, setor_id, competencia, periodo_de, periodo_ate, centro_custo,
                                                 valor_fundo_fixo, saldo_inicial, saldo_final, total_despesas, valor_a_pagar)
  values (p_tipo, v_uid, imobdesk.sf_pessoa_do_usuario(v_uid), v_setor, v_mes, v_mes, (v_mes + interval '1 month - 1 day')::date,
          st.sf_centro_custo_padrao, v_fundo, v_saldo, v_saldo, 0, 0)
  returning id into v_id;
  perform imobdesk.sf_registrar_evento(v_id, 'criada', jsonb_build_object('tipo', p_tipo));
  return v_id;
end;
$$;

-- ---------- Cadastros (redefinida: ehGestor no fundo fixo e nos usuários) ----------
create or replace function imobdesk.sf_cadastros_lista()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform imobdesk.sf_exigir_admin();
  return jsonb_build_object(
    'fundos', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'usuarioId', f.usuario_id, 'usuario', u.nome,
                                                             'setor', (select s.nome from imobdesk.at_setores s where s.id = imobdesk.sf_setor_do_usuario(u.id)),
                                                             'valor', f.valor, 'vigenteDesde', f.vigente_desde,
                                                             -- P1: quem tem fundo e não é gestor não abre prestação nova.
                                                             'ehGestor', imobdesk.sf_eh_gestor(u.id)) order by u.nome)
                        from imobdesk.sf_fundo_fixo f join imobdesk.usuarios u on u.id = f.usuario_id where f.ativo), '[]'),
    'categorias', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'nome', c.nome, 'descricao', c.descricao, 'palavrasChave', c.palavras_chave,
                                                                 'tetoValor', c.teto_valor, 'ativo', c.ativo) order by c.ordem, c.nome)
                            from imobdesk.sf_categoria_motivo c), '[]'),
    'regras', coalesce((select jsonb_agg(jsonb_build_object('codigo', r.codigo, 'nome', r.nome, 'descricao', r.descricao, 'aplicaA', r.aplica_a,
                                                             'severidade', r.severidade, 'ativo', r.ativo, 'parametros', r.parametros) order by left(r.codigo, 1) desc, r.codigo)
                        from imobdesk.sf_regra r), '[]'),
    'usuarios', coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'nome', u.nome, 'ehGestor', imobdesk.sf_eh_gestor(u.id)) order by u.nome)
                          from imobdesk.usuarios u where u.status = 'active'), '[]')
  );
end;
$$;

-- ---------- D3: ninguém que aprova hoje perde o menu Aprovações ----------
-- Marca a tela para o perfil de cada aprovador ou substituto ativo. Linha já existente (inclusive desligada) não muda.
insert into imobdesk.profile_permissions (role, permission_id, enabled)
select distinct u.perfil_key, 'sf_aprovacoes', true
from imobdesk.usuarios u
where u.perfil_key is not null and u.perfil_key <> 'super_admin'
  and exists (select 1 from imobdesk.sf_setor_aprovador a where a.ativo and u.id in (a.aprovador_id, a.substituto_id))
on conflict (role, permission_id) do nothing;

-- ---------- Permissões de execução ----------
do $$
declare
  f text;
begin
  foreach f in array array['sf_meu_contexto()', 'sf_minhas()', 'sf_rascunho_criar(text)', 'sf_cadastros_lista()'] loop
    execute format('revoke execute on function imobdesk.%s from public, anon', f);
    execute format('grant execute on function imobdesk.%s to authenticated, service_role', f);
  end loop;
  -- Auxiliares: só dentro das RPCs.
  foreach f in array array['sf_eh_gestor(uuid)', 'sf_eh_aprovador(uuid)'] loop
    execute format('revoke execute on function imobdesk.%s from public, anon, authenticated', f);
    execute format('grant execute on function imobdesk.%s to service_role', f);
  end loop;
end;
$$;

notify pgrst, 'reload schema';

-- ======================================== 20261024000000_imobdesk_90_multiempresa.sql
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

-- ======================================== 20261024000100_imobdesk_central_acessos.sql
-- Central de acessos do ikvj (Permissões por aplicativo): o Imobdesk se cadastra aqui, com o controle desligado.
-- O cadastro de usuário de cada empresa é feito na tela Usuários do próprio Imobdesk: o "Liberar" da Central
-- grava em imobdesk.usuarios na empresa aberta por quem libera (imobdesk.empresa_atual()).
-- Aditiva: só insere se ainda não existir.

do $$
begin
  if to_regclass('acessos.aplicativos') is null then
    raise notice 'Central de acessos (schema acessos) não existe neste banco: cadastro do app ignorado.';
    return;
  end if;
  execute $i$
    insert into acessos.aplicativos (schema_name, nome, url)
    values ('imobdesk', 'Imobdesk', 'https://imobdesk.imobsystems.com.br')
    on conflict (schema_name) do nothing
  $i$;
  if exists (select 1 from information_schema.columns
              where table_schema = 'acessos' and table_name = 'aplicativos' and column_name = 'perfil_liberar') then
    execute $u$ update acessos.aplicativos set perfil_liberar = 'operador'
                 where schema_name = 'imobdesk' and perfil_liberar is null $u$;
  end if;
end $$;

notify pgrst, 'reload schema';

-- ======================================== 20261024000200_imobdesk_empresa_edge.sql
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

commit;
