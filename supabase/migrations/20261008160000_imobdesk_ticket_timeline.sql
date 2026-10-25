-- Linha do tempo do ticket no modelo da Movidesk (Wagner, 08/10/2026): cada ação de e-mail traz os cabeçalhos para o
-- "Visualizar e-mail" (de, para, cc, assunto, data e status do envio). Igual à de 20261007171000, só acrescenta chaves
-- em "acoes". Só aditiva.

/** Detalhe completo para a tela do ticket. */
create or replace function imobdesk.ch_ticket_detalhe(p_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  t imobdesk.ch_tickets := imobdesk.ch_ticket_visivel(p_id);
begin
  return jsonb_build_object(
    'id', t.id, 'assunto', t.assunto, 'origem', t.origem, 'recebidoEm', t.recebido_em,
    'solicitante', jsonb_build_object('pessoaId', t.solicitante_pessoa_id, 'nome', t.solicitante_nome, 'contato', t.solicitante_contato,
       'departamento', (select d.nome from imobdesk.at_pessoa_relacoes r join imobdesk.at_pessoas d on d.id = r.empresa_id and d.tipo = 'departamento'
                        where r.pessoa_id = t.solicitante_pessoa_id limit 1)),
    'setorId', t.setor_id, 'equipeId', t.equipe_id, 'responsavelId', t.responsavel_id, 'servicoId', t.servico_id, 'categoriaId', t.categoria_id,
    'urgenciaId', t.urgencia_id, 'statusId', t.status_id, 'justificativaId', t.justificativa_id, 'tags', to_jsonb(t.tags), 'cc', to_jsonb(t.cc), 'campos', t.campos,
    'solucaoAplicada', t.solucao_aplicada, 'criadoEm', t.criado_em, 'assumidoEm', t.assumido_em, 'primeiraRespostaEm', t.primeira_resposta_em,
    'slaRespostaAte', t.sla_resposta_ate, 'slaSolucaoAte', t.sla_solucao_ate, 'slaManual', t.sla_manual, 'slaPausadoDesde', t.sla_pausado_desde,
    'encerradoEm', t.encerrado_em, 'mescladoEmId', t.mesclado_em_id, 'clonadoDeId', t.clonado_de_id, 'excluidoEm', t.excluido_em,
    'clones', coalesce((select jsonb_agg(c.id order by c.id) from imobdesk.ch_tickets c where c.clonado_de_id = t.id), '[]'),
    'mesclados', coalesce((select jsonb_agg(c.id order by c.id) from imobdesk.ch_tickets c where c.mesclado_em_id = t.id), '[]'),
    'campoEstado', coalesce((select jsonb_object_agg(e.chave, jsonb_build_object('visivel', e.visivel, 'obrigatorio', e.obrigatorio)) from imobdesk.ch_campos_estado(t) e), '{}'),
    'seguindo', exists (select 1 from imobdesk.ch_ticket_seguidores s where s.ticket_id = t.id and s.usuario_id = (select auth.uid())),
    'acoes', coalesce((select jsonb_agg(jsonb_build_object('numero', a.numero, 'tipo', a.tipo, 'canal', a.canal, 'direcao', a.direcao, 'autorId', a.autor_id, 'autorNome', a.autor_nome,
                         'texto', a.texto, 'html', a.html, 'anexos', a.anexos, 'envioStatus', a.envio_status, 'criadoEm', a.criado_em,
                         'enviadoEm', a.enviado_em, 'envioErro', a.envio_erro, 'envioTentativas', a.envio_tentativas,
                         -- "Visualizar e-mail" da linha do tempo: cabeçalhos da mensagem trocada.
                         'email', case when a.canal <> 'email' or a.tipo <> 'publica' then null
                           when a.direcao = 'saida' then jsonb_build_object(
                             'de', c.email, 'deNome', case when c.exibir_no_envio then coalesce(nullif(btrim(c.nome_remetente), ''), c.nome) end,
                             'para', jsonb_build_array(t.solicitante_contato), 'cc', to_jsonb(t.cc),
                             'assunto', 'Re: [#' || t.id || '] ' || regexp_replace(t.assunto, '\[#\d+\]\s*', '', 'g'),
                             'data', coalesce(a.enviado_em, a.criado_em))
                           else (select jsonb_build_object('de', r.de, 'deNome', r.de_nome, 'para', to_jsonb(r.para), 'cc', to_jsonb(r.cc),
                                                           'assunto', r.assunto, 'data', r.recebido_em)
                                 from imobdesk.at_email_recebidos r where r.message_id = a.email_message_id order by r.id desc limit 1) end
                         ) order by a.numero desc)
                       from imobdesk.ch_ticket_acoes a left join imobdesk.at_email_contas c on c.id = t.email_conta_id where a.ticket_id = t.id), '[]'),
    'eventos', coalesce((select jsonb_agg(jsonb_build_object('tipo', e.tipo, 'descricao', e.descricao, 'autorNome', e.autor_nome, 'criadoEm', e.criado_em) order by e.criado_em desc, e.id desc)
                         from imobdesk.ch_ticket_eventos e where e.ticket_id = t.id), '[]'),
    'podeAlterarPrazo', imobdesk.ch_eh_admin() or imobdesk.at_gestor_de(t.setor_id),
    'podeExcluir', imobdesk.eh_super_admin()
  );
end;
$$;
