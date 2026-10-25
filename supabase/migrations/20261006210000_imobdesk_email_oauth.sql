-- Contas de e-mail · "Autorizar com Gmail" por conta (OAuth2), como a Movidesk (pedido do Wagner, 06/10/2026).
-- Alguém entra no Google com a própria caixa e autoriza; o portal guarda o refresh token da caixa no Vault.
-- Não precisa de conta de serviço nem de delegação no domínio (que continuam como alternativa).
-- A TI cria uma vez o "ID do cliente OAuth" (Aplicativo da Web, tela de consentimento Interna) no Google Cloud.
-- Traz também os campos da tela de recebimento da Movidesk: habilitar recebimento, apagar processadas depois de
-- N dias, regra de abertura de novos tickets. Só aditiva (o check de `modo` só ganha um valor).

-- ---------- Conta: modo OAuth e campos de recebimento ----------
alter table imobdesk.at_email_contas drop constraint if exists at_email_contas_modo_check;
alter table imobdesk.at_email_contas add constraint at_email_contas_modo_check check (modo in ('oauth_google', 'api_google', 'imap_smtp'));

alter table imobdesk.at_email_contas add column if not exists receber_habilitado boolean not null default true;
alter table imobdesk.at_email_contas add column if not exists apagar_apos_dias int check (apagar_apos_dias between 1 and 3650);
alter table imobdesk.at_email_contas add column if not exists abrir_tickets text not null default 'qualquer'
  check (abrir_tickets in ('qualquer', 'cliente', 'cliente_ou_dominio', 'nao'));
alter table imobdesk.at_email_contas add column if not exists oauth_segredo_id uuid;
alter table imobdesk.at_email_contas add column if not exists oauth_email text;
alter table imobdesk.at_email_contas add column if not exists oauth_autorizado_em timestamptz;
alter table imobdesk.at_email_contas add column if not exists oauth_autorizado_por uuid references imobdesk.usuarios (id) on delete set null;

-- ---------- Aplicativo OAuth do portal (um para o domínio) ----------
alter table imobdesk.at_config add column if not exists google_oauth_client_id text;
alter table imobdesk.at_config add column if not exists google_oauth_segredo_id uuid;
alter table imobdesk.at_config add column if not exists google_oauth_definido_em timestamptz;

-- ---------- "state" do login no Google (uso único, 10 min) ----------
create table if not exists imobdesk.at_email_oauth_estados (
  state       text        primary key,
  conta_id    bigint      not null references imobdesk.at_email_contas (id) on delete cascade,
  usuario_id  uuid        not null,
  retorno     text        not null,                      -- origem do portal para onde o Google volta
  criado_em   timestamptz not null default now(),
  expira_em   timestamptz not null default now() + interval '10 minutes'
);
alter table imobdesk.at_email_oauth_estados enable row level security;
revoke all on imobdesk.at_email_oauth_estados from anon, public, authenticated;
grant all on imobdesk.at_email_oauth_estados to service_role;

-- ---------- Lista (com os campos novos) ----------
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
  join imobdesk.at_setores s on s.id = c.setor_id
  where imobdesk.at_supervisor() or imobdesk.at_gestor_de(c.setor_id);
$$;

-- ---------- Salvar (mesma assinatura; aceita o modo OAuth e os campos novos) ----------
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
  if v_setor is null or not exists (select 1 from imobdesk.at_setores s where s.id = v_setor) then
    perform imobdesk.erro('INVALID_INPUT', 'Escolha o setor que recebe os chamados desta conta.', 'setorId');
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

  if (p ->> 'padraoDoSetor')::boolean then
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
      padrao_do_setor = coalesce((p ->> 'padraoDoSetor')::boolean, c.padrao_do_setor),
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

-- ---------- Excluir (apaga também o token OAuth do Vault) ----------
create or replace function imobdesk.at_email_conta_excluir(p_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := auth.uid();
  c imobdesk.at_email_contas;
begin
  if v_ator is null or not imobdesk.at_supervisor() then
    perform imobdesk.erro('FORBIDDEN', 'Só a supervisão geral exclui contas de e-mail.');
  end if;
  select * into c from imobdesk.at_email_contas where id = p_id;
  if c.id is null then
    perform imobdesk.erro('NOT_FOUND', 'Conta não encontrada.');
  end if;
  if exists (select 1 from imobdesk.at_email_recebidos r where r.conta_id = p_id)
     or exists (select 1 from imobdesk.at_email_saida s where s.conta_id = p_id) then
    perform imobdesk.erro('INVALID_INPUT', 'Esta conta já tem e-mails no histórico. Desabilite em vez de excluir.');
  end if;
  delete from imobdesk.at_email_contas where id = p_id;
  delete from vault.secrets where id in (c.senha_segredo_id, c.oauth_segredo_id);
  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', 'delete', format('Conta de e-mail %s excluída', c.email),
    to_jsonb(c) - 'senha_segredo_id' - 'oauth_segredo_id' - 'cursor', null, p_id::text);
end;
$$;

-- ---------- Aplicativo OAuth (Integrações › Google Workspace, só super admin) ----------
create or replace function imobdesk.at_google_oauth_salvar(p_client_id text, p_client_secret text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := auth.uid();
  v_cid text := btrim(coalesce(p_client_id, ''));
  v_sec text := btrim(coalesce(p_client_secret, ''));
  v_id uuid;
begin
  if v_ator is null or not imobdesk.eh_super_admin() then
    perform imobdesk.erro('FORBIDDEN', 'Só o super admin configura o Google Workspace.');
  end if;
  if v_cid !~ '^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$' then
    perform imobdesk.erro('INVALID_INPUT', 'ID do cliente inválido: termina em .apps.googleusercontent.com.', 'clientId');
  end if;
  if v_sec <> '' then
    if length(v_sec) < 10 then
      perform imobdesk.erro('INVALID_INPUT', 'Chave secreta do cliente inválida.', 'clientSecret');
    end if;
    v_id := coalesce((select c.google_oauth_segredo_id from imobdesk.at_config c where c.id),
                     (select s.id from vault.secrets s where s.name = ('imobdesk_google_oauth_' || imobdesk.empresa_atual())));
    if v_id is null then
      v_id := vault.create_secret(v_sec, ('imobdesk_google_oauth_' || imobdesk.empresa_atual()), 'Chave secreta do cliente OAuth do Google (Imobdesk)');
    else
      perform vault.update_secret(v_id, v_sec);
    end if;
  elsif not exists (select 1 from imobdesk.at_config c where c.id and c.google_oauth_segredo_id is not null) then
    perform imobdesk.erro('INVALID_INPUT', 'Informe a chave secreta do cliente.', 'clientSecret');
  end if;
  update imobdesk.at_config set google_oauth_client_id = v_cid, google_oauth_segredo_id = coalesce(v_id, google_oauth_segredo_id),
    google_oauth_definido_em = now(), atualizado_em = now(), atualizado_por = v_ator where id;
  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', 'secret', 'Cliente OAuth do Google configurado', null,
    jsonb_build_object('client_id', v_cid, 'segredo_trocado', v_sec <> ''), 'at_config');
end;
$$;

-- ---------- Só para as Edge Functions (service_role) ----------
create or replace function imobdesk.at_google_oauth_ler()
returns table (client_id text, client_secret text)
language sql
stable
security definer
set search_path = ''
as $$
  select c.google_oauth_client_id, (select d.decrypted_secret from vault.decrypted_secrets d where d.id = c.google_oauth_segredo_id)
  from imobdesk.at_config c where c.id;
$$;

create or replace function imobdesk.at_email_oauth_estado_criar(p_conta bigint, p_usuario uuid, p_retorno text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  if p_retorno !~ '^https://[a-z0-9.-]+(:\d+)?$' and p_retorno !~ '^http://(localhost|127\.0\.0\.1)(:\d+)?$' then
    perform imobdesk.erro('INVALID_INPUT', 'Endereço de retorno inválido.');
  end if;
  delete from imobdesk.at_email_oauth_estados where expira_em < now();
  insert into imobdesk.at_email_oauth_estados (state, conta_id, usuario_id, retorno) values (v_state, p_conta, p_usuario, p_retorno);
  return v_state;
end;
$$;

-- Uso único: devolve e apaga.
create or replace function imobdesk.at_email_oauth_estado_consumir(p_state text)
returns table (conta_id bigint, usuario_id uuid, retorno text, email text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
    with apagado as (
      delete from imobdesk.at_email_oauth_estados e where e.state = p_state and e.expira_em >= now()
      returning e.conta_id, e.usuario_id, e.retorno
    )
    select a.conta_id, a.usuario_id, a.retorno, c.email from apagado a join imobdesk.at_email_contas c on c.id = a.conta_id;
end;
$$;

create or replace function imobdesk.at_email_oauth_gravar(p_conta bigint, p_refresh text, p_email text, p_usuario uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_seg uuid;
  v_email text;
begin
  select c.oauth_segredo_id, c.email into v_seg, v_email from imobdesk.at_email_contas c where c.id = p_conta;
  if v_email is null then
    perform imobdesk.erro('NOT_FOUND', 'Conta não encontrada.');
  end if;
  if v_seg is null then
    v_seg := vault.create_secret(p_refresh, 'imobdesk_email_oauth_' || p_conta, 'Token OAuth do Google da conta ' || v_email || ' (Imobdesk)');
  else
    perform vault.update_secret(v_seg, p_refresh);
  end if;
  update imobdesk.at_email_contas set oauth_segredo_id = v_seg, oauth_email = lower(p_email), oauth_autorizado_em = now(),
    oauth_autorizado_por = p_usuario, modo = 'oauth_google', status = 'aguardando', ultimo_erro = null, atualizado_em = now()
  where id = p_conta;
  perform imobdesk.registrar_auditoria(p_usuario, 'atendimento', 'secret', format('Conta de e-mail %s autorizada no Google', v_email), null,
    jsonb_build_object('autorizado_como', lower(p_email)), p_conta::text);
end;
$$;

create or replace function imobdesk.at_email_oauth_token(p_conta bigint)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select d.decrypted_secret from vault.decrypted_secrets d join imobdesk.at_email_contas c on c.oauth_segredo_id = d.id where c.id = p_conta;
$$;

do $$
declare
  f text;
begin
  revoke execute on function imobdesk.at_google_oauth_salvar(text, text) from public, anon;
  grant execute on function imobdesk.at_google_oauth_salvar(text, text) to authenticated, service_role;
  foreach f in array array[
    'imobdesk.at_google_oauth_ler()', 'imobdesk.at_email_oauth_estado_criar(bigint, uuid, text)',
    'imobdesk.at_email_oauth_estado_consumir(text)', 'imobdesk.at_email_oauth_gravar(bigint, text, text, uuid)',
    'imobdesk.at_email_oauth_token(bigint)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
