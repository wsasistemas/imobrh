-- ImobRH · 0002 · Base da tabela de casos sensíveis (só a estrutura e a RLS; o canal confidencial é da Fase 1).
--
-- Fica fora das tabelas comuns de pedido e caso de propósito: nenhuma visão, relatório ou busca geral a alcança.
-- Leitura só para o papel compliance. Relato anônimo não grava user_id, IP nem dados do aparelho (PRD v2, Segurança).
-- Aditiva.

create table if not exists app_imobrh.caso_sensivel (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default app_imobrh.empresa_atual() references imobdesk.empresas (id),
  -- Código de acompanhamento entregue ao denunciante (o único jeito de voltar ao relato no modo anônimo).
  codigo text not null check (codigo ~ '^[A-Z0-9]{8,16}$'),
  categoria text not null check (categoria in ('assedio_moral', 'assedio_sexual', 'discriminacao', 'conflito_lideranca',
    'fraude_desvio', 'outros')),
  relato text not null,
  anonimo boolean not null default true,
  -- Só quando a pessoa escolhe se identificar.
  user_id uuid references auth.users (id) on delete set null,
  estado text not null default 'recebido' check (estado in ('recebido', 'triagem', 'apuracao', 'parecer', 'concluido')),
  created_at timestamptz not null default now(),
  unique (tenant_id, codigo),
  check (not anonimo or user_id is null)
);
comment on table app_imobrh.caso_sensivel is 'Casos sensíveis (compliance). RLS: só o papel compliance lê.';

select app_imobrh.aplicar_multiempresa();

grant select on app_imobrh.caso_sensivel to authenticated;

drop policy if exists caso_sensivel_compliance on app_imobrh.caso_sensivel;
create policy caso_sensivel_compliance on app_imobrh.caso_sensivel for select to authenticated
  using ((select app_imobrh.tem_papel(array['compliance'])));
