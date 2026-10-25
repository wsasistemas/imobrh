-- Colunas da Lista de Tickets com campos do ticket (docs/PLANO-visoes-colunas.md, Fase 2; aprovado em 10/10/2026).
-- O ch_painel() não muda: esta função traz só os dados extras das colunas novas, e a Lista só chama quando a visão
-- usa alguma delas. Mesmo filtro de visibilidade do ch_painel (os mesmos tickets, nem um a mais).
-- Campos adicionais: só os ativos com "usar em visões"; os do tipo usuário vêm com o nome da pessoa.
-- Só aditiva: uma função nova.

create or replace function imobdesk.ch_lista_extras()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_agora timestamptz := now();
begin
  if not (imobdesk.ch_eh_admin() or imobdesk.tem_permissao('gestao_chamados_visao_geral') or imobdesk.tem_permissao('gestao_chamados_tickets')) then
    perform imobdesk.erro('FORBIDDEN', 'Sem acesso à Gestão de Chamados.');
  end if;
  return (
    with cmp as (
      select c.chave, c.rotulo, c.tipo, c.interno, c.ordem from imobdesk.ch_campos c where c.ativo and c.usar_em_visoes
    ), vis as (
      select t.* from imobdesk.ch_tickets t
      where t.excluido_em is null and t.mesclado_em_id is null
        and (t.encerrado_em is null or t.encerrado_em >= v_agora - interval '30 days')
        and imobdesk.ch_pode_ver_ticket(t.setor_id, t.equipe_id, t.responsavel_id)
    )
    select jsonb_build_object(
      'campos', coalesce((select jsonb_agg(jsonb_build_object('chave', c.chave, 'rotulo', c.rotulo, 'tipo', c.tipo, 'interno', c.interno) order by c.ordem, c.rotulo) from cmp c), '[]'),
      'tickets', coalesce((select jsonb_object_agg(t.id::text, jsonb_build_object(
          'categoria', (select c.nome from imobdesk.ch_categorias c where c.id = t.categoria_id),
          'setor', (select s.nome from imobdesk.at_setores s where s.id = t.setor_id),
          'contato', t.solicitante_contato,
          'criado_por', case when t.criado_por is null then null else imobdesk.ch_nome_usuario(t.criado_por) end,
          'atualizado_em', t.atualizado_em,
          'primeira_resposta_em', t.primeira_resposta_em,
          'sla_resposta_ate', t.sla_resposta_ate,
          'sla_solucao_ate', t.sla_solucao_ate,
          'encerrado_em', t.encerrado_em,
          'campos', coalesce((select jsonb_object_agg(c.chave,
                                case when c.tipo = 'usuario' and (t.campos ->> c.chave) ~* '^[0-9a-f-]{36}$'
                                     then to_jsonb(imobdesk.ch_nome_usuario((t.campos ->> c.chave)::uuid))
                                     else t.campos -> c.chave end)
                              from cmp c where t.campos ? c.chave and jsonb_typeof(t.campos -> c.chave) <> 'null'), '{}')))
        from vis t), '{}'))
  );
end;
$$;

revoke execute on function imobdesk.ch_lista_extras() from public, anon;
grant execute on function imobdesk.ch_lista_extras() to authenticated, service_role;

notify pgrst, 'reload schema';
