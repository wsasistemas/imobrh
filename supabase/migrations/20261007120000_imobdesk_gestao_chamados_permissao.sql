-- Gestão de Chamados liberada para quem atende (pedido do Wagner, 07/10/2026): admin, ti e operador
-- (operador vai virar "Agente"; só o label muda, a chave fica). Libera o menu e o resumo de chamados
-- na Página Inicial. Migração aditiva: só insere, e não sobrescreve o que já foi ajustado em Perfis e permissões.

insert into imobdesk.profile_permissions (role, permission_id, enabled)
select v.role, 'gestao_chamados', true
from (values ('admin'), ('ti'), ('operador')) as v(role)
where exists (select 1 from imobdesk.perfis p where p.key = v.role)
on conflict (role, permission_id) do nothing;
