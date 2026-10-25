-- Conversas e Monitor dentro da Gestão de Chamados, tela WhatsApp OpenWA e a métrica "Quem mais abre chamados"
-- (docs/PLANO-conversas-whatsapp-openwa.md, Fases 4 e 5; aprovado em 09/10/2026). Só aditiva: só insere
-- permissões novas (copiadas de quem já tinha a equivalente) e cria uma função.

-- "Monitor de atendimento" (seção nova da Gestão de Chamados): quem já via o Monitor (gestor do setor ou supervisão).
insert into imobdesk.profile_permissions (role, permission_id, enabled)
select distinct pp.role, 'gestao_chamados_monitor', true
from imobdesk.profile_permissions pp
where pp.permission_id in ('gestao_atendimento_monitor', 'gestao_atendimento_supervisao') and pp.enabled
on conflict (role, permission_id) do nothing;

-- "WhatsApp OpenWA" (Administração): quem já configura Setores e números.
insert into imobdesk.profile_permissions (role, permission_id, enabled)
select distinct pp.role, 'gestao_atendimento_openwa', true
from imobdesk.profile_permissions pp
where pp.permission_id = 'gestao_atendimento_setores' and pp.enabled
on conflict (role, permission_id) do nothing;

/**
 * Quem mais abre chamados (Visão geral). Só os tickets que a pessoa pode ver, criados nos últimos p_dias.
 * {periodoDias, total, whatsapp, resolvidosNaConversa (%), identificados (%), top: [...], departamentos: [...]}
 */
create or replace function imobdesk.ch_top_solicitantes(p_dias int default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dias int := least(greatest(coalesce(p_dias, 30), 1), 365);
begin
  if not (imobdesk.ch_eh_admin() or imobdesk.tem_permissao('gestao_chamados_visao_geral') or imobdesk.tem_permissao('gestao_chamados_tickets')) then
    perform imobdesk.erro('FORBIDDEN', 'Sem acesso à Gestão de Chamados.');
  end if;
  return (
    with vis as (
      select t.* from imobdesk.ch_tickets t
      where t.excluido_em is null and t.mesclado_em_id is null and t.criado_em >= now() - make_interval(days => v_dias)
        and imobdesk.ch_pode_ver_ticket(t.setor_id, t.equipe_id, t.responsavel_id)
    ), wa as (
      -- Atendimentos de WhatsApp encerrados pelo atendente: resolvido na conversa = ticket resolvido/fechado.
      select a.ticket_id, (st.categoria in ('resolvido', 'fechado')) as resolvido
      from imobdesk.at_atendimentos a
      join vis t on t.id = a.ticket_id
      join imobdesk.ch_status st on st.id = t.status_id
      where a.encerramento = 'atendente'
    ), top as (
      select t.solicitante_pessoa_id as pessoa_id, max(t.solicitante_nome) as nome, count(*) as tickets,
             (select sv.nome from vis t2 join imobdesk.ch_servicos sv on sv.id = t2.servico_id
              where t2.solicitante_pessoa_id = t.solicitante_pessoa_id group by sv.nome order by count(*) desc, sv.nome limit 1) as servico
      from vis t where t.solicitante_pessoa_id is not null
      group by t.solicitante_pessoa_id
      order by count(*) desc, max(t.solicitante_nome)
      limit 10
    ), dep as (
      select e.nome, count(distinct t.id) as tickets
      from vis t
      join imobdesk.at_pessoa_relacoes r on r.pessoa_id = t.solicitante_pessoa_id
      join imobdesk.at_pessoas e on e.id = r.empresa_id and e.tipo = 'departamento'
      group by e.nome order by count(distinct t.id) desc, e.nome limit 10
    )
    select jsonb_build_object(
      'periodoDias', v_dias,
      'total', (select count(*) from vis),
      'whatsapp', (select count(*) from vis where origem = 'whatsapp'),
      'resolvidosNaConversa', (select case when count(*) = 0 then null else round(100.0 * count(*) filter (where resolvido) / count(*)) end from wa),
      'identificados', (select case when count(*) = 0 then null else round(100.0 * count(*) filter (where solicitante_pessoa_id is not null) / count(*)) end from vis),
      'top', coalesce((select jsonb_agg(jsonb_build_object('pessoaId', pessoa_id, 'nome', nome, 'tickets', tickets, 'servico', servico) order by tickets desc, nome) from top), '[]'),
      'departamentos', coalesce((select jsonb_agg(jsonb_build_object('nome', nome, 'tickets', tickets) order by tickets desc, nome) from dep), '[]')
    )
  );
end;
$$;
revoke execute on function imobdesk.ch_top_solicitantes(int) from public, anon;
grant execute on function imobdesk.ch_top_solicitantes(int) to authenticated, service_role;

notify pgrst, 'reload schema';
