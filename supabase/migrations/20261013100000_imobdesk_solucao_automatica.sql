-- "Solução aplicada" automática (Wagner, 13/10/2026): o agente não preenche mais o campo. Ao resolver ou fechar sem
-- solução, ela vem da última resposta ao solicitante (texto + nomes dos anexos); sem resposta pública, da última nota
-- interna. É a base de conhecimento (sugestões e App do solicitante), por isso o campo saiu da tela do ticket.
-- Só troca funções (create or replace); nenhum dado muda.

/** Texto da solução a partir das ações de saída do ticket: a resposta pública mais recente; senão a nota interna mais recente. */
create or replace function imobdesk.ch_solucao_da_resposta(p_ticket bigint)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select left(
           btrim(a.texto) ||
           coalesce(E'\n\nAnexos: ' || (select string_agg(coalesce(x ->> 'nome', x ->> 'name', x ->> 'arquivo', 'imagem'), ', ')
                                          from jsonb_array_elements(case when jsonb_typeof(a.anexos) = 'array' then a.anexos else '[]' end) x), ''),
           20000)
    from imobdesk.ch_ticket_acoes a
   where a.ticket_id = p_ticket and a.direcao = 'saida' and length(btrim(coalesce(a.texto, ''))) > 0
   order by (a.tipo = 'publica') desc, a.numero desc
   limit 1;
$$;

/**
 * Altera o ticket. Só as chaves enviadas mudam. Resolver ou fechar exige os campos obrigatórios; a "Solução aplicada",
 * se vazia, vem da última resposta ao solicitante (ch_solucao_da_resposta). Alterar o prazo à mão: gestor do setor,
 * Admin ou Super admin, com justificativa.
 */
create or replace function imobdesk.ch_ticket_atualizar(p_id bigint, p jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  t imobdesk.ch_tickets := imobdesk.ch_ticket_visivel(p_id);
  n imobdesk.ch_tickets;
  v_cat text;
  v_pend text[];
begin
  if t.excluido_em is not null then perform imobdesk.erro('INVALID_INPUT', 'Ticket excluído.'); end if;
  if t.mesclado_em_id is not null then perform imobdesk.erro('INVALID_INPUT', format('Este ticket foi mesclado em #%s.', t.mesclado_em_id)); end if;
  n := t;
  if p ? 'servicoId' then n.servico_id := nullif(p ->> 'servicoId', '')::bigint;
    if n.servico_id is not null then
      n.setor_id := (select s.setor_id from imobdesk.ch_servicos s where s.id = n.servico_id and s.ativo);
      if n.setor_id is null then perform imobdesk.erro('INVALID_INPUT', 'Serviço inválido.', 'servicoId'); end if;
      if not (p ? 'equipeId') then n.equipe_id := null; end if;   -- o gatilho põe a equipe do serviço
    end if;
  end if;
  if p ? 'categoriaId' then n.categoria_id := nullif(p ->> 'categoriaId', '')::bigint; end if;
  if p ? 'urgenciaId' then n.urgencia_id := coalesce(nullif(p ->> 'urgenciaId', '')::bigint, n.urgencia_id); end if;
  if p ? 'equipeId' then n.equipe_id := nullif(p ->> 'equipeId', '')::bigint; end if;
  if p ? 'responsavelId' then n.responsavel_id := nullif(p ->> 'responsavelId', '')::uuid; end if;
  if p ? 'statusId' then n.status_id := (p ->> 'statusId')::bigint; n.justificativa_id := nullif(p ->> 'justificativaId', '')::bigint; end if;
  if p ? 'tags' then n.tags := coalesce(array(select distinct btrim(x) from jsonb_array_elements_text(p -> 'tags') x where btrim(x) <> ''), '{}'); end if;
  if p ? 'cc' then n.cc := coalesce(array(select distinct lower(btrim(x)) from jsonb_array_elements_text(p -> 'cc') x where btrim(x) <> ''), '{}'); end if;
  if p ? 'campos' then n.campos := t.campos || coalesce(p -> 'campos', '{}'); end if;
  if p ? 'assunto' and length(btrim(p ->> 'assunto')) > 0 then n.assunto := btrim(p ->> 'assunto'); end if;
  if p ? 'solucaoAplicada' then n.solucao_aplicada := nullif(btrim(p ->> 'solucaoAplicada'), ''); end if;
  if p ? 'solicitantePessoaId' then
    n.solicitante_pessoa_id := nullif(p ->> 'solicitantePessoaId', '')::bigint;
    select pe.nome into n.solicitante_nome from imobdesk.at_pessoas pe where pe.id = n.solicitante_pessoa_id;
    if n.solicitante_nome is null then perform imobdesk.erro('INVALID_INPUT', 'Solicitante não encontrado.', 'solicitante'); end if;
  end if;
  if p ? 'slaSolucaoAte' then
    if not (imobdesk.ch_eh_admin() or imobdesk.at_gestor_de(t.setor_id)) then
      perform imobdesk.erro('FORBIDDEN', 'Só o gestor do setor, Admin ou Super admin alteram o prazo.');
    end if;
    if length(btrim(coalesce(p ->> 'slaJustificativa', ''))) < 5 then perform imobdesk.erro('INVALID_INPUT', 'Explique por que o prazo mudou.', 'slaJustificativa'); end if;
    n.sla_solucao_ate := (p ->> 'slaSolucaoAte')::timestamptz;
    n.sla_manual := true;
  end if;

  v_cat := (select s.categoria from imobdesk.ch_status s where s.id = n.status_id and s.ativo);
  if v_cat is null then perform imobdesk.erro('INVALID_INPUT', 'Status inválido.', 'statusId'); end if;
  if v_cat in ('resolvido', 'fechado') then
    v_pend := imobdesk.ch_campos_pendentes(n);
    if cardinality(v_pend) > 0 then
      perform imobdesk.erro('INVALID_INPUT', 'Preencha antes de resolver: ' || array_to_string(v_pend, ', ') || '.', 'campos');
    end if;
    if n.servico_id is null then perform imobdesk.erro('INVALID_INPUT', 'Escolha o serviço antes de resolver.', 'servicoId'); end if;
    if n.solucao_aplicada is null then n.solucao_aplicada := imobdesk.ch_solucao_da_resposta(p_id); end if;
    if n.solucao_aplicada is null then
      perform imobdesk.erro('INVALID_INPUT', 'Responda ao solicitante antes de resolver: o texto da resposta vira a solução aplicada.', 'texto');
    end if;
  end if;

  update imobdesk.ch_tickets set
    servico_id = n.servico_id, setor_id = n.setor_id, categoria_id = n.categoria_id, urgencia_id = n.urgencia_id, equipe_id = n.equipe_id,
    responsavel_id = n.responsavel_id, status_id = n.status_id, justificativa_id = n.justificativa_id, tags = n.tags, cc = n.cc, campos = n.campos,
    assunto = n.assunto, solucao_aplicada = n.solucao_aplicada, solicitante_pessoa_id = n.solicitante_pessoa_id, solicitante_nome = n.solicitante_nome,
    sla_solucao_ate = n.sla_solucao_ate, sla_manual = n.sla_manual
  where id = p_id;

  if p ? 'slaSolucaoAte' then
    insert into imobdesk.ch_ticket_eventos (ticket_id, tipo, descricao, autor_id, autor_nome)
    values (p_id, 'sla_justificativa', 'Motivo: ' || btrim(p ->> 'slaJustificativa'), (select auth.uid()), imobdesk.ch_nome_usuario((select auth.uid())));
  end if;
end;
$$;

-- Helper interno: só as funções do banco chamam.
revoke execute on function imobdesk.ch_solucao_da_resposta(bigint) from public, anon, authenticated;
grant execute on function imobdesk.ch_solucao_da_resposta(bigint) to service_role;

notify pgrst, 'reload schema';
