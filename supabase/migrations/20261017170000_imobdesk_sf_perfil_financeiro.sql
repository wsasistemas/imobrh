-- Solicitações Financeiras: o perfil "Financeiro" abre a tela Conferência financeira (pedido do Wagner, 17/10/2026,
-- junto com o resumo financeiro da Página Inicial). Só a permissão de tela: a regra de dados continua igual
-- (sf_exigir_financeiro: só quem é do setor marcado como financeiro, ou admin, confere). Aditiva.
insert into imobdesk.profile_permissions (role, permission_id, enabled)
select 'financeiro', 'sf_conferencia', true
where exists (select 1 from imobdesk.perfis p where p.key = 'financeiro')
on conflict (role, permission_id) do nothing;
