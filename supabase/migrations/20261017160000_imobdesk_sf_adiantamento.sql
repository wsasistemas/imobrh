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
