-- Solicitações Financeiras, Fase 4: leitura dos comprovantes (CONTEXTO.md, seção 5; telas 11 e 12).
-- A Edge Function imobdesk-sf-ocr transcreve o comprovante (API da Anthropic, chave no secret ANTHROPIC_API_KEY)
-- e grava aqui. Princípio: a IA NÃO sugere data, valor nem favorecido; campo com legibilidade abaixo do limiar da R02
-- volta nulo e o anexo fica "ilegivel". A única sugestão é o motivo, entre as categorias ativas.
-- Fluxo "adicionar por comprovante": o anexo entra sem linha (item_id nulo), é lido e, ao confirmar, vira linha com
-- origem ocr_confirmado (ou ocr_editado, se a pessoa mudou data, valor ou favorecido).
-- Checagens que dependem da leitura: R02, R04, R05, R06 (CNPJ + data + valor) e R07. sf_checagens redefinida com acréscimos.

-- ---------- Para a Edge Function ----------

/** Quem pede a leitura: o dono da solicitação editável. Devolve o que a função precisa. */
create or replace function imobdesk.sf_ocr_pedido(p_anexo bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a imobdesk.sf_anexo;
  s imobdesk.sf_solicitacao;
begin
  select * into a from imobdesk.sf_anexo where id = p_anexo;
  if not found then perform imobdesk.erro('NOT_FOUND', 'Anexo não encontrado.'); end if;
  s := imobdesk.sf_exigir_editavel(a.solicitacao_id);
  update imobdesk.sf_anexo set ocr_status = 'lendo' where id = p_anexo;
  return jsonb_build_object(
    'anexoId', a.id, 'path', a.storage_path, 'mime', a.mime, 'tamanho', a.tamanho,
    'modo', case a.finalidade when 'documento_origem' then 'pedido_compra' when 'comprovacao' then 'comprovacao' else 'comprovante' end,
    'periodoDe', s.periodo_de, 'periodoAte', s.periodo_ate,
    'limiar', coalesce((select (r.parametros ->> 'limiar')::numeric from imobdesk.sf_regra r where r.codigo = 'R02'), 0.80),
    'categorias', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'nome', c.nome, 'descricao', c.descricao, 'palavrasChave', c.palavras_chave)
                                             order by c.ordem, c.nome)
                            from imobdesk.sf_categoria_motivo c where c.ativo), '[]')
  );
end;
$$;

/** Resultado da leitura (só service_role). Status: lido, ilegivel (campo-chave abaixo do limiar) ou erro. */
create or replace function imobdesk.sf_ocr_registrar(p_anexo bigint, p_status text, p_json jsonb, p_erro text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_status not in ('lido', 'ilegivel', 'erro') then
    perform imobdesk.erro('INVALID_INPUT', 'Status de leitura inválido.');
  end if;
  update imobdesk.sf_anexo
     set ocr_status = p_status,
         ocr_json = case when p_status = 'erro' then jsonb_build_object('erro', left(coalesce(p_erro, 'Falha na leitura'), 500)) else p_json end,
         ocr_confianca = case when p_status = 'erro' then null
                              else least((p_json -> 'legibilidade' ->> 'data')::numeric, (p_json -> 'legibilidade' ->> 'valor')::numeric,
                                         (p_json -> 'legibilidade' ->> 'favorecido')::numeric) end,
         chave_acesso = case when coalesce(p_json ->> 'chave_acesso', '') ~ '^\d{44}$' then p_json ->> 'chave_acesso' end
   where id = p_anexo;
  perform imobdesk.sf_registrar_evento((select a.solicitacao_id from imobdesk.sf_anexo a where a.id = p_anexo),
                                                 'ocr_' || p_status, jsonb_build_object('anexoId', p_anexo));
end;
$$;

-- ---------- Para a tela ----------

/** Fila de leitura: anexos ainda sem linha, com o resultado da leitura. */
create or replace function imobdesk.sf_fila_leitura(p_solicitacao bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not imobdesk.sf_pode_ver(p_solicitacao) then perform imobdesk.erro('NOT_FOUND', 'Solicitação não encontrada.'); end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'nome', a.nome_arquivo, 'path', a.storage_path, 'mime', a.mime,
                                                       'status', a.ocr_status, 'ocr', a.ocr_json, 'criadoEm', a.criado_em) order by a.id)
                   from imobdesk.sf_anexo a
                   where a.solicitacao_id = p_solicitacao and a.item_id is null and a.finalidade = 'comprovante'), '[]');
end;
$$;

/**
 * Confirma a leitura: cria a linha a partir do anexo e liga o anexo a ela. Origem: ocr_confirmado se data, valor e
 * favorecido batem com o que foi lido; senão ocr_editado.
 */
create or replace function imobdesk.sf_linha_do_comprovante(p jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  a imobdesk.sf_anexo;
  s imobdesk.sf_solicitacao;
  v_data date := nullif(p ->> 'data', '')::date;
  v_valor numeric(14,2) := nullif(p ->> 'valor', '')::numeric;
  v_desc text := left(nullif(btrim(p ->> 'descricao'), ''), 200);
  v_cat bigint := nullif(p ->> 'categoriaId', '')::bigint;
  v_motivo text := left(nullif(btrim(p ->> 'motivo'), ''), 200);
  v_item bigint;
  v_lido jsonb;
begin
  select * into a from imobdesk.sf_anexo where id = nullif(p ->> 'anexoId', '')::bigint;
  if not found then perform imobdesk.erro('NOT_FOUND', 'Comprovante não encontrado.'); end if;
  s := imobdesk.sf_exigir_editavel(a.solicitacao_id);
  if a.item_id is not null then perform imobdesk.erro('INVALID_INPUT', 'Este comprovante já virou linha.'); end if;
  if v_data is null or v_valor is null or v_valor <= 0 or v_desc is null then
    perform imobdesk.erro('INVALID_INPUT', 'Preencha data, valor e favorecido para criar a linha.', 'itens');
  end if;
  if v_cat is not null then
    select c.nome into v_motivo from imobdesk.sf_categoria_motivo c where c.id = v_cat and c.ativo;
    v_motivo := coalesce(left(nullif(btrim(p ->> 'motivo'), ''), 200), v_motivo);
  end if;
  v_lido := a.ocr_json;
  insert into imobdesk.sf_item (solicitacao_id, ordem, data, valor, descricao_favorecido, motivo, categoria_id, origem)
  values (s.id, coalesce((select max(i.ordem) from imobdesk.sf_item i where i.solicitacao_id = s.id), 0) + 1,
          v_data, v_valor, v_desc, v_motivo, v_cat,
          case when a.ocr_status in ('lido', 'ilegivel')
                    and v_data is not distinct from nullif(v_lido ->> 'data', '')::date
                    and v_valor is not distinct from nullif(v_lido ->> 'valor_total', '')::numeric
                    and lower(v_desc) is not distinct from lower(nullif(btrim(v_lido ->> 'favorecido'), ''))
               then 'ocr_confirmado'
               when a.ocr_status in ('lido', 'ilegivel') then 'ocr_editado'
               else 'manual' end)
  returning id into v_item;
  update imobdesk.sf_anexo set item_id = v_item where id = a.id;
  perform imobdesk.sf_recalcular(s.id);
  perform imobdesk.sf_registrar_evento(s.id, 'linha_do_comprovante', jsonb_build_object('itemId', v_item, 'anexoId', a.id));
  return v_item;
end;
$$;

-- ---------- Checagens (redefinida: acrescenta as que dependem da leitura) ----------
create or replace function imobdesk.sf_checagens(p_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s imobdesk.sf_solicitacao;
  v_res jsonb := '[]';
  r record;
  v_dias int;
  v_sev text;
  v_par jsonb;
begin
  select * into s from imobdesk.sf_solicitacao where id = p_id;
  if not found or not imobdesk.sf_pode_ver(p_id) then perform imobdesk.erro('NOT_FOUND', 'Solicitação não encontrada.'); end if;

  -- R01 comprovante em cada linha
  select severidade into v_sev from imobdesk.sf_regra where codigo = 'R01' and ativo;
  if v_sev is not null then
    for r in select i.id, i.ordem from imobdesk.sf_item i where i.solicitacao_id = p_id
               and not exists (select 1 from imobdesk.sf_anexo a where a.item_id = i.id and a.finalidade = 'comprovante') loop
      v_res := v_res || jsonb_build_object('codigo', 'R01', 'itemId', r.id, 'resultado', v_sev, 'detalhe', format('Linha %s sem comprovante', r.ordem));
    end loop;
  end if;
  -- R02 legibilidade (comprovante lido com campo-chave abaixo do limiar)
  select severidade, parametros into v_sev, v_par from imobdesk.sf_regra where codigo = 'R02' and ativo;
  if v_sev is not null then
    for r in select i.id, i.ordem from imobdesk.sf_item i join imobdesk.sf_anexo a on a.item_id = i.id
             where i.solicitacao_id = p_id and a.ocr_status = 'ilegivel' loop
      v_res := v_res || jsonb_build_object('codigo', 'R02', 'itemId', r.id, 'resultado', v_sev,
                                           'detalhe', format('Linha %s: comprovante com legibilidade abaixo de %s%%', r.ordem, round(coalesce((v_par ->> 'limiar')::numeric, 0.8) * 100)));
    end loop;
  end if;
  -- R03 data no período
  select severidade into v_sev from imobdesk.sf_regra where codigo = 'R03' and ativo;
  if v_sev is not null and s.periodo_de is not null and s.periodo_ate is not null then
    for r in select i.id, i.ordem, i.data from imobdesk.sf_item i where i.solicitacao_id = p_id and i.data is not null
               and (i.data < s.periodo_de or i.data > s.periodo_ate) loop
      v_res := v_res || jsonb_build_object('codigo', 'R03', 'itemId', r.id, 'resultado', v_sev,
                                           'detalhe', format('Linha %s: %s fora do período', r.ordem, to_char(r.data, 'DD/MM/YYYY')));
    end loop;
  end if;
  -- R04 valor lido = declarado (com tolerância)
  select severidade, parametros into v_sev, v_par from imobdesk.sf_regra where codigo = 'R04' and ativo;
  if v_sev is not null then
    for r in select i.id, i.ordem, i.valor, (a.ocr_json ->> 'valor_total')::numeric as lido
             from imobdesk.sf_item i join imobdesk.sf_anexo a on a.item_id = i.id
             where i.solicitacao_id = p_id and a.ocr_status in ('lido', 'ilegivel') and (a.ocr_json ->> 'valor_total') is not null
               and abs(i.valor - (a.ocr_json ->> 'valor_total')::numeric) > coalesce((v_par ->> 'tolerancia')::numeric, 0) loop
      v_res := v_res || jsonb_build_object('codigo', 'R04', 'itemId', r.id, 'resultado', v_sev,
                                           'detalhe', format('Linha %s: declarado %s, comprovante %s', r.ordem, r.valor, r.lido));
    end loop;
  end if;
  -- R05 documento fiscal com CNPJ/CPF do emissor
  select severidade into v_sev from imobdesk.sf_regra where codigo = 'R05' and ativo;
  if v_sev is not null then
    for r in select i.id, i.ordem from imobdesk.sf_item i join imobdesk.sf_anexo a on a.item_id = i.id
             where i.solicitacao_id = p_id and a.ocr_status in ('lido', 'ilegivel')
               and (coalesce(a.ocr_json ->> 'tipo_documento', 'outro') = 'outro' or coalesce(a.ocr_json ->> 'cnpj_cpf_emissor', '') !~ '^\d{11}$|^\d{14}$') loop
      v_res := v_res || jsonb_build_object('codigo', 'R05', 'itemId', r.id, 'resultado', v_sev,
                                           'detalhe', format('Linha %s: sem documento fiscal com CNPJ/CPF do emissor', r.ordem));
    end loop;
  end if;
  -- R06 duplicidade: mesmo arquivo, ou mesmo CNPJ + data + valor lidos, em outra solicitação ativa
  select severidade into v_sev from imobdesk.sf_regra where codigo = 'R06' and ativo;
  if v_sev is not null then
    for r in select distinct on (a.id) a.item_id, a.nome_arquivo, o.numero
             from imobdesk.sf_anexo a
             join imobdesk.sf_anexo b on b.solicitacao_id <> a.solicitacao_id
                  and (b.sha256 = a.sha256
                       or (a.ocr_json ->> 'cnpj_cpf_emissor' is not null and a.ocr_json ->> 'data' is not null and a.ocr_json ->> 'valor_total' is not null
                           and b.ocr_json ->> 'cnpj_cpf_emissor' = a.ocr_json ->> 'cnpj_cpf_emissor'
                           and b.ocr_json ->> 'data' = a.ocr_json ->> 'data'
                           and (b.ocr_json ->> 'valor_total')::numeric = (a.ocr_json ->> 'valor_total')::numeric))
             join imobdesk.sf_solicitacao o on o.id = b.solicitacao_id and o.status not in ('cancelada', 'reprovada')
             where a.solicitacao_id = p_id and a.item_id is not null loop
      v_res := v_res || jsonb_build_object('codigo', 'R06', 'itemId', r.item_id, 'resultado', v_sev,
                                           'detalhe', format('%s já usado na %s', r.nome_arquivo, r.numero));
    end loop;
  end if;
  -- R07 itens proibidos (lista do admin) nos itens lidos, e alertas da leitura
  select severidade, parametros into v_sev, v_par from imobdesk.sf_regra where codigo = 'R07' and ativo;
  if v_sev is not null then
    for r in select distinct i.id, i.ordem, x.palavra
             from imobdesk.sf_item i
             join imobdesk.sf_anexo a on a.item_id = i.id
             cross join lateral jsonb_array_elements(coalesce(a.ocr_json -> 'itens', '[]')) it
             cross join lateral jsonb_array_elements_text(coalesce(v_par -> 'itens_proibidos', '[]')) x(palavra)
             where i.solicitacao_id = p_id and length(btrim(x.palavra)) >= 3
               and position(lower(btrim(x.palavra)) in lower(coalesce(it ->> 'descricao', ''))) > 0 loop
      v_res := v_res || jsonb_build_object('codigo', 'R07', 'itemId', r.id, 'resultado', v_sev,
                                           'detalhe', format('Linha %s: item "%s" na lista de proibidos', r.ordem, r.palavra));
    end loop;
  end if;
  -- R08 teto da categoria
  select severidade into v_sev from imobdesk.sf_regra where codigo = 'R08' and ativo;
  if v_sev is not null then
    for r in select i.id, i.ordem, c.nome from imobdesk.sf_item i
             join imobdesk.sf_categoria_motivo c on c.id = i.categoria_id
             where i.solicitacao_id = p_id and c.teto_valor is not null and i.valor > c.teto_valor loop
      v_res := v_res || jsonb_build_object('codigo', 'R08', 'itemId', r.id, 'resultado', v_sev, 'detalhe', format('Linha %s acima do teto de %s', r.ordem, r.nome));
    end loop;
  end if;
  -- R09 prazo de envio
  select severidade, (parametros ->> 'dias')::int into v_sev, v_dias from imobdesk.sf_regra where codigo = 'R09' and ativo;
  if v_sev is not null and v_dias is not null and s.periodo_ate is not null and current_date > s.periodo_ate + v_dias then
    v_res := v_res || jsonb_build_object('codigo', 'R09', 'itemId', null, 'resultado', v_sev, 'detalhe', format('Enviada %s dias após o fim do período', current_date - s.periodo_ate));
  end if;
  -- R10 saldo do fundo fixo
  select severidade into v_sev from imobdesk.sf_regra where codigo = 'R10' and ativo;
  if v_sev is not null and s.tipo = 'fundo_fixo' and s.total_despesas > coalesce(s.saldo_inicial, 0) then
    v_res := v_res || jsonb_build_object('codigo', 'R10', 'itemId', null, 'resultado', v_sev, 'detalhe', 'Despesas acima do saldo inicial do fundo fixo');
  end if;
  return v_res;
end;
$$;

-- ---------- Rascunho (redefinida: p.conhecidos evita apagar linha criada no meio de um salvamento) ----------
create or replace function imobdesk.sf_rascunho_salvar(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s imobdesk.sf_solicitacao := imobdesk.sf_exigir_editavel(nullif(p ->> 'id', '')::bigint);
  v_item jsonb;
  v_ids bigint[] := '{}';
  v_item_id bigint;
  v_ordem int := 0;
  v_de date := nullif(p ->> 'periodoDe', '')::date;
  v_ate date := nullif(p ->> 'periodoAte', '')::date;
  v_mapa jsonb := '[]';
begin
  if v_de is not null and v_ate is not null and v_ate < v_de then
    perform imobdesk.erro('INVALID_INPUT', 'O fim do período é antes do início.', 'periodoAte');
  end if;
  if jsonb_array_length(coalesce(p -> 'itens', '[]')) > 200 then
    perform imobdesk.erro('INVALID_INPUT', 'No máximo 200 linhas por solicitação.', 'itens');
  end if;
  update imobdesk.sf_solicitacao
     set competencia = coalesce(date_trunc('month', nullif(p ->> 'competencia', '')::date)::date, competencia),
         periodo_de = v_de, periodo_ate = v_ate,
         centro_custo = left(nullif(btrim(p ->> 'centroCusto'), ''), 60),
         atualizado_em = now()
   where id = s.id;

  for v_item in select value from jsonb_array_elements(coalesce(p -> 'itens', '[]')) loop
    v_ordem := v_ordem + 1;
    v_item_id := nullif(v_item ->> 'id', '')::bigint;
    if nullif(v_item ->> 'valor', '')::numeric < 0 then
      perform imobdesk.erro('INVALID_INPUT', format('Linha %s: valor negativo.', v_ordem), 'itens');
    end if;
    if v_item_id is not null and exists (select 1 from imobdesk.sf_item i where i.id = v_item_id and i.solicitacao_id = s.id) then
      update imobdesk.sf_item
         set ordem = v_ordem, data = nullif(v_item ->> 'data', '')::date, valor = nullif(v_item ->> 'valor', '')::numeric,
             descricao_favorecido = left(nullif(btrim(v_item ->> 'descricao'), ''), 200), motivo = left(nullif(btrim(v_item ->> 'motivo'), ''), 200),
             categoria_id = nullif(v_item ->> 'categoriaId', '')::bigint, atualizado_em = now(),
             -- Linha que veio da leitura e foi alterada passa a "ocr_editado" (Fase 4).
             origem = case when origem = 'ocr_confirmado' and (data is distinct from nullif(v_item ->> 'data', '')::date
                                                               or valor is distinct from nullif(v_item ->> 'valor', '')::numeric) then 'ocr_editado' else origem end
       where id = v_item_id;
    else
      insert into imobdesk.sf_item (solicitacao_id, ordem, data, valor, descricao_favorecido, motivo, categoria_id)
      values (s.id, v_ordem, nullif(v_item ->> 'data', '')::date, nullif(v_item ->> 'valor', '')::numeric,
              left(nullif(btrim(v_item ->> 'descricao'), ''), 200), left(nullif(btrim(v_item ->> 'motivo'), ''), 200),
              nullif(v_item ->> 'categoriaId', '')::bigint)
      returning id into v_item_id;
    end if;
    v_ids := v_ids || v_item_id;
    v_mapa := v_mapa || jsonb_build_object('chave', v_item ->> 'chave', 'id', v_item_id);
  end loop;

  -- Só apaga as linhas que a tela conhecia (p.conhecidos) e tirou da lista: uma linha criada no meio do caminho
  -- (ex.: confirmada a partir do comprovante enquanto o rascunho salvava) não some. Sem p.conhecidos, vale a lista toda.
  delete from imobdesk.sf_anexo a using imobdesk.sf_item i
   where a.item_id = i.id and i.solicitacao_id = s.id and not (i.id = any (v_ids))
     and (p -> 'conhecidos' is null or i.id in (select x::bigint from jsonb_array_elements_text(p -> 'conhecidos') x));
  delete from imobdesk.sf_item i where i.solicitacao_id = s.id and not (i.id = any (v_ids))
     and (p -> 'conhecidos' is null or i.id in (select x::bigint from jsonb_array_elements_text(p -> 'conhecidos') x));
  perform imobdesk.sf_recalcular(s.id);
  -- A tela troca a chave provisória de cada linha nova pelo id gravado.
  return jsonb_build_object('itens', v_mapa);
end;
$$;

-- ---------- Permissões ----------
do $$
declare
  f text;
begin
  foreach f in array array['sf_ocr_pedido(bigint)', 'sf_fila_leitura(bigint)', 'sf_linha_do_comprovante(jsonb)', 'sf_checagens(bigint)'] loop
    execute format('revoke execute on function imobdesk.%s from public, anon', f);
    execute format('grant execute on function imobdesk.%s to authenticated, service_role', f);
  end loop;
  execute 'revoke execute on function imobdesk.sf_ocr_registrar(bigint, text, jsonb, text) from public, anon, authenticated';
  execute 'grant execute on function imobdesk.sf_ocr_registrar(bigint, text, jsonb, text) to service_role';
end;
$$;

notify pgrst, 'reload schema';
