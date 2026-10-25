-- Etapa 4 (docs/PLANO-recebimento-email-ticket.md): e-mail recebido vira ticket ou ação, e a resposta pública
-- do ticket sai pela conta de e-mail. A Edge imobdesk-email-sync roda a cada 1 min pelo pg_cron,
-- autenticada por uma chave no Vault (sem JWT). Só aditiva.

-- ---------- Colunas de controle ----------
alter table imobdesk.at_email_recebidos add column if not exists motivo text;
alter table imobdesk.at_email_recebidos add column if not exists ticket_id bigint references imobdesk.ch_tickets (id) on delete set null;
create index if not exists at_email_recebidos_provedor_idx on imobdesk.at_email_recebidos (conta_id, provedor_id);

alter table imobdesk.ch_ticket_acoes add column if not exists envio_tentativas int not null default 0;
alter table imobdesk.ch_ticket_acoes add column if not exists enviado_em timestamptz;
create index if not exists ch_ticket_acoes_msgid_idx on imobdesk.ch_ticket_acoes (email_message_id) where email_message_id is not null;
create index if not exists ch_ticket_acoes_envio_idx on imobdesk.ch_ticket_acoes (criado_em) where envio_status = 'pendente';

-- ---------- Anexos dos e-mails (privado, 25 MB por arquivo) ----------
insert into storage.buckets (id, name, public, file_size_limit)
values ('imobdesk-atendimento-email', 'imobdesk-atendimento-email', false, 26214400)
on conflict (id) do nothing;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'atendimento-email: leitura') then
    create policy "atendimento-email: leitura" on storage.objects for select to authenticated
      using (bucket_id = 'imobdesk-atendimento-email'
             and (select imobdesk.ch_eh_admin() or imobdesk.tem_permissao('gestao_chamados_tickets')));
  end if;
end;
$$;

-- ---------- Chave do agendamento (pg_cron → Edge) ----------
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'imobdesk_email_cron') then
    perform vault.create_secret(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'imobdesk_email_cron',
      'Chave do pg_cron para a Edge imobdesk-email-sync (Imobdesk)');
  end if;
end;
$$;

create or replace function imobdesk.at_email_cron_chave()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select d.decrypted_secret from vault.decrypted_secrets d where d.name = 'imobdesk_email_cron';
$$;

-- ---------- E-mail recebido → ticket novo ou ação no ticket ----------
/**
 * Processa um e-mail de at_email_recebidos (estado pendente). Resposta ("[#n]" no assunto ou In-Reply-To/References
 * de uma ação já trocada) vira ação de entrada no ticket; senão, abre ticket no setor da conta, conforme a regra de
 * abertura da conta. Ticket Resolvido volta como "Reaberto"; Aguardando volta para "Em atendimento"; Fechado ou
 * Cancelado abre ticket novo. Devolve {estado, ticketId, motivo}.
 */
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

-- ---------- Respostas públicas a enviar por e-mail ----------
/** Ações públicas pendentes de tickets de e-mail, com tudo o que a Edge precisa para montar a mensagem. */
create or replace function imobdesk.ch_email_para_enviar(p_limite int default 20)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(x order by x ->> 'criadoEm'), '[]') from (
    select jsonb_build_object(
      'acaoId', a.id, 'ticketId', t.id, 'numero', a.numero, 'texto', a.texto, 'html', a.html, 'criadoEm', a.criado_em,
      'tentativas', a.envio_tentativas, 'assunto', t.assunto, 'para', t.solicitante_contato, 'cc', to_jsonb(t.cc),
      'contaId', c.id, 'contaEmail', c.email, 'remetente', coalesce(nullif(btrim(c.nome_remetente), ''), c.nome),
      'exibirRemetente', c.exibir_no_envio, 'responderPara', c.responder_para, 'copiaOculta', c.copia_oculta, 'assinatura', c.assinatura,
      'raiz', t.email_thread_id,
      'ultimaRecebida', (select e.email_message_id from imobdesk.ch_ticket_acoes e
                          where e.ticket_id = t.id and e.direcao = 'entrada' and e.email_message_id is not null order by e.numero desc limit 1),
      'threadGmail', (select r.thread_id from imobdesk.at_email_recebidos r where r.ticket_id = t.id and r.conta_id = c.id order by r.id desc limit 1)
    ) x
    from imobdesk.ch_ticket_acoes a
    join imobdesk.ch_tickets t on t.id = a.ticket_id
    join imobdesk.at_email_contas c on c.id = t.email_conta_id
    where a.envio_status = 'pendente' and a.canal = 'email' and a.tipo = 'publica' and a.direcao = 'saida'
      and t.excluido_em is null and c.habilitada and c.modo = 'oauth_google' and c.oauth_segredo_id is not null
    order by a.criado_em
    limit greatest(1, least(p_limite, 100))
  ) s;
$$;

/** Resultado do envio: enviado (com o Message-ID, que liga a resposta do cliente ao ticket) ou falha (3 tentativas). */
create or replace function imobdesk.ch_email_envio_resultado(p_acao bigint, p_ok boolean, p_message_id text, p_erro text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_ok then
    update imobdesk.ch_ticket_acoes
       set envio_status = 'enviado', envio_erro = null, email_message_id = p_message_id, enviado_em = now(), envio_tentativas = envio_tentativas + 1
     where id = p_acao;
  else
    update imobdesk.ch_ticket_acoes
       set envio_tentativas = envio_tentativas + 1, envio_erro = left(p_erro, 1000),
           envio_status = case when envio_tentativas + 1 >= 3 then 'falhou' else 'pendente' end
     where id = p_acao;
  end if;
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array['at_email_cron_chave()', 'ch_email_processar(bigint)', 'ch_email_para_enviar(int)', 'ch_email_envio_resultado(bigint, boolean, text, text)'] loop
    execute format('revoke execute on function imobdesk.%s from public, anon, authenticated', f);
    execute format('grant execute on function imobdesk.%s to service_role', f);
  end loop;
end;
$$;

-- ---------- Agendamento: lê as caixas e envia as respostas a cada 1 min ----------
do $$
begin
  if exists (select 1 from cron.job where jobname = 'imobdesk-email-1min') then
    perform cron.unschedule('imobdesk-email-1min');
  end if;
  perform cron.schedule('imobdesk-email-1min', '* * * * *', $job$
    select net.http_post(
      url := 'https://ikvjaowvpvxojvcfwnct.supabase.co/functions/v1/imobdesk-email-sync',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-atendimento-chave', imobdesk.at_email_cron_chave()),
      body := '{"acao": "ciclo"}'::jsonb,
      timeout_milliseconds := 55000
    );
  $job$);
end;
$$;
