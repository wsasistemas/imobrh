-- App do solicitante: empreendimentos do site da empresa no carrossel e na tela Avisos quando não há aviso
-- (pedido do Wagner, 10/10/2026). O site (WordPress) não expõe os empreendimentos na API; a Edge
-- Uma Edge Function pode ler o site da empresa e guardar aqui por algumas horas (o app não
-- depende do site estar no ar a cada abertura). Só aditiva: uma tabela de cache e duas funções (service_role).

create table if not exists imobdesk.cd_empreendimentos_cache (
  id            boolean     primary key default true check (id),
  itens         jsonb       not null default '[]',
  atualizado_em timestamptz,
  erro          text        check (length(erro) <= 300)
);
insert into imobdesk.cd_empreendimentos_cache (id) values (true) on conflict (id) do nothing;
alter table imobdesk.cd_empreendimentos_cache enable row level security;
revoke all on imobdesk.cd_empreendimentos_cache from anon, authenticated;

create or replace function imobdesk.cd_empreendimentos_ler()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('itens', c.itens, 'atualizadoEm', c.atualizado_em, 'erro', c.erro)
  from imobdesk.cd_empreendimentos_cache c where c.id;
$$;

/** Grava a leitura do site. Lista vazia (site fora ou mudou o layout) não apaga a última boa: só registra o erro. */
create or replace function imobdesk.cd_empreendimentos_gravar(p_itens jsonb, p_erro text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if jsonb_typeof(p_itens) = 'array' and jsonb_array_length(p_itens) > 0 then
    update imobdesk.cd_empreendimentos_cache set itens = p_itens, atualizado_em = now(), erro = null where id;
  else
    update imobdesk.cd_empreendimentos_cache set erro = left(coalesce(p_erro, 'Nenhum empreendimento lido.'), 300) where id;
  end if;
end;
$$;

revoke execute on function imobdesk.cd_empreendimentos_ler() from public, anon, authenticated;
revoke execute on function imobdesk.cd_empreendimentos_gravar(jsonb, text) from public, anon, authenticated;
grant execute on function imobdesk.cd_empreendimentos_ler() to service_role;
grant execute on function imobdesk.cd_empreendimentos_gravar(jsonb, text) to service_role;

notify pgrst, 'reload schema';
