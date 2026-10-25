-- Solicitações Financeiras, Fase 1: regras de acesso e RPCs dos cadastros (CONTEXTO.md, seções 1, 4, 6 e 9).
-- Quem é quem:
--   colaborador  = qualquer usuário: vê só as próprias solicitações;
--   aprovador    = está numa etapa (sf_aprovacao) como aprovador ou substituto;
--   financeiro   = o setor da pessoa (ou um setor que ele gere) tem sf_financeiro; vê de em_conferencia em diante;
--   admin        = Admin e Super admin: vê tudo e mantém os cadastros.
-- Usuário → pessoa pelo e-mail em at_pessoa_contatos → setor (at_pessoas.setor_id) e CPF (at_pessoas.documento).
-- Só aditiva: funções novas.

-- ---------- Quem é o usuário ----------

create or replace function imobdesk.sf_pessoa_do_usuario(p_usuario uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select c.pessoa_id
  from imobdesk.usuarios u
  join imobdesk.at_pessoa_contatos c on c.tipo = 'email' and lower(btrim(c.valor)) = u.email
  join imobdesk.at_pessoas p on p.id = c.pessoa_id and p.tipo = 'pessoa'
  where u.id = p_usuario
  order by c.principal desc, (p.setor_id is null), c.pessoa_id
  limit 1;
$$;

create or replace function imobdesk.sf_setor_do_usuario(p_usuario uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select p.setor_id from imobdesk.at_pessoas p where p.id = imobdesk.sf_pessoa_do_usuario(p_usuario);
$$;

/** Conferente: o setor da pessoa é financeiro, ou ela é gestora de um setor financeiro. */
create or replace function imobdesk.sf_eh_financeiro(p_usuario uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from imobdesk.at_setores s where s.sf_financeiro and s.ativo and s.id = imobdesk.sf_setor_do_usuario(p_usuario))
      or exists (select 1 from imobdesk.at_setor_gestores g join imobdesk.at_setores s on s.id = g.setor_id
                 where g.usuario_id = p_usuario and s.sf_financeiro and s.ativo);
$$;

/** Status que o Financeiro enxerga (de em_conferencia em diante). */
create or replace function imobdesk.sf_status_financeiro(p_status text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_status in ('em_conferencia', 'pendencia_solicitante', 'lancamento_gerado', 'pagamento_programado', 'paga',
                      'comprovacao_pendente', 'comprovacao_em_conferencia', 'devolucao_pendente', 'encerrada');
$$;

/** Regra única de visibilidade de uma solicitação (equivale às policies da seção 6, aplicada dentro das RPCs). */
create or replace function imobdesk.sf_pode_ver(p_solicitacao bigint)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from imobdesk.sf_solicitacao s
    where s.id = p_solicitacao
      and (s.solicitante_id = (select auth.uid())
           or imobdesk.ch_eh_admin()
           or exists (select 1 from imobdesk.sf_aprovacao a
                      where a.solicitacao_id = s.id and (select auth.uid()) in (a.aprovador_id, a.substituto_id))
           or (imobdesk.sf_status_financeiro(s.status) and imobdesk.sf_eh_financeiro((select auth.uid()))))
  );
$$;

create or replace function imobdesk.sf_exigir_login()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or imobdesk.perfil_usuario_atual() is null then
    perform imobdesk.erro('FORBIDDEN', 'Entre no portal para usar as solicitações financeiras.');
  end if;
  return (select auth.uid());
end;
$$;

create or replace function imobdesk.sf_exigir_admin()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not imobdesk.ch_eh_admin() then
    perform imobdesk.erro('FORBIDDEN', 'Só Admin e Super admin alteram os cadastros financeiros.');
  end if;
  return (select auth.uid());
end;
$$;

/** Lê a configuração de setores: Admin ou quem cadastra Setores e números. */
create or replace function imobdesk.sf_exigir_leitura_setores()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (imobdesk.ch_eh_admin() or imobdesk.tem_permissao('gestao_atendimento_setores')) then
    perform imobdesk.erro('FORBIDDEN', 'Sem acesso a Setores e números.');
  end if;
  return (select auth.uid());
end;
$$;

-- ---------- Contexto do usuário logado ----------

/** Cabeçalho dos formulários e menus: nome, CPF mascarado, setor e papéis. */
create or replace function imobdesk.sf_meu_contexto()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.sf_exigir_login();
  v_pessoa bigint := imobdesk.sf_pessoa_do_usuario(v_uid);
  v_doc text;
  v_setor record;
begin
  select p.documento into v_doc from imobdesk.at_pessoas p where p.id = v_pessoa;
  select s.id, s.nome, s.sf_setor_obra, s.sf_financeiro into v_setor
  from imobdesk.at_setores s where s.id = imobdesk.sf_setor_do_usuario(v_uid);
  return jsonb_build_object(
    'usuarioId', v_uid,
    'nome', (select u.nome from imobdesk.usuarios u where u.id = v_uid),
    'pessoaId', v_pessoa,
    -- CPF completo só no PDF e no SIENGE.
    'cpfMascarado', case when v_doc ~ '^\d{11}$' then '***.' || substr(v_doc, 4, 3) || '.' || substr(v_doc, 7, 3) || '-**' end,
    'setor', case when v_setor.id is null then null
                  else jsonb_build_object('id', v_setor.id, 'nome', v_setor.nome, 'obra', v_setor.sf_setor_obra, 'financeiro', v_setor.sf_financeiro) end,
    'ehAdmin', imobdesk.ch_eh_admin(),
    'ehFinanceiro', imobdesk.sf_eh_financeiro(v_uid),
    'ehAprovador', exists (select 1 from imobdesk.sf_setor_aprovador a where a.ativo and v_uid in (a.aprovador_id, a.substituto_id))
  );
end;
$$;

-- ---------- Setores: aba "Aprovação financeira" ----------

/** Coluna "Aprovação" da lista de setores. */
create or replace function imobdesk.sf_setores_resumo()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform imobdesk.sf_exigir_leitura_setores();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'setorId', s.id,
      'obra', s.sf_setor_obra,
      'financeiro', s.sf_financeiro,
      'niveisReembolso', (select count(*) from imobdesk.sf_setor_aprovador a where a.setor_id = s.id and a.ativo and a.tipo_solicitacao = 'reembolso_fundo_fixo'),
      'niveisAdiantamento', (select count(*) from imobdesk.sf_setor_aprovador a where a.setor_id = s.id and a.ativo and a.tipo_solicitacao = 'adiantamento'))
      order by s.id)
    from imobdesk.at_setores s), '[]');
end;
$$;

create or replace function imobdesk.sf_setor_config_obter(p_setor bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s imobdesk.at_setores%rowtype;
begin
  perform imobdesk.sf_exigir_leitura_setores();
  select * into s from imobdesk.at_setores where id = p_setor;
  if not found then perform imobdesk.erro('NOT_FOUND', 'Setor não encontrado.'); end if;
  return jsonb_build_object(
    'setorId', s.id,
    'setor', s.nome,
    'podeEditar', imobdesk.ch_eh_admin(),
    'obra', s.sf_setor_obra,
    'financeiro', s.sf_financeiro,
    'modoAprovacao', s.sf_modo_aprovacao,
    'prazoHoras', s.sf_prazo_horas,
    'acaoPrazoVencido', s.sf_acao_prazo_vencido,
    'centroCustoPadrao', s.sf_centro_custo_padrao,
    'prazoComprovacaoDias', s.sf_prazo_comprovacao_dias,
    'acaoComprovacaoVencida', s.sf_acao_comprovacao_vencida,
    'limiteAdiantamentosAbertos', s.sf_limite_adiantamentos_abertos,
    'pessoas', (select count(*) from imobdesk.at_pessoas p where p.setor_id = s.id and p.tipo = 'pessoa' and p.habilitada),
    -- Gestão do setor: sugerida como Gestor/Gerente (aprovado em 17/10/2026).
    'gestores', coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'nome', u.nome) order by u.nome)
                          from imobdesk.at_setor_gestores g join imobdesk.usuarios u on u.id = g.usuario_id
                          where g.setor_id = s.id), '[]'),
    'aprovadores', coalesce((select jsonb_agg(jsonb_build_object(
                               'tipo', a.tipo_solicitacao, 'ordem', a.ordem, 'papel', a.papel, 'condicao', a.condicao,
                               'aprovadorId', a.aprovador_id, 'aprovador', ua.nome,
                               'substitutoId', a.substituto_id, 'substituto', us.nome, 'alcadaMinima', a.alcada_minima)
                             order by a.tipo_solicitacao desc, a.ordem)
                             from imobdesk.sf_setor_aprovador a
                             join imobdesk.usuarios ua on ua.id = a.aprovador_id
                             left join imobdesk.usuarios us on us.id = a.substituto_id
                             where a.setor_id = s.id and a.ativo), '[]')
  );
end;
$$;

/** Usuários ativos para os campos Aprovador e Substituto. */
create or replace function imobdesk.sf_usuarios_opcoes()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform imobdesk.sf_exigir_leitura_setores();
  return coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'nome', u.nome) order by u.nome)
                   from imobdesk.usuarios u where u.status = 'active'), '[]');
end;
$$;

/**
 * Salva a aba inteira. Os aprovadores são regravados (as solicitações enviadas não mudam: a cadeia delas fica congelada
 * em sf_aprovacao). Adiantamento: papéis fixos, condição derivada do papel.
 */
create or replace function imobdesk.sf_setor_config_salvar(p jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := imobdesk.sf_exigir_admin();
  v_setor bigint := nullif(p ->> 'setorId', '')::bigint;
  v_item jsonb;
  v_ordem int;
  v_papel text;
  v_aprov uuid;
  v_subst uuid;
  v_alcada numeric(14,2);
  v_papeis text[] := '{}';
begin
  if not exists (select 1 from imobdesk.at_setores s where s.id = v_setor) then
    perform imobdesk.erro('NOT_FOUND', 'Setor não encontrado.');
  end if;
  if coalesce(p ->> 'modoAprovacao', 'sequencial') not in ('sequencial', 'paralelo', 'qualquer_um') then
    perform imobdesk.erro('INVALID_INPUT', 'Modo de aprovação inválido.', 'modoAprovacao');
  end if;
  if coalesce(nullif(p ->> 'prazoHoras', '')::int, 48) not between 1 and 720 then
    perform imobdesk.erro('INVALID_INPUT', 'O prazo por etapa vai de 1 a 720 horas.', 'prazoHoras');
  end if;
  if coalesce(nullif(p ->> 'prazoComprovacaoDias', '')::int, 30) not between 1 and 365 then
    perform imobdesk.erro('INVALID_INPUT', 'O prazo de comprovação vai de 1 a 365 dias.', 'prazoComprovacaoDias');
  end if;
  if nullif(p ->> 'limiteAdiantamentosAbertos', '')::int not between 1 and 99 then
    perform imobdesk.erro('INVALID_INPUT', 'O limite de adiantamentos em aberto vai de 1 a 99 (vazio = sem limite).', 'limiteAdiantamentosAbertos');
  end if;

  update imobdesk.at_setores
     set sf_setor_obra = coalesce((p ->> 'obra')::boolean, false),
         sf_financeiro = coalesce((p ->> 'financeiro')::boolean, false),
         sf_modo_aprovacao = coalesce(p ->> 'modoAprovacao', 'sequencial'),
         sf_prazo_horas = coalesce(nullif(p ->> 'prazoHoras', '')::int, 48),
         sf_acao_prazo_vencido = case when p ->> 'acaoPrazoVencido' = 'lembrar' then 'lembrar' else 'escalar' end,
         sf_centro_custo_padrao = left(nullif(btrim(p ->> 'centroCustoPadrao'), ''), 60),
         sf_prazo_comprovacao_dias = coalesce(nullif(p ->> 'prazoComprovacaoDias', '')::int, 30),
         sf_acao_comprovacao_vencida = case when p ->> 'acaoComprovacaoVencida' = 'avisar' then 'avisar' else 'avisar_bloquear' end,
         sf_limite_adiantamentos_abertos = nullif(p ->> 'limiteAdiantamentosAbertos', '')::int,
         sf_atualizado_em = now(), sf_atualizado_por = v_ator
   where id = v_setor;

  delete from imobdesk.sf_setor_aprovador where setor_id = v_setor;

  -- Reembolso e fundo fixo: ordem = posição na lista.
  v_ordem := 0;
  for v_item in select value from jsonb_array_elements(coalesce(p -> 'reembolso', '[]')) loop
    v_ordem := v_ordem + 1;
    v_papel := btrim(coalesce(v_item ->> 'papel', ''));
    v_aprov := nullif(v_item ->> 'aprovadorId', '')::uuid;
    v_subst := nullif(v_item ->> 'substitutoId', '')::uuid;
    v_alcada := coalesce(nullif(v_item ->> 'alcadaMinima', '')::numeric, 0);
    if length(v_papel) not between 2 and 40 then
      perform imobdesk.erro('INVALID_INPUT', format('Nível %s: informe o papel (ex.: Gestor).', v_ordem), 'reembolso');
    end if;
    if v_aprov is null or not exists (select 1 from imobdesk.usuarios u where u.id = v_aprov and u.status = 'active') then
      perform imobdesk.erro('INVALID_INPUT', format('Nível %s: escolha um aprovador ativo.', v_ordem), 'reembolso');
    end if;
    if v_subst = v_aprov then
      perform imobdesk.erro('INVALID_INPUT', format('Nível %s: o substituto não pode ser o próprio aprovador.', v_ordem), 'reembolso');
    end if;
    if v_alcada < 0 then
      perform imobdesk.erro('INVALID_INPUT', format('Nível %s: alçada mínima não pode ser negativa.', v_ordem), 'reembolso');
    end if;
    insert into imobdesk.sf_setor_aprovador (setor_id, tipo_solicitacao, ordem, papel, aprovador_id, substituto_id, condicao, alcada_minima, atualizado_por)
    values (v_setor, 'reembolso_fundo_fixo', v_ordem, v_papel, v_aprov, v_subst, case when v_alcada > 0 then 'valor_acima' else 'sempre' end, v_alcada, v_ator);
  end loop;

  -- Adiantamento: planejamento (obra) → gerente (sempre) → diretor e presidente (acima da alçada).
  for v_item in select value from jsonb_array_elements(coalesce(p -> 'adiantamento', '[]')) loop
    v_papel := v_item ->> 'papel';
    v_aprov := nullif(v_item ->> 'aprovadorId', '')::uuid;
    v_subst := nullif(v_item ->> 'substitutoId', '')::uuid;
    v_alcada := nullif(v_item ->> 'alcadaMinima', '')::numeric;
    if v_papel is null or v_papel not in ('planejamento', 'gerente', 'diretor', 'presidente') then
      perform imobdesk.erro('INVALID_INPUT', 'Nível do adiantamento inválido.', 'adiantamento');
    end if;
    if v_papel = any (v_papeis) then
      perform imobdesk.erro('INVALID_INPUT', format('O nível %s aparece duas vezes.', v_papel), 'adiantamento');
    end if;
    v_papeis := v_papeis || v_papel;
    continue when v_aprov is null;  -- nível sem aprovador = não configurado
    if not exists (select 1 from imobdesk.usuarios u where u.id = v_aprov and u.status = 'active') then
      perform imobdesk.erro('INVALID_INPUT', format('%s: escolha um aprovador ativo.', initcap(v_papel)), 'adiantamento');
    end if;
    if v_subst = v_aprov then
      perform imobdesk.erro('INVALID_INPUT', format('%s: o substituto não pode ser o próprio aprovador.', initcap(v_papel)), 'adiantamento');
    end if;
    if v_papel in ('diretor', 'presidente') and (v_alcada is null or v_alcada <= 0) then
      perform imobdesk.erro('INVALID_INPUT', format('%s: informe a partir de que valor ele aprova.', initcap(v_papel)), 'adiantamento');
    end if;
    insert into imobdesk.sf_setor_aprovador (setor_id, tipo_solicitacao, ordem, papel, aprovador_id, substituto_id, condicao, alcada_minima, atualizado_por)
    values (v_setor, 'adiantamento', array_position(array['planejamento', 'gerente', 'diretor', 'presidente'], v_papel), v_papel, v_aprov, v_subst,
            case v_papel when 'planejamento' then 'obra' when 'gerente' then 'sempre' else 'valor_acima' end,
            case when v_papel in ('diretor', 'presidente') then v_alcada end, v_ator);
  end loop;

  perform imobdesk.registrar_auditoria(v_ator, 'financeiro', 'update', 'Setor: aprovação financeira salva', null, p, v_setor::text);
end;
$$;

-- ---------- Cadastros financeiros ----------

create or replace function imobdesk.sf_cadastros_lista()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform imobdesk.sf_exigir_admin();
  return jsonb_build_object(
    'fundos', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'usuarioId', f.usuario_id, 'usuario', u.nome,
                                                             'setor', (select s.nome from imobdesk.at_setores s where s.id = imobdesk.sf_setor_do_usuario(u.id)),
                                                             'valor', f.valor, 'vigenteDesde', f.vigente_desde) order by u.nome)
                        from imobdesk.sf_fundo_fixo f join imobdesk.usuarios u on u.id = f.usuario_id where f.ativo), '[]'),
    'categorias', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'nome', c.nome, 'descricao', c.descricao, 'palavrasChave', c.palavras_chave,
                                                                 'tetoValor', c.teto_valor, 'ativo', c.ativo) order by c.ordem, c.nome)
                            from imobdesk.sf_categoria_motivo c), '[]'),
    'regras', coalesce((select jsonb_agg(jsonb_build_object('codigo', r.codigo, 'nome', r.nome, 'descricao', r.descricao, 'aplicaA', r.aplica_a,
                                                             'severidade', r.severidade, 'ativo', r.ativo, 'parametros', r.parametros) order by left(r.codigo, 1) desc, r.codigo)
                        from imobdesk.sf_regra r), '[]'),
    'usuarios', coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'nome', u.nome) order by u.nome)
                          from imobdesk.usuarios u where u.status = 'active'), '[]')
  );
end;
$$;

/** Valor do fundo fixo: o novo valor encerra o anterior (fica o histórico). Valor 0 = retira o fundo fixo. */
create or replace function imobdesk.sf_fundo_fixo_salvar(p jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := imobdesk.sf_exigir_admin();
  v_usuario uuid := nullif(p ->> 'usuarioId', '')::uuid;
  v_valor numeric(14,2) := coalesce(nullif(p ->> 'valor', '')::numeric, 0);
begin
  if v_usuario is null or not exists (select 1 from imobdesk.usuarios u where u.id = v_usuario) then
    perform imobdesk.erro('INVALID_INPUT', 'Escolha o colaborador.', 'usuarioId');
  end if;
  if v_valor < 0 then perform imobdesk.erro('INVALID_INPUT', 'O valor não pode ser negativo.', 'valor'); end if;
  update imobdesk.sf_fundo_fixo set ativo = false, atualizado_em = now(), atualizado_por = v_ator where usuario_id = v_usuario and ativo;
  if v_valor > 0 then
    insert into imobdesk.sf_fundo_fixo (usuario_id, valor, vigente_desde, atualizado_por)
    values (v_usuario, v_valor, coalesce(nullif(p ->> 'vigenteDesde', '')::date, current_date), v_ator);
  end if;
  perform imobdesk.registrar_auditoria(v_ator, 'financeiro', 'update', 'Fundo fixo do colaborador salvo', null, p, v_usuario::text);
end;
$$;

create or replace function imobdesk.sf_categoria_salvar(p jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := imobdesk.sf_exigir_admin();
  v_id bigint := nullif(p ->> 'id', '')::bigint;
  v_nome text := regexp_replace(btrim(coalesce(p ->> 'nome', '')), '\s+', ' ', 'g');
  v_teto numeric(14,2) := nullif(p ->> 'tetoValor', '')::numeric;
  v_chaves text[];
begin
  if length(v_nome) not between 2 and 60 then perform imobdesk.erro('INVALID_INPUT', 'Informe o nome (2 a 60 letras).', 'nome'); end if;
  if exists (select 1 from imobdesk.sf_categoria_motivo c where lower(btrim(c.nome)) = lower(v_nome) and c.id is distinct from v_id) then
    perform imobdesk.erro('DUPLICATE', 'Já existe uma categoria com esse nome.', 'nome');
  end if;
  if v_teto is not null and v_teto <= 0 then perform imobdesk.erro('INVALID_INPUT', 'O teto precisa ser maior que zero (vazio = sem teto).', 'tetoValor'); end if;
  select coalesce(array_agg(distinct lower(btrim(x))) filter (where length(btrim(x)) >= 2), '{}') into v_chaves
  from jsonb_array_elements_text(coalesce(p -> 'palavrasChave', '[]')) x;
  if v_id is null then
    insert into imobdesk.sf_categoria_motivo (nome, descricao, palavras_chave, teto_valor, ativo, ordem, atualizado_por)
    values (v_nome, left(nullif(btrim(p ->> 'descricao'), ''), 300), v_chaves, v_teto, coalesce((p ->> 'ativo')::boolean, true),
            coalesce((select max(ordem) from imobdesk.sf_categoria_motivo), 0) + 1, v_ator)
    returning id into v_id;
  else
    update imobdesk.sf_categoria_motivo
       set nome = v_nome, descricao = left(nullif(btrim(p ->> 'descricao'), ''), 300), palavras_chave = v_chaves, teto_valor = v_teto,
           ativo = coalesce((p ->> 'ativo')::boolean, ativo), atualizado_em = now(), atualizado_por = v_ator
     where id = v_id;
    if not found then perform imobdesk.erro('NOT_FOUND', 'Categoria não encontrada.'); end if;
  end if;
  perform imobdesk.registrar_auditoria(v_ator, 'financeiro', 'update', format('Categoria de motivo "%s" salva', v_nome), null, p, v_id::text);
  return v_id;
end;
$$;

/** Liga/desliga, severidade e parâmetros de uma regra. */
create or replace function imobdesk.sf_regra_salvar(p jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := imobdesk.sf_exigir_admin();
  v_cod text := p ->> 'codigo';
  v_param jsonb := coalesce(p -> 'parametros', '{}');
begin
  if coalesce(p ->> 'severidade', 'alerta') not in ('alerta', 'bloqueio') then
    perform imobdesk.erro('INVALID_INPUT', 'Severidade inválida.', 'severidade');
  end if;
  if jsonb_typeof(v_param) <> 'object' then perform imobdesk.erro('INVALID_INPUT', 'Parâmetros inválidos.', 'parametros'); end if;
  if v_cod = 'R02' and coalesce((v_param ->> 'limiar')::numeric, 0.8) not between 0.5 and 1 then
    perform imobdesk.erro('INVALID_INPUT', 'O limiar de legibilidade vai de 50% a 100%.', 'parametros');
  end if;
  if v_cod = 'R04' and coalesce((v_param ->> 'tolerancia')::numeric, 0) < 0 then
    perform imobdesk.erro('INVALID_INPUT', 'A tolerância não pode ser negativa.', 'parametros');
  end if;
  if v_cod = 'R09' and (v_param ->> 'dias') is not null and (v_param ->> 'dias')::int not between 1 and 365 then
    perform imobdesk.erro('INVALID_INPUT', 'O prazo de envio vai de 1 a 365 dias.', 'parametros');
  end if;
  update imobdesk.sf_regra
     set ativo = coalesce((p ->> 'ativo')::boolean, ativo), severidade = coalesce(p ->> 'severidade', severidade),
         parametros = parametros || v_param, atualizado_em = now(), atualizado_por = v_ator
   where codigo = v_cod;
  if not found then perform imobdesk.erro('NOT_FOUND', 'Regra não encontrada.'); end if;
  perform imobdesk.registrar_auditoria(v_ator, 'financeiro', 'update', format('Regra %s salva', v_cod), null, p, v_cod);
end;
$$;

-- ---------- Solicitações: leitura com a regra de visibilidade ----------

/**
 * Lista o que o usuário pode ver. Escopo: 'minhas' (solicitante), 'aprovacoes' (é ou foi etapa), 'financeiro'
 * (conferente, de em_conferencia em diante) ou 'todas' (tudo o que ele vê).
 */
create or replace function imobdesk.sf_solicitacoes_listar(p_escopo text default 'todas')
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.sf_exigir_login();
  v_fin boolean := imobdesk.sf_eh_financeiro(v_uid);
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', s.id, 'numero', s.numero, 'tipo', s.tipo, 'status', s.status, 'solicitante', u.nome,
      'setor', (select st.nome from imobdesk.at_setores st where st.id = s.setor_id),
      'valor', coalesce(s.valor_adiantamento, s.total_despesas), 'pagarAte', s.pagar_ate, 'atualizadoEm', s.atualizado_em)
      order by s.atualizado_em desc)
    from imobdesk.sf_solicitacao s
    join imobdesk.usuarios u on u.id = s.solicitante_id
    where imobdesk.sf_pode_ver(s.id)
      and case coalesce(p_escopo, 'todas')
            when 'minhas' then s.solicitante_id = v_uid
            when 'aprovacoes' then exists (select 1 from imobdesk.sf_aprovacao a where a.solicitacao_id = s.id and v_uid in (a.aprovador_id, a.substituto_id))
            when 'financeiro' then (v_fin or imobdesk.ch_eh_admin()) and imobdesk.sf_status_financeiro(s.status)
            else true
          end), '[]');
end;
$$;

-- ---------- Permissões de execução ----------
do $$
declare
  f text;
begin
  foreach f in array array[
    'sf_meu_contexto()', 'sf_setores_resumo()', 'sf_setor_config_obter(bigint)', 'sf_usuarios_opcoes()', 'sf_setor_config_salvar(jsonb)',
    'sf_cadastros_lista()', 'sf_fundo_fixo_salvar(jsonb)', 'sf_categoria_salvar(jsonb)', 'sf_regra_salvar(jsonb)', 'sf_solicitacoes_listar(text)'
  ] loop
    execute format('revoke execute on function imobdesk.%s from public, anon', f);
    execute format('grant execute on function imobdesk.%s to authenticated, service_role', f);
  end loop;
  -- Auxiliares: só dentro das RPCs.
  foreach f in array array[
    'sf_pessoa_do_usuario(uuid)', 'sf_setor_do_usuario(uuid)', 'sf_eh_financeiro(uuid)', 'sf_status_financeiro(text)', 'sf_pode_ver(bigint)',
    'sf_exigir_login()', 'sf_exigir_admin()', 'sf_exigir_leitura_setores()'
  ] loop
    execute format('revoke execute on function imobdesk.%s from public, anon, authenticated', f);
    execute format('grant execute on function imobdesk.%s to service_role', f);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
