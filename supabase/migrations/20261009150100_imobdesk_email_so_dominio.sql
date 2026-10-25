-- E-mail "Só domínio" (docs/PLANO-conversas-whatsapp-openwa.md, Fase 1; aprovado pelo Wagner em 09/10/2026).
-- TI, Administrativo e CFTV só abrem ticket por remetente do domínio da empresa. A regra "cliente_ou_dominio" aceitava
-- também qualquer pessoa cadastrada (até de fora); a nova regra "dominio" olha só o domínio do remetente.
-- Respostas a tickets que já existem continuam entrando (a checagem é só para ticket novo).
-- Só aditiva: o check de abrir_tickets ganha um valor, coluna nova e as três funções trocadas (mesma assinatura).

alter table imobdesk.at_email_contas add column if not exists dominios_permitidos text[] not null default '{}';
alter table imobdesk.at_email_contas drop constraint if exists at_email_contas_abrir_tickets_check;
alter table imobdesk.at_email_contas add constraint at_email_contas_abrir_tickets_check
  check (abrir_tickets in ('qualquer', 'cliente', 'cliente_ou_dominio', 'dominio', 'nao'));

create or replace function imobdesk.at_email_contas_lista()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id, 'nome', c.nome, 'email', c.email, 'setorId', c.setor_id, 'setorNome', s.nome,
    'nomeRemetente', c.nome_remetente, 'exibirNoEnvio', c.exibir_no_envio, 'padraoDoSetor', c.padrao_do_setor,
    'usarLogo', c.usar_logo, 'logoPath', c.logo_path, 'habilitada', c.habilitada,
    'provedor', c.provedor, 'modo', c.modo,
    'imapHost', c.imap_host, 'imapPorta', c.imap_porta, 'imapSeguranca', c.imap_seguranca,
    'smtpHost', c.smtp_host, 'smtpPorta', c.smtp_porta, 'usuario', c.usuario,
    'senhaMascara', c.senha_mascara,
    'pasta', c.pasta, 'intervaloMin', c.intervalo_min, 'lerDesde', c.ler_desde,
    'marcarLido', c.marcar_lido, 'moverPara', c.mover_para, 'juntarRespostas', c.juntar_respostas,
    'ignorarRemetentes', to_jsonb(c.ignorar_remetentes),
    'responderPara', c.responder_para, 'copiaOculta', c.copia_oculta, 'assinatura', c.assinatura,
    'receberHabilitado', c.receber_habilitado, 'apagarAposDias', c.apagar_apos_dias, 'abrirTickets', c.abrir_tickets, 'dominiosPermitidos', to_jsonb(c.dominios_permitidos),
    'oauthEmail', c.oauth_email, 'oauthAutorizadoEm', c.oauth_autorizado_em,
    'oauthAutorizadoPor', (select u.nome from imobdesk.usuarios u where u.id = c.oauth_autorizado_por),
    'status', c.status, 'ultimoErro', c.ultimo_erro, 'ultimaLeituraEm', c.ultima_leitura_em, 'verificacao', c.verificacao,
    'naFila', (select count(*) from imobdesk.at_email_recebidos r where r.conta_id = c.id and r.estado = 'pendente')
  ) order by c.email), '[]')
  from imobdesk.at_email_contas c
  left join imobdesk.at_setores s on s.id = c.setor_id
  where imobdesk.at_supervisor() or (c.setor_id is not null and imobdesk.at_gestor_de(c.setor_id));
$$;

create or replace function imobdesk.at_email_conta_salvar(p jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := auth.uid();
  v_id bigint := nullif(p ->> 'id', '')::bigint;
  v_email text := lower(btrim(coalesce(p ->> 'email', '')));
  v_setor bigint := nullif(p ->> 'setorId', '')::bigint;
  v_modo text := coalesce(p ->> 'modo', 'oauth_google');
  v_antes jsonb;
  v_ignorar text[];
  v_dominios text[];
begin
  if v_ator is null or not imobdesk.at_supervisor() then
    perform imobdesk.erro('FORBIDDEN', 'Só a supervisão geral cadastra contas de e-mail.');
  end if;
  if length(btrim(coalesce(p ->> 'nome', ''))) not between 2 and 80 then
    perform imobdesk.erro('INVALID_INPUT', 'Informe o nome da conta (2 a 80 letras).', 'nome');
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    perform imobdesk.erro('INVALID_INPUT', 'Endereço de e-mail inválido.', 'email');
  end if;
  if exists (select 1 from imobdesk.at_email_contas c where c.email = v_email and c.id is distinct from v_id) then
    perform imobdesk.erro('DUPLICATE', 'Já existe uma conta com esse endereço.', 'email');
  end if;
  -- Setor é opcional: a conta existe só com a autorização do Google; o vínculo com a equipe/setor vem depois.
  if v_setor is not null and not exists (select 1 from imobdesk.at_setores s where s.id = v_setor) then
    perform imobdesk.erro('INVALID_INPUT', 'Setor não encontrado.', 'setorId');
  end if;
  if v_modo not in ('oauth_google', 'api_google', 'imap_smtp') then
    perform imobdesk.erro('INVALID_INPUT', 'Modo de acesso inválido.', 'modo');
  end if;
  if v_modo in ('oauth_google', 'api_google') and coalesce(p ->> 'provedor', 'google') <> 'google' then
    perform imobdesk.erro('INVALID_INPUT', 'A autorização pelo Google só existe para contas do Google Workspace / Gmail.', 'modo');
  end if;
  if v_modo = 'imap_smtp' and (nullif(btrim(p ->> 'imapHost'), '') is null or nullif(btrim(p ->> 'smtpHost'), '') is null) then
    perform imobdesk.erro('INVALID_INPUT', 'Informe os servidores de entrada (IMAP) e de saída (SMTP).', 'imapHost');
  end if;
  if (p ->> 'smtpPorta')::int in (25, 587) then
    perform imobdesk.erro('INVALID_INPUT', 'Use a porta 465 (SSL): o servidor do portal bloqueia as portas 25 e 587.', 'smtpPorta');
  end if;
  if (p ->> 'apagarAposDias') is not null and (p ->> 'apagarAposDias')::int not between 1 and 3650 then
    perform imobdesk.erro('INVALID_INPUT', 'Informe de 1 a 3650 dias para apagar as mensagens processadas.', 'apagarAposDias');
  end if;
  select coalesce(array_agg(lower(btrim(x))) filter (where btrim(x) <> ''), '{}') into v_ignorar
  from jsonb_array_elements_text(coalesce(p -> 'ignorarRemetentes', '[]')) x;

  -- "Só domínio": domínios sem @, minúsculos; ao menos um quando a regra for essa.
  if p ? 'dominiosPermitidos' then
    select coalesce(array_agg(distinct d) filter (where d <> ''), '{}') into v_dominios
    from (select lower(btrim(ltrim(btrim(x), '@'))) d from jsonb_array_elements_text(coalesce(p -> 'dominiosPermitidos', '[]')) x) y;
    if exists (select 1 from unnest(v_dominios) d where d !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$') then
      perform imobdesk.erro('INVALID_INPUT', 'Domínio inválido. Use só o domínio, como suaempresa.com.br.', 'dominiosPermitidos');
    end if;
  end if;
  if p ->> 'abrirTickets' = 'dominio'
     and cardinality(coalesce(v_dominios, (select c.dominios_permitidos from imobdesk.at_email_contas c where c.id = v_id), '{}')) = 0 then
    perform imobdesk.erro('INVALID_INPUT', 'Informe ao menos um domínio para a regra "Só domínio".', 'dominiosPermitidos');
  end if;

  if v_setor is not null and (p ->> 'padraoDoSetor')::boolean then
    update imobdesk.at_email_contas set padrao_do_setor = false
    where setor_id = v_setor and padrao_do_setor and id is distinct from v_id;
  end if;

  begin
    if v_id is null then
      insert into imobdesk.at_email_contas (nome, email, setor_id, modo, atualizado_por) values (btrim(p ->> 'nome'), v_email, v_setor, v_modo, v_ator)
      returning id into v_id;
    else
      select to_jsonb(c) - 'senha_segredo_id' - 'oauth_segredo_id' - 'cursor' into v_antes from imobdesk.at_email_contas c where c.id = v_id;
      if v_antes is null then
        perform imobdesk.erro('NOT_FOUND', 'Conta não encontrada.');
      end if;
      -- Trocou o endereço: o token do Google era da caixa antiga e sai do Vault.
      if v_antes ->> 'email' is distinct from v_email then
        delete from vault.secrets where id = (select c.oauth_segredo_id from imobdesk.at_email_contas c where c.id = v_id);
      end if;
    end if;
    update imobdesk.at_email_contas c set
      nome = btrim(p ->> 'nome'),
      email = v_email,
      setor_id = v_setor,
      nome_remetente = nullif(btrim(p ->> 'nomeRemetente'), ''),
      exibir_no_envio = coalesce((p ->> 'exibirNoEnvio')::boolean, c.exibir_no_envio),
      padrao_do_setor = v_setor is not null and coalesce((p ->> 'padraoDoSetor')::boolean, c.padrao_do_setor),
      usar_logo = coalesce((p ->> 'usarLogo')::boolean, c.usar_logo),
      habilitada = coalesce((p ->> 'habilitada')::boolean, c.habilitada),
      provedor = coalesce(p ->> 'provedor', c.provedor),
      modo = v_modo,
      imap_host = nullif(btrim(p ->> 'imapHost'), ''),
      imap_porta = coalesce((p ->> 'imapPorta')::int, c.imap_porta),
      imap_seguranca = coalesce(p ->> 'imapSeguranca', c.imap_seguranca),
      smtp_host = nullif(btrim(p ->> 'smtpHost'), ''),
      smtp_porta = coalesce((p ->> 'smtpPorta')::int, c.smtp_porta),
      usuario = nullif(btrim(p ->> 'usuario'), ''),
      pasta = coalesce(nullif(btrim(p ->> 'pasta'), ''), 'INBOX'),
      intervalo_min = coalesce((p ->> 'intervaloMin')::int, c.intervalo_min),
      ler_desde = coalesce((p ->> 'lerDesde')::date, c.ler_desde),
      marcar_lido = coalesce((p ->> 'marcarLido')::boolean, c.marcar_lido),
      mover_para = nullif(btrim(p ->> 'moverPara'), ''),
      juntar_respostas = coalesce((p ->> 'juntarRespostas')::boolean, c.juntar_respostas),
      ignorar_remetentes = v_ignorar,
      responder_para = nullif(lower(btrim(p ->> 'responderPara')), ''),
      copia_oculta = nullif(lower(btrim(p ->> 'copiaOculta')), ''),
      assinatura = nullif(p ->> 'assinatura', ''),
      receber_habilitado = coalesce((p ->> 'receberHabilitado')::boolean, c.receber_habilitado),
      apagar_apos_dias = case when p ? 'apagarAposDias' then (p ->> 'apagarAposDias')::int else c.apagar_apos_dias end,
      abrir_tickets = coalesce(nullif(p ->> 'abrirTickets', ''), c.abrir_tickets),
      dominios_permitidos = coalesce(v_dominios, c.dominios_permitidos),
      -- Trocou o endereço: a autorização do Google era de outra caixa.
      oauth_segredo_id = case when v_antes is not null and v_antes ->> 'email' is distinct from v_email then null else c.oauth_segredo_id end,
      oauth_email = case when v_antes is not null and v_antes ->> 'email' is distinct from v_email then null else c.oauth_email end,
      status = case when v_antes is null or v_antes ->> 'modo' is distinct from v_modo
                         or v_antes ->> 'imap_host' is distinct from nullif(btrim(p ->> 'imapHost'), '')
                         or v_antes ->> 'email' is distinct from v_email then 'aguardando' else c.status end,
      atualizado_em = now(),
      atualizado_por = v_ator
    where c.id = v_id;
  exception when check_violation then
    perform imobdesk.erro('INVALID_INPUT', 'Algum valor está fora do permitido (porta, intervalo, provedor, regra de abertura ou tamanho do texto).');
  end;

  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', case when v_antes is null then 'create' else 'update' end,
    format('Conta de e-mail %s %s', v_email, case when v_antes is null then 'criada' else 'alterada' end),
    v_antes, (select to_jsonb(c) - 'senha_segredo_id' - 'oauth_segredo_id' - 'cursor' from imobdesk.at_email_contas c where c.id = v_id), v_id::text);
  return v_id;
end;
$$;

create or replace function imobdesk.ch_email_processar(p_recebido bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r imobdesk.at_email_recebidos;
  c imobdesk.at_email_contas;
  t imobdesk.ch_tickets;
  v_ticket bigint;
  v_cat text;
  v_ids text[];
  v_pessoa bigint;
  v_num int;
  v_dominio text;
  v_motivo text;
  v_status bigint;
begin
  select * into r from imobdesk.at_email_recebidos x where x.id = p_recebido for update;
  if r.id is null or r.estado <> 'pendente' then
    return jsonb_build_object('estado', coalesce(r.estado, 'inexistente'), 'ticketId', r.ticket_id);
  end if;
  select * into c from imobdesk.at_email_contas x where x.id = r.conta_id;

  -- 1) É resposta a um ticket?
  v_ticket := nullif(substring(coalesce(r.assunto, '') from '\[#(\d{1,12})\]'), '')::bigint;
  if v_ticket is not null and not exists (select 1 from imobdesk.ch_tickets x where x.id = v_ticket and x.excluido_em is null) then
    v_ticket := null;
  end if;
  if v_ticket is null then
    v_ids := array(select m[1] from regexp_matches(coalesce(r.in_reply_to, '') || ' ' || coalesce(r.referencias, ''), '(<[^<>[:space:]]+>)', 'g') m);
    if cardinality(v_ids) > 0 then
      select a.ticket_id into v_ticket from imobdesk.ch_ticket_acoes a
       where a.email_message_id = any (v_ids) order by a.id desc limit 1;
      if v_ticket is null then
        select x.id into v_ticket from imobdesk.ch_tickets x
         where x.email_thread_id = any (v_ids) and x.excluido_em is null order by x.id desc limit 1;
      end if;
    end if;
  end if;
  -- Ticket mesclado: a resposta cai no destino.
  while v_ticket is not null loop
    select * into t from imobdesk.ch_tickets x where x.id = v_ticket;
    exit when t.mesclado_em_id is null;
    v_ticket := t.mesclado_em_id;
  end loop;

  if v_ticket is not null then
    v_cat := (select s.categoria from imobdesk.ch_status s where s.id = t.status_id);
    if v_cat in ('fechado', 'cancelado') then
      v_ticket := null;   -- encerrado de vez: abre ticket novo
    else
      perform 1 from imobdesk.ch_tickets x where x.id = v_ticket for update;
      v_num := coalesce((select max(a.numero) from imobdesk.ch_ticket_acoes a where a.ticket_id = v_ticket), 0) + 1;
      insert into imobdesk.ch_ticket_acoes (ticket_id, numero, tipo, canal, direcao, autor_nome, texto, html, anexos, envio_status, email_message_id)
      values (v_ticket, v_num, 'publica', 'email', 'entrada', coalesce(nullif(btrim(r.de_nome), ''), r.de), left(coalesce(r.texto, ''), 100000), r.html, r.anexos,
              'nao_se_aplica', r.message_id);
      if v_cat = 'resolvido' then
        v_status := coalesce((select s.id from imobdesk.ch_status s where s.categoria = 'andamento' and s.ativo and lower(s.nome) = 'reaberto' limit 1),
                             (select s.id from imobdesk.ch_status s where s.categoria = 'andamento' and s.ativo order by s.ordem limit 1));
      elsif v_cat = 'pendente' then
        v_status := (select s.id from imobdesk.ch_status s where s.categoria = 'andamento' and s.ativo order by s.ordem limit 1);
      end if;
      if v_status is not null then
        update imobdesk.ch_tickets set status_id = v_status, justificativa_id = null where id = v_ticket;
      end if;
      update imobdesk.at_email_recebidos set estado = 'virou_chamado', ticket_id = v_ticket, motivo = format('resposta no ticket #%s', v_ticket) where id = r.id;
      return jsonb_build_object('estado', 'virou_chamado', 'ticketId', v_ticket, 'motivo', 'resposta');
    end if;
  end if;

  -- 2) Ticket novo: regra de abertura da conta.
  v_dominio := split_part(r.de, '@', 2);
  if c.abrir_tickets = 'nao' then
    v_motivo := 'a conta não abre tickets novos';
  elsif c.abrir_tickets = 'dominio' and not (lower(v_dominio) = any (c.dominios_permitidos)) then
    v_motivo := 'remetente fora de ' || coalesce(array_to_string(array(select '@' || d from unnest(c.dominios_permitidos) d), ', '), 'domínio permitido');
  elsif c.abrir_tickets in ('cliente', 'cliente_ou_dominio')
        and not exists (select 1 from imobdesk.at_pessoa_contatos pc where pc.tipo = 'email' and pc.valor = r.de)
        and not (c.abrir_tickets = 'cliente_ou_dominio'
                 and exists (select 1 from imobdesk.at_pessoas e where e.tipo <> 'pessoa' and e.habilitada and v_dominio = any (e.dominios))) then
    v_motivo := case when c.abrir_tickets = 'cliente' then 'remetente não cadastrado em Pessoas' else 'remetente nem domínio cadastrados em Pessoas' end;
  elsif c.setor_id is null then
    v_motivo := 'a conta de e-mail não tem setor';
  end if;
  if v_motivo is not null then
    update imobdesk.at_email_recebidos set estado = 'ignorado', motivo = v_motivo where id = r.id;
    return jsonb_build_object('estado', 'ignorado', 'motivo', v_motivo);
  end if;

  v_pessoa := imobdesk.at_pessoa_identificar('email', r.de, r.de_nome, 'E-mail para ' || c.email);
  insert into imobdesk.ch_tickets (assunto, origem, recebido_em, solicitante_pessoa_id, solicitante_nome, solicitante_contato, email_conta_id,
                                             email_thread_id, setor_id, categoria_id, urgencia_id, status_id, cc)
  values (left(coalesce(nullif(btrim(r.assunto), ''), '(sem assunto)'), 300), 'email', left(c.email, 160), v_pessoa,
          left(coalesce(nullif(btrim(r.de_nome), ''), (select pe.nome from imobdesk.at_pessoas pe where pe.id = v_pessoa), r.de), 160), r.de, c.id,
          r.message_id, c.setor_id,
          (select x.id from imobdesk.ch_categorias x where x.padrao and x.ativa limit 1),
          coalesce((select u.id from imobdesk.ch_urgencias u where u.padrao and u.ativa limit 1), (select min(u.id) from imobdesk.ch_urgencias u)),
          coalesce((select s.id from imobdesk.ch_status s where s.categoria = 'novo' and s.ativo order by s.ordem limit 1), 1),
          coalesce(array(select x from unnest(r.para || r.cc) x where x <> c.email and x <> coalesce(c.oauth_email, '') and x <> r.de), '{}'))
  returning id into v_ticket;
  insert into imobdesk.ch_ticket_acoes (ticket_id, numero, tipo, canal, direcao, autor_nome, texto, html, anexos, envio_status, email_message_id)
  values (v_ticket, 1, 'publica', 'email', 'entrada', coalesce(nullif(btrim(r.de_nome), ''), r.de), left(coalesce(r.texto, ''), 100000), r.html, r.anexos,
          'nao_se_aplica', r.message_id);
  update imobdesk.at_email_recebidos set estado = 'virou_chamado', ticket_id = v_ticket, pessoa_id = v_pessoa, motivo = 'ticket novo' where id = r.id;
  return jsonb_build_object('estado', 'virou_chamado', 'ticketId', v_ticket, 'motivo', 'novo');
end;
$$;
