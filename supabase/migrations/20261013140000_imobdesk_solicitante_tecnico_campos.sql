-- App do solicitante · Técnico: campos adicionais obrigatórios no "Registrar atendimento" (13/10/2026).
-- O #1036 (serviço com o campo "Câmera" obrigatório por regra) não concluía: o app só dizia "falta preencher no portal".
-- Agora cd_tec_chamado devolve os campos obrigatórios visíveis do ticket e cd_tec_concluir grava p.campos antes de validar.
-- Só troca as duas funções (create or replace).

/** Detalhe para o técnico. */
create or replace function imobdesk.cd_tec_chamado(p_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.cd_tec_quem();
  t imobdesk.ch_tickets := imobdesk.cd_tec_ticket(p_id, v_uid);
  v_cat text := (select s.categoria from imobdesk.ch_status s where s.id = t.status_id);
  v_aberto boolean := v_cat not in ('resolvido', 'fechado', 'cancelado') and t.mesclado_em_id is null;
begin
  return imobdesk.cd_tec_resumo(t, v_uid) || jsonb_build_object(
    'setor', (select s.nome from imobdesk.at_setores s where s.id = t.setor_id),
    'servicoId', t.servico_id,
    'local', (select jsonb_build_object('nome', e.nome, 'cidade', e.cidade, 'endereco', e.endereco, 'observacao', e.observacao)
                from imobdesk.ch_empreendimentos e where e.id = t.empreendimento_id),
    'email', (select c.valor from imobdesk.at_pessoa_contatos c where c.pessoa_id = t.solicitante_pessoa_id and c.tipo = 'email' order by c.principal desc, c.id limit 1),
    'solucao', t.solucao_aplicada,
    'podeAtribuir', v_aberto and t.responsavel_id is null,
    'podeAtender', v_aberto and coalesce(t.responsavel_id = v_uid, false),
    -- Campos adicionais obrigatórios para resolver (regras de exibição deste ticket), com o valor atual.
    'campos', coalesce((select jsonb_agg(jsonb_build_object('chave', c.chave, 'rotulo', c.rotulo, 'tipo', c.tipo, 'opcoes', to_jsonb(c.opcoes),
                                                            'ajuda', c.ajuda, 'valor', t.campos -> c.chave) order by c.ordem, c.rotulo)
                          from imobdesk.ch_campos_estado(t) e join imobdesk.ch_campos c on c.chave = e.chave and c.ativo
                         where e.visivel and e.obrigatorio and c.tipo <> 'usuario'), '[]'),
    -- Sem serviço (ex.: "Outro assunto"), o técnico escolhe ao concluir: Resolvido exige serviço.
    'servicos', case when t.servico_id is null then coalesce((
        select jsonb_agg(jsonb_build_object('id', s.id, 'rotulo', imobdesk.cd_trilha(s.id)) order by imobdesk.cd_trilha(s.id))
          from imobdesk.ch_servicos s
         where s.setor_id = t.setor_id and s.ativo and not exists (select 1 from imobdesk.ch_servicos f where f.pai_id = s.id and f.ativo)), '[]') end,
    'acoes', coalesce((select jsonb_agg(jsonb_build_object('numero', a.numero, 'direcao', a.direcao, 'autorNome', a.autor_nome, 'texto', a.texto,
                                                           'anexos', a.anexos, 'criadoEm', a.criado_em) order by a.criado_em, a.numero)
                         from imobdesk.ch_ticket_acoes a where a.ticket_id = t.id and a.tipo = 'publica'), '[]'),
    'eventos', coalesce((select jsonb_agg(jsonb_build_object('tipo', e.tipo, 'criadoEm', e.criado_em, 'autorNome', e.autor_nome,
                                                             'descricao', case e.tipo
                                                               when 'criado' then 'Chamado aberto'
                                                               when 'status' then 'Status: ' || coalesce((select s.nome from imobdesk.ch_status s where s.id = (e.para ->> 'statusId')::bigint), '—')
                                                               else e.descricao end) order by e.criado_em desc)
                           from imobdesk.ch_ticket_eventos e where e.ticket_id = t.id and e.tipo in ('criado', 'status', 'responsavel')), '[]'));
end;
$$;


/**
 * Concluir atendimento: resposta pública ao solicitante (texto + fotos) e o status pelo tipo de resolução.
 *   resolvido → Resolvido (exige 1 foto, serviço e obrigatórios; o texto vira a Solução aplicada)
 *   voltar → Em atendimento · peca → Aguardando·Fornecedor · orcamento → Aguardando·Cotação
 *   aprovacao → Aguardando·Aprovação do gestor (avisa o líder da equipe) · sem_acesso → Aguardando·Retorno do cliente
 *   nao_procede → Cancelado
 * p.campos: valores dos campos adicionais (só chaves de campos ativos), gravados antes de validar.
 */
create or replace function imobdesk.cd_tec_concluir(p_id bigint, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.cd_tec_quem();
  t imobdesk.ch_tickets := imobdesk.cd_tec_ticket(p_id, v_uid);
  n imobdesk.ch_tickets;
  v_tipo text := coalesce(p ->> 'tipo', '');
  v_texto text := btrim(coalesce(p ->> 'texto', ''));
  v_fotos jsonb := imobdesk.cd_anexos_validos(p -> 'fotos', v_uid);
  v_servico bigint := nullif(p ->> 'servicoId', '')::bigint;
  v_campos jsonb := case when jsonb_typeof(p -> 'campos') = 'object' then p -> 'campos' else '{}' end;
  v_cat text;
  v_just text;
  v_status bigint;
  v_justificativa bigint;
  v_pend text[];
  v_canal text;
  v_num int;
  v_nome text := coalesce((select u.nome from imobdesk.usuarios u where u.id = v_uid), 'Técnico');
begin
  perform 1 from imobdesk.ch_tickets x where x.id = p_id for update;
  select * into t from imobdesk.ch_tickets x where x.id = p_id;
  if t.responsavel_id is distinct from v_uid then perform imobdesk.erro('FORBIDDEN', 'Só o técnico responsável registra o atendimento. Use "Atribuir-me" primeiro.'); end if;
  if (select s.categoria from imobdesk.ch_status s where s.id = t.status_id) in ('resolvido', 'fechado', 'cancelado') or t.mesclado_em_id is not null then
    perform imobdesk.erro('INVALID_INPUT', 'Este chamado já foi encerrado.');
  end if;
  if v_tipo not in ('resolvido', 'voltar', 'peca', 'orcamento', 'aprovacao', 'sem_acesso', 'nao_procede') then
    perform imobdesk.erro('INVALID_INPUT', 'Escolha o tipo de resolução.', 'tipo');
  end if;
  if length(v_texto) < 5 then perform imobdesk.erro('INVALID_INPUT', 'Escreva o que foi feito.', 'texto'); end if;
  if length(v_texto) > 4000 then perform imobdesk.erro('INVALID_INPUT', 'O texto passou de 4.000 caracteres.', 'texto'); end if;
  if v_tipo = 'resolvido' and jsonb_array_length(v_fotos) = 0 then
    perform imobdesk.erro('INVALID_INPUT', 'Tire pelo menos 1 foto do atendimento para concluir como Resolvido.', 'fotos');
  end if;

  v_cat := case v_tipo when 'resolvido' then 'resolvido' when 'voltar' then 'andamento' when 'nao_procede' then 'cancelado' else 'pendente' end;
  v_just := case v_tipo when 'peca' then 'fornecedor' when 'orcamento' then 'cotação' when 'aprovacao' then 'aprovação do gestor' when 'sem_acesso' then 'retorno do cliente' end;
  if v_cat = 'pendente' then
    select j.status_id, j.id into v_status, v_justificativa
      from imobdesk.ch_status_justificativas j join imobdesk.ch_status s on s.id = j.status_id and s.ativo and s.categoria = 'pendente'
     where j.ativa and lower(btrim(j.nome)) = v_just order by s.ordem, j.ordem limit 1;
    v_status := coalesce(v_status, (select s.id from imobdesk.ch_status s where s.categoria = 'pendente' and s.ativo order by s.ordem limit 1));
  elsif v_cat = 'andamento' then
    v_status := t.status_id;
    v_justificativa := t.justificativa_id;
    if (select s.categoria from imobdesk.ch_status s where s.id = t.status_id) <> 'andamento' then
      v_status := coalesce((select s.id from imobdesk.ch_status s where s.categoria = 'andamento' and s.ativo and lower(s.nome) = 'em atendimento' limit 1),
                           (select s.id from imobdesk.ch_status s where s.categoria = 'andamento' and s.ativo order by s.ordem limit 1));
      v_justificativa := null;
    end if;
  else
    v_status := (select s.id from imobdesk.ch_status s where s.categoria = v_cat and s.ativo order by s.ordem limit 1);
  end if;
  if v_status is null then perform imobdesk.erro('INVALID_INPUT', 'Status de destino não cadastrado. Fale com a TI.'); end if;

  n := t;
  n.status_id := v_status;
  n.justificativa_id := v_justificativa;
  if v_servico is not null and v_servico is distinct from t.servico_id then
    if not exists (select 1 from imobdesk.ch_servicos s where s.id = v_servico and s.setor_id = t.setor_id and s.ativo) then
      perform imobdesk.erro('INVALID_INPUT', 'Escolha o serviço de novo.', 'servicoId');
    end if;
    n.servico_id := v_servico;
  end if;
  if exists (select 1 from jsonb_object_keys(v_campos) k where not exists (select 1 from imobdesk.ch_campos c where c.chave = k and c.ativo)) then
    perform imobdesk.erro('INVALID_INPUT', 'Campo adicional inválido. Abra o chamado de novo.', 'campos');
  end if;
  n.campos := t.campos || v_campos;
  if v_cat = 'resolvido' then
    if n.servico_id is null then perform imobdesk.erro('INVALID_INPUT', 'Escolha o serviço antes de concluir como Resolvido.', 'servicoId'); end if;
    v_pend := imobdesk.ch_campos_pendentes(n);
    if cardinality(v_pend) > 0 then
      perform imobdesk.erro('INVALID_INPUT', 'Preencha antes de concluir: ' || array_to_string(v_pend, ', ') || '.', 'campos');
    end if;
    n.solucao_aplicada := coalesce(n.solucao_aplicada, left(v_texto, 20000));
  end if;

  -- Resposta ao solicitante pelo canal do ticket (como ch_ticket_acao).
  v_canal := case when t.origem in ('email', 'whatsapp') then t.origem else 'portal' end;
  v_num := coalesce((select max(a.numero) from imobdesk.ch_ticket_acoes a where a.ticket_id = p_id), 0) + 1;
  insert into imobdesk.ch_ticket_acoes (ticket_id, numero, tipo, canal, direcao, autor_id, autor_nome, texto, anexos, envio_status)
  values (p_id, v_num, 'publica', v_canal, 'saida', v_uid, v_nome, v_texto, v_fotos,
          case when v_canal in ('email', 'whatsapp') then 'pendente' else 'nao_se_aplica' end);

  update imobdesk.ch_tickets set
    status_id = n.status_id, justificativa_id = n.justificativa_id, servico_id = n.servico_id, campos = n.campos,
    solucao_aplicada = n.solucao_aplicada, primeira_resposta_em = coalesce(primeira_resposta_em, now())
  where id = p_id;

  if v_tipo = 'aprovacao' then
    perform imobdesk.ch_notificar(array[(select e.lider_id from imobdesk.at_equipes e where e.id = t.equipe_id)], p_id,
      format('Ticket #%s precisa de aprovação', p_id), format('%s: %s', v_nome, left(v_texto, 300)));
  end if;

  return jsonb_build_object('status', (select s.nome from imobdesk.ch_status s where s.id = n.status_id),
                            'justificativa', (select j.nome from imobdesk.ch_status_justificativas j where j.id = n.justificativa_id));
end;
$$;


notify pgrst, 'reload schema';
