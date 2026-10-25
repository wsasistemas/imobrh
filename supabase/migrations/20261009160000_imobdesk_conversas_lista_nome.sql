-- Correção (09/10/2026): Conversas mostrava "Não foi possível carregar as conversas". A at_conversas_lista (security
-- invoker: a RLS de at_conversas decide o que entra) passou a ler o nome em at_pessoas, que não tem SELECT para
-- authenticated (pessoas só por RPC) → "permission denied for table at_pessoas" e a lista inteira falhava.
-- Agora o nome vem de at_nome_pessoa (security definer, devolve só o nome). O ticket do atendimento também vinha vazio
-- (a RLS de at_atendimentos esconde a linha do atendente): vem de at_ticket_do_atendimento. Mesma assinatura. Só aditiva.

create or replace function imobdesk.at_nome_pessoa(p_id bigint)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p.nome from imobdesk.at_pessoas p where p.id = p_id;
$$;
revoke execute on function imobdesk.at_nome_pessoa(bigint) from public, anon;
grant execute on function imobdesk.at_nome_pessoa(bigint) to authenticated, service_role;

create or replace function imobdesk.at_ticket_do_atendimento(p_atendimento bigint)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select a.ticket_id from imobdesk.at_atendimentos a where a.id = p_atendimento;
$$;
revoke execute on function imobdesk.at_ticket_do_atendimento(bigint) from public, anon;
grant execute on function imobdesk.at_ticket_do_atendimento(bigint) to authenticated, service_role;

create or replace function imobdesk.at_conversas_lista(p_limite int default 300)
returns table (
  id bigint, setor_id bigint, numero text, telefone text, nome_contato text, modo text,
  atendente_id uuid, atendente_nome text, atendente_desde timestamptz, fila_desde timestamptz,
  ticket bigint, ultima_msg_cliente_em timestamptz, ultima_msg_atendente_em timestamptz, ultima_msg_em timestamptz,
  ultima_previa text, nao_lidas int, nota_interna text, cliente_desde timestamptz, total_atendimentos bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  select c.id, c.setor_id, n.numero, c.telefone,
         coalesce(imobdesk.at_nome_pessoa(c.pessoa_id), c.nome_contato), c.modo,
         c.atendente_id, coalesce(ua.nome, uu.nome), c.atendente_desde, c.fila_desde,
         imobdesk.at_ticket_do_atendimento(c.atendimento_id),
         c.ultima_msg_cliente_em, c.ultima_msg_atendente_em, c.ultima_msg_em,
         c.ultima_previa, c.nao_lidas, c.nota_interna, c.criado_em,
         (select count(*) from imobdesk.at_atendimentos t where t.conversa_id = c.id)
  from imobdesk.at_conversas c
  join imobdesk.at_numeros n on n.id = c.numero_id
  left join imobdesk.usuarios ua on ua.id = c.atendente_id
  left join imobdesk.usuarios uu on uu.id = c.ultimo_atendente_id
  order by c.ultima_msg_em desc nulls last
  limit least(greatest(coalesce(p_limite, 300), 1), 1000);
$$;

notify pgrst, 'reload schema';
