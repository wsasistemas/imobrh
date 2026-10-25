-- Central Email: a conta de e-mail existe sem setor (pedido do Wagner, 06/10/2026).
-- Basta a autorização do Google; o vínculo com a equipe/setor vem depois. Migração aditiva: só relaxa o NOT NULL
-- e troca as funções (mesma assinatura). Nada é apagado.

alter table imobdesk.at_email_contas alter column setor_id drop not null;

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
    'receberHabilitado', c.receber_habilitado, 'apagarAposDias', c.apagar_apos_dias, 'abrirTickets', c.abrir_tickets,
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
