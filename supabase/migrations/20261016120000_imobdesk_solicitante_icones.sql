-- App do solicitante: ícones coloridos do Iconify nos departamentos (pedido do Wagner, 16/10/2026). O campo cd_icone passa a
-- guardar o nome do ícone ("fluent-color:people-team-24", até 60 letras) além do emoji. Nenhum dado é apagado: só o
-- limite do campo cresce (16 → 60) e os 4 setores que recebem chamado ganham um ícone colorido no lugar do emoji.

alter table imobdesk.at_setores drop constraint if exists at_setores_cd_icone_check;
alter table imobdesk.at_setores add constraint at_setores_cd_icone_check check (length(cd_icone) <= 60);

create or replace function imobdesk.cd_admin_setor_salvar(p_id bigint, p jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform imobdesk.cd_admin_checar();
  if not exists (select 1 from imobdesk.at_setores s where s.id = p_id) then perform imobdesk.erro('NOT_FOUND', 'Setor não encontrado.'); end if;
  update imobdesk.at_setores set
    cd_visivel = coalesce((p ->> 'visivel')::boolean, cd_visivel),
    cd_icone = case when p ? 'icone' then nullif(left(btrim(p ->> 'icone'), 60), '') else cd_icone end,
    cd_descricao = case when p ? 'descricao' then nullif(left(btrim(p ->> 'descricao'), 200), '') else cd_descricao end,
    cd_ordem = coalesce((p ->> 'ordem')::int, cd_ordem),
    atualizado_em = now(), atualizado_por = (select auth.uid())
  where id = p_id;
end;
$$;

update imobdesk.at_setores s set cd_icone = x.icone
from (values ('ti', '💻', 'fluent-color:code-block-24'), ('cftv', '📹', 'flat-color-icons:multiple-cameras'),
             ('administrativo', '🏢', 'flat-color-icons:briefcase'), ('financeiro', null, 'flat-color-icons:money-transfer')) x(nome, antes, icone)
where lower(btrim(s.nome)) = x.nome and s.cd_icone is not distinct from x.antes;

notify pgrst, 'reload schema';
