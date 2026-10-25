
-- Fase 5B (ajuste): parâmetros de teste por consulta.
--
-- Várias consultas do RM exigem parâmetros; sem eles o RM responde FE011 ("Quantidade de parâmetros
-- passados para o SQL não corresponde ao esperado"). O teste da aba Consultas SQL passa a abrir já
-- preenchido com estes valores (editáveis no cadastro e no próprio teste).
-- Valores conferidos no RM em 2026-09-27 (todos responderam HTTP 200 com dados).
-- Aditivo: coluna nova, função nova (a versão de 6 argumentos continua existindo e delega para ela).

alter table imobdesk.api_queries add column if not exists parametros_teste text;

comment on column imobdesk.api_queries.parametros_teste is
  'Parâmetros usados no teste da tela, no formato NOME=valor;NOME2=valor (ex.: CODEMPREENDIMENTO=229).';

update imobdesk.api_queries set parametros_teste = v.params
from (values
  ('API.00.02.003', 'PROPOSTA_ID=10707'),
  ('API.00.07.002', 'CODEMPREENDIMENTO=229'),
  ('API.00.07.003', 'CODEMPREENDIMENTO=229'),
  ('API.00.07.004', 'CODEMPREENDIMENTO=229'),
  ('API.00.07.006', 'CODCOLIGADA=126;CODEMPREENDIMENTO=221')
) as v(code, params)
where upper(imobdesk.api_queries.code) = v.code and imobdesk.api_queries.parametros_teste is null;

-- ---------- Leitura: inclui os parâmetros de teste ----------

create or replace function imobdesk.listar_consultas_sql()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform imobdesk.exigir_super_admin((select auth.uid()));
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', q.id,
      'code', q.code,
      'name', q.name,
      'description', q.description,
      'type', q.query_type,
      'active', q.is_active,
      'order', q.display_order,
      'testParams', q.parametros_teste,
      'usedBy', imobdesk.uso_consulta_sql(q.code),
      'lastTest', q.ultimo_teste
    ) order by q.display_order, q.created_at)
    from imobdesk.api_queries q
    where q.integration_id = imobdesk.id_integracao_totvs()
  ), '[]'::jsonb);
end;
$$;

-- ---------- Salvar com parâmetros de teste ----------

create or replace function imobdesk.salvar_consulta_sql(
  p_id uuid, p_codigo text, p_nome text, p_descricao text, p_tipo text, p_ativa boolean, p_parametros_teste text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := (select auth.uid());
  v_params text := nullif(regexp_replace(trim(coalesce(p_parametros_teste, '')), ';+$', ''), '');
  v_anterior text;
  v_id uuid;
begin
  perform imobdesk.exigir_super_admin(v_ator);
  if v_params is not null
     and v_params !~ '^[A-Za-z0-9_]{1,40}=[^;]{0,120}(\s*;\s*[A-Za-z0-9_]{1,40}=[^;]{0,120}){0,9}$' then
    perform imobdesk.erro('INVALID_INPUT', 'Use NOME=valor, separados por ponto e vírgula.', 'testParams');
  end if;
  if p_id is not null then
    select q.parametros_teste into v_anterior from imobdesk.api_queries q where q.id = p_id;
  end if;

  -- Regras, auditoria e gravação dos demais campos ficam na versão principal.
  v_id := imobdesk.salvar_consulta_sql(p_id, p_codigo, p_nome, p_descricao, p_tipo, p_ativa);

  if v_params is distinct from v_anterior then
    update imobdesk.api_queries set parametros_teste = v_params, atualizado_por = v_ator where id = v_id;
    if p_id is not null then
      perform imobdesk.registrar_auditoria(v_ator, 'integracoes', 'update',
        format('Parâmetros de teste da consulta SQL %s alterados', (select q.code from imobdesk.api_queries q where q.id = v_id)),
        jsonb_build_object('testParams', v_anterior), jsonb_build_object('testParams', v_params), 'consultas_sql');
    end if;
  end if;
  return v_id;
end;
$$;

revoke all on function imobdesk.salvar_consulta_sql(uuid, text, text, text, text, boolean, text) from public, anon, authenticated;
grant execute on function imobdesk.salvar_consulta_sql(uuid, text, text, text, text, boolean, text) to authenticated;

notify pgrst, 'reload schema';
