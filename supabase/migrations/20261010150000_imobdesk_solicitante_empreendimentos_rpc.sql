-- App do solicitante: os empreendimentos não apareciam no celular na versão publicada (10/10/2026).
-- O cache estava cheio (32, lidos às 14:54) e a Edge respondia, mas a tela dependia de uma chamada à Edge com a
-- checagem de sessão própria dela: qualquer falha nesse caminho (ex.: sessão antiga encerrada pela troca de senha,
-- com o app já aberto) virava o card "Tudo funcionando por aqui". Agora o app lê o cache por esta RPC, com a mesma
-- checagem do resto do app (cd_quem); a Edge só atualiza o cache quando ele estiver vazio ou velho.
-- Só aditiva: uma função nova.

create or replace function imobdesk.cd_empreendimentos()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform imobdesk.cd_quem(null);
  return (select jsonb_build_object('itens', c.itens, 'atualizadoEm', c.atualizado_em)
          from imobdesk.cd_empreendimentos_cache c where c.id);
end;
$$;

revoke execute on function imobdesk.cd_empreendimentos() from public, anon;
grant execute on function imobdesk.cd_empreendimentos() to authenticated, service_role;

notify pgrst, 'reload schema';
