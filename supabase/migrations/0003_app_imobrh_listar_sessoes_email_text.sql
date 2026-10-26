-- ImobRH · 0003 · Corrige app_imobrh.listar_sessoes (tela Sessões ativas: "Algo deu errado").
--
-- Causa: no Supabase, auth.users.email é varchar(255) e a função declara a coluna email como text. Em RETURN QUERY
-- o PL/pgSQL exige o tipo exato (42804 "structure of query does not match function result type"). O ensaio local
-- não pegou porque o stub declarava email como text (corrigido em tests/db/pgHarness.ts).
-- Aditiva: só recria a função com os casts. Rodar no SQL Editor do ikvj.

create or replace function app_imobrh.listar_sessoes()
returns table (id uuid, user_id uuid, nome text, email text, user_agent text, ip text, iniciada_em timestamptz,
               ultima_atividade timestamptz, atual boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_empresa uuid := app_imobrh.empresa_atual();
  v_sessao text := auth.jwt() ->> 'session_id';
begin
  perform app_imobrh.exigir('manage_sessions');
  return query
    select s.id, s.user_id, coalesce(u.nome, a.email)::text, a.email::text, s.user_agent::text, host(s.ip)::text,
           s.created_at::timestamptz, coalesce(s.refreshed_at::timestamptz, s.updated_at::timestamptz, s.created_at::timestamptz),
           s.id::text = v_sessao
      from auth.sessions s
      join auth.users a on a.id = s.user_id
      left join imobdesk.usuarios u on u.id = s.user_id and u.tenant_id = v_empresa
     where (s.not_after is null or s.not_after > now())
       and exists (select 1 from app_imobrh.papel_usuario p
                    where p.tenant_id = v_empresa and p.user_id = s.user_id and p.papel = any (app_imobrh.papeis_console()))
     order by 8 desc;
end;
$$;

select app_imobrh.aplicar_multiempresa();

grant execute on function app_imobrh.listar_sessoes() to authenticated;
