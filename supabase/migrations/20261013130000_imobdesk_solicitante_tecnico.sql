-- App do solicitante · modo Técnico (mockup docs/mockups/app-solicitante-tecnico.html, aprovado pelo Wagner em 13/10/2026).
--   D1 só membros de uma equipe de setor com "técnico no app" (hoje o CFTV);
--   D2 o técnico vê todos os chamados do setor e registra atendimento só nos dele;
--   D4 sem agendamento: data e hora do cartão = abertura e prazo do SLA (automático);
--   D5 pelo menos 1 foto para Resolvido; D6 o tipo de resolução define o status e o texto vira a Solução aplicada.
-- Aditiva: 1 coluna nova, funções novas e 1 policy nova de leitura no bucket imobdesk-solicitante.

alter table imobdesk.at_setores add column if not exists cd_tecnico boolean not null default false;
comment on column imobdesk.at_setores.cd_tecnico is 'App do solicitante: os membros das equipes do setor entram no app pela aba Técnico.';
update imobdesk.at_setores set cd_tecnico = true where lower(btrim(nome)) = 'cftv' and not cd_tecnico;

-- ======================================================================= helpers

/** Setores em que o usuário é técnico no app (membro de equipe ativa de setor ativo com cd_tecnico). */
create or replace function imobdesk.cd_tec_setores(p_usuario uuid)
returns bigint[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(distinct s.id), '{}')
    from imobdesk.at_equipe_membros m
    join imobdesk.at_equipes e on e.id = m.equipe_id and e.ativa
    join imobdesk.at_setores s on s.id = e.setor_id and s.ativo and s.cd_tecnico
   where m.usuario_id = p_usuario;
$$;

/** Usuário da sessão, se for técnico; senão erro. */
create or replace function imobdesk.cd_tec_quem()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.cd_quem(null);
begin
  if cardinality(imobdesk.cd_tec_setores(v_uid)) = 0 then
    perform imobdesk.erro('FORBIDDEN', format('Seu usuário não está numa equipe do %s. Entre como Colaborador ou peça à TI para incluir você na equipe.',
      coalesce((select string_agg(s.nome, ', ' order by s.nome) from imobdesk.at_setores s where s.ativo and s.cd_tecnico), 'setor técnico')));
  end if;
  return v_uid;
end;
$$;

/** Ticket de um setor em que o usuário é técnico. */
create or replace function imobdesk.cd_tec_ticket(p_id bigint, p_usuario uuid)
returns imobdesk.ch_tickets
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  t imobdesk.ch_tickets;
begin
  select * into t from imobdesk.ch_tickets x
   where x.id = p_id and x.excluido_em is null and x.setor_id = any (imobdesk.cd_tec_setores(p_usuario));
  if t.id is null then perform imobdesk.erro('NOT_FOUND', 'Chamado não encontrado.'); end if;
  return t;
end;
$$;

/** Telefone do solicitante: WhatsApp/telefone do cadastro da pessoa; senão o contato do ticket, se for número. */
create or replace function imobdesk.cd_tec_telefone(t imobdesk.ch_tickets)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select c.valor from imobdesk.at_pessoa_contatos c where c.pessoa_id = t.solicitante_pessoa_id and c.tipo in ('whatsapp', 'telefone')
      order by c.principal desc, (c.tipo = 'whatsapp') desc, c.id limit 1),
    case when t.solicitante_contato ~ '^\+?[0-9 ()-]{8,}$' then t.solicitante_contato end);
$$;

/** Resumo do ticket para a lista e o detalhe do técnico. */
create or replace function imobdesk.cd_tec_resumo(t imobdesk.ch_tickets, p_usuario uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', t.id, 'assunto', t.assunto, 'origem', t.origem,
    'servico', imobdesk.cd_trilha(t.servico_id),
    'status', imobdesk.cd_status_json(t.status_id),
    'justificativa', (select j.nome from imobdesk.ch_status_justificativas j where j.id = t.justificativa_id),
    'urgencia', (select u.nome from imobdesk.ch_urgencias u where u.id = t.urgencia_id),
    'tags', to_jsonb(t.tags),
    'empreendimento', (select e.nome from imobdesk.ch_empreendimentos e where e.id = t.empreendimento_id),
    'solicitante', t.solicitante_nome,
    'telefone', imobdesk.cd_tec_telefone(t),
    'criadoEm', t.criado_em, 'slaSolucaoAte', t.sla_solucao_ate, 'slaPausadoDesde', t.sla_pausado_desde, 'encerradoEm', t.encerrado_em,
    'responsavelId', t.responsavel_id,
    'responsavel', (select u.nome from imobdesk.usuarios u where u.id = t.responsavel_id),
    'meu', coalesce(t.responsavel_id = p_usuario, false));
$$;

-- ======================================================================= RPCs do app (modo Técnico)

/** Entrada pela aba Técnico. */
create or replace function imobdesk.cd_tec_entrar()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.cd_tec_quem();
  v_setores bigint[] := imobdesk.cd_tec_setores(v_uid);
begin
  return jsonb_build_object(
    'usuarioId', v_uid,
    'nome', coalesce((select u.nome from imobdesk.usuarios u where u.id = v_uid), imobdesk.cd_email_de(v_uid)),
    'email', imobdesk.cd_email_de(v_uid),
    'setores', (select jsonb_agg(jsonb_build_object('id', s.id, 'nome', s.nome) order by s.nome) from imobdesk.at_setores s where s.id = any (v_setores)));
end;
$$;

/** Chamados dos setores do técnico: todos os abertos e os encerrados nos últimos p_dias (padrão 30). Os filtros são na tela. */
create or replace function imobdesk.cd_tec_chamados(p_dias int default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.cd_tec_quem();
  v_setores bigint[] := imobdesk.cd_tec_setores(v_uid);
begin
  return coalesce((
    select jsonb_agg(imobdesk.cd_tec_resumo(t, v_uid) order by (t.encerrado_em is not null), t.sla_solucao_ate nulls last, t.id desc)
      from (select * from imobdesk.ch_tickets x
             where x.setor_id = any (v_setores) and x.excluido_em is null and x.mesclado_em_id is null
               and (x.encerrado_em is null or x.encerrado_em >= now() - make_interval(days => least(greatest(coalesce(p_dias, 30), 1), 180)))
             order by x.id desc limit 500) t), '[]');
end;
$$;

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

/** Atribuir-me: só sem responsável. Fica com o técnico, na equipe dele do setor, e vai para Em atendimento. */
create or replace function imobdesk.cd_tec_atribuir(p_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.cd_tec_quem();
  t imobdesk.ch_tickets := imobdesk.cd_tec_ticket(p_id, v_uid);
  v_cat text := (select s.categoria from imobdesk.ch_status s where s.id = t.status_id);
  v_equipe bigint;
begin
  perform 1 from imobdesk.ch_tickets x where x.id = p_id for update;
  select * into t from imobdesk.ch_tickets x where x.id = p_id;
  if v_cat in ('resolvido', 'fechado', 'cancelado') or t.mesclado_em_id is not null then
    perform imobdesk.erro('INVALID_INPUT', 'Este chamado já foi encerrado.');
  end if;
  if t.responsavel_id = v_uid then return; end if;
  if t.responsavel_id is not null then
    perform imobdesk.erro('INVALID_INPUT', format('Este chamado já está com %s.', coalesce((select u.nome from imobdesk.usuarios u where u.id = t.responsavel_id), 'outro técnico')));
  end if;
  -- A equipe atual, se o técnico for dela; senão uma equipe dele no setor.
  v_equipe := case when exists (select 1 from imobdesk.at_equipe_membros m where m.equipe_id = t.equipe_id and m.usuario_id = v_uid) then t.equipe_id
                   else (select e.id from imobdesk.at_equipe_membros m join imobdesk.at_equipes e on e.id = m.equipe_id and e.ativa
                          where m.usuario_id = v_uid and e.setor_id = t.setor_id order by e.id limit 1) end;
  update imobdesk.ch_tickets set
    responsavel_id = v_uid, equipe_id = coalesce(v_equipe, equipe_id),
    status_id = case when v_cat in ('novo', 'pendente')
                     then coalesce((select s.id from imobdesk.ch_status s where s.categoria = 'andamento' and s.ativo and lower(s.nome) = 'em atendimento' limit 1),
                                   (select s.id from imobdesk.ch_status s where s.categoria = 'andamento' and s.ativo order by s.ordem limit 1), status_id)
                     else status_id end,
    justificativa_id = case when v_cat in ('novo', 'pendente') then null else justificativa_id end
  where id = p_id;
end;
$$;

/**
 * Concluir atendimento: resposta pública ao solicitante (texto + fotos) e o status pelo tipo de resolução.
 *   resolvido → Resolvido (exige 1 foto, serviço e obrigatórios; o texto vira a Solução aplicada)
 *   voltar → Em atendimento · peca → Aguardando·Fornecedor · orcamento → Aguardando·Cotação
 *   aprovacao → Aguardando·Aprovação do gestor (avisa o líder da equipe) · sem_acesso → Aguardando·Retorno do cliente
 *   nao_procede → Cancelado
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
  if v_cat = 'resolvido' then
    if n.servico_id is null then perform imobdesk.erro('INVALID_INPUT', 'Escolha o serviço antes de concluir como Resolvido.', 'servicoId'); end if;
    v_pend := imobdesk.ch_campos_pendentes(n);
    if cardinality(v_pend) > 0 then
      perform imobdesk.erro('INVALID_INPUT', 'Falta preencher no portal: ' || array_to_string(v_pend, ', ') || '. Peça ao gestor.', 'campos');
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
    status_id = n.status_id, justificativa_id = n.justificativa_id, servico_id = n.servico_id,
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

-- ======================================================================= arquivos

/**
 * Leitura de arquivos do bucket imobdesk-solicitante citados em ações públicas: o solicitante do chamado (fotos do técnico)
 * e os técnicos do setor (fotos do solicitante). Usada pela policy de leitura abaixo.
 */
create or replace function imobdesk.cd_pode_ler_arquivo(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select imobdesk.cd_sessao_ok() and exists (
    select 1
      from imobdesk.ch_ticket_acoes a
      join imobdesk.ch_tickets t on t.id = a.ticket_id and t.excluido_em is null
     where a.tipo = 'publica'
       and a.anexos @> jsonb_build_array(jsonb_build_object('path', p_name))
       and (t.setor_id = any (imobdesk.cd_tec_setores((select auth.uid())))
            or (t.origem = 'intranet' and t.criado_por = (select auth.uid()))
            or t.solicitante_pessoa_id = imobdesk.cd_pessoa_de((select auth.uid()))));
$$;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'imobdesk-solicitante: leitura pelo chamado') then
    create policy "imobdesk-solicitante: leitura pelo chamado" on storage.objects for select to authenticated
      using (bucket_id = 'imobdesk-solicitante' and (select imobdesk.cd_pode_ler_arquivo(name)));
  end if;
end;
$$;

-- ======================================================================= permissões

do $$
declare
  f text;
begin
  foreach f in array array['cd_tec_entrar()', 'cd_tec_chamados(int)', 'cd_tec_chamado(bigint)', 'cd_tec_atribuir(bigint)', 'cd_tec_concluir(bigint, jsonb)', 'cd_pode_ler_arquivo(text)'] loop
    execute format('revoke execute on function imobdesk.%s from public, anon', f);
    execute format('grant execute on function imobdesk.%s to authenticated, service_role', f);
  end loop;
  foreach f in array array['cd_tec_setores(uuid)', 'cd_tec_quem()', 'cd_tec_ticket(bigint, uuid)', 'cd_tec_telefone(imobdesk.ch_tickets)',
                           'cd_tec_resumo(imobdesk.ch_tickets, uuid)'] loop
    execute format('revoke execute on function imobdesk.%s from public, anon, authenticated', f);
    execute format('grant execute on function imobdesk.%s to service_role', f);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
