-- "Receber chamado" no setor + "Setor" do solicitante no ticket (docs/PLANO-setor-solicitante.md, aprovado em 16/10/2026).
-- Setor com a flag marcada atende (fila, serviços, equipes, App do solicitante); desmarcado só identifica de onde vem quem pede.
-- A pessoa (solicitante) passa a ter setor; o ticket grava o setor dela na abertura (nulo = "A identificar").
-- Decisões do Wagner: recebem só TI, CFTV, Administrativo e Financeiro; grupos internos da planilha viram setores que
-- não recebem; trocar o setor no ticket atualiza também o cadastro da pessoa; corrigir Compliance e Relacionamento.
-- Só aditiva: colunas novas, gatilhos novos e RPCs redefinidas (com os campos novos) a partir da versão em produção.

-- ---------- Colunas ----------
alter table imobdesk.at_setores add column if not exists recebe_chamados boolean not null default false;
alter table imobdesk.at_pessoas add column if not exists setor_id bigint references imobdesk.at_setores (id) on delete set null;
alter table imobdesk.ch_tickets add column if not exists setor_solicitante_id bigint references imobdesk.at_setores (id) on delete set null;
create index if not exists at_pessoas_setor_idx on imobdesk.at_pessoas (setor_id) where setor_id is not null;
create index if not exists ch_tickets_setor_solicitante_idx on imobdesk.ch_tickets (setor_solicitante_id);

-- ---------- Carga inicial (só na primeira vez) ----------
do $$
begin
  if not exists (select 1 from imobdesk.at_setores where recebe_chamados) then
    update imobdesk.at_setores set recebe_chamados = true
    where lower(btrim(nome)) in ('ti', 'cftv', 'administrativo', 'financeiro');
  end if;
end;
$$;

update imobdesk.at_setores set nome = replace(nome, 'Complience', 'Compliance') where nome like '%Complience%';
update imobdesk.at_setores set nome = replace(nome, 'Relecionamento', 'Relacionamento') where nome like '%Relecionamento%';

-- Setores internos (grupos da planilha usuariosxsetores sem setor cadastrado): só solicitantes.
insert into imobdesk.at_setores (nome, recebe_chamados)
select x, false
from unnest(array['Obra', 'Obra - Arte Wave', 'Obra - Arte Jardim', 'Obra - Arte Design', 'Orçamento e Planejamento', 'Suprimentos',
                  'Incorporação', 'Jurídico', 'Projetos Executivos', 'CRC', 'Instalações', 'Presidência', 'RH', 'Alumínio', 'Esquadria', 'COP']) x
where not exists (select 1 from imobdesk.at_setores s where lower(btrim(s.nome)) = lower(x));

-- ---------- Regra do setor: só quem recebe chamado aparece no App do solicitante ----------
create or replace function imobdesk.at_setores_recebe_regra()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not new.recebe_chamados and new.cd_visivel then
    if tg_op = 'INSERT' or old.recebe_chamados then
      new.cd_visivel := false;  -- setor novo ou que deixou de receber: sai do app
    else
      perform imobdesk.erro('INVALID_INPUT', format('O setor %s não recebe chamados. Marque "Receber chamado" em Setores e números para mostrá-lo no App do solicitante.', new.nome));
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists at_setores_recebe_regra on imobdesk.at_setores;
create trigger at_setores_recebe_regra before insert or update of recebe_chamados, cd_visivel on imobdesk.at_setores
  for each row execute function imobdesk.at_setores_recebe_regra();

-- ---------- Ticket: setor do solicitante na abertura (todos os canais) ----------
create or replace function imobdesk.ch_tickets_setor_solicitante()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.setor_solicitante_id is null and new.solicitante_pessoa_id is not null then
      new.setor_solicitante_id := (select p.setor_id from imobdesk.at_pessoas p where p.id = new.solicitante_pessoa_id);
    end if;
  elsif new.solicitante_pessoa_id is distinct from old.solicitante_pessoa_id and new.setor_solicitante_id is not distinct from old.setor_solicitante_id then
    -- Trocou o solicitante sem escolher o setor: vale o setor do novo solicitante.
    new.setor_solicitante_id := (select p.setor_id from imobdesk.at_pessoas p where p.id = new.solicitante_pessoa_id);
  end if;
  return new;
end;
$$;
drop trigger if exists ch_tickets_setor_solicitante on imobdesk.ch_tickets;
create trigger ch_tickets_setor_solicitante before insert or update of solicitante_pessoa_id on imobdesk.ch_tickets
  for each row execute function imobdesk.ch_tickets_setor_solicitante();

-- ---------- Setores (lista para os campos "Setor" do ticket e da pessoa) ----------
create or replace function imobdesk.ch_setores_opcoes()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when auth.uid() is null then '[]'::jsonb else coalesce((
    select jsonb_agg(jsonb_build_object('id', s.id, 'nome', s.nome, 'recebeChamados', s.recebe_chamados) order by lower(s.nome))
    from imobdesk.at_setores s where s.ativo), '[]') end;
$$;

-- Ticket: troca o setor do solicitante; vale também para o cadastro da pessoa e para os tickets abertos dela sem setor.
create or replace function imobdesk.ch_ticket_setor_solicitante_definir(p_id bigint, p_setor bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  t imobdesk.ch_tickets := imobdesk.ch_ticket_visivel(p_id);
  v_uid uuid := (select auth.uid());
  v_de text := (select s.nome from imobdesk.at_setores s where s.id = t.setor_solicitante_id);
  v_para text;
  v_antes bigint;
begin
  if t.excluido_em is not null then perform imobdesk.erro('INVALID_INPUT', 'Ticket excluído.'); end if;
  if t.mesclado_em_id is not null then perform imobdesk.erro('INVALID_INPUT', format('Este ticket foi mesclado em #%s.', t.mesclado_em_id)); end if;
  if p_setor is not null then
    select s.nome into v_para from imobdesk.at_setores s where s.id = p_setor and (s.ativo or s.id = t.setor_solicitante_id);
    if v_para is null then perform imobdesk.erro('INVALID_INPUT', 'Setor inválido.', 'setorSolicitanteId'); end if;
  end if;
  if p_setor is not distinct from t.setor_solicitante_id then return; end if;
  update imobdesk.ch_tickets set setor_solicitante_id = p_setor where id = p_id;
  insert into imobdesk.ch_ticket_eventos (ticket_id, tipo, descricao, de, para, autor_id, autor_nome)
  values (p_id, 'setor_solicitante',
          case when p_setor is null then format('Setor do solicitante removido (era %s)', coalesce(v_de, 'A identificar'))
               else format('Setor do solicitante: %s', v_para) end,
          jsonb_build_object('setorSolicitanteId', t.setor_solicitante_id), jsonb_build_object('setorSolicitanteId', p_setor),
          v_uid, coalesce(imobdesk.ch_nome_usuario(v_uid), 'Sistema'));
  if t.solicitante_pessoa_id is not null then
    select p.setor_id into v_antes from imobdesk.at_pessoas p where p.id = t.solicitante_pessoa_id;
    if v_antes is distinct from p_setor then
      update imobdesk.at_pessoas set setor_id = p_setor, atualizado_em = now(), atualizado_por = v_uid where id = t.solicitante_pessoa_id;
      if p_setor is not null then
        update imobdesk.ch_tickets set setor_solicitante_id = p_setor
        where solicitante_pessoa_id = t.solicitante_pessoa_id and setor_solicitante_id is null and encerrado_em is null and excluido_em is null;
      end if;
      perform imobdesk.registrar_auditoria(v_uid, 'atendimento', 'update',
        format('Setor de %s: %s (pelo ticket #%s)', t.solicitante_nome, coalesce(v_para, 'A identificar'), p_id),
        jsonb_build_object('setorId', v_antes), jsonb_build_object('setorId', p_setor), t.solicitante_pessoa_id::text);
    end if;
  end if;
end;
$$;

-- Pessoa: define o setor (Configurações › Pessoas). Preenche os tickets abertos dela que estão "A identificar".
create or replace function imobdesk.at_pessoa_setor_definir(p_pessoa bigint, p_setor bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := imobdesk.at_exigir_pessoas();
  v_antes bigint;
  v_nome text;
  v_para text;
begin
  select p.setor_id, p.nome into v_antes, v_nome from imobdesk.at_pessoas p where p.id = p_pessoa;
  if v_nome is null then perform imobdesk.erro('NOT_FOUND', 'Pessoa não encontrada.'); end if;
  if p_setor is not null then
    select s.nome into v_para from imobdesk.at_setores s where s.id = p_setor and (s.ativo or s.id = v_antes);
    if v_para is null then perform imobdesk.erro('INVALID_INPUT', 'Setor inválido.', 'setorId'); end if;
  end if;
  if p_setor is not distinct from v_antes then return; end if;
  update imobdesk.at_pessoas set setor_id = p_setor, atualizado_em = now(), atualizado_por = v_ator where id = p_pessoa;
  if p_setor is not null then
    update imobdesk.ch_tickets set setor_solicitante_id = p_setor
    where solicitante_pessoa_id = p_pessoa and setor_solicitante_id is null and encerrado_em is null and excluido_em is null;
  end if;
  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', 'update', format('Setor de %s: %s', v_nome, coalesce(v_para, 'A identificar')),
    jsonb_build_object('setorId', v_antes), jsonb_build_object('setorId', p_setor), p_pessoa::text);
end;
$$;

-- ---------- Setores e números: flag "Receber chamado" ----------
create or replace function imobdesk.at_setor_salvar(p jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := auth.uid();
  v_id bigint := nullif(p ->> 'id', '')::bigint;
  v_nome text := btrim(coalesce(p ->> 'nome', ''));
  v_antes jsonb;
  v_numeros text[];
  v_num text;
  v_outro text;
  v_gestores uuid[];
  v_recebe boolean;
  v_uso text[];
  v_qtd int;
begin
  if v_ator is null or not imobdesk.at_supervisor() then
    perform imobdesk.erro('FORBIDDEN', 'Só a supervisão geral cadastra setores e números.');
  end if;
  if length(v_nome) not between 2 and 60 then
    perform imobdesk.erro('INVALID_INPUT', 'Informe o nome do setor (2 a 60 letras).', 'nome');
  end if;
  if exists (select 1 from imobdesk.at_setores s where lower(btrim(s.nome)) = lower(v_nome) and s.id is distinct from v_id) then
    perform imobdesk.erro('DUPLICATE', 'Já existe um setor com esse nome.', 'nome');
  end if;

  -- Números: só dígitos; com 10 ou 11 dígitos, assume o DDI 55.
  select coalesce(array_agg(distinct d), '{}') into v_numeros
  from (select case when length(x) in (10, 11) then '55' || x else x end d
        from (select regexp_replace(e, '\D', '', 'g') x from jsonb_array_elements_text(coalesce(p -> 'numeros', '[]')) e) a
        where x <> '') b;
  foreach v_num in array v_numeros loop
    if v_num !~ '^\d{12,13}$' then
      perform imobdesk.erro('INVALID_INPUT', format('Número inválido: %s. Use DDI + DDD + número (ex.: 5521999990002).', v_num), 'numeros');
    end if;
    select s.nome into v_outro from imobdesk.at_numeros n join imobdesk.at_setores s on s.id = n.setor_id
    where n.numero = v_num and n.ativo and n.setor_id is distinct from v_id;
    if v_outro is not null then
      perform imobdesk.erro('DUPLICATE', format('O número %s já pertence ao setor %s.', v_num, v_outro), 'numeros');
    end if;
  end loop;

  select coalesce(array_agg(distinct g::uuid), '{}') into v_gestores from jsonb_array_elements_text(coalesce(p -> 'gestores', '[]')) g;
  if exists (select 1 from unnest(v_gestores) g where not exists (select 1 from imobdesk.usuarios u where u.id = g and u.status = 'active')) then
    perform imobdesk.erro('INVALID_INPUT', 'Gestor precisa ser um usuário ativo do portal.', 'gestores');
  end if;

  if v_id is not null then
    select to_jsonb(s) into v_antes from imobdesk.at_setores s where s.id = v_id;
    if v_antes is null then
      perform imobdesk.erro('NOT_FOUND', 'Setor não encontrado.');
    end if;
  end if;
  v_recebe := coalesce((p ->> 'recebeChamados')::boolean, (v_antes ->> 'recebe_chamados')::boolean, false);
  if not v_recebe and cardinality(v_numeros) > 0 then
    perform imobdesk.erro('INVALID_INPUT', 'Número de WhatsApp só em setor que recebe chamado. Marque "Receber chamado" ou tire os números.', 'recebeChamados');
  end if;

  -- Deixar de receber: só sem nada em uso (as mensagens que chegassem ficariam sem fila).
  if v_id is not null and not v_recebe and (v_antes ->> 'recebe_chamados')::boolean then
    v_uso := '{}';
    select count(*) into v_qtd from imobdesk.ch_tickets t where t.setor_id = v_id and t.encerrado_em is null and t.excluido_em is null and t.mesclado_em_id is null;
    if v_qtd > 0 then v_uso := v_uso || format('%s ticket(s) aberto(s)', v_qtd); end if;
    select count(*) into v_qtd from imobdesk.at_atendentes a where a.setor_id = v_id;
    if v_qtd > 0 then v_uso := v_uso || format('%s atendente(s)', v_qtd); end if;
    select count(*) into v_qtd from imobdesk.at_email_contas c where c.setor_id = v_id;
    if v_qtd > 0 then v_uso := v_uso || format('%s conta(s) de e-mail', v_qtd); end if;
    select count(*) into v_qtd from imobdesk.ch_servicos sv where sv.setor_id = v_id and sv.ativo;
    if v_qtd > 0 then v_uso := v_uso || format('%s serviço(s) ativo(s)', v_qtd); end if;
    select count(*) into v_qtd from imobdesk.at_equipes e where e.setor_id = v_id and e.ativa;
    if v_qtd > 0 then v_uso := v_uso || format('%s equipe(s) ativa(s)', v_qtd); end if;
    if cardinality(v_uso) > 0 then
      perform imobdesk.erro('INVALID_INPUT', format('O setor ainda tem %s. Encerre, mova ou desative antes de desmarcar "Receber chamado".', array_to_string(v_uso, ', ')), 'recebeChamados');
    end if;
  end if;

  if v_id is null then
    insert into imobdesk.at_setores (nome, ativo, recebe_chamados, atualizado_por)
    values (v_nome, coalesce((p ->> 'ativo')::boolean, true), v_recebe, v_ator) returning id into v_id;
  else
    update imobdesk.at_setores
      set nome = v_nome, ativo = coalesce((p ->> 'ativo')::boolean, ativo), recebe_chamados = v_recebe, atualizado_em = now(), atualizado_por = v_ator
      where id = v_id;
  end if;

  update imobdesk.at_numeros set ativo = false where setor_id = v_id and ativo and not (numero = any (v_numeros));
  insert into imobdesk.at_numeros (setor_id, numero)
  select v_id, x from unnest(v_numeros) x
  on conflict (numero) do update set setor_id = excluded.setor_id, ativo = true, verificacao = null;

  delete from imobdesk.at_setor_gestores where setor_id = v_id and not (usuario_id = any (v_gestores));
  insert into imobdesk.at_setor_gestores (setor_id, usuario_id) select v_id, g from unnest(v_gestores) g on conflict do nothing;

  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', case when v_antes is null then 'create' else 'update' end,
    format('Setor de atendimento "%s" %s', v_nome, case when v_antes is null then 'criado' else 'alterado' end),
    v_antes, jsonb_build_object('nome', v_nome, 'ativo', coalesce((p ->> 'ativo')::boolean, true), 'recebeChamados', v_recebe,
                                'numeros', to_jsonb(v_numeros), 'gestores', to_jsonb(v_gestores)),
    v_id::text);
  return v_id;
end;
$$;

create or replace function imobdesk.at_contexto()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with eu as (
    select auth.uid() as id, imobdesk.at_supervisor() as supervisor, imobdesk.eh_super_admin() as super_admin
  ),
  vis as (
    select s.*,
      case
        when (select supervisor from eu) then 'supervisor'
        when imobdesk.at_gestor_de(s.id) then 'gestor'
        else 'atendente'
      end as papel
    from imobdesk.at_setores s
    where (select supervisor from eu) or imobdesk.at_membro_de(s.id)
  )
  select jsonb_build_object(
    'eu', (select id from eu),
    'supervisor', (select supervisor from eu),
    'superAdmin', (select super_admin from eu),
    'souAtendente', exists (select 1 from imobdesk.at_atendentes a where a.usuario_id = (select id from eu)),
    'setores', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', v.id, 'nome', v.nome, 'ativo', v.ativo, 'recebeChamados', v.recebe_chamados, 'papel', v.papel,
        'msgBoasVindas', v.msg_boas_vindas, 'msgForaHorario', v.msg_fora_horario, 'msgEncerramento', v.msg_encerramento,
        'limiteSimultaneo', v.limite_simultaneo, 'atendenteSemRespostaMin', v.atendente_sem_resposta_min,
        'encerrarAposHoras', v.encerrar_apos_horas, 'alertaFilaMin', v.alerta_fila_min, 'alertaClienteMin', v.alerta_cliente_min,
        'numeros', coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'numero', n.numero, 'verificacao', n.verificacao) order by n.id)
                             from imobdesk.at_numeros n where n.setor_id = v.id and n.ativo), '[]'),
        'gestores', coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'nome', u.nome, 'email', u.email) order by u.nome)
                              from imobdesk.at_setor_gestores g join imobdesk.usuarios u on u.id = g.usuario_id
                              where g.setor_id = v.id), '[]'),
        'atendentes', coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'nome', u.nome, 'email', u.email, 'apto', a.apto,
                                                                    'pausa', a.pausa, 'onlineEm', a.online_em) order by u.nome)
                                from imobdesk.at_atendentes a join imobdesk.usuarios u on u.id = a.usuario_id
                                where a.setor_id = v.id), '[]'),
        'horarios', coalesce((select jsonb_agg(jsonb_build_object('dia', h.dia, 'aberto', h.aberto, 'abre', to_char(h.abre, 'HH24:MI'),
                                                                  'fecha', to_char(h.fecha, 'HH24:MI')) order by h.dia)
                              from imobdesk.at_horarios h where h.setor_id = v.id), '[]')
      ) order by v.nome)
      from vis v
    ), '[]')
  );
$$;

-- Equipes: só setores que recebem chamado.
create or replace function imobdesk.at_equipes_setores()
returns table (id bigint, nome text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform imobdesk.at_exigir_equipes();
  return query select s.id, s.nome from imobdesk.at_setores s where s.ativo and s.recebe_chamados order by s.nome;
end;
$$;

-- App do solicitante › Administração: só setores que recebem chamado.
create or replace function imobdesk.cd_admin_painel()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform imobdesk.cd_admin_checar();
  return jsonb_build_object(
    'config', (select jsonb_build_object('quadros', c.quadros, 'whatsapp', c.whatsapp, 'boasVindas', c.boas_vindas) from imobdesk.cd_config c where c.id),
    'setores', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'nome', s.nome, 'visivel', s.cd_visivel, 'icone', s.cd_icone, 'descricao', s.cd_descricao, 'ordem', s.cd_ordem,
                                                             'servicos', (select count(*) from imobdesk.ch_servicos v where v.setor_id = s.id and v.ativo and 'intranet' = any (v.canais)))
                                          order by s.cd_ordem, s.nome)
                         from imobdesk.at_setores s where s.ativo and s.recebe_chamados), '[]'),
    'avisos', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'setorId', a.setor_id, 'titulo', a.titulo, 'texto', a.texto, 'tipo', a.tipo, 'link', a.link,
                                                            'inicio', a.inicio, 'fim', a.fim, 'ativo', a.ativo) order by a.inicio desc)
                        from (select * from imobdesk.cd_avisos order by inicio desc limit 100) a), '[]'),
    'solucoes', coalesce((select jsonb_agg(jsonb_build_object('id', so.id, 'setorId', so.setor_id, 'servicoId', so.servico_id, 'servico', imobdesk.cd_trilha(so.servico_id),
                                                              'ticketId', so.ticket_id, 'titulo', so.titulo, 'texto', so.texto, 'publicado', so.publicado, 'usos', so.usos) order by so.atualizado_em desc)
                          from imobdesk.cd_solucoes so), '[]'),
    -- Para publicar: últimos tickets resolvidos com "Solução aplicada" que ainda não viraram solução.
    'sugestoes', coalesce((select jsonb_agg(jsonb_build_object('ticketId', t.id, 'assunto', t.assunto, 'setorId', t.setor_id, 'servicoId', t.servico_id,
                                                               'servico', imobdesk.cd_trilha(t.servico_id), 'solucao', left(t.solucao_aplicada, 2000)) order by t.encerrado_em desc)
                           from (select * from imobdesk.ch_tickets x
                                 where x.solucao_aplicada is not null and x.encerrado_em is not null and x.excluido_em is null
                                   and not exists (select 1 from imobdesk.cd_solucoes so where so.ticket_id = x.id)
                                 order by x.encerrado_em desc limit 30) t), '[]'),
    'solicitantes', (select count(*) from imobdesk.usuarios u where u.perfil_key = 'solicitante'),
    'chamadosApp30d', (select count(*) from imobdesk.ch_tickets t where t.recebido_em = 'App do solicitante' and t.criado_em > now() - interval '30 days'));
end;
$$;

-- Cadastros do ticket: a flag vai junto (Serviços só oferece setor que recebe).
create or replace function imobdesk.ch_cadastros()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not imobdesk.ch_pode_ler() then
    perform imobdesk.erro('FORBIDDEN', 'Sem acesso à Gestão de Chamados.');
  end if;
  return jsonb_build_object(
    'setores', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'nome', s.nome, 'ativo', s.ativo, 'recebeChamados', s.recebe_chamados, 'slaPadraoHoras', s.sla_padrao_horas, 'equipePadraoId', s.equipe_padrao_id) order by s.nome) from imobdesk.at_setores s), '[]'),
    'equipes', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'nome', e.nome, 'setorId', e.setor_id, 'ativa', e.ativa, 'descricaoIa', e.descricao_ia) order by e.nome) from imobdesk.at_equipes e), '[]'),
    'urgencias', coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'nome', u.nome, 'ordem', u.ordem, 'cor', u.cor, 'descricao', u.descricao, 'padrao', u.padrao, 'ativa', u.ativa) order by u.ordem, u.id) from imobdesk.ch_urgencias u), '[]'),
    'categorias', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'nome', c.nome, 'descricao', c.descricao, 'servicos', c.servicos, 'ordem', c.ordem, 'padrao', c.padrao, 'ativa', c.ativa) order by c.ordem, c.id) from imobdesk.ch_categorias c), '[]'),
    'servicos', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'paiId', s.pai_id, 'setorId', s.setor_id, 'nivel', s.nivel, 'nome', s.nome, 'equipeId', s.equipe_id, 'descricao', s.descricao,
                          'urgenciaPadraoId', s.urgencia_padrao_id, 'categoriaPadraoId', s.categoria_padrao_id, 'canais', s.canais, 'ordem', s.ordem, 'ativo', s.ativo,
                          'sla', coalesce((select jsonb_agg(jsonb_build_object('urgenciaId', l.urgencia_id, 'respostaHoras', l.resposta_horas, 'solucaoHoras', l.solucao_horas) order by l.urgencia_id)
                                           from imobdesk.ch_servicos_sla l where l.servico_id = s.id), '[]')) order by s.setor_id, s.nivel, s.ordem, s.id)
                         from imobdesk.ch_servicos s), '[]'),
    'campos', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'chave', c.chave, 'rotulo', c.rotulo, 'tipo', c.tipo, 'opcoes', c.opcoes, 'ajuda', c.ajuda, 'aparece', c.aparece,
                          'interno', c.interno, 'obrigatorio', c.obrigatorio, 'usarEmVisoes', c.usar_em_visoes, 'ordem', c.ordem, 'ativo', c.ativo) order by c.ordem, c.id)
                       from imobdesk.ch_campos c), '[]'),
    'regras', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'nome', r.nome, 'ordem', r.ordem, 'condicoes', r.condicoes, 'acoes', r.acoes, 'ativa', r.ativa) order by r.ordem, r.id)
                       from imobdesk.ch_regras_exibicao r), '[]')
  );
end;
$$;

-- ---------- Ticket: setor do solicitante na tela e na Lista ----------
create or replace function imobdesk.ch_ticket_detalhe(p_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  t imobdesk.ch_tickets := imobdesk.ch_ticket_visivel(p_id);
begin
  return jsonb_build_object(
    'id', t.id, 'assunto', t.assunto, 'origem', t.origem, 'recebidoEm', t.recebido_em,
    'solicitante', jsonb_build_object('pessoaId', t.solicitante_pessoa_id, 'nome', t.solicitante_nome, 'contato', t.solicitante_contato,
       'departamento', (select d.nome from imobdesk.at_pessoa_relacoes r join imobdesk.at_pessoas d on d.id = r.empresa_id and d.tipo = 'departamento'
                        where r.pessoa_id = t.solicitante_pessoa_id limit 1)),
    'setorSolicitanteId', t.setor_solicitante_id,
    'setorSolicitante', (select s.nome from imobdesk.at_setores s where s.id = t.setor_solicitante_id),
    'setorId', t.setor_id, 'equipeId', t.equipe_id, 'responsavelId', t.responsavel_id, 'servicoId', t.servico_id, 'categoriaId', t.categoria_id,
    'urgenciaId', t.urgencia_id, 'statusId', t.status_id, 'justificativaId', t.justificativa_id, 'tags', to_jsonb(t.tags), 'cc', to_jsonb(t.cc), 'campos', t.campos,
    'solucaoAplicada', t.solucao_aplicada, 'criadoEm', t.criado_em, 'assumidoEm', t.assumido_em, 'primeiraRespostaEm', t.primeira_resposta_em,
    'slaRespostaAte', t.sla_resposta_ate, 'slaSolucaoAte', t.sla_solucao_ate, 'slaManual', t.sla_manual, 'slaPausadoDesde', t.sla_pausado_desde,
    'encerradoEm', t.encerrado_em, 'mescladoEmId', t.mesclado_em_id, 'clonadoDeId', t.clonado_de_id, 'excluidoEm', t.excluido_em,
    'clones', coalesce((select jsonb_agg(c.id order by c.id) from imobdesk.ch_tickets c where c.clonado_de_id = t.id), '[]'),
    'mesclados', coalesce((select jsonb_agg(c.id order by c.id) from imobdesk.ch_tickets c where c.mesclado_em_id = t.id), '[]'),
    'campoEstado', coalesce((select jsonb_object_agg(e.chave, jsonb_build_object('visivel', e.visivel, 'obrigatorio', e.obrigatorio)) from imobdesk.ch_campos_estado(t) e), '{}'),
    'seguindo', exists (select 1 from imobdesk.ch_ticket_seguidores s where s.ticket_id = t.id and s.usuario_id = (select auth.uid())),
    'acoes', coalesce((select jsonb_agg(jsonb_build_object('numero', a.numero, 'tipo', a.tipo, 'canal', a.canal, 'direcao', a.direcao, 'autorId', a.autor_id, 'autorNome', a.autor_nome,
                         'texto', a.texto, 'html', a.html, 'anexos', a.anexos, 'envioStatus', a.envio_status, 'criadoEm', a.criado_em,
                         'enviadoEm', a.enviado_em, 'envioErro', a.envio_erro, 'envioTentativas', a.envio_tentativas,
                         -- "Visualizar e-mail" da linha do tempo: cabeçalhos da mensagem trocada.
                         'email', case when a.canal <> 'email' or a.tipo <> 'publica' then null
                           when a.direcao = 'saida' then jsonb_build_object(
                             'de', c.email, 'deNome', case when c.exibir_no_envio then coalesce(nullif(btrim(c.nome_remetente), ''), c.nome) end,
                             'para', jsonb_build_array(t.solicitante_contato), 'cc', to_jsonb(t.cc),
                             'assunto', 'Re: [#' || t.id || '] ' || regexp_replace(t.assunto, '\[#\d+\]\s*', '', 'g'),
                             'data', coalesce(a.enviado_em, a.criado_em))
                           else (select jsonb_build_object('de', r.de, 'deNome', r.de_nome, 'para', to_jsonb(r.para), 'cc', to_jsonb(r.cc),
                                                           'assunto', r.assunto, 'data', r.recebido_em)
                                 from imobdesk.at_email_recebidos r where r.message_id = a.email_message_id order by r.id desc limit 1) end
                         ) order by a.numero desc)
                       from imobdesk.ch_ticket_acoes a left join imobdesk.at_email_contas c on c.id = t.email_conta_id where a.ticket_id = t.id), '[]'),
    'eventos', coalesce((select jsonb_agg(jsonb_build_object('tipo', e.tipo, 'descricao', e.descricao, 'autorNome', e.autor_nome, 'criadoEm', e.criado_em) order by e.criado_em desc, e.id desc)
                         from imobdesk.ch_ticket_eventos e where e.ticket_id = t.id), '[]'),
    'podeAlterarPrazo', imobdesk.ch_eh_admin() or imobdesk.at_gestor_de(t.setor_id),
    'podeExcluir', imobdesk.eh_super_admin()
  );
end;
$$;

create or replace function imobdesk.ch_lista_extras()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_agora timestamptz := now();
begin
  if not (imobdesk.ch_eh_admin() or imobdesk.tem_permissao('gestao_chamados_visao_geral') or imobdesk.tem_permissao('gestao_chamados_tickets')) then
    perform imobdesk.erro('FORBIDDEN', 'Sem acesso à Gestão de Chamados.');
  end if;
  return (
    with cmp as (
      select c.chave, c.rotulo, c.tipo, c.interno, c.ordem from imobdesk.ch_campos c where c.ativo and c.usar_em_visoes
    ), vis as (
      select t.* from imobdesk.ch_tickets t
      where t.excluido_em is null and t.mesclado_em_id is null
        and (t.encerrado_em is null or t.encerrado_em >= v_agora - interval '30 days')
        and imobdesk.ch_pode_ver_ticket(t.setor_id, t.equipe_id, t.responsavel_id)
    )
    select jsonb_build_object(
      'campos', coalesce((select jsonb_agg(jsonb_build_object('chave', c.chave, 'rotulo', c.rotulo, 'tipo', c.tipo, 'interno', c.interno) order by c.ordem, c.rotulo) from cmp c), '[]'),
      'tickets', coalesce((select jsonb_object_agg(t.id::text, jsonb_build_object(
          'categoria', (select c.nome from imobdesk.ch_categorias c where c.id = t.categoria_id),
          'setor', (select s.nome from imobdesk.at_setores s where s.id = t.setor_id),
          'setor_solicitante', (select s.nome from imobdesk.at_setores s where s.id = t.setor_solicitante_id),
          'contato', t.solicitante_contato,
          'criado_por', case when t.criado_por is null then null else imobdesk.ch_nome_usuario(t.criado_por) end,
          'atualizado_em', t.atualizado_em,
          'primeira_resposta_em', t.primeira_resposta_em,
          'sla_resposta_ate', t.sla_resposta_ate,
          'sla_solucao_ate', t.sla_solucao_ate,
          'encerrado_em', t.encerrado_em,
          'empreendimento_id', t.empreendimento_id,
          'empreendimento', (select e.nome from imobdesk.ch_empreendimentos e where e.id = t.empreendimento_id),
          'empreendimento_origem', t.empreendimento_origem,
          'campos', coalesce((select jsonb_object_agg(c.chave,
                                case when c.tipo = 'usuario' and (t.campos ->> c.chave) ~* '^[0-9a-f-]{36}$'
                                     then to_jsonb(imobdesk.ch_nome_usuario((t.campos ->> c.chave)::uuid))
                                     else t.campos -> c.chave end)
                              from cmp c where t.campos ? c.chave and jsonb_typeof(t.campos -> c.chave) <> 'null'), '{}')))
        from vis t), '{}'))
  );
end;
$$;

-- ---------- Pessoa: setor no detalhe ----------
create or replace function imobdesk.at_pessoa_detalhe(p_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  ps imobdesk.at_pessoas;
  v_grupo bigint[];
begin
  perform imobdesk.at_exigir_pessoas();
  select * into ps from imobdesk.at_pessoas where id = p_id;
  if ps.id is null then
    perform imobdesk.erro('NOT_FOUND', 'Pessoa não encontrada.');
  end if;
  -- Histórico da empresa inclui as pessoas relacionadas a ela.
  v_grupo := array[ps.id] || coalesce((select array_agg(r.pessoa_id) from imobdesk.at_pessoa_relacoes r where r.empresa_id = ps.id), '{}');
  return jsonb_build_object(
    'id', ps.id, 'tipo', ps.tipo, 'nome', ps.nome, 'razaoSocial', ps.razao_social, 'ramo', ps.ramo, 'documento', ps.documento,
    'codRef', ps.cod_ref, 'codRefAdicional', ps.cod_ref_adicional, 'classificacao', ps.classificacao, 'dominios', to_jsonb(ps.dominios),
    'sinalizadores', to_jsonb(ps.sinalizadores), 'observacoes', ps.observacoes, 'avatarPath', ps.avatar_path, 'habilitada', ps.habilitada,
    'setorId', ps.setor_id,
    'origem', ps.origem, 'origemDetalhe', ps.origem_detalhe, 'ultimoContatoEm', ps.ultimo_contato_em, 'criadoEm', ps.criado_em,
    'criadoPor', (select u.nome from imobdesk.usuarios u where u.id = ps.criado_por),
    'contatos', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'tipo', c.tipo, 'valor', c.valor, 'principal', c.principal) order by c.tipo, c.principal desc, c.id)
                          from imobdesk.at_pessoa_contatos c where c.pessoa_id = ps.id), '[]'),
    'relacoes', coalesce((
      select jsonb_agg(jsonb_build_object('pessoaId', o.id, 'nome', o.nome, 'tipo', o.tipo, 'cargo', x.cargo,
                                          'email', (select c.valor from imobdesk.at_pessoa_contatos c where c.pessoa_id = o.id and c.tipo = 'email' order by c.principal desc, c.id limit 1)) order by o.nome)
      from (select r.empresa_id as outro, r.cargo from imobdesk.at_pessoa_relacoes r where r.pessoa_id = ps.id
            union all
            select r.pessoa_id, r.cargo from imobdesk.at_pessoa_relacoes r where r.empresa_id = ps.id) x
      join imobdesk.at_pessoas o on o.id = x.outro), '[]'),
    'anexos', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'nome', a.nome, 'path', a.path, 'mime', a.mime, 'tamanho', a.tamanho,
                                                            'enviadoPor', (select u.nome from imobdesk.usuarios u where u.id = a.enviado_por), 'enviadoEm', a.enviado_em) order by a.enviado_em desc)
                        from imobdesk.at_pessoa_anexos a where a.pessoa_id = ps.id), '[]'),
    'historico', coalesce((
      select jsonb_agg(h order by h ->> 'em' desc) from (
        select jsonb_build_object('canal', 'whatsapp', 'ticket', a.id, 'titulo', coalesce(cv.ultima_previa, 'Conversa no WhatsApp'),
               'setor', s.nome, 'atendente', u.nome, 'pessoa', pp.nome, 'em', a.entrou_fila_em,
               'situacao', case when a.encerrado_em is null then 'andamento' else 'encerrado' end) h
        from imobdesk.at_atendimentos a
        join imobdesk.at_conversas cv on cv.id = a.conversa_id
        join imobdesk.at_setores s on s.id = a.setor_id
        join imobdesk.at_pessoas pp on pp.id = cv.pessoa_id
        left join imobdesk.usuarios u on u.id = a.atendente_id
        where cv.pessoa_id = any (v_grupo)
        union all
        select jsonb_build_object('canal', 'email', 'ticket', null, 'titulo', coalesce(er.assunto, '(sem assunto)'),
               'setor', s.nome, 'atendente', null, 'pessoa', pp.nome, 'em', er.recebido_em,
               'situacao', case er.estado when 'pendente' then 'andamento' when 'ignorado' then 'ignorado' else 'encerrado' end)
        from imobdesk.at_email_recebidos er
        join imobdesk.at_email_contas ec on ec.id = er.conta_id
        join imobdesk.at_setores s on s.id = ec.setor_id
        join imobdesk.at_pessoas pp on pp.id = er.pessoa_id
        where er.pessoa_id = any (v_grupo)
        order by 1 desc
        limit 200
      ) z), '[]')
  );
end;
$$;

-- ---------- Tickets que já existem: setor pela pessoa ----------
update imobdesk.ch_tickets t set setor_solicitante_id = p.setor_id
from imobdesk.at_pessoas p
where p.id = t.solicitante_pessoa_id and p.setor_id is not null and t.setor_solicitante_id is null;

-- ---------- Execução ----------
do $$
declare
  f text;
begin
  foreach f in array array[
    'imobdesk.ch_setores_opcoes()', 'imobdesk.ch_ticket_setor_solicitante_definir(bigint, bigint)',
    'imobdesk.at_pessoa_setor_definir(bigint, bigint)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
  revoke execute on function imobdesk.at_setores_recebe_regra() from public, anon, authenticated;
  revoke execute on function imobdesk.ch_tickets_setor_solicitante() from public, anon, authenticated;
end;
$$;

do $$
begin
  if to_regclass('acessos.aplicativos') is not null then
    if exists (select 1 from acessos.aplicativos a where a.schema_name = 'imobdesk' and a.controle_ativo) then
      perform acessos.aplicar_protecao('imobdesk', true);
    end if;
  end if;
end;
$$;

notify pgrst, 'reload schema';
