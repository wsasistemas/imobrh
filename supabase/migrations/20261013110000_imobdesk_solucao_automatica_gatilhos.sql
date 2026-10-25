-- "Solução aplicada" automática também nos gatilhos (Wagner, 13/10/2026): resolver ou fechar por gatilho sem solução
-- usa a última resposta ao solicitante (ch_solucao_da_resposta, migration 20261013100000). Só troca a função.

/**
 * Aplica as ações do gatilho no ticket e devolve o resumo. Resolver ou fechar segue as mesmas regras do agente
 * (serviço e obrigatórios); sem solução aplicada, usa a última resposta. Se faltar algo, a execução fica como "erro".
 */
create or replace function imobdesk.ch_gatilho_aplicar(p_ticket bigint, g imobdesk.ch_gatilhos)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  t imobdesk.ch_tickets;
  n imobdesk.ch_tickets;
  a jsonb;
  v_feito text[] := '{}';
  v_cat text;
  v_pend text[];
  v_lider uuid;
  v_texto text;
  v_canal text;
  v_num int;
  v_quem uuid[];
begin
  select * into t from imobdesk.ch_tickets x where x.id = p_ticket for update;
  n := t;
  for a in select * from jsonb_array_elements(g.acoes) loop
    v_lider := (select e.lider_id from imobdesk.at_equipes e where e.id = n.equipe_id);
    case a ->> 'tipo'
      when 'status' then
        n.status_id := (a ->> 'statusId')::bigint;
        n.justificativa_id := nullif(a ->> 'justificativaId', '')::bigint;
        v_feito := array_append(v_feito, ('status → ' || coalesce((select s.nome from imobdesk.ch_status s where s.id = n.status_id), '?'))::text);
      when 'equipe' then
        n.equipe_id := nullif(a ->> 'equipeId', '')::bigint;
        v_feito := array_append(v_feito, ('equipe → ' || coalesce((select e.nome from imobdesk.at_equipes e where e.id = n.equipe_id), 'nenhuma'))::text);
      when 'responsavel' then
        n.responsavel_id := case a ->> 'modo'
          when 'pessoa' then nullif(a ->> 'usuarioId', '')::uuid
          when 'lider' then v_lider
          else null end;
        v_feito := array_append(v_feito, ('responsável → ' || coalesce((select u.nome from imobdesk.usuarios u where u.id = n.responsavel_id), 'ninguém'))::text);
      when 'urgencia' then
        n.urgencia_id := coalesce(nullif(a ->> 'urgenciaId', '')::bigint, n.urgencia_id);
        v_feito := array_append(v_feito, ('urgência → ' || (select u.nome from imobdesk.ch_urgencias u where u.id = n.urgencia_id))::text);
      when 'categoria' then
        n.categoria_id := nullif(a ->> 'categoriaId', '')::bigint;
        v_feito := array_append(v_feito, ('categoria → ' || coalesce((select c.nome from imobdesk.ch_categorias c where c.id = n.categoria_id), 'nenhuma'))::text);
      when 'servico' then
        n.servico_id := nullif(a ->> 'servicoId', '')::bigint;
        if n.servico_id is not null then
          n.setor_id := coalesce((select s.setor_id from imobdesk.ch_servicos s where s.id = n.servico_id and s.ativo), n.setor_id);
          n.equipe_id := null;   -- o trigger põe a equipe do serviço
        end if;
        v_feito := array_append(v_feito, ('serviço → ' || coalesce((select s.nome from imobdesk.ch_servicos s where s.id = n.servico_id), 'nenhum'))::text);
      when 'tags_adicionar' then
        n.tags := array(select distinct x from unnest(n.tags || array(select btrim(y) from jsonb_array_elements_text(coalesce(a -> 'tags', '[]')) y where btrim(y) <> '')) x);
        v_feito := array_append(v_feito, 'tags adicionadas'::text);
      when 'tags_remover' then
        n.tags := array(select x from unnest(n.tags) x where not x = any (array(select btrim(y) from jsonb_array_elements_text(coalesce(a -> 'tags', '[]')) y)));
        v_feito := array_append(v_feito, 'tags removidas'::text);
      when 'campo' then
        n.campos := n.campos || jsonb_build_object(a ->> 'chave', a -> 'valor');
        v_feito := array_append(v_feito, ('campo ' || (a ->> 'chave'))::text);
      when 'solucao' then
        if n.solucao_aplicada is null then
          n.solucao_aplicada := nullif(btrim(a ->> 'texto'), '');
          v_feito := array_append(v_feito, 'solução aplicada preenchida'::text);
        end if;
      when 'nota_interna' then
        v_num := coalesce((select max(x.numero) from imobdesk.ch_ticket_acoes x where x.ticket_id = p_ticket), 0) + 1;
        insert into imobdesk.ch_ticket_acoes (ticket_id, numero, tipo, canal, direcao, autor_nome, texto, envio_status)
        values (p_ticket, v_num, 'interna', 'portal', 'saida', 'Gatilho: ' || g.nome, coalesce(nullif(btrim(a ->> 'texto'), ''), g.nome), 'nao_se_aplica');
        v_feito := array_append(v_feito, 'nota interna'::text);
      when 'responder_macro' then
        select m.texto into v_texto from imobdesk.ch_macros m where m.id = nullif(a ->> 'macroId', '')::bigint and m.ativa;
        if v_texto is null then perform imobdesk.erro('INVALID_INPUT', 'A macro da resposta não existe ou está inativa.'); end if;
        v_texto := replace(replace(replace(v_texto,
                     '{{solicitante.nome}}', split_part(btrim(n.solicitante_nome), ' ', 1)),
                     '{{ticket.numero}}', n.id::text),
                     '{{agente.nome}}', coalesce((select u.nome from imobdesk.usuarios u where u.id = n.responsavel_id), 'Equipe de atendimento'));
        v_canal := case when n.origem in ('email', 'whatsapp') then n.origem else 'portal' end;
        v_num := coalesce((select max(x.numero) from imobdesk.ch_ticket_acoes x where x.ticket_id = p_ticket), 0) + 1;
        insert into imobdesk.ch_ticket_acoes (ticket_id, numero, tipo, canal, direcao, autor_nome, texto, envio_status)
        values (p_ticket, v_num, 'publica', v_canal, 'saida', 'Gatilho: ' || g.nome, v_texto, case when v_canal in ('email', 'whatsapp') then 'pendente' else 'nao_se_aplica' end);
        if n.primeira_resposta_em is null then n.primeira_resposta_em := now(); end if;
        v_feito := array_append(v_feito, 'resposta ao solicitante'::text);
      when 'seguidor' then
        insert into imobdesk.ch_ticket_seguidores (ticket_id, usuario_id)
        select p_ticket, u from (select case a ->> 'modo' when 'lider' then v_lider when 'responsavel' then n.responsavel_id else nullif(a ->> 'usuarioId', '')::uuid end u) s
         where u is not null
        on conflict do nothing;
        v_feito := array_append(v_feito, 'seguidor'::text);
      when 'avisar' then
        v_quem := case a ->> 'quem'
          when 'responsavel' then array[n.responsavel_id]
          when 'lider' then array[v_lider]
          when 'seguidores' then array(select s.usuario_id from imobdesk.ch_ticket_seguidores s where s.ticket_id = p_ticket)
          when 'equipe' then array(select m.usuario_id from imobdesk.at_equipe_membros m where m.equipe_id = n.equipe_id)
          when 'pessoa' then array[nullif(a ->> 'usuarioId', '')::uuid]
          else '{}'::uuid[] end;
        perform imobdesk.ch_notificar(v_quem, p_ticket, format('Ticket #%s: %s', n.id, n.assunto), coalesce(nullif(btrim(a ->> 'texto'), ''), g.nome));
        v_feito := array_append(v_feito, ('aviso (' || coalesce(a ->> 'quem', '?') || ')')::text);
      else
        perform imobdesk.erro('INVALID_INPUT', format('Ação desconhecida: %s', a ->> 'tipo'));
    end case;
  end loop;

  v_cat := (select s.categoria from imobdesk.ch_status s where s.id = n.status_id and s.ativo);
  if v_cat is null then perform imobdesk.erro('INVALID_INPUT', 'Status do gatilho inválido ou inativo.'); end if;
  if v_cat in ('resolvido', 'fechado') and t.status_id is distinct from n.status_id then
    v_pend := imobdesk.ch_campos_pendentes(n);
    if cardinality(v_pend) > 0 then perform imobdesk.erro('INVALID_INPUT', 'Para resolver falta: ' || array_to_string(v_pend, ', ') || '.'); end if;
    if n.servico_id is null then perform imobdesk.erro('INVALID_INPUT', 'Para resolver falta o serviço.'); end if;
    if n.solucao_aplicada is null then n.solucao_aplicada := imobdesk.ch_solucao_da_resposta(p_ticket); end if;
    if n.solucao_aplicada is null then perform imobdesk.erro('INVALID_INPUT', 'Para resolver falta uma resposta ao solicitante (vira a "Solução aplicada").'); end if;
  end if;

  update imobdesk.ch_tickets set
    servico_id = n.servico_id, setor_id = n.setor_id, categoria_id = n.categoria_id, urgencia_id = n.urgencia_id, equipe_id = n.equipe_id,
    responsavel_id = n.responsavel_id, status_id = n.status_id, justificativa_id = n.justificativa_id, tags = n.tags, campos = n.campos,
    solucao_aplicada = n.solucao_aplicada, primeira_resposta_em = n.primeira_resposta_em
  where id = p_ticket
    and (servico_id, setor_id, categoria_id, urgencia_id, equipe_id, responsavel_id, status_id, justificativa_id, tags, campos, solucao_aplicada, primeira_resposta_em)
        is distinct from (n.servico_id, n.setor_id, n.categoria_id, n.urgencia_id, n.equipe_id, n.responsavel_id, n.status_id, n.justificativa_id, n.tags, n.campos, n.solucao_aplicada, n.primeira_resposta_em);

  return array_to_string(v_feito, '; ');
end;
$$;

notify pgrst, 'reload schema';
