-- Solicitações Financeiras — App Financeiro por perfil, Fase 1 (docs/PLANO-app-financeiro-perfis.md, decisões D1–D5 e P1
-- aprovadas pelo Wagner em 23/10/2026). Aditiva: uma função nova e quatro redefinições que mantêm os campos de hoje.
--   D1: gestor de setor = Gestão do setor em Setores e números (at_setor_gestores). Só ele presta contas do fundo fixo.
--   D2/D3: Aprovações = aprovador ou substituto + permissão sf_aprovacoes; Conferência = setor financeiro + permissão
--          sf_conferencia; Cadastros = Admin. A regra fica no bloco `acesso` de sf_meu_contexto, lido pelo app e pelo portal.
--   P1: a prestação de contas já criada segue até o fim; o fundo fixo novo de quem não é gestor é recusado; Cadastros
--       mostra quem tem fundo e não é gestor.

-- ---------- Gestor do setor ----------
/** A pessoa está em "Gestão do setor" de algum setor ativo. */
create or replace function imobdesk.sf_eh_gestor(p_usuario uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from imobdesk.at_setor_gestores g join imobdesk.at_setores s on s.id = g.setor_id
                 where g.usuario_id = p_usuario and s.ativo);
$$;

/** Aprovador ou substituto ativo na aba Aprovação financeira, ou substituto por período vigente. */
create or replace function imobdesk.sf_eh_aprovador(p_usuario uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from imobdesk.sf_setor_aprovador a where a.ativo and p_usuario in (a.aprovador_id, a.substituto_id))
      or exists (select 1 from imobdesk.sf_substituicao x where x.substituto_id = p_usuario and current_date between x.de and x.ate);
$$;

-- ---------- Contexto (redefinida: acrescenta ehGestor e o bloco acesso) ----------
/**
 * Quem é o usuário e o que ele pode abrir nas Solicitações Financeiras. O bloco `acesso` é a regra única de quem vê o
 * quê, no app (App do solicitante › Financeiro) e no menu do portal. As RPCs de cada tela continuam conferindo o papel.
 */
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
  v_admin boolean := imobdesk.ch_eh_admin();
  v_financeiro boolean := imobdesk.sf_eh_financeiro(v_uid);
  v_gestor boolean := imobdesk.sf_eh_gestor(v_uid);
  v_bloqueio text;
begin
  select p.documento into v_doc from imobdesk.at_pessoas p where p.id = v_pessoa;
  select s.id, s.nome, s.sf_setor_obra, s.sf_financeiro, s.sf_acao_comprovacao_vencida into v_setor
  from imobdesk.at_setores s where s.id = imobdesk.sf_setor_do_usuario(v_uid);
  -- Mesma regra da A06 em sf_rascunho_criar.
  if v_setor.sf_acao_comprovacao_vencida = 'avisar_bloquear' and exists (
       select 1 from imobdesk.sf_solicitacao s
       where s.solicitante_id = v_uid and s.tipo = 'adiantamento' and s.status = 'comprovacao_pendente' and s.prazo_comprovacao < current_date) then
    v_bloqueio := 'Você tem adiantamento com comprovação vencida. Envie a comprovação antes de pedir outro adiantamento.';
  end if;
  return jsonb_build_object(
    'usuarioId', v_uid,
    'nome', (select u.nome from imobdesk.usuarios u where u.id = v_uid),
    'pessoaId', v_pessoa,
    -- CPF completo só no PDF e no SIENGE.
    'cpfMascarado', case when v_doc ~ '^\d{11}$' then '***.' || substr(v_doc, 4, 3) || '.' || substr(v_doc, 7, 3) || '-**' end,
    'setor', case when v_setor.id is null then null
                  else jsonb_build_object('id', v_setor.id, 'nome', v_setor.nome, 'obra', v_setor.sf_setor_obra, 'financeiro', v_setor.sf_financeiro) end,
    'ehAdmin', v_admin,
    'ehFinanceiro', v_financeiro,
    'ehAprovador', exists (select 1 from imobdesk.sf_setor_aprovador a where a.ativo and v_uid in (a.aprovador_id, a.substituto_id)),
    'ehGestor', v_gestor,
    'acesso', jsonb_build_object(
      'reembolso', v_setor.id is not null,
      'fundoFixo', v_setor.id is not null and v_gestor,
      'temValorFundo', exists (select 1 from imobdesk.sf_fundo_fixo f where f.usuario_id = v_uid and f.ativo),
      'adiantamento', v_setor.id is not null and v_bloqueio is null,
      'adiantamentoBloqueio', v_bloqueio,
      'aprovacoes', v_admin or (imobdesk.sf_eh_aprovador(v_uid) and imobdesk.tem_permissao('sf_aprovacoes')),
      'conferencia', v_admin or (v_financeiro and imobdesk.tem_permissao('sf_conferencia')),
      'cadastros', v_admin
    )
  );
end;
$$;

-- ---------- Minhas solicitações (redefinida: fundo fixo só para gestor) ----------
/** Tela 1: contadores e histórico do próprio colaborador. temFundoFixo = gestor do setor com valor cadastrado. */
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
  v_gestor boolean := imobdesk.sf_eh_gestor(v_uid);
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
    'temFundoFixo', v_gestor and exists (select 1 from imobdesk.sf_fundo_fixo f where f.usuario_id = v_uid and f.ativo),
    'ehGestor', v_gestor,
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

-- ---------- Rascunho (redefinida a partir da Fase 5B: fundo fixo só para gestor) ----------
/** Cria o rascunho. Fundo fixo exige gestor do setor e traz o valor e o saldo inicial; adiantamento é recusado com comprovação vencida (A06). */
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
  st imobdesk.at_setores;
begin
  if p_tipo not in ('reembolso', 'fundo_fixo', 'adiantamento') then
    perform imobdesk.erro('INVALID_INPUT', 'Tipo de solicitação inválido.', 'tipo');
  end if;
  if v_setor is null then
    perform imobdesk.erro('INVALID_INPUT', 'Seu cadastro de Pessoas está sem setor. Peça ao administrador para definir o seu setor.');
  end if;
  select * into st from imobdesk.at_setores where id = v_setor;
  if p_tipo = 'adiantamento' then
    if st.sf_acao_comprovacao_vencida = 'avisar_bloquear' and exists (
         select 1 from imobdesk.sf_solicitacao s
         where s.solicitante_id = v_uid and s.tipo = 'adiantamento' and s.status = 'comprovacao_pendente' and s.prazo_comprovacao < current_date) then
      perform imobdesk.erro('INVALID_INPUT', 'Você tem adiantamento com comprovação vencida. Envie a comprovação antes de pedir outro adiantamento.');
    end if;
    insert into imobdesk.sf_solicitacao (tipo, solicitante_id, pessoa_id, setor_id, competencia, centro_custo, obra, forma_pagamento, tipo_conta,
                                                   total_despesas, valor_a_pagar)
    values ('adiantamento', v_uid, imobdesk.sf_pessoa_do_usuario(v_uid), v_setor, v_mes, st.sf_centro_custo_padrao,
            case when st.sf_setor_obra then st.nome end, 'deposito', 'corrente', 0, 0)
    returning id into v_id;
    perform imobdesk.sf_registrar_evento(v_id, 'criada', jsonb_build_object('tipo', p_tipo));
    return v_id;
  end if;
  if p_tipo = 'fundo_fixo' then
    -- D1: só o gestor do setor. A prestação já criada segue (as demais RPCs não olham o gestor).
    if not imobdesk.sf_eh_gestor(v_uid) then
      perform imobdesk.erro('FORBIDDEN', 'O fundo fixo é só para o gestor do setor (Gestão do setor em Setores e números).');
    end if;
    select f.valor into v_fundo from imobdesk.sf_fundo_fixo f where f.usuario_id = v_uid and f.ativo;
    if v_fundo is null then
      perform imobdesk.erro('INVALID_INPUT', 'Você não tem fundo fixo cadastrado. Peça ao Financeiro para cadastrar em Cadastros financeiros › Fundo fixo.');
    end if;
    select * into v_ant from imobdesk.sf_solicitacao s
    where s.solicitante_id = v_uid and s.tipo = 'fundo_fixo' and s.status not in ('rascunho', 'cancelada', 'reprovada')
    order by s.enviado_em desc nulls last, s.id desc limit 1;
    v_saldo := case when v_ant.id is null then v_fundo
                    else coalesce(v_ant.saldo_final, 0) + case when v_ant.status in ('paga', 'encerrada') then coalesce(v_ant.valor_a_pagar, 0) else 0 end end;
  end if;
  insert into imobdesk.sf_solicitacao (tipo, solicitante_id, pessoa_id, setor_id, competencia, periodo_de, periodo_ate, centro_custo,
                                                 valor_fundo_fixo, saldo_inicial, saldo_final, total_despesas, valor_a_pagar)
  values (p_tipo, v_uid, imobdesk.sf_pessoa_do_usuario(v_uid), v_setor, v_mes, v_mes, (v_mes + interval '1 month - 1 day')::date,
          st.sf_centro_custo_padrao, v_fundo, v_saldo, v_saldo, 0, 0)
  returning id into v_id;
  perform imobdesk.sf_registrar_evento(v_id, 'criada', jsonb_build_object('tipo', p_tipo));
  return v_id;
end;
$$;

-- ---------- Cadastros (redefinida: ehGestor no fundo fixo e nos usuários) ----------
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
                                                             'valor', f.valor, 'vigenteDesde', f.vigente_desde,
                                                             -- P1: quem tem fundo e não é gestor não abre prestação nova.
                                                             'ehGestor', imobdesk.sf_eh_gestor(u.id)) order by u.nome)
                        from imobdesk.sf_fundo_fixo f join imobdesk.usuarios u on u.id = f.usuario_id where f.ativo), '[]'),
    'categorias', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'nome', c.nome, 'descricao', c.descricao, 'palavrasChave', c.palavras_chave,
                                                                 'tetoValor', c.teto_valor, 'ativo', c.ativo) order by c.ordem, c.nome)
                            from imobdesk.sf_categoria_motivo c), '[]'),
    'regras', coalesce((select jsonb_agg(jsonb_build_object('codigo', r.codigo, 'nome', r.nome, 'descricao', r.descricao, 'aplicaA', r.aplica_a,
                                                             'severidade', r.severidade, 'ativo', r.ativo, 'parametros', r.parametros) order by left(r.codigo, 1) desc, r.codigo)
                        from imobdesk.sf_regra r), '[]'),
    'usuarios', coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'nome', u.nome, 'ehGestor', imobdesk.sf_eh_gestor(u.id)) order by u.nome)
                          from imobdesk.usuarios u where u.status = 'active'), '[]')
  );
end;
$$;

-- ---------- D3: ninguém que aprova hoje perde o menu Aprovações ----------
-- Marca a tela para o perfil de cada aprovador ou substituto ativo. Linha já existente (inclusive desligada) não muda.
insert into imobdesk.profile_permissions (role, permission_id, enabled)
select distinct u.perfil_key, 'sf_aprovacoes', true
from imobdesk.usuarios u
where u.perfil_key is not null and u.perfil_key <> 'super_admin'
  and exists (select 1 from imobdesk.sf_setor_aprovador a where a.ativo and u.id in (a.aprovador_id, a.substituto_id))
on conflict (role, permission_id) do nothing;

-- ---------- Permissões de execução ----------
do $$
declare
  f text;
begin
  foreach f in array array['sf_meu_contexto()', 'sf_minhas()', 'sf_rascunho_criar(text)', 'sf_cadastros_lista()'] loop
    execute format('revoke execute on function imobdesk.%s from public, anon', f);
    execute format('grant execute on function imobdesk.%s to authenticated, service_role', f);
  end loop;
  -- Auxiliares: só dentro das RPCs.
  foreach f in array array['sf_eh_gestor(uuid)', 'sf_eh_aprovador(uuid)'] loop
    execute format('revoke execute on function imobdesk.%s from public, anon, authenticated', f);
    execute format('grant execute on function imobdesk.%s to service_role', f);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
