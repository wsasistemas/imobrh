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
