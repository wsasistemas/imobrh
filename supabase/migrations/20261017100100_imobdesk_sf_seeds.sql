-- Solicitações Financeiras, Fase 1: cargas iniciais (CONTEXTO.md, seções 5 e 9).
-- Regras R01–R10 e A01–A07 com os parâmetros que o PRD fixa; o que está em aberto ([PRAZO] da R09, itens proibidos da R07)
-- fica nulo/vazio até o admin preencher em Cadastros financeiros. Só insere o que não existe.

insert into imobdesk.sf_regra (codigo, nome, descricao, aplica_a, severidade, parametros) values
  ('R01', 'Comprovante anexado', 'Toda linha tem ao menos um comprovante.', 'reembolso_fundo_fixo', 'bloqueio', '{}'),
  ('R02', 'Legível', 'Legibilidade de data, valor e favorecido a partir do limiar; abaixo dele o campo não é copiado.', 'reembolso_fundo_fixo', 'alerta', '{"limiar": 0.80}'),
  ('R03', 'Data no período', 'Data do comprovante entre o início e o fim do período da competência.', 'reembolso_fundo_fixo', 'alerta', '{}'),
  ('R04', 'Valor confere', 'Valor do comprovante igual ao declarado, dentro da tolerância.', 'reembolso_fundo_fixo', 'alerta', '{"tolerancia": 0}'),
  ('R05', 'Documento fiscal', 'NF-e, NFC-e, cupom ou recibo com CNPJ/CPF do emissor.', 'reembolso_fundo_fixo', 'alerta', '{}'),
  ('R06', 'Sem duplicidade', 'Arquivo (SHA-256) e combinação CNPJ + data + valor não usados em outra solicitação.', 'reembolso_fundo_fixo', 'bloqueio', '{}'),
  ('R07', 'Categoria permitida', 'Itens lidos não batem com a lista de itens proibidos.', 'reembolso_fundo_fixo', 'alerta', '{"itens_proibidos": []}'),
  ('R08', 'Limite por categoria', 'Valor do item até o teto da categoria de motivo, quando houver teto.', 'reembolso_fundo_fixo', 'alerta', '{}'),
  ('R09', 'Prazo de envio', 'Solicitação enviada até N dias após o fim da competência.', 'reembolso_fundo_fixo', 'alerta', '{"dias": null}'),
  ('R10', 'Saldo do fundo fixo', 'Despesas totais até o saldo inicial do fundo fixo.', 'reembolso_fundo_fixo', 'bloqueio', '{}'),
  ('A01', 'Documento de origem', 'Pedido de compras, proposta ou e-mail anexado.', 'adiantamento', 'bloqueio', '{}'),
  ('A02', 'Valor × pedido', 'Valor adiantado até o valor do pedido × percentual da condição.', 'adiantamento', 'alerta', '{}'),
  ('A03', 'Favorecido × pedido', 'CNPJ do favorecido igual ao do fornecedor do pedido.', 'adiantamento', 'alerta', '{}'),
  ('A04', 'Titularidade bancária', 'Conta informada pertence ao CPF/CNPJ do favorecido (conferência do Financeiro).', 'adiantamento', 'alerta', '{}'),
  ('A05', 'Rateio', 'Soma das porcentagens por tarefa igual a 100%.', 'adiantamento', 'bloqueio', '{}'),
  ('A06', 'Adiantamento em aberto', 'Pedido sem outro adiantamento não comprovado; solicitante abaixo do limite e sem comprovação vencida.', 'adiantamento', 'bloqueio', '{}'),
  ('A07', 'Comprovação', 'Emitente = favorecido, emissão após o pagamento e no prazo, valor ≥ adiantado, nota não usada antes.', 'adiantamento', 'alerta', '{}')
on conflict (codigo) do nothing;

insert into imobdesk.sf_categoria_motivo (nome, palavras_chave, ordem)
select x.nome, x.chaves, x.ordem
from (values
  ('Material de obra', array['cimento', 'areia', 'tijolo', 'argamassa', 'tinta'], 1),
  ('Ferramentas', array['disco', 'broca', 'martelo', 'chave', 'serra'], 2),
  ('EPI', array['luva', 'óculos', 'capacete', 'bota', 'protetor'], 3),
  ('Combustível', array['gasolina', 'etanol', 'diesel', 'posto'], 4),
  ('Transporte', array['uber', '99', 'táxi', 'pedágio', 'ônibus'], 5),
  ('Estacionamento', array['estacionamento', 'park', 'garagem'], 6),
  ('Alimentação', array['refeição', 'almoço', 'restaurante', 'lanche'], 7),
  ('Copa/mantimentos', array['café', 'açúcar', 'água', 'biscoito'], 8),
  ('Material de escritório', array['papel', 'caneta', 'toner', 'grampo'], 9),
  ('Outros', array[]::text[], 10)
) as x(nome, chaves, ordem)
where not exists (select 1 from imobdesk.sf_categoria_motivo c where lower(btrim(c.nome)) = lower(x.nome));

-- O setor Financeiro confere as solicitações; setores cujo nome começa com "Obra" são de obra.
-- Só na primeira vez: depois, quem manda é a aba Aprovação financeira do setor.
do $$
begin
  if not exists (select 1 from imobdesk.at_setores where sf_financeiro) then
    update imobdesk.at_setores set sf_financeiro = true where lower(btrim(nome)) = 'financeiro';
  end if;
  if not exists (select 1 from imobdesk.at_setores where sf_setor_obra) then
    update imobdesk.at_setores set sf_setor_obra = true where lower(btrim(nome)) like 'obra%';
  end if;
end;
$$;
