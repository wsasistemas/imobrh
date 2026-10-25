-- Tela do ticket (docs/PLANO-tela-ticket.md, aprovado em 07/10/2026). Só aditiva: duas leituras que a tela usa.
--   ch_ticket_solucoes(p_id): a última solução dada a uma demanda parecida (mesmo serviço; sem serviço, mesma
--     equipe e setor), para o agente usar ou não (T4). Sem IA: a IA melhora a escolha depois (plano de IA).
--   ch_responsaveis(): quem pode ser responsável (membros de equipes ativas), para o seletor "Equipe › Pessoa".

create or replace function imobdesk.ch_ticket_solucoes(p_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  t imobdesk.ch_tickets := imobdesk.ch_ticket_visivel(p_id);
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', q.id, 'assunto', q.assunto, 'solucao', q.solucao_aplicada, 'encerradoEm', q.encerrado_em,
                                        'responsavel', q.responsavel, 'servico', q.servico) order by q.encerrado_em desc)
    from (
      select x.id, x.assunto, x.solucao_aplicada, x.encerrado_em,
             imobdesk.ch_nome_usuario(x.responsavel_id) as responsavel,
             (select s.nome from imobdesk.ch_servicos s where s.id = x.servico_id) as servico
      from imobdesk.ch_tickets x
      join imobdesk.ch_status st on st.id = x.status_id
      where x.id <> t.id and x.excluido_em is null and x.mesclado_em_id is null
        and x.solucao_aplicada is not null and st.categoria in ('resolvido', 'fechado')
        and ((t.servico_id is not null and x.servico_id = t.servico_id)
             or (t.servico_id is null and x.setor_id = t.setor_id and x.equipe_id is not distinct from t.equipe_id))
      order by x.encerrado_em desc
      limit 3
    ) q
  ), '[]'::jsonb);
end;
$$;

create or replace function imobdesk.ch_responsaveis()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not imobdesk.ch_pode_ler() then
    perform imobdesk.erro('FORBIDDEN', 'Sem acesso à Gestão de Chamados.');
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', u.id, 'nome', u.nome, 'equipes', q.equipes) order by u.nome)
    from (
      select m.usuario_id, jsonb_agg(m.equipe_id order by m.equipe_id) as equipes
      from imobdesk.at_equipe_membros m
      join imobdesk.at_equipes e on e.id = m.equipe_id and e.ativa
      group by m.usuario_id
    ) q
    join imobdesk.usuarios u on u.id = q.usuario_id and u.status = 'active'
  ), '[]'::jsonb);
end;
$$;

revoke execute on function imobdesk.ch_ticket_solucoes(bigint), imobdesk.ch_responsaveis() from public, anon;
grant execute on function imobdesk.ch_ticket_solucoes(bigint), imobdesk.ch_responsaveis() to authenticated, service_role;

notify pgrst, 'reload schema';
