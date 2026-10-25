-- Árvore de serviços do setor Administrativo (pedido do Wagner, 10/10/2026), dentro da raiz "Administrativo".
-- A descrição de cada serviço orienta o solicitante no App do solicitante e vai para a IA de triagem.
-- Categoria padrão "Solicitação", urgência "Normal"; equipe herdada da raiz (Administração). Todos os canais.
-- Aditiva: só inclui o que ainda não existe (mesmo setor, pai e nome); não mexe no exemplo "Solicitação administrativa".
do $$
declare
  v_setor bigint := (select id from imobdesk.at_setores where lower(nome) in ('administrativo', 'administração', 'administracao') order by id limit 1);
  v_raiz bigint;
  v_cat bigint := (select id from imobdesk.ch_categorias where lower(nome) in ('solicitação', 'solicitacao') limit 1);
  v_urg bigint := (select id from imobdesk.ch_urgencias where lower(nome) = 'normal' limit 1);
  r record;
begin
  if v_setor is null then
    raise notice 'Setor Administrativo não encontrado: nada a fazer.';
    return;
  end if;
  select id into v_raiz from imobdesk.ch_servicos
  where setor_id = v_setor and pai_id is null and lower(btrim(nome)) in ('administrativo', 'administração', 'administracao') order by id limit 1;
  if v_raiz is null then
    insert into imobdesk.ch_servicos (setor_id, nivel, nome, canais, ordem)
    values (v_setor, 1, 'Administrativo', '{agente,intranet,email,whatsapp}', 1)
    returning id into v_raiz;
  end if;

  for r in select * from (values
    (1, 'Solicitação de Material Corporativo',
     'Utilize esta categoria para solicitar materiais de uso corporativo necessários para o desempenho das atividades. Informe o material desejado e a quantidade necessária para facilitar o atendimento.'),
    (2, 'Solicitação de Adesão ao Estacionamento',
     'Utilize esta categoria para solicitar adesão, alteração ou cancelamento de acesso ao estacionamento corporativo. Informe os dados do veículo (modelo, placa e cor), bem como seus dados pessoais (nome, CPF e contato corporativo). A liberação estará sujeita às normas internas da empresa responsável pela gestão do estacionamento.'),
    (3, 'Solicitação ao Portador',
     E'Utilize esta categoria para solicitar serviços do portador, como transporte de malotes entre obras, envio e coleta de documentos, entrega ou retirada de materiais junto a clientes e fornecedores. Informe o local de origem e destino, o responsável e contato para recebimento, a descrição do material e a data necessária para a realização do serviço.\nImportante: As solicitações devem ser registradas impreterivelmente até às 17h do dia útil anterior à rota programada, para que possam ser incluídas no planejamento do portador.'),
    (4, 'Agendamento de salas de reunião e autorização de Acesso a Visitantes',
     'Utilize esta categoria para solicitar o agendamento de salas de reunião, assim como o cadastro e a autorização de acesso de visitantes às dependências da empresa. Informe o nome completo do visitante, CPF (quando aplicável), empresa de origem, data e horário da visita, colaborador responsável pelo atendimento e demais informações necessárias para o controle de acesso.')
  ) as x(ordem, nome, descricao)
  loop
    continue when exists (select 1 from imobdesk.ch_servicos s
                          where s.setor_id = v_setor and s.pai_id = v_raiz and lower(btrim(s.nome)) = lower(r.nome));
    insert into imobdesk.ch_servicos (pai_id, setor_id, nivel, nome, descricao, urgencia_padrao_id, categoria_padrao_id, canais, ativo, ordem)
    values (v_raiz, v_setor, 2, r.nome, r.descricao, v_urg, v_cat, '{agente,intranet,email,whatsapp}', true, r.ordem);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
