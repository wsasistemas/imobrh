-- Solicitações Financeiras, Fase 2: formulários e envio (CONTEXTO.md, seções 2, 3, 4, 5 e 9).
-- Rascunho (reembolso e fundo fixo), itens, anexos com SHA-256 no bucket sf-comprovantes, checagens antes de enviar
-- (as que não dependem da leitura do comprovante: R01, R03, R06 por arquivo, R08, R09, R10) e sf_enviar, que congela a
-- cadeia do SETOR do solicitante em sf_aprovacao. Adiantamento entra na Fase 5B. Só aditiva: funções e políticas novas.

-- ---------- Editável pelo solicitante ----------
create or replace function imobdesk.sf_exigir_editavel(p_id bigint)
returns imobdesk.sf_solicitacao
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s imobdesk.sf_solicitacao;
begin
  perform imobdesk.sf_exigir_login();
  select * into s from imobdesk.sf_solicitacao where id = p_id;
  if not found or s.solicitante_id <> (select auth.uid()) then
    perform imobdesk.erro('NOT_FOUND', 'Solicitação não encontrada.');
  end if;
  if s.status not in ('rascunho', 'devolvida') then
    perform imobdesk.erro('INVALID_INPUT', 'Esta solicitação não pode mais ser alterada.');
  end if;
  return s;
end;
$$;

create or replace function imobdesk.sf_registrar_evento(p_id bigint, p_tipo text, p_payload jsonb default '{}')
returns void
language sql
security definer
set search_path = ''
as $$
  insert into imobdesk.sf_evento (solicitacao_id, tipo, ator_id, payload, ip, user_agent)
  values (p_id, p_tipo, (select auth.uid()), coalesce(p_payload, '{}'),
          nullif(btrim(split_part(coalesce((nullif(current_setting('request.headers', true), '')::json ->> 'x-forwarded-for'), ''), ',', 1)), ''),
          left((nullif(current_setting('request.headers', true), '')::json ->> 'user-agent'), 400));
$$;

-- ---------- Storage: <usuário>/<solicitação>/<arquivo> ----------
create or replace function imobdesk.sf_storage_pode_ler(p_nome text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_sol bigint;
begin
  begin
    v_sol := (string_to_array(p_nome, '/'))[2]::bigint;
  exception when others then
    return false;
  end;
  return imobdesk.perfil_usuario_atual() is not null and imobdesk.sf_pode_ver(v_sol);
end;
$$;

create or replace function imobdesk.sf_storage_pode_gravar(p_nome text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_partes text[] := string_to_array(p_nome, '/');
  v_sol bigint;
begin
  if cardinality(v_partes) <> 3 or v_partes[1] <> (select auth.uid())::text or imobdesk.perfil_usuario_atual() is null then
    return false;
  end if;
  begin
    v_sol := v_partes[2]::bigint;
  exception when others then
    return false;
  end;
  return exists (select 1 from imobdesk.sf_solicitacao s
                 where s.id = v_sol and s.solicitante_id = (select auth.uid())
                   and s.status in ('rascunho', 'devolvida', 'pendencia_solicitante', 'comprovacao_pendente'));
end;
$$;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'sf-comprovantes: gravar') then
    create policy "sf-comprovantes: gravar" on storage.objects for insert to authenticated
      with check (bucket_id = 'imobdesk-sf-comprovantes' and (select imobdesk.sf_storage_pode_gravar(name)));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'sf-comprovantes: apagar') then
    create policy "sf-comprovantes: apagar" on storage.objects for delete to authenticated
      using (bucket_id = 'imobdesk-sf-comprovantes' and (select imobdesk.sf_storage_pode_gravar(name)));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'sf-comprovantes: leitura') then
    create policy "sf-comprovantes: leitura" on storage.objects for select to authenticated
      using (bucket_id = 'imobdesk-sf-comprovantes' and (select imobdesk.sf_storage_pode_ler(name)));
  end if;
end;
$$;

-- ---------- Cadeia de aprovação (mesma regra de src/features/financeiro/cadeia.ts) ----------
/**
 * Etapas para o setor, tipo e valor. exigido = entra na aprovação; pulado = o aprovador é o próprio solicitante.
 * Reembolso/fundo fixo: alçada mínima <= total. Adiantamento: planejamento só em obra, gerente sempre,
 * diretor e presidente com valor acima da alçada.
 */
create or replace function imobdesk.sf_montar_cadeia(p_setor bigint, p_tipo text, p_valor numeric, p_solicitante uuid)
returns table (nivel int, papel text, aprovador_id uuid, substituto_id uuid, exigido boolean, pulado boolean, motivo text)
language sql
stable
security definer
set search_path = ''
as $$
  with base as (
    select a.ordem, a.papel, a.aprovador_id, a.substituto_id,
           case
             when p_tipo in ('reembolso', 'fundo_fixo') then coalesce(p_valor, 0) >= coalesce(a.alcada_minima, 0)
             when a.condicao = 'obra' then coalesce(s.sf_setor_obra, false)
             when a.condicao = 'sempre' then true
             else coalesce(p_valor, 0) > coalesce(a.alcada_minima, 0)
           end as exigido,
           case
             when p_tipo in ('reembolso', 'fundo_fixo') then case when coalesce(a.alcada_minima, 0) > 0 then 'a partir da alçada' else 'sempre' end
             when a.condicao = 'obra' then 'despesa de obra'
             when a.condicao = 'sempre' then 'sempre'
             else 'acima da alçada'
           end as motivo
    from imobdesk.sf_setor_aprovador a
    join imobdesk.at_setores s on s.id = a.setor_id
    where a.setor_id = p_setor and a.ativo
      and a.tipo_solicitacao = case when p_tipo = 'adiantamento' then 'adiantamento' else 'reembolso_fundo_fixo' end
  )
  select row_number() over (order by b.ordem)::int, b.papel, b.aprovador_id, b.substituto_id, b.exigido,
         b.exigido and b.aprovador_id = p_solicitante,
         case when not b.exigido then 'não exigido para este valor' when b.aprovador_id = p_solicitante then 'etapa do próprio solicitante: pulada' else b.motivo end
  from base b
  order by b.ordem;
$$;

-- ---------- Criar e gravar o rascunho ----------

/** Cria o rascunho (número SF-AAAA-NNNN já na criação, como no mockup). Fundo fixo traz o valor e o saldo inicial. */
create or replace function imobdesk.sf_rascunho_criar(p_tipo text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.sf_exigir_login();
  v_setor bigint := imobdesk.sf_setor_do_usuario(v_uid);
  v_fundo numeric(14,2);
  v_ant imobdesk.sf_solicitacao;
  v_saldo numeric(14,2);
  v_id bigint;
  v_mes date := date_trunc('month', current_date)::date;
begin
  if p_tipo not in ('reembolso', 'fundo_fixo') then
    perform imobdesk.erro('INVALID_INPUT', 'Tipo de solicitação inválido.', 'tipo');
  end if;
  if v_setor is null then
    perform imobdesk.erro('INVALID_INPUT', 'Seu cadastro de Pessoas está sem setor. Peça ao administrador para definir o seu setor.');
  end if;
  if p_tipo = 'fundo_fixo' then
    select f.valor into v_fundo from imobdesk.sf_fundo_fixo f where f.usuario_id = v_uid and f.ativo;
    if v_fundo is null then
      perform imobdesk.erro('INVALID_INPUT', 'Você não tem fundo fixo cadastrado. Peça ao administrador para cadastrar o valor do seu caixinha.');
    end if;
    -- Saldo inicial = saldo final anterior + reposição recebida (a reposição só conta quando a anterior foi paga).
    select * into v_ant from imobdesk.sf_solicitacao s
    where s.solicitante_id = v_uid and s.tipo = 'fundo_fixo' and s.status not in ('rascunho', 'cancelada', 'reprovada')
    order by s.enviado_em desc nulls last, s.id desc limit 1;
    v_saldo := case when v_ant.id is null then v_fundo
                    else coalesce(v_ant.saldo_final, 0) + case when v_ant.status in ('paga', 'encerrada') then coalesce(v_ant.valor_a_pagar, 0) else 0 end end;
  end if;
  insert into imobdesk.sf_solicitacao (tipo, solicitante_id, pessoa_id, setor_id, competencia, periodo_de, periodo_ate, centro_custo,
                                                 valor_fundo_fixo, saldo_inicial, saldo_final, total_despesas, valor_a_pagar)
  values (p_tipo, v_uid, imobdesk.sf_pessoa_do_usuario(v_uid), v_setor, v_mes, v_mes, (v_mes + interval '1 month - 1 day')::date,
          (select s.sf_centro_custo_padrao from imobdesk.at_setores s where s.id = v_setor),
          v_fundo, v_saldo, v_saldo, 0, 0)
  returning id into v_id;
  perform imobdesk.sf_registrar_evento(v_id, 'criada', jsonb_build_object('tipo', p_tipo));
  return v_id;
end;
$$;

/** Recalcula totais (reembolso: valor a pagar = total; fundo fixo: saldo final = saldo inicial − despesas, reposição = despesas). */
create or replace function imobdesk.sf_recalcular(p_id bigint)
returns void
language sql
security definer
set search_path = ''
as $$
  update imobdesk.sf_solicitacao s
     set total_despesas = t.total,
         saldo_final = case when s.tipo = 'fundo_fixo' then coalesce(s.saldo_inicial, 0) - t.total else s.saldo_final end,
         valor_a_pagar = t.total - s.valor_glosado,
         atualizado_em = now()
    from (select coalesce(sum(i.valor), 0)::numeric(14,2) as total from imobdesk.sf_item i where i.solicitacao_id = p_id) t
   where s.id = p_id;
$$;

/**
 * Grava o cabeçalho e as linhas (rascunho automático). Linha com id é atualizada; sem id é criada; a que sumiu da lista é
 * apagada (com os anexos dela). Valida só formato: completude é checada no envio.
 */
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

  delete from imobdesk.sf_anexo a using imobdesk.sf_item i
   where a.item_id = i.id and i.solicitacao_id = s.id and not (i.id = any (v_ids));
  delete from imobdesk.sf_item i where i.solicitacao_id = s.id and not (i.id = any (v_ids));
  perform imobdesk.sf_recalcular(s.id);
  -- A tela troca a chave provisória de cada linha nova pelo id gravado.
  return jsonb_build_object('itens', v_mapa);
end;
$$;

-- ---------- Anexos ----------

/** Registra o arquivo já enviado ao Storage. R06 (mesmo arquivo em outra solicitação) volta como aviso e bloqueia o envio. */
create or replace function imobdesk.sf_anexo_registrar(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s imobdesk.sf_solicitacao := imobdesk.sf_exigir_editavel(nullif(p ->> 'solicitacaoId', '')::bigint);
  v_item bigint := nullif(p ->> 'itemId', '')::bigint;
  v_path text := p ->> 'path';
  v_sha text := lower(coalesce(p ->> 'sha256', ''));
  v_mime text := coalesce(p ->> 'mime', '');
  v_id bigint;
  v_dup text;
begin
  if v_path is null or split_part(v_path, '/', 1) <> s.solicitante_id::text or split_part(v_path, '/', 2) <> s.id::text then
    perform imobdesk.erro('INVALID_INPUT', 'Arquivo fora da pasta da solicitação.', 'path');
  end if;
  if v_sha !~ '^[0-9a-f]{64}$' then perform imobdesk.erro('INVALID_INPUT', 'Assinatura do arquivo inválida.', 'sha256'); end if;
  if v_mime not in ('image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp', 'application/pdf') then
    perform imobdesk.erro('INVALID_INPUT', 'Envie JPG, PNG, HEIC ou PDF.', 'mime');
  end if;
  if coalesce((p ->> 'tamanho')::bigint, 0) not between 1 and 10485760 then
    perform imobdesk.erro('INVALID_INPUT', 'O arquivo precisa ter até 10 MB.', 'tamanho');
  end if;
  if v_item is not null and not exists (select 1 from imobdesk.sf_item i where i.id = v_item and i.solicitacao_id = s.id) then
    perform imobdesk.erro('NOT_FOUND', 'Linha não encontrada.');
  end if;
  insert into imobdesk.sf_anexo (solicitacao_id, item_id, finalidade, storage_path, nome_arquivo, mime, tamanho, sha256, criado_por)
  values (s.id, v_item, coalesce(nullif(p ->> 'finalidade', ''), 'comprovante'), v_path, left(coalesce(nullif(p ->> 'nome', ''), 'arquivo'), 200),
          v_mime, (p ->> 'tamanho')::bigint, v_sha, (select auth.uid()))
  returning id into v_id;
  select o.numero into v_dup
  from imobdesk.sf_anexo a join imobdesk.sf_solicitacao o on o.id = a.solicitacao_id
  where a.sha256 = v_sha and a.solicitacao_id <> s.id and o.status not in ('cancelada', 'reprovada')
  limit 1;
  perform imobdesk.sf_registrar_evento(s.id, 'anexo_incluido', jsonb_build_object('anexoId', v_id, 'nome', p ->> 'nome'));
  return jsonb_build_object('id', v_id, 'duplicadoEm', v_dup);
end;
$$;

/** Tira o anexo (a tela apaga o arquivo do Storage com o caminho devolvido). */
create or replace function imobdesk.sf_anexo_remover(p_id bigint)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  a imobdesk.sf_anexo;
begin
  select * into a from imobdesk.sf_anexo where id = p_id;
  if not found then perform imobdesk.erro('NOT_FOUND', 'Anexo não encontrado.'); end if;
  perform imobdesk.sf_exigir_editavel(a.solicitacao_id);
  delete from imobdesk.sf_anexo where id = p_id;
  perform imobdesk.sf_registrar_evento(a.solicitacao_id, 'anexo_removido', jsonb_build_object('nome', a.nome_arquivo));
  return a.storage_path;
end;
$$;

-- ---------- Checagens antes de enviar ----------

/** Resultado das regras que não dependem da leitura do comprovante. Não grava: o envio grava em sf_regra_resultado. */
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
  -- R03 data no período
  select severidade into v_sev from imobdesk.sf_regra where codigo = 'R03' and ativo;
  if v_sev is not null and s.periodo_de is not null and s.periodo_ate is not null then
    for r in select i.id, i.ordem, i.data from imobdesk.sf_item i where i.solicitacao_id = p_id and i.data is not null
               and (i.data < s.periodo_de or i.data > s.periodo_ate) loop
      v_res := v_res || jsonb_build_object('codigo', 'R03', 'itemId', r.id, 'resultado', v_sev,
                                           'detalhe', format('Linha %s: %s fora do período', r.ordem, to_char(r.data, 'DD/MM/YYYY')));
    end loop;
  end if;
  -- R06 mesmo arquivo em outra solicitação ativa
  select severidade into v_sev from imobdesk.sf_regra where codigo = 'R06' and ativo;
  if v_sev is not null then
    for r in select distinct on (a.id) a.item_id, a.nome_arquivo, o.numero
             from imobdesk.sf_anexo a
             join imobdesk.sf_anexo b on b.sha256 = a.sha256 and b.solicitacao_id <> a.solicitacao_id
             join imobdesk.sf_solicitacao o on o.id = b.solicitacao_id and o.status not in ('cancelada', 'reprovada')
             where a.solicitacao_id = p_id loop
      v_res := v_res || jsonb_build_object('codigo', 'R06', 'itemId', r.item_id, 'resultado', v_sev,
                                           'detalhe', format('%s já usado na %s', r.nome_arquivo, r.numero));
    end loop;
  end if;
  -- R08 teto da categoria
  select severidade into v_sev from imobdesk.sf_regra where codigo = 'R08' and ativo;
  if v_sev is not null then
    for r in select i.id, i.ordem, c.nome, c.teto_valor from imobdesk.sf_item i
             join imobdesk.sf_categoria_motivo c on c.id = i.categoria_id
             where i.solicitacao_id = p_id and c.teto_valor is not null and i.valor > c.teto_valor loop
      v_res := v_res || jsonb_build_object('codigo', 'R08', 'itemId', r.id, 'resultado', v_sev,
                                           'detalhe', format('Linha %s acima do teto de %s', r.ordem, r.nome));
    end loop;
  end if;
  -- R09 prazo de envio após o fim da competência (só com [PRAZO] definido)
  select severidade, (parametros ->> 'dias')::int into v_sev, v_dias from imobdesk.sf_regra where codigo = 'R09' and ativo;
  if v_sev is not null and v_dias is not null and s.periodo_ate is not null and current_date > s.periodo_ate + v_dias then
    v_res := v_res || jsonb_build_object('codigo', 'R09', 'itemId', null, 'resultado', v_sev, 'detalhe', format('Enviada %s dias após o fim do período', current_date - s.periodo_ate));
  end if;
  -- R10 despesas até o saldo do fundo fixo
  select severidade into v_sev from imobdesk.sf_regra where codigo = 'R10' and ativo;
  if v_sev is not null and s.tipo = 'fundo_fixo' and s.total_despesas > coalesce(s.saldo_inicial, 0) then
    v_res := v_res || jsonb_build_object('codigo', 'R10', 'itemId', null, 'resultado', v_sev, 'detalhe', 'Despesas acima do saldo inicial do fundo fixo');
  end if;
  return v_res;
end;
$$;

-- ---------- Envio ----------

/**
 * Envia para aprovação: valida linhas e aceite, grava as checagens, congela a cadeia do setor em sf_aprovacao
 * (novo ciclo quando volta de "devolvida", recomeçando do nível 1) e registra o aceite (usuário, data/hora, IP e navegador).
 */
create or replace function imobdesk.sf_enviar(p_id bigint, p_aceite boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s imobdesk.sf_solicitacao := imobdesk.sf_exigir_editavel(p_id);
  v_uid uuid := (select auth.uid());
  v_checks jsonb;
  v_bloq jsonb;
  v_ciclo int;
  v_modo text;
  v_prazo int;
  v_falta int;
  v_exigidos int;
  v_primeiro int;
  c record;
  v_headers json := nullif(current_setting('request.headers', true), '')::json;
begin
  if not coalesce(p_aceite, false) then
    perform imobdesk.erro('INVALID_INPUT', 'Marque o aceite eletrônico para enviar.', 'aceite');
  end if;
  if s.setor_id is null then
    perform imobdesk.erro('INVALID_INPUT', 'Seu cadastro de Pessoas está sem setor. Peça ao administrador para definir o seu setor.');
  end if;
  if not exists (select 1 from imobdesk.sf_item i where i.solicitacao_id = p_id) then
    perform imobdesk.erro('INVALID_INPUT', 'Inclua ao menos uma despesa.', 'itens');
  end if;
  select count(*) into v_falta from imobdesk.sf_item i
  where i.solicitacao_id = p_id and (i.data is null or i.valor is null or i.valor <= 0 or i.descricao_favorecido is null or i.motivo is null);
  if v_falta > 0 then
    perform imobdesk.erro('INVALID_INPUT', format('Preencha data, valor, %s e motivo em todas as linhas (%s incompleta%s).',
                                                         case when s.tipo = 'fundo_fixo' then 'favorecido' else 'descrição' end, v_falta,
                                                         case when v_falta > 1 then 's' else '' end), 'itens');
  end if;
  if s.periodo_de is null or s.periodo_ate is null then
    perform imobdesk.erro('INVALID_INPUT', 'Informe o período.', 'periodoDe');
  end if;

  perform imobdesk.sf_recalcular(p_id);
  select * into s from imobdesk.sf_solicitacao where id = p_id;
  v_checks := imobdesk.sf_checagens(p_id);
  select jsonb_agg(x) into v_bloq from jsonb_array_elements(v_checks) x where x ->> 'resultado' = 'bloqueio';
  if v_bloq is not null then
    perform imobdesk.erro('INVALID_INPUT', (v_bloq -> 0 ->> 'codigo') || ': ' || (v_bloq -> 0 ->> 'detalhe')
                                    || case when jsonb_array_length(v_bloq) > 1 then format(' (e mais %s)', jsonb_array_length(v_bloq) - 1) else '' end);
  end if;

  -- Cadeia congelada
  select st.sf_modo_aprovacao, st.sf_prazo_horas into v_modo, v_prazo from imobdesk.at_setores st where st.id = s.setor_id;
  v_ciclo := case when s.status = 'devolvida' then s.ciclo + 1 else s.ciclo end;
  select count(*) filter (where exigido and not pulado), min(nivel) filter (where exigido and not pulado) into v_exigidos, v_primeiro
  from imobdesk.sf_montar_cadeia(s.setor_id, s.tipo, s.total_despesas, v_uid);
  if coalesce(v_exigidos, 0) = 0 then
    perform imobdesk.erro('INVALID_INPUT', 'O seu setor ainda não tem aprovador para este valor. Avise o administrador (Setores e números › Aprovação financeira).');
  end if;
  delete from imobdesk.sf_aprovacao where solicitacao_id = p_id and ciclo = v_ciclo;  -- reenvio no mesmo ciclo não duplica
  for c in select * from imobdesk.sf_montar_cadeia(s.setor_id, s.tipo, s.total_despesas, v_uid) loop
    insert into imobdesk.sf_aprovacao (solicitacao_id, ciclo, nivel, papel, aprovador_id, substituto_id, status, prazo_em)
    values (p_id, v_ciclo, c.nivel, c.papel, c.aprovador_id, c.substituto_id,
            case when not c.exigido then 'nao_exigido'
                 when c.pulado then 'pulado'
                 when v_modo <> 'sequencial' or c.nivel = v_primeiro then 'aguardando'
                 else 'pendente' end,
            case when c.exigido and not c.pulado and (v_modo <> 'sequencial' or c.nivel = v_primeiro) then now() + make_interval(hours => v_prazo) end);
  end loop;

  delete from imobdesk.sf_regra_resultado where solicitacao_id = p_id;
  insert into imobdesk.sf_regra_resultado (solicitacao_id, item_id, regra_codigo, resultado, detalhe)
  select p_id, nullif(x ->> 'itemId', '')::bigint, x ->> 'codigo', x ->> 'resultado', x ->> 'detalhe' from jsonb_array_elements(v_checks) x;

  update imobdesk.sf_solicitacao
     set status = 'em_aprovacao', ciclo = v_ciclo, etapa_atual = v_primeiro, enviado_em = now(), atualizado_em = now(),
         aceite_em = now(),
         aceite_ip = nullif(btrim(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1)), ''),
         aceite_user_agent = left(v_headers ->> 'user-agent', 400)
   where id = p_id;
  perform imobdesk.sf_registrar_evento(p_id, case when s.status = 'devolvida' then 'reenviada' else 'enviada' end,
                                                 jsonb_build_object('ciclo', v_ciclo, 'total', s.total_despesas, 'aceite', true));
  return jsonb_build_object('status', 'em_aprovacao', 'ciclo', v_ciclo, 'alertas', (select count(*) from jsonb_array_elements(v_checks) x where x ->> 'resultado' = 'alerta'));
end;
$$;

/** Cancela: em rascunho, devolvida, ou em aprovação antes da 1ª aprovação do ciclo. */
create or replace function imobdesk.sf_cancelar(p_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  s imobdesk.sf_solicitacao;
begin
  perform imobdesk.sf_exigir_login();
  select * into s from imobdesk.sf_solicitacao where id = p_id;
  if not found or s.solicitante_id <> (select auth.uid()) then perform imobdesk.erro('NOT_FOUND', 'Solicitação não encontrada.'); end if;
  if not (s.status in ('rascunho', 'devolvida')
          or (s.status = 'em_aprovacao' and not exists (select 1 from imobdesk.sf_aprovacao a
                                                         where a.solicitacao_id = p_id and a.ciclo = s.ciclo and a.status = 'aprovado'))) then
    perform imobdesk.erro('INVALID_INPUT', 'Só dá para cancelar antes da primeira aprovação.');
  end if;
  update imobdesk.sf_solicitacao set status = 'cancelada', atualizado_em = now() where id = p_id;
  update imobdesk.sf_aprovacao set status = 'nao_exigido', prazo_em = null
   where solicitacao_id = p_id and ciclo = s.ciclo and status in ('aguardando', 'pendente');
  perform imobdesk.sf_registrar_evento(p_id, 'cancelada');
end;
$$;

-- ---------- Leitura ----------

/** Detalhe completo para o formulário e para a tela de detalhe (quem pode ver). */
create or replace function imobdesk.sf_detalhe(p_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s imobdesk.sf_solicitacao;
  v_uid uuid := imobdesk.sf_exigir_login();
  v_doc text;
begin
  select * into s from imobdesk.sf_solicitacao where id = p_id;
  if not found or not imobdesk.sf_pode_ver(p_id) then perform imobdesk.erro('NOT_FOUND', 'Solicitação não encontrada.'); end if;
  select p.documento into v_doc from imobdesk.at_pessoas p where p.id = s.pessoa_id;
  return jsonb_build_object(
    'id', s.id, 'numero', s.numero, 'tipo', s.tipo, 'status', s.status, 'ciclo', s.ciclo,
    'podeEditar', s.solicitante_id = v_uid and s.status in ('rascunho', 'devolvida'),
    'podeCancelar', s.solicitante_id = v_uid and (s.status in ('rascunho', 'devolvida')
                    or (s.status = 'em_aprovacao' and not exists (select 1 from imobdesk.sf_aprovacao a where a.solicitacao_id = s.id and a.ciclo = s.ciclo and a.status = 'aprovado'))),
    'solicitante', jsonb_build_object('id', s.solicitante_id, 'nome', (select u.nome from imobdesk.usuarios u where u.id = s.solicitante_id),
                                      'cpfMascarado', case when v_doc ~ '^\d{11}$' then '***.' || substr(v_doc, 4, 3) || '.' || substr(v_doc, 7, 3) || '-**' end),
    'setor', (select jsonb_build_object('id', st.id, 'nome', st.nome) from imobdesk.at_setores st where st.id = s.setor_id),
    'competencia', s.competencia, 'periodoDe', s.periodo_de, 'periodoAte', s.periodo_ate, 'centroCusto', s.centro_custo,
    'valorFundoFixo', s.valor_fundo_fixo, 'saldoInicial', s.saldo_inicial, 'totalDespesas', s.total_despesas, 'saldoFinal', s.saldo_final,
    'valorGlosado', s.valor_glosado, 'valorAPagar', s.valor_a_pagar, 'pagarAte', s.pagar_ate,
    'enviadoEm', s.enviado_em, 'aceiteEm', s.aceite_em, 'criadoEm', s.criado_em, 'atualizadoEm', s.atualizado_em,
    'itens', coalesce((select jsonb_agg(jsonb_build_object(
                'id', i.id, 'ordem', i.ordem, 'data', i.data, 'valor', i.valor, 'descricao', i.descricao_favorecido, 'motivo', i.motivo,
                'categoriaId', i.categoria_id, 'origem', i.origem, 'statusConferencia', i.status_conferencia,
                'anexos', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'nome', a.nome_arquivo, 'path', a.storage_path, 'mime', a.mime, 'tamanho', a.tamanho)
                                                     order by a.id)
                                    from imobdesk.sf_anexo a where a.item_id = i.id), '[]'))
              order by i.ordem) from imobdesk.sf_item i where i.solicitacao_id = s.id), '[]'),
    'aprovacoes', coalesce((select jsonb_agg(jsonb_build_object(
                'ciclo', a.ciclo, 'nivel', a.nivel, 'papel', a.papel, 'status', a.status, 'comentario', a.comentario,
                'aprovador', (select u.nome from imobdesk.usuarios u where u.id = a.aprovador_id),
                'substituto', (select u.nome from imobdesk.usuarios u where u.id = a.substituto_id),
                'prazoEm', a.prazo_em, 'decididoEm', a.decidido_em)
              order by a.ciclo, a.nivel) from imobdesk.sf_aprovacao a where a.solicitacao_id = s.id), '[]'),
    'eventos', coalesce((select jsonb_agg(jsonb_build_object('tipo', e.tipo, 'em', e.criado_em, 'payload', e.payload,
                                                              'ator', (select u.nome from imobdesk.usuarios u where u.id = e.ator_id))
              order by e.criado_em) from imobdesk.sf_evento e where e.solicitacao_id = s.id), '[]'),
    -- Painel "Quem vai aprovar": a cadeia que o envio aplicaria agora (até enviar).
    'cadeiaPrevista', case when s.status in ('rascunho', 'devolvida') then coalesce((
              select jsonb_agg(jsonb_build_object('nivel', c.nivel, 'papel', c.papel, 'exigido', c.exigido, 'pulado', c.pulado, 'motivo', c.motivo,
                                                  'aprovador', (select u.nome from imobdesk.usuarios u where u.id = c.aprovador_id),
                                                  'substituto', (select u.nome from imobdesk.usuarios u where u.id = c.substituto_id))
                     order by c.nivel)
              from imobdesk.sf_montar_cadeia(s.setor_id, s.tipo, s.total_despesas, s.solicitante_id) c), '[]') end,
    'categorias', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'nome', c.nome) order by c.ordem, c.nome)
                            from imobdesk.sf_categoria_motivo c where c.ativo), '[]')
  );
end;
$$;

/** Tela 1: contadores e histórico do próprio colaborador. */
create or replace function imobdesk.sf_minhas()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.sf_exigir_login();
  v_mes date := date_trunc('month', current_date)::date;
begin
  return jsonb_build_object(
    'kpis', (select jsonb_build_object(
               'rascunho', count(*) filter (where s.status = 'rascunho'),
               'emAprovacao', count(*) filter (where s.status = 'em_aprovacao'),
               'devolvida', count(*) filter (where s.status in ('devolvida', 'pendencia_solicitante')),
               'noFinanceiro', count(*) filter (where s.status in ('em_conferencia', 'lancamento_gerado', 'pagamento_programado')),
               'aComprovar', count(*) filter (where s.status = 'comprovacao_pendente'),
               'pagasMes', count(*) filter (where s.status in ('paga', 'encerrada') and s.atualizado_em >= v_mes),
               'pagasMesValor', coalesce(sum(s.valor_a_pagar) filter (where s.status in ('paga', 'encerrada') and s.atualizado_em >= v_mes), 0))
             from imobdesk.sf_solicitacao s where s.solicitante_id = v_uid),
    'temFundoFixo', exists (select 1 from imobdesk.sf_fundo_fixo f where f.usuario_id = v_uid and f.ativo),
    'temSetor', imobdesk.sf_setor_do_usuario(v_uid) is not null,
    'lista', coalesce((select jsonb_agg(jsonb_build_object(
                 'id', s.id, 'numero', s.numero, 'tipo', s.tipo, 'status', s.status, 'competencia', s.competencia, 'vencimento', s.vencimento,
                 'valor', coalesce(s.valor_adiantamento, s.total_despesas), 'pagarAte', s.pagar_ate, 'atualizadoEm', s.atualizado_em,
                 'etapa', (select jsonb_build_object('papel', a.papel, 'nivel', a.nivel,
                                                     'de', (select count(*) from imobdesk.sf_aprovacao b where b.solicitacao_id = s.id and b.ciclo = s.ciclo and b.status not in ('nao_exigido', 'pulado')))
                           from imobdesk.sf_aprovacao a where a.solicitacao_id = s.id and a.ciclo = s.ciclo and a.status = 'aguardando'
                           order by a.nivel limit 1))
               order by s.atualizado_em desc)
               from imobdesk.sf_solicitacao s where s.solicitante_id = v_uid and s.status <> 'cancelada'), '[]')
  );
end;
$$;

-- ---------- Permissões de execução ----------
do $$
declare
  f text;
begin
  foreach f in array array[
    'sf_rascunho_criar(text)', 'sf_rascunho_salvar(jsonb)', 'sf_anexo_registrar(jsonb)', 'sf_anexo_remover(bigint)', 'sf_checagens(bigint)',
    'sf_enviar(bigint, boolean)', 'sf_cancelar(bigint)', 'sf_detalhe(bigint)', 'sf_minhas()',
    'sf_storage_pode_ler(text)', 'sf_storage_pode_gravar(text)'
  ] loop
    execute format('revoke execute on function imobdesk.%s from public, anon', f);
    execute format('grant execute on function imobdesk.%s to authenticated, service_role', f);
  end loop;
  foreach f in array array['sf_exigir_editavel(bigint)', 'sf_registrar_evento(bigint, text, jsonb)', 'sf_montar_cadeia(bigint, text, numeric, uuid)', 'sf_recalcular(bigint)'] loop
    execute format('revoke execute on function imobdesk.%s from public, anon, authenticated', f);
    execute format('grant execute on function imobdesk.%s to service_role', f);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
