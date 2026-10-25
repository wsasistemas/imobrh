-- Solicitações Financeiras, Fase 5 (parte 1): conferência financeira (CONTEXTO.md, seções 1, 2 e 5; telas 8 e 9).
-- Fila do Financeiro com contadores por etapa; conferência item a item (aceitar, pedir ajuste, glosar; aceitar item com
-- alerta exige observação; glosa sai do pagamento: valor_a_pagar = total − glosas); pendência do solicitante (ele
-- responde e troca o comprovante dos itens em ajuste, volta para a conferência sem nova aprovação); pagamento programado
-- e paga. O lançamento no SIENGE (lancamento_gerado) entra depois da aprovação dos endpoints (Fase 5, parte 2).
-- Permissão nova `sf_conferencia` (tela Conferência financeira) para o perfil do Financeiro; a regra de dados continua:
-- só quem é do setor financeiro (ou admin) confere. Só aditiva.

insert into imobdesk.profile_permissions (role, permission_id, enabled)
values ('admin', 'sf_conferencia', true)
on conflict (role, permission_id) do nothing;

create or replace function imobdesk.sf_exigir_financeiro()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.sf_exigir_login();
begin
  if not (imobdesk.ch_eh_admin() or imobdesk.sf_eh_financeiro(v_uid)) then
    perform imobdesk.erro('FORBIDDEN', 'Só o setor Financeiro confere as solicitações.');
  end if;
  return v_uid;
end;
$$;

-- ---------- Tela 8: fila do Financeiro ----------
create or replace function imobdesk.sf_conferencia_fila()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_mes date := date_trunc('month', current_date)::date;
begin
  perform imobdesk.sf_exigir_financeiro();
  return jsonb_build_object(
    'kpis', (select jsonb_build_object(
               'aConferir', count(*) filter (where s.status = 'em_conferencia'),
               'aConferirValor', coalesce(sum(s.valor_a_pagar) filter (where s.status = 'em_conferencia'), 0),
               'pendencia', count(*) filter (where s.status = 'pendencia_solicitante'),
               'lancamentoGerado', count(*) filter (where s.status = 'lancamento_gerado'),
               'pagamentoProgramado', count(*) filter (where s.status = 'pagamento_programado'),
               'aComprovar', count(*) filter (where s.status in ('comprovacao_pendente', 'comprovacao_em_conferencia')),
               'aComprovarVencidos', count(*) filter (where s.status = 'comprovacao_pendente' and s.prazo_comprovacao < current_date),
               'pagasMes', count(*) filter (where s.status in ('paga', 'encerrada') and s.atualizado_em >= v_mes),
               'pagasMesValor', coalesce(sum(s.valor_a_pagar) filter (where s.status in ('paga', 'encerrada') and s.atualizado_em >= v_mes), 0))
             from imobdesk.sf_solicitacao s where imobdesk.sf_status_financeiro(s.status)),
    'lista', coalesce((select jsonb_agg(jsonb_build_object(
                 'id', s.id, 'numero', s.numero, 'tipo', s.tipo, 'status', s.status, 'solicitante', u.nome,
                 'setor', (select st.nome from imobdesk.at_setores st where st.id = s.setor_id),
                 'valor', coalesce(s.valor_adiantamento, s.total_despesas), 'valorAPagar', s.valor_a_pagar,
                 'ultimaAprovacaoEm', s.ultima_aprovacao_em, 'pagarAte', s.pagar_ate, 'vencimento', s.vencimento,
                 'itens', (select count(*) from imobdesk.sf_item i where i.solicitacao_id = s.id),
                 'resolvidos', (select count(*) from imobdesk.sf_item i where i.solicitacao_id = s.id and i.status_conferencia in ('aceito', 'glosado')))
               order by s.ultima_aprovacao_em nulls last, s.id)
               from imobdesk.sf_solicitacao s join imobdesk.usuarios u on u.id = s.solicitante_id
               where s.status in ('em_conferencia', 'pendencia_solicitante', 'lancamento_gerado', 'pagamento_programado',
                                  'comprovacao_pendente', 'comprovacao_em_conferencia', 'devolucao_pendente')
                  or (s.status in ('paga', 'encerrada') and s.atualizado_em >= v_mes)), '[]')
  );
end;
$$;

-- ---------- Tela 9: itens da conferência ----------
create or replace function imobdesk.sf_conferencia_itens(p_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not imobdesk.sf_pode_ver(p_id) then perform imobdesk.erro('NOT_FOUND', 'Solicitação não encontrada.'); end if;
  return jsonb_build_object(
    'podeConferir', (imobdesk.ch_eh_admin() or imobdesk.sf_eh_financeiro((select auth.uid())))
                    and exists (select 1 from imobdesk.sf_solicitacao s where s.id = p_id and s.status = 'em_conferencia'),
    'itens', coalesce((select jsonb_agg(jsonb_build_object(
                 'id', i.id, 'ordem', i.ordem, 'data', i.data, 'valor', i.valor, 'descricao', i.descricao_favorecido, 'motivo', i.motivo,
                 'origem', i.origem, 'status', i.status_conferencia, 'valorGlosado', i.valor_glosado, 'obs', i.obs_conferente,
                 'anexos', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'nome', a.nome_arquivo, 'path', a.storage_path, 'mime', a.mime,
                                                                          'ocrStatus', a.ocr_status, 'ocr', a.ocr_json) order by a.id desc)
                                     from imobdesk.sf_anexo a where a.item_id = i.id), '[]'),
                 'regras', coalesce((select jsonb_agg(jsonb_build_object('codigo', x ->> 'codigo', 'resultado', x ->> 'resultado', 'detalhe', x ->> 'detalhe'))
                                     from jsonb_array_elements(imobdesk.sf_checagens(p_id)) x
                                     where (x ->> 'itemId')::bigint = i.id), '[]'))
               order by i.ordem)
               from imobdesk.sf_item i where i.solicitacao_id = p_id), '[]'),
    'gerais', coalesce((select jsonb_agg(x) from jsonb_array_elements(imobdesk.sf_checagens(p_id)) x where x ->> 'itemId' is null), '[]')
  );
end;
$$;

/** Recalcula glosas e valor a pagar. */
create or replace function imobdesk.sf_recalcular_glosa(p_id bigint)
returns void
language sql
security definer
set search_path = ''
as $$
  update imobdesk.sf_solicitacao s
     set valor_glosado = g.glosa, valor_a_pagar = s.total_despesas - g.glosa, atualizado_em = now()
    from (select coalesce(sum(i.valor_glosado), 0)::numeric(14,2) as glosa from imobdesk.sf_item i where i.solicitacao_id = p_id) g
   where s.id = p_id;
$$;

/**
 * Decisão por item: aceitar (com alerta, exige observação), ajuste (pede correção ao solicitante; exige observação)
 * ou glosar (retira o valor do pagamento; exige valor e observação).
 */
create or replace function imobdesk.sf_decidir_item(p_item bigint, p_decisao text, p_valor_glosa numeric default null, p_obs text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.sf_exigir_financeiro();
  i imobdesk.sf_item;
  s imobdesk.sf_solicitacao;
  v_obs text := nullif(btrim(coalesce(p_obs, '')), '');
  v_alerta boolean;
begin
  select * into i from imobdesk.sf_item where id = p_item;
  if not found then perform imobdesk.erro('NOT_FOUND', 'Item não encontrado.'); end if;
  select * into s from imobdesk.sf_solicitacao where id = i.solicitacao_id;
  if s.status <> 'em_conferencia' then perform imobdesk.erro('INVALID_INPUT', 'A solicitação não está em conferência.'); end if;
  if p_decisao not in ('aceitar', 'ajuste', 'glosar') then perform imobdesk.erro('INVALID_INPUT', 'Decisão inválida.', 'decisao'); end if;
  select exists (select 1 from jsonb_array_elements(imobdesk.sf_checagens(s.id)) x
                 where (x ->> 'itemId')::bigint = p_item and x ->> 'resultado' <> 'ok') into v_alerta;
  if v_obs is null and (p_decisao <> 'aceitar' or v_alerta) then
    perform imobdesk.erro('INVALID_INPUT', case when p_decisao = 'aceitar' then 'Item com alerta: escreva a observação para aceitar.' else 'Escreva a observação.' end, 'obs');
  end if;
  if p_decisao = 'glosar' and (p_valor_glosa is null or p_valor_glosa <= 0 or p_valor_glosa > i.valor) then
    perform imobdesk.erro('INVALID_INPUT', 'Informe o valor glosado (maior que zero e até o valor do item).', 'valorGlosa');
  end if;
  update imobdesk.sf_item
     set status_conferencia = case p_decisao when 'aceitar' then 'aceito' when 'ajuste' then 'ajuste' else 'glosado' end,
         valor_glosado = case when p_decisao = 'glosar' then round(p_valor_glosa, 2) else 0 end,
         obs_conferente = left(v_obs, 1000), atualizado_em = now()
   where id = p_item;
  perform imobdesk.sf_recalcular_glosa(s.id);
  perform imobdesk.sf_registrar_evento(s.id, 'item_' || p_decisao,
    jsonb_build_object('itemId', p_item, 'ordem', i.ordem, 'glosa', case when p_decisao = 'glosar' then p_valor_glosa end, 'obs', v_obs));
  return jsonb_build_object('valorAPagar', (select x.valor_a_pagar from imobdesk.sf_solicitacao x where x.id = s.id));
end;
$$;

/** Devolve ao solicitante os itens marcados "ajuste" (status pendencia_solicitante). */
create or replace function imobdesk.sf_pedir_ajuste(p_id bigint, p_comentario text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.sf_exigir_financeiro();
begin
  if nullif(btrim(coalesce(p_comentario, '')), '') is null then
    perform imobdesk.erro('INVALID_INPUT', 'Escreva o que o solicitante precisa ajustar.', 'comentario');
  end if;
  if not exists (select 1 from imobdesk.sf_solicitacao where id = p_id and status = 'em_conferencia') then
    perform imobdesk.erro('INVALID_INPUT', 'A solicitação não está em conferência.');
  end if;
  if not exists (select 1 from imobdesk.sf_item where solicitacao_id = p_id and status_conferencia = 'ajuste') then
    perform imobdesk.erro('INVALID_INPUT', 'Marque ao menos um item como "Pedir ajuste".');
  end if;
  perform imobdesk.sf_registrar_evento(p_id, 'pendencia_aberta', jsonb_build_object('comentario', left(p_comentario, 2000)));
  update imobdesk.sf_solicitacao set status = 'pendencia_solicitante', atualizado_em = now() where id = p_id;
end;
$$;

/** O solicitante troca o comprovante de um item em ajuste (o arquivo já está no Storage). */
create or replace function imobdesk.sf_pendencia_anexar(p jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.sf_exigir_login();
  i imobdesk.sf_item;
  s imobdesk.sf_solicitacao;
  v_id bigint;
  v_path text := p ->> 'path';
begin
  select * into i from imobdesk.sf_item where id = nullif(p ->> 'itemId', '')::bigint;
  if not found then perform imobdesk.erro('NOT_FOUND', 'Item não encontrado.'); end if;
  select * into s from imobdesk.sf_solicitacao where id = i.solicitacao_id;
  if s.solicitante_id <> v_uid or s.status <> 'pendencia_solicitante' or i.status_conferencia <> 'ajuste' then
    perform imobdesk.erro('INVALID_INPUT', 'Só dá para trocar o comprovante dos itens com ajuste pedido.');
  end if;
  if v_path is null or split_part(v_path, '/', 1) <> v_uid::text or split_part(v_path, '/', 2) <> s.id::text then
    perform imobdesk.erro('INVALID_INPUT', 'Arquivo fora da pasta da solicitação.', 'path');
  end if;
  if coalesce(p ->> 'sha256', '') !~ '^[0-9a-f]{64}$' or coalesce((p ->> 'tamanho')::bigint, 0) not between 1 and 10485760
     or coalesce(p ->> 'mime', '') not in ('image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp', 'application/pdf') then
    perform imobdesk.erro('INVALID_INPUT', 'Arquivo inválido (JPG, PNG, HEIC ou PDF até 10 MB).');
  end if;
  insert into imobdesk.sf_anexo (solicitacao_id, item_id, finalidade, storage_path, nome_arquivo, mime, tamanho, sha256, criado_por)
  values (s.id, i.id, 'comprovante', v_path, left(coalesce(nullif(p ->> 'nome', ''), 'arquivo'), 200), p ->> 'mime', (p ->> 'tamanho')::bigint, lower(p ->> 'sha256'), v_uid)
  returning id into v_id;
  perform imobdesk.sf_registrar_evento(s.id, 'pendencia_anexo', jsonb_build_object('itemId', i.id, 'anexoId', v_id));
  return v_id;
end;
$$;

/** O solicitante responde a pendência: volta para a conferência e os itens em ajuste voltam a "pendente". */
create or replace function imobdesk.sf_pendencia_responder(p_id bigint, p_resposta text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.sf_exigir_login();
begin
  if not exists (select 1 from imobdesk.sf_solicitacao where id = p_id and solicitante_id = v_uid and status = 'pendencia_solicitante') then
    perform imobdesk.erro('NOT_FOUND', 'Pendência não encontrada.');
  end if;
  if nullif(btrim(coalesce(p_resposta, '')), '') is null then
    perform imobdesk.erro('INVALID_INPUT', 'Escreva a resposta para o Financeiro.', 'resposta');
  end if;
  update imobdesk.sf_item set status_conferencia = 'pendente', atualizado_em = now() where solicitacao_id = p_id and status_conferencia = 'ajuste';
  perform imobdesk.sf_registrar_evento(p_id, 'pendencia_respondida', jsonb_build_object('resposta', left(p_resposta, 2000)));
  update imobdesk.sf_solicitacao set status = 'em_conferencia', atualizado_em = now() where id = p_id;
  perform imobdesk.sf_notificar_financeiro(p_id, 'Pendência respondida: ' || imobdesk.sf_rotulo(p_id), left(p_resposta, 300));
end;
$$;

-- ---------- Pagamento ----------
/** Depois do lançamento: o Financeiro programa a data do pagamento. */
create or replace function imobdesk.sf_programar_pagamento(p_id bigint, p_data date)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.sf_exigir_financeiro();
begin
  if p_data is null or p_data < current_date then perform imobdesk.erro('INVALID_INPUT', 'Informe a data do pagamento (hoje ou depois).', 'data'); end if;
  if not exists (select 1 from imobdesk.sf_solicitacao where id = p_id and status = 'lancamento_gerado') then
    perform imobdesk.erro('INVALID_INPUT', 'Só dá para programar o pagamento depois do lançamento no SIENGE.');
  end if;
  update imobdesk.sf_solicitacao set pagar_ate = p_data, status = 'pagamento_programado', atualizado_em = now() where id = p_id;
  perform imobdesk.sf_registrar_evento(p_id, 'pagamento_programado', jsonb_build_object('data', p_data));
end;
$$;

/** Pagamento feito. Adiantamento segue para a comprovação (Fase 5B); os demais terminam aqui. */
create or replace function imobdesk.sf_marcar_paga(p_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.sf_exigir_financeiro();
  s imobdesk.sf_solicitacao;
begin
  select * into s from imobdesk.sf_solicitacao where id = p_id;
  if not found or s.status <> 'pagamento_programado' then
    perform imobdesk.erro('INVALID_INPUT', 'Só dá para marcar como paga depois de programar o pagamento.');
  end if;
  update imobdesk.sf_solicitacao set status = 'paga', atualizado_em = now() where id = p_id;
  perform imobdesk.sf_registrar_evento(p_id, 'paga');
  if s.tipo = 'adiantamento' then
    update imobdesk.sf_solicitacao set status = 'comprovacao_pendente', status_comprovacao = 'pendente', atualizado_em = now() where id = p_id;
  end if;
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array['sf_conferencia_fila()', 'sf_conferencia_itens(bigint)', 'sf_decidir_item(bigint, text, numeric, text)', 'sf_pedir_ajuste(bigint, text)',
                           'sf_pendencia_anexar(jsonb)', 'sf_pendencia_responder(bigint, text)', 'sf_programar_pagamento(bigint, date)', 'sf_marcar_paga(bigint)'] loop
    execute format('revoke execute on function imobdesk.%s from public, anon', f);
    execute format('grant execute on function imobdesk.%s to authenticated, service_role', f);
  end loop;
  foreach f in array array['sf_exigir_financeiro()', 'sf_recalcular_glosa(bigint)'] loop
    execute format('revoke execute on function imobdesk.%s from public, anon, authenticated', f);
    execute format('grant execute on function imobdesk.%s to service_role', f);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
