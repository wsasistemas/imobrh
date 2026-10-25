-- Gestão de Atendimento — Contas de e-mail (F2). Estrutura da Movidesk (Configurações › Contas de e-mail),
-- com a regra do portal: cada conta pertence a um setor (fila, equipe e horário do setor).
-- Decisões (Wagner, 06/10/2026): Google Workspace pela API do Gmail (conta de serviço com delegação no
-- domínio) e IMAP/SMTP com senha como alternativa; só a supervisão geral cadastra; sem POP3.
-- Só aditiva. Senhas e a chave do Google ficam no Vault; a tela nunca as recebe de volta.

-- ---------- Contas ----------
create table if not exists imobdesk.at_email_contas (
  id                   bigint      generated always as identity primary key,
  nome                 text        not null check (length(btrim(nome)) between 2 and 80),
  email                text        not null unique check (email = lower(btrim(email)) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  setor_id             bigint      not null references imobdesk.at_setores (id),
  nome_remetente       text        check (length(nome_remetente) <= 80),
  exibir_no_envio      boolean     not null default true,
  padrao_do_setor      boolean     not null default false,
  usar_logo            boolean     not null default false,
  logo_path            text,
  habilitada           boolean     not null default true,
  provedor             text        not null default 'google'
                                   check (provedor in ('google', 'outlook', 'exchange', 'yahoo', 'uol', 'bol', 'terra', 'ig', 'ibest', 'manual')),
  modo                 text        not null default 'api_google' check (modo in ('api_google', 'imap_smtp')),
  imap_host            text,
  imap_porta           int         not null default 993 check (imap_porta between 1 and 65535),
  imap_seguranca       text        not null default 'ssl' check (imap_seguranca in ('ssl', 'starttls')),
  smtp_host            text,
  -- O Supabase bloqueia a saída nas portas 25 e 587: SMTP só com SSL direto (465).
  smtp_porta           int         not null default 465 check (smtp_porta between 1 and 65535 and smtp_porta not in (25, 587)),
  usuario              text,
  senha_segredo_id     uuid,
  senha_mascara        text,
  pasta                text        not null default 'INBOX' check (length(btrim(pasta)) between 1 and 120),
  intervalo_min        int         not null default 1 check (intervalo_min in (1, 2, 5, 10, 15)),
  ler_desde            date        not null default current_date,
  marcar_lido          boolean     not null default true,
  mover_para           text,
  juntar_respostas     boolean     not null default true,
  ignorar_remetentes   text[]      not null default '{mailer-daemon@,noreply@,no-reply@}',
  responder_para       text,
  copia_oculta         text,
  assinatura           text        check (length(assinatura) <= 4000),
  status               text        not null default 'aguardando' check (status in ('conectado', 'falha', 'aguardando')),
  ultimo_erro          text,
  ultima_leitura_em    timestamptz,
  cursor               text,                                  -- historyId do Gmail ou UID do IMAP (F4)
  verificacao          jsonb,                                 -- último "Testar configurações"
  criado_em            timestamptz not null default now(),
  atualizado_em        timestamptz not null default now(),
  atualizado_por       uuid
);
create index if not exists at_email_contas_setor_idx on imobdesk.at_email_contas (setor_id);
-- Uma conta padrão de envio por setor.
create unique index if not exists at_email_contas_padrao_uidx on imobdesk.at_email_contas (setor_id) where padrao_do_setor;

-- ---------- E-mails recebidos (a "fila" da lista e a entrada do processo de ticket) ----------
create table if not exists imobdesk.at_email_recebidos (
  id            bigint      generated always as identity primary key,
  conta_id      bigint      not null references imobdesk.at_email_contas (id),
  message_id    text        not null,                         -- cabeçalho Message-ID (idempotência)
  provedor_id   text,                                         -- id da mensagem no Gmail / UID do IMAP
  thread_id     text,
  de            text        not null,
  de_nome       text,
  para          text[]      not null default '{}',
  cc            text[]      not null default '{}',
  assunto       text,
  texto         text,
  html          text,
  anexos        jsonb       not null default '[]',            -- [{nome, mime, tamanho, path}] no Storage
  in_reply_to   text,
  referencias   text,
  recebido_em   timestamptz not null,
  importado_em  timestamptz not null default now(),
  estado        text        not null default 'pendente' check (estado in ('pendente', 'virou_chamado', 'ignorado')),
  unique (conta_id, message_id)
);
create index if not exists at_email_recebidos_fila_idx on imobdesk.at_email_recebidos (conta_id) where estado = 'pendente';

-- ---------- Fila de envio ----------
create table if not exists imobdesk.at_email_saida (
  id            bigint      generated always as identity primary key,
  conta_id      bigint      not null references imobdesk.at_email_contas (id),
  para          text[]      not null,
  cc            text[]      not null default '{}',
  assunto       text        not null,
  texto         text,
  html          text,
  in_reply_to   text,
  referencias   text,
  estado        text        not null default 'pendente' check (estado in ('pendente', 'enviado', 'falhou')),
  tentativas    int         not null default 0,
  erro          text,
  provedor_id   text,
  criado_por    uuid,
  criado_em     timestamptz not null default now(),
  enviado_em    timestamptz
);
create index if not exists at_email_saida_pendente_idx on imobdesk.at_email_saida (criado_em) where estado = 'pendente';

-- ---------- Conta de serviço do Google Workspace (uma para o domínio) ----------
alter table imobdesk.at_config add column if not exists google_sa_segredo_id uuid;
alter table imobdesk.at_config add column if not exists google_sa_email text;
alter table imobdesk.at_config add column if not exists google_sa_definido_em timestamptz;
alter table imobdesk.at_config add column if not exists google_verificacao jsonb;

-- ---------- Segurança: leitura só por RPC/RLS; escrita só por RPC ----------
do $$
declare
  t text;
begin
  foreach t in array array['at_email_contas', 'at_email_recebidos', 'at_email_saida'] loop
    execute format('alter table imobdesk.%I enable row level security', t);
    execute format('revoke all on imobdesk.%I from anon, public', t);
    execute format('revoke insert, update, delete, truncate on imobdesk.%I from authenticated', t);
    execute format('grant all on imobdesk.%I to service_role', t);
  end loop;
  -- A tabela de contas tem o id do segredo: a tela lê pela RPC at_email_contas_lista, nunca direto.
  revoke select on imobdesk.at_email_contas from authenticated;
  grant select on imobdesk.at_email_recebidos, imobdesk.at_email_saida to authenticated;

  if not exists (select 1 from pg_policies where schemaname = 'imobdesk' and tablename = 'at_email_recebidos' and policyname = 'Atendimento: e-mails da gestão do setor') then
    create policy "Atendimento: e-mails da gestão do setor" on imobdesk.at_email_recebidos
      for select to authenticated using (
        (select imobdesk.at_supervisor())
        or exists (select 1 from imobdesk.at_email_contas c where c.id = conta_id and imobdesk.at_gestor_de(c.setor_id))
      );
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'imobdesk' and tablename = 'at_email_saida' and policyname = 'Atendimento: saída da gestão do setor') then
    create policy "Atendimento: saída da gestão do setor" on imobdesk.at_email_saida
      for select to authenticated using (
        (select imobdesk.at_supervisor())
        or exists (select 1 from imobdesk.at_email_contas c where c.id = conta_id and imobdesk.at_gestor_de(c.setor_id))
      );
  end if;
end;
$$;

-- ---------- Lista (supervisão: todas; gestor: as do seu setor). Sem segredo ----------
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
    'status', c.status, 'ultimoErro', c.ultimo_erro, 'ultimaLeituraEm', c.ultima_leitura_em, 'verificacao', c.verificacao,
    'naFila', (select count(*) from imobdesk.at_email_recebidos r where r.conta_id = c.id and r.estado = 'pendente')
  ) order by c.email), '[]')
  from imobdesk.at_email_contas c
  join imobdesk.at_setores s on s.id = c.setor_id
  where imobdesk.at_supervisor() or imobdesk.at_gestor_de(c.setor_id);
$$;

-- p: os campos da tela (camelCase). Devolve o id. Senha vai por at_email_conta_senha.
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
  v_modo text := coalesce(p ->> 'modo', 'api_google');
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
  if v_modo = 'api_google' and coalesce(p ->> 'provedor', 'google') <> 'google' then
    perform imobdesk.erro('INVALID_INPUT', 'A conexão por API só existe para contas do Google Workspace.', 'modo');
  end if;
  if v_modo = 'imap_smtp' and (nullif(btrim(p ->> 'imapHost'), '') is null or nullif(btrim(p ->> 'smtpHost'), '') is null) then
    perform imobdesk.erro('INVALID_INPUT', 'Informe os servidores de entrada (IMAP) e de saída (SMTP).', 'imapHost');
  end if;
  if (p ->> 'smtpPorta')::int in (25, 587) then
    perform imobdesk.erro('INVALID_INPUT', 'Use a porta 465 (SSL): o servidor do portal bloqueia as portas 25 e 587.', 'smtpPorta');
  end if;
  select coalesce(array_agg(lower(btrim(x))) filter (where btrim(x) <> ''), '{}') into v_ignorar
  from jsonb_array_elements_text(coalesce(p -> 'ignorarRemetentes', '[]')) x;

  if (p ->> 'padraoDoSetor')::boolean then
    update imobdesk.at_email_contas set padrao_do_setor = false
    where setor_id = v_setor and padrao_do_setor and id is distinct from v_id;
  end if;

  begin
    if v_id is null then
      insert into imobdesk.at_email_contas (nome, email, setor_id, atualizado_por) values (btrim(p ->> 'nome'), v_email, v_setor, v_ator)
      returning id into v_id;
    else
      select to_jsonb(c) - 'senha_segredo_id' - 'cursor' into v_antes from imobdesk.at_email_contas c where c.id = v_id;
      if v_antes is null then
        perform imobdesk.erro('NOT_FOUND', 'Conta não encontrada.');
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
      -- Mudou a conexão: precisa testar de novo.
      status = case when v_antes is null or v_antes ->> 'modo' is distinct from v_modo
                         or v_antes ->> 'imap_host' is distinct from nullif(btrim(p ->> 'imapHost'), '')
                         or v_antes ->> 'email' is distinct from v_email then 'aguardando' else c.status end,
      atualizado_em = now(),
      atualizado_por = v_ator
    where c.id = v_id;
  exception when check_violation then
    perform imobdesk.erro('INVALID_INPUT', 'Algum valor está fora do permitido (porta, intervalo, provedor ou tamanho do texto).');
  end;

  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', case when v_antes is null then 'create' else 'update' end,
    format('Conta de e-mail %s %s', v_email, case when v_antes is null then 'criada' else 'alterada' end),
    v_antes, (select to_jsonb(c) - 'senha_segredo_id' - 'cursor' from imobdesk.at_email_contas c where c.id = v_id), v_id::text);
  return v_id;
end;
$$;

-- Senha (ou senha de app) da conta IMAP/SMTP: só no Vault.
create or replace function imobdesk.at_email_conta_senha(p_id bigint, p_senha text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := auth.uid();
  v_senha text := coalesce(p_senha, '');
  v_seg uuid;
  v_email text;
begin
  if v_ator is null or not imobdesk.at_supervisor() then
    perform imobdesk.erro('FORBIDDEN', 'Só a supervisão geral altera as contas de e-mail.');
  end if;
  select c.senha_segredo_id, c.email into v_seg, v_email from imobdesk.at_email_contas c where c.id = p_id;
  if v_email is null then
    perform imobdesk.erro('NOT_FOUND', 'Conta não encontrada.');
  end if;
  if length(v_senha) not between 4 and 200 then
    perform imobdesk.erro('INVALID_INPUT', 'Informe a senha da conta (ou a senha de app).', 'senha');
  end if;
  if v_seg is null then
    v_seg := vault.create_secret(v_senha, 'imobdesk_email_' || p_id, 'Senha da conta de e-mail ' || v_email || ' (Imobdesk)');
  else
    perform vault.update_secret(v_seg, v_senha);
  end if;
  update imobdesk.at_email_contas set senha_segredo_id = v_seg, senha_mascara = '••••••••' || right(v_senha, 2),
    status = 'aguardando', atualizado_em = now(), atualizado_por = v_ator where id = p_id;
  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', 'secret', format('Senha da conta de e-mail %s substituída', v_email), null, null, p_id::text);
end;
$$;

create or replace function imobdesk.at_email_conta_habilitar(p_ids bigint[], p_habilitada boolean)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := auth.uid();
  v_n int;
begin
  if v_ator is null or not imobdesk.at_supervisor() then
    perform imobdesk.erro('FORBIDDEN', 'Só a supervisão geral altera as contas de e-mail.');
  end if;
  update imobdesk.at_email_contas set habilitada = coalesce(p_habilitada, false), atualizado_em = now(), atualizado_por = v_ator
  where id = any (coalesce(p_ids, '{}'));
  get diagnostics v_n = row_count;
  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', case when p_habilitada then 'activate' else 'deactivate' end,
    format('%s conta(s) de e-mail %s', v_n, case when p_habilitada then 'habilitada(s)' else 'desabilitada(s)' end), null, to_jsonb(p_ids), null);
  return v_n;
end;
$$;

-- Excluir só conta sem histórico; com e-mails, desabilite (mantém os chamados).
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
  if c.senha_segredo_id is not null then
    delete from vault.secrets where id = c.senha_segredo_id;
  end if;
  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', 'delete', format('Conta de e-mail %s excluída', c.email),
    to_jsonb(c) - 'senha_segredo_id' - 'cursor', null, p_id::text);
end;
$$;

-- ---------- Conta de serviço do Google (Integrações › Google Workspace, só super admin) ----------
create or replace function imobdesk.at_google_sa_salvar(p_json text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := auth.uid();
  j jsonb;
  v_id uuid;
begin
  if v_ator is null or not imobdesk.eh_super_admin() then
    perform imobdesk.erro('FORBIDDEN', 'Só o super admin configura o Google Workspace.');
  end if;
  begin
    j := p_json::jsonb;
  exception when others then
    perform imobdesk.erro('INVALID_INPUT', 'Arquivo inválido: envie o JSON da chave da conta de serviço do Google Cloud.', 'chave');
  end;
  if j ->> 'type' is distinct from 'service_account' or coalesce(j ->> 'client_email', '') = '' or coalesce(j ->> 'private_key', '') not like '-----BEGIN PRIVATE KEY-----%' then
    perform imobdesk.erro('INVALID_INPUT', 'O JSON precisa ser de uma conta de serviço (type, client_email e private_key).', 'chave');
  end if;
  v_id := coalesce((select c.google_sa_segredo_id from imobdesk.at_config c where c.id),
                   (select s.id from vault.secrets s where s.name = ('imobdesk_google_sa_' || imobdesk.empresa_atual())));
  if v_id is null then
    v_id := vault.create_secret(p_json, ('imobdesk_google_sa_' || imobdesk.empresa_atual()), 'Chave da conta de serviço do Google Workspace (Imobdesk)');
  else
    perform vault.update_secret(v_id, p_json);
  end if;
  update imobdesk.at_config set google_sa_segredo_id = v_id, google_sa_email = j ->> 'client_email',
    google_sa_definido_em = now(), google_verificacao = null, atualizado_em = now(), atualizado_por = v_ator where id;
  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', 'secret', 'Chave da conta de serviço do Google Workspace substituída',
    null, jsonb_build_object('client_email', j ->> 'client_email'), 'at_config');
end;
$$;

-- Só para as Edge Functions (service_role).
create or replace function imobdesk.at_email_credenciais(p_conta bigint)
returns table (senha text, google_sa text)
language sql
stable
security definer
set search_path = ''
as $$
  select (select d.decrypted_secret from vault.decrypted_secrets d join imobdesk.at_email_contas c on c.senha_segredo_id = d.id where c.id = p_conta),
         (select d.decrypted_secret from vault.decrypted_secrets d join imobdesk.at_config c on c.google_sa_segredo_id = d.id where c.id);
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'imobdesk.at_email_contas_lista()', 'imobdesk.at_email_conta_salvar(jsonb)',
    'imobdesk.at_email_conta_senha(bigint, text)', 'imobdesk.at_email_conta_habilitar(bigint[], boolean)',
    'imobdesk.at_email_conta_excluir(bigint)', 'imobdesk.at_google_sa_salvar(text)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
  revoke execute on function imobdesk.at_email_credenciais(bigint) from public, anon, authenticated;
  grant execute on function imobdesk.at_email_credenciais(bigint) to service_role;
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
