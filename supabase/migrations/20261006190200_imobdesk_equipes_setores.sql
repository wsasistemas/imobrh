-- Equipes: lista de setores para o seletor da equipe. Quem gerencia usuários pode não ter setor no atendimento
-- (at_contexto só devolve os setores do usuário). Só aditiva.

create or replace function imobdesk.at_equipes_setores()
returns table (id bigint, nome text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform imobdesk.at_exigir_equipes();
  return query select s.id, s.nome from imobdesk.at_setores s where s.ativo order by s.nome;
end;
$$;

revoke execute on function imobdesk.at_equipes_setores() from public, anon;
grant execute on function imobdesk.at_equipes_setores() to authenticated, service_role;

notify pgrst, 'reload schema';
