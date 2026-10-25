-- CFTV sem o campo "Câmera" (pedido do Wagner, 13/10/2026). O campo era exemplo da carga inicial (20261007170000) e a
-- regra "Câmera no CFTV" o tornava obrigatório para resolver qualquer chamado do CFTV (portal e App do solicitante Técnico).
-- Sem apagar nada: o campo fica inativo (some do portal e do app) e a regra perde só a ação "obrigar Câmera";
-- continua exibindo "Data do ocorrido" no CFTV. Valores já gravados nos tickets ficam como estão.

update imobdesk.ch_campos set ativo = false, atualizado_em = now()
 where chave = 'camera' and ativo;

update imobdesk.ch_regras_exibicao r
   set acoes = coalesce((select jsonb_agg(a) from jsonb_array_elements(r.acoes) a where a ->> 'campo' <> 'camera'), '[]'),
       atualizado_em = now()
 where r.acoes @> '[{"campo": "camera"}]';
