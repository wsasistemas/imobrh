-- WhatsApp: descrição do problema + print e grupo interno criado pelo portal (pedido do Wagner, 09/10/2026).
--  1. Depois de identificar o colaborador, se a 1ª mensagem não explicou o problema ("Oi", "Bom dia"…), o sistema
--     pergunta: "Descreva em poucas palavras qual é o problema e, se puder, envie um print da tela." A resposta (texto
--     e/ou imagem) vira a descrição do ticket e só então o pedido entra na fila. Liga/desliga por setor
--     (wa_pedir_descricao, ligado por padrão).
--  2. O print (imagem/arquivo recebido pelo OpenWA) fica no bucket privado atendimento-whatsapp (a Edge do webhook
--     grava); vai como anexo da ação do ticket e junto com o pedido para o grupo interno (at_repasses.arquivo).
-- Só aditiva: bucket, colunas novas e funções trocadas (mesma assinatura) ou novas.

-- ---------- Prints e arquivos do WhatsApp (privado, 20 MB) ----------
insert into storage.buckets (id, name, public, file_size_limit)
values ('imobdesk-atendimento-whatsapp', 'imobdesk-atendimento-whatsapp', false, 20971520)
on conflict (id) do nothing;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'atendimento-whatsapp: leitura') then
    create policy "atendimento-whatsapp: leitura" on storage.objects for select to authenticated
      using (bucket_id = 'imobdesk-atendimento-whatsapp'
             and (select imobdesk.ch_eh_admin() or imobdesk.tem_permissao('gestao_chamados_tickets')
                         or imobdesk.tem_permissao('gestao_atendimento_central')));
  end if;
end;
$$;

alter table imobdesk.at_setores add column if not exists wa_pedir_descricao boolean not null default true;
alter table imobdesk.at_repasses add column if not exists arquivo jsonb;   -- {bucket, path, mime, nome}: o print vai junto

/** O pedido não explica o problema? (vazio, curto ou só saudação: "Oi", "Bom dia, tudo bem?"). */
create or replace function imobdesk.at_precisa_descricao(p_textos text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  with t as (select lower(btrim(coalesce(array_to_string(p_textos, ' '), ''))) as x)
  select length(regexp_replace(x, '[^[:alnum:]]', '', 'g')) < 12
      or x ~ '^(oi+|ol[aá]|opa|e a[ií]|eai|bom dia|boa tarde|boa noite|tudo bem|tudo bom|suporte|ajuda|preciso de ajuda|hello|hi|al[oô])([[:space:][:punct:]]+(oi+|ol[aá]|bom dia|boa tarde|boa noite|tudo bem|tudo bom|pessoal|equipe|ti|suporte|como vai|blz|beleza))*[[:space:][:punct:]]*$'
  from t;
$$;

/** Repasse com arquivo (print) para o grupo interno do número (só OpenWA com grupo configurado). */
create or replace function imobdesk.at_repassar_arquivo(p_conversa bigint, p_ticket bigint, p_tipo text, p_texto text, p_arquivo jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into imobdesk.at_repasses (numero_id, conversa_id, ticket_id, tipo, texto, arquivo)
  select n.id, c.id, p_ticket, p_tipo, left(p_texto, 4000), case when p_arquivo ? 'path' then p_arquivo end
  from imobdesk.at_conversas c
  join imobdesk.at_numeros n on n.id = c.numero_id
  where c.id = p_conversa and n.canal = 'openwa' and n.grupo_interno is not null;
$$;

/**
 * Depois de identificar: se o pedido não explica o problema (e não veio print), pergunta a descrição e espera
 * (modo robo, passo 'descricao'); senão entra na fila. p_prefixo_pergunta vai antes da pergunta; p_prefixo_fila,
 * antes das boas-vindas da fila.
 */
create or replace function imobdesk.at_seguir_ou_descrever(p_conversa bigint, p_pedido text[], p_prefixo_pergunta text, p_prefixo_fila text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c imobdesk.at_conversas;
  s imobdesk.at_setores;
  v_ticket bigint;
begin
  select * into c from imobdesk.at_conversas x where x.id = p_conversa;
  select * into s from imobdesk.at_setores x where x.id = c.setor_id;
  if s.wa_pedir_descricao and imobdesk.at_auto_conversa(c.id)
     and imobdesk.at_precisa_descricao(p_pedido)
     and not exists (select 1 from imobdesk.at_mensagens m
                     where m.conversa_id = c.id and m.atendimento_id is null and m.direcao = 'entrada' and m.arquivo ? 'path') then
    update imobdesk.at_conversas set modo = 'robo',
           ident = jsonb_build_object('passo', 'descricao', 'tentativas', 0, 'desde', now(), 'pedido', to_jsonb(coalesce(p_pedido, '{}')))
    where id = c.id;
    perform imobdesk.at_auto(c.id, concat_ws(' ', nullif(btrim(p_prefixo_pergunta), ''),
      'Descreva em poucas palavras qual é o problema e, se puder, envie um print da tela. 📸'));
    return jsonb_build_object('estado', 'descricao', 'conversaId', c.id);
  end if;
  v_ticket := imobdesk.at_entrar_fila(c.id, p_pedido, p_prefixo_fila);
  return jsonb_build_object('estado', 'fila', 'conversaId', c.id, 'ticketId', v_ticket);
end;
$$;

/**
 * Conversa entra na fila: abre o atendimento, cria o ticket (ou continua o aberto da conversa), grava o pedido
 * como 1ª ação, manda boas-vindas (ou fora do horário) e repassa ao grupo interno. p_prefixo vai antes da
 * mensagem automática ("Obrigado, Vinicius!").
 */
create or replace function imobdesk.at_entrar_fila(p_conversa bigint, p_pedido text[], p_prefixo text default null, p_forcar_novo boolean default false)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  c imobdesk.at_conversas;
  s imobdesk.at_setores;
  n imobdesk.at_numeros;
  v_atend bigint;
  v_ticket bigint;
  v_cat text;
  v_nome text;
  v_pedido text := nullif(btrim(array_to_string(coalesce(p_pedido, '{}'), E'\n')), '');
  v_aberto boolean;
  v_msg text;
  v_novo boolean := false;
  v_anexos jsonb;
begin
  select * into c from imobdesk.at_conversas x where x.id = p_conversa for update;
  select * into s from imobdesk.at_setores x where x.id = c.setor_id;
  select * into n from imobdesk.at_numeros x where x.id = c.numero_id;
  v_nome := imobdesk.at_nome_da_conversa(c);
  v_aberto := imobdesk.at_dentro_horario(c.setor_id);

  -- Voltou em até 24 h depois do último encerramento: conta como reaberto (indicador do Monitor).
  update imobdesk.at_atendimentos a set reaberto_em_24h = true
  where a.id = (select x.id from imobdesk.at_atendimentos x where x.conversa_id = c.id order by x.id desc limit 1)
    and a.encerrado_em is not null and a.encerrado_em > now() - interval '24 hours';

  -- Ticket aberto desta conversa continua (fechou com "não resolvido" ou ainda pendente).
  if not p_forcar_novo then
    select t.id, st.categoria into v_ticket, v_cat
    from imobdesk.ch_tickets t join imobdesk.ch_status st on st.id = t.status_id
    where t.conversa_id = c.id and t.excluido_em is null and t.mesclado_em_id is null and st.categoria in ('novo', 'andamento', 'pendente')
    order by t.id desc limit 1;
  end if;

  if v_ticket is null then
    insert into imobdesk.ch_tickets (assunto, origem, recebido_em, solicitante_pessoa_id, solicitante_nome, solicitante_contato, numero_id, conversa_id,
                                               setor_id, categoria_id, urgencia_id, status_id)
    values (left(coalesce(nullif(btrim(split_part(coalesce(v_pedido, ''), E'\n', 1)), ''), 'WhatsApp de ' || v_nome), 300), 'whatsapp',
            left('WhatsApp +' || n.numero, 160), c.pessoa_id, left(v_nome, 160), '+' || c.telefone, n.id, c.id, c.setor_id,
            (select x.id from imobdesk.ch_categorias x where x.padrao and x.ativa limit 1),
            coalesce((select u.id from imobdesk.ch_urgencias u where u.padrao and u.ativa limit 1), (select min(u.id) from imobdesk.ch_urgencias u)),
            coalesce(imobdesk.ch_status_de('novo'), 1))
    returning id into v_ticket;
    v_novo := true;
  elsif v_cat = 'pendente' then
    update imobdesk.ch_tickets set status_id = imobdesk.ch_status_de('andamento', 'Em atendimento'), justificativa_id = null where id = v_ticket;
  end if;

  -- Atendimento anterior ainda aberto (o colaborador pediu "novo"): fecha antes de abrir outro.
  update imobdesk.at_atendimentos set encerrado_em = now(), encerramento = 'sistema'
  where id = c.atendimento_id and encerrado_em is null;

  insert into imobdesk.at_atendimentos (conversa_id, setor_id, entrou_fila_em, fora_horario, ticket_id)
  values (c.id, c.setor_id, now(),
          not v_aberto or not exists (select 1 from imobdesk.at_atendentes a where a.setor_id = c.setor_id and a.apto and not a.pausa and a.online_em > now() - interval '3 minutes'),
          v_ticket)
  returning id into v_atend;

  update imobdesk.at_conversas set modo = 'fila', ident = null, atendente_id = null, atendente_desde = null, fila_desde = now(), atendimento_id = v_atend, atualizado_em = now()
  where id = c.id;
  -- Prints/arquivos que o colaborador mandou neste ciclo (antes de entrar na fila) vão para a 1ª ação do ticket.
  select coalesce(jsonb_agg(m.arquivo order by m.id) filter (where m.arquivo ? 'path'), '[]') into v_anexos
  from imobdesk.at_mensagens m
  where m.conversa_id = c.id and m.atendimento_id is null and m.direcao = 'entrada' and m.arquivo is not null;
  -- Mensagens deste ciclo ficam no atendimento novo.
  update imobdesk.at_mensagens set atendimento_id = v_atend where conversa_id = c.id and atendimento_id is null;

  if v_pedido is not null or jsonb_array_length(v_anexos) > 0 then
    perform imobdesk.at_ticket_acao(v_ticket, 'entrada', null, v_nome, coalesce(v_pedido, '[print]'), null, 'nao_se_aplica');
    if jsonb_array_length(v_anexos) > 0 then
      update imobdesk.ch_ticket_acoes set anexos = v_anexos
      where id = (select max(a.id) from imobdesk.ch_ticket_acoes a where a.ticket_id = v_ticket);
    end if;
  end if;
  perform imobdesk.at_evento(c.id, format('Na fila do setor %s · ticket #%s%s', s.nome, v_ticket, case when v_novo then ' aberto' else ' (continua)' end));

  v_msg := case when v_aberto then s.msg_boas_vindas else s.msg_fora_horario end;
  v_msg := replace(replace(v_msg, '{nome}', coalesce(imobdesk.at_primeiro_nome(v_nome), '')), '{ticket}', '#' || v_ticket);
  -- Com prefixo ("Obrigado, Vinicius!"), tira a saudação do início da mensagem do setor para não repetir.
  if nullif(btrim(p_prefixo), '') is not null then
    v_msg := regexp_replace(v_msg, '^\s*(olá|ola|oi)\s*[!,.]?\s*', '', 'i');
  end if;
  perform imobdesk.at_auto(c.id, concat_ws(' ', nullif(btrim(p_prefixo), ''), v_msg));

  perform imobdesk.at_repassar_arquivo(c.id, v_ticket, 'novo',
    format(E'🆕 *#%s* · %s%s\n"%s"', v_ticket, v_nome, case when v_novo then '' else ' (continua)' end, left(coalesce(v_pedido, case when jsonb_array_length(v_anexos) > 0 then '(enviou um print)' else '(sem texto)' end), 600))
    || E'\n\n_Responda citando esta mensagem para falar com o colaborador._',
    (select x from jsonb_array_elements(v_anexos) x where x ->> 'mime' like 'image/%' limit 1));
  return v_ticket;
end;
$$;

/**
 * Mensagem recebida (Zenvia ou OpenWA, service role). p:
 *   {canal: 'zenvia'|'openwa', para?: número de destino (Zenvia), sessao?: sessão do OpenWA, de: telefone,
 *    nome?, texto?, tipo?: texto|imagem|arquivo|audio|video, arquivo?: {nome, url?, mime}, externoId}
 * Devolve {estado, conversaId?, ticketId?}. Idempotente pelo externoId.
 */
create or replace function imobdesk.at_whatsapp_receber(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_canal text := coalesce(p ->> 'canal', 'zenvia');
  v_de text := regexp_replace(coalesce(p ->> 'de', ''), '\D', '', 'g');
  v_texto text := left(btrim(coalesce(p ->> 'texto', '')), 4000);
  v_tipo text := coalesce(nullif(p ->> 'tipo', ''), 'texto');
  v_ext text := nullif(p ->> 'externoId', '');
  n imobdesk.at_numeros;
  s imobdesk.at_setores;
  c imobdesk.at_conversas;
  l imobdesk.at_linhas;
  v_msg bigint;
  v_ticket bigint;
  v_nome text;
  v_cat text;
  v_t text;
  v_ident jsonb;
  v_tent int;
  v_pessoa bigint;
  v_email text;
  v_base bigint;   -- pessoa achada pelo número (linhas ou cadastro de Pessoas)
  v_corp boolean;
  v_real text := left(btrim(coalesce(p ->> 'texto', '')), 4000);   -- só o texto digitado (sem "[imagem]")
  v_res jsonb;
begin
  if v_de !~ '^\d{10,15}$' then return jsonb_build_object('estado', 'ignorado', 'motivo', 'telefone inválido'); end if;
  if v_tipo not in ('texto', 'arquivo', 'imagem', 'audio', 'video') then v_tipo := 'arquivo'; end if;

  if v_canal = 'openwa' then
    select * into n from imobdesk.at_numeros x where x.canal = 'openwa' and x.openwa_sessao = p ->> 'sessao' and x.ativo;
  else
    select * into n from imobdesk.at_numeros x where x.numero = regexp_replace(coalesce(p ->> 'para', ''), '\D', '', 'g') and x.ativo;
  end if;
  if n.id is null then return jsonb_build_object('estado', 'ignorado', 'motivo', 'número sem setor'); end if;
  if v_ext is not null and exists (select 1 from imobdesk.at_mensagens m where m.externo_id = v_ext or m.zenvia_id = v_ext) then
    return jsonb_build_object('estado', 'duplicado');
  end if;
  select * into s from imobdesk.at_setores x where x.id = n.setor_id;

  -- Conversa (uma por número + telefone). Duas mensagens juntas: a segunda espera a primeira (for update).
  insert into imobdesk.at_conversas (setor_id, numero_id, telefone, nome_contato, modo)
  values (n.setor_id, n.id, v_de, nullif(left(btrim(p ->> 'nome'), 80), ''), 'encerrada')
  on conflict (numero_id, telefone) do nothing;
  select * into c from imobdesk.at_conversas x where x.numero_id = n.id and x.telefone = v_de for update;

  insert into imobdesk.at_mensagens (conversa_id, atendimento_id, direcao, autor, tipo, texto, arquivo, status, zenvia_id, externo_id)
  values (c.id, case when c.modo in ('fila', 'atendente') then c.atendimento_id end, 'entrada', 'cliente', v_tipo, nullif(v_texto, ''),
          case when v_tipo <> 'texto' then p -> 'arquivo' end, 'recebida',
          case when v_canal = 'zenvia' then v_ext end, case when v_canal = 'openwa' then v_ext end)
  returning id into v_msg;
  update imobdesk.at_conversas set
    nome_contato = coalesce(nome_contato, nullif(left(btrim(p ->> 'nome'), 80), '')),
    ultima_msg_cliente_em = now(), ultima_msg_em = now(), nao_lidas = nao_lidas + 1,
    ultima_previa = left(coalesce(nullif(v_texto, ''), '[' || v_tipo || ']'), 200), atualizado_em = now()
  where id = c.id
  returning * into c;
  v_texto := coalesce(nullif(v_texto, ''), '[' || v_tipo || ']');
  v_t := lower(btrim(v_texto));

  -- ---------- Em atendimento (fila ou atendente): mensagem entra no ticket ----------
  if c.modo in ('fila', 'atendente') then
    v_ticket := imobdesk.at_ticket_da_conversa(c.id);
    v_nome := imobdesk.at_nome_da_conversa(c);
    if v_t = 'novo' then
      v_ticket := imobdesk.at_entrar_fila(c.id, '{}', 'Certo, abri um ticket novo. Conte o que você precisa.', true);
      return jsonb_build_object('estado', 'ticket_novo', 'conversaId', c.id, 'ticketId', v_ticket);
    end if;
    perform imobdesk.at_ticket_acao(v_ticket, 'entrada', null, v_nome, v_texto, v_msg, 'nao_se_aplica');
    if p -> 'arquivo' ? 'path' then
      update imobdesk.ch_ticket_acoes set anexos = jsonb_build_array(p -> 'arquivo')
      where id = (select max(a.id) from imobdesk.ch_ticket_acoes a where a.ticket_id = v_ticket);
    end if;
    select st.categoria into v_cat from imobdesk.ch_tickets t join imobdesk.ch_status st on st.id = t.status_id where t.id = v_ticket;
    if v_cat in ('pendente', 'resolvido') then
      update imobdesk.ch_tickets
         set status_id = imobdesk.ch_status_de('andamento', case when v_cat = 'resolvido' then 'Reaberto' else 'Em atendimento' end), justificativa_id = null
       where id = v_ticket;
    end if;
    perform imobdesk.at_repassar_arquivo(c.id, v_ticket, 'mensagem', format(E'💬 *#%s* · %s:\n"%s"', v_ticket, v_nome, left(v_texto, 1500)),
      case when p -> 'arquivo' ? 'path' and p -> 'arquivo' ->> 'mime' like 'image/%' then p -> 'arquivo' end);
    return jsonb_build_object('estado', 'mensagem', 'conversaId', c.id, 'ticketId', v_ticket);
  end if;

  -- ---------- Identificando (modo robo) ----------
  if c.modo = 'robo' then
    v_ident := coalesce(c.ident, '{}');
    v_tent := coalesce((v_ident ->> 'tentativas')::int, 0);
    select * into l from imobdesk.at_linhas x where x.numero = v_de;

    if v_ident ->> 'passo' = 'confirmar' then
      if v_t ~ '^(1|1\.|sim|s|sou|sou eu|isso|confirmo|correto|yes)$' then
        v_base := coalesce(nullif(v_ident ->> 'pessoaId', '')::bigint, l.pessoa_id);
        insert into imobdesk.at_linhas (numero, pessoa_id, corporativa, confirmado_em)
        values (v_de, v_base, false, now())
        on conflict (numero) do update set pessoa_id = excluded.pessoa_id, confirmado_em = now(), atualizado_em = now();
        insert into imobdesk.at_pessoa_contatos (pessoa_id, tipo, valor, principal)
        values (v_base, 'whatsapp', v_de, not exists (select 1 from imobdesk.at_pessoa_contatos x where x.pessoa_id = v_base and x.tipo = 'whatsapp'))
        on conflict (tipo, valor) do update set pessoa_id = excluded.pessoa_id;
        update imobdesk.at_conversas set pessoa_id = v_base, nome_contato = (select left(pe.nome, 80) from imobdesk.at_pessoas pe where pe.id = v_base)
        where id = c.id returning * into c;
        perform imobdesk.at_evento(c.id, 'Contato confirmado pelo colaborador');
        v_nome := format('Obrigado, %s!', imobdesk.at_primeiro_nome(imobdesk.at_nome_da_conversa(c)));
        return imobdesk.at_seguir_ou_descrever(c.id, array(select jsonb_array_elements_text(coalesce(v_ident -> 'pedido', '[]'))), v_nome, v_nome);
      elsif v_t ~ '^(2|2\.|n|nao|não|no|errado|não sou|nao sou)$' then
        update imobdesk.at_conversas set ident = v_ident || jsonb_build_object('passo', 'nome', 'tentativas', 0) where id = c.id;
        perform imobdesk.at_auto(c.id, 'Sem problemas! Para cadastrar você, qual é o seu nome completo?');
        return jsonb_build_object('estado', 'identificando', 'conversaId', c.id);
      end if;
    elsif v_ident ->> 'passo' = 'nome' then
      if length(v_texto) between 3 and 80 and v_texto ~ '[[:alpha:]]{2}' and v_texto !~ '@' then
        update imobdesk.at_conversas set ident = v_ident || jsonb_build_object('passo', 'email', 'tentativas', 0, 'nome', btrim(v_texto)) where id = c.id;
        perform imobdesk.at_auto(c.id, format('Obrigado, %s. Qual é o seu e-mail corporativo?', imobdesk.at_primeiro_nome(v_texto)));
        return jsonb_build_object('estado', 'identificando', 'conversaId', c.id);
      end if;
    elsif v_ident ->> 'passo' = 'email' then
      v_email := lower(btrim(v_texto));
      if v_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
         and split_part(v_email, '@', 2) = any (coalesce((select x.dominios_corporativos from imobdesk.at_config x where x.id), '{}')::text[]) then
        select pc.pessoa_id into v_pessoa from imobdesk.at_pessoa_contatos pc where pc.tipo = 'email' and pc.valor = v_email limit 1;
        if v_pessoa is null then
          v_pessoa := imobdesk.at_pessoa_identificar('email', v_email, v_ident ->> 'nome', 'WhatsApp ' || s.nome);
        end if;
        -- O número passa a ser desta pessoa (se estava em outra, muda).
        insert into imobdesk.at_pessoa_contatos (pessoa_id, tipo, valor, principal)
        values (v_pessoa, 'whatsapp', v_de, not exists (select 1 from imobdesk.at_pessoa_contatos x where x.pessoa_id = v_pessoa and x.tipo = 'whatsapp'))
        on conflict (tipo, valor) do update set pessoa_id = excluded.pessoa_id;
        insert into imobdesk.at_linhas (numero, pessoa_id, corporativa, confirmado_em)
        values (v_de, v_pessoa, false, now())
        on conflict (numero) do update set pessoa_id = excluded.pessoa_id, confirmado_em = now(), atualizado_em = now();
        update imobdesk.at_conversas set pessoa_id = v_pessoa, nome_contato = left(coalesce(v_ident ->> 'nome', nome_contato), 80)
        where id = c.id returning * into c;
        perform imobdesk.at_evento(c.id, format('Colaborador identificado: %s (%s)', imobdesk.at_nome_da_conversa(c), v_email));
        return imobdesk.at_seguir_ou_descrever(c.id, array(select jsonb_array_elements_text(coalesce(v_ident -> 'pedido', '[]'))),
                                                         'Pronto! Da próxima vez eu já te reconheço.', 'Pronto! Da próxima vez eu já te reconheço.');
      end if;
      v_tent := v_tent + 1;
      if v_tent >= 2 then
        if s.wa_so_corporativo then
          -- Linha corporativa (já conferida): segue para a fila sem identificação; o atendente completa.
          perform imobdesk.at_evento(c.id, 'Identificação não concluída (e-mail inválido): segue para a fila');
          v_ticket := imobdesk.at_entrar_fila(c.id, array(select jsonb_array_elements_text(coalesce(v_ident -> 'pedido', '[]'))));
          return jsonb_build_object('estado', 'fila', 'conversaId', c.id, 'ticketId', v_ticket);
        end if;
        perform imobdesk.at_auto(c.id, s.msg_nao_corporativo);
        update imobdesk.at_conversas set modo = 'encerrada', ident = null, aviso_nao_corporativo_em = now() where id = c.id;
        perform imobdesk.at_evento(c.id, 'Não é colaborador (e-mail fora do domínio): nenhum ticket aberto');
        return jsonb_build_object('estado', 'nao_colaborador', 'conversaId', c.id);
      end if;
      update imobdesk.at_conversas set ident = v_ident || jsonb_build_object('tentativas', v_tent) where id = c.id;
      perform imobdesk.at_auto(c.id, format('Esse e-mail não é de um domínio da empresa (%s). Qual é o seu e-mail corporativo?',
        (select array_to_string(array(select '@' || d from unnest(x.dominios_corporativos) d), ', ') from imobdesk.at_config x where x.id)));
      return jsonb_build_object('estado', 'identificando', 'conversaId', c.id);
    end if;

    -- Descrição do problema (texto e/ou print): qualquer resposta segue para a fila com o pedido completo.
    if v_ident ->> 'passo' = 'descricao' then
      -- Só o print, sem texto: guarda (a imagem já está na mensagem) e pede a descrição uma vez; segue esperando.
      if v_real = '' and v_tipo <> 'texto' then
        if not coalesce((v_ident ->> 'print')::boolean, false) then
          update imobdesk.at_conversas set ident = v_ident || jsonb_build_object('print', true) where id = c.id;
          perform imobdesk.at_auto(c.id, 'Recebi o print 👍 Agora escreva em poucas palavras qual é o problema.');
        end if;
        return jsonb_build_object('estado', 'descricao', 'conversaId', c.id);
      end if;
      -- A descrição vem primeiro (vira o assunto); a saudação do início ("Oi", "Bom dia") é descartada.
      v_ticket := imobdesk.at_entrar_fila(c.id,
        case when v_real <> '' then array[v_real] else '{}'::text[] end
        || case when imobdesk.at_precisa_descricao(array(select jsonb_array_elements_text(coalesce(v_ident -> 'pedido', '[]')))) then '{}'::text[]
                else array(select jsonb_array_elements_text(coalesce(v_ident -> 'pedido', '[]'))) end,
        'Obrigado!');
      return jsonb_build_object('estado', 'fila', 'conversaId', c.id, 'ticketId', v_ticket);
    end if;

    -- Resposta que não serve para o passo: repete a pergunta (3 vezes; depois segue para a fila).
    v_tent := v_tent + 1;
    if v_tent >= 3 then
      v_base := coalesce(nullif(v_ident ->> 'pessoaId', '')::bigint, l.pessoa_id);
      if v_base is not null then update imobdesk.at_conversas set pessoa_id = v_base where id = c.id; end if;
      perform imobdesk.at_evento(c.id, 'Identificação não concluída: segue para a fila');
      v_ticket := imobdesk.at_entrar_fila(c.id, array(select jsonb_array_elements_text(coalesce(v_ident -> 'pedido', '[]'))) || case when v_real <> '' then array[v_real] else '{}'::text[] end);
      return jsonb_build_object('estado', 'fila', 'conversaId', c.id, 'ticketId', v_ticket);
    end if;
    update imobdesk.at_conversas set ident = v_ident || jsonb_build_object('tentativas', v_tent) where id = c.id;
    perform imobdesk.at_auto(c.id, case v_ident ->> 'passo'
      when 'confirmar' then 'Não entendi. Responda 1 para Sim ou 2 para Não.'
      when 'nome' then 'Qual é o seu nome completo?'
      else 'Qual é o seu e-mail corporativo?' end);
    return jsonb_build_object('estado', 'identificando', 'conversaId', c.id);
  end if;

  -- ---------- Conversa nova ou encerrada: começa um atendimento ----------
  -- A base é a lista de linhas e o cadastro de Pessoas (contato WhatsApp ou telefone com este número).
  select * into l from imobdesk.at_linhas x where x.numero = v_de;
  v_base := coalesce(l.pessoa_id,
    (select pc.pessoa_id from imobdesk.at_pessoa_contatos pc
     where pc.valor = v_de and pc.tipo in ('whatsapp', 'telefone') order by (pc.tipo = 'whatsapp') desc, pc.id limit 1));
  -- Colaborador: linha corporativa ou pessoa da base com e-mail de um domínio da empresa.
  v_corp := coalesce(l.corporativa, false) or exists (
    select 1 from imobdesk.at_pessoa_contatos pc
    where pc.pessoa_id = v_base and pc.tipo = 'email'
      and split_part(pc.valor, '@', 2) = any (coalesce((select x.dominios_corporativos from imobdesk.at_config x where x.id), '{}')::text[]));
  if s.wa_so_corporativo and not v_corp then
    if c.aviso_nao_corporativo_em is null or c.aviso_nao_corporativo_em < now() - interval '24 hours' then
      perform imobdesk.at_auto(c.id, s.msg_nao_corporativo);
      update imobdesk.at_conversas set aviso_nao_corporativo_em = now() where id = c.id;
      perform imobdesk.at_evento(c.id, 'Número fora das linhas corporativas e sem cadastro de colaborador: nenhum ticket aberto');
    end if;
    return jsonb_build_object('estado', 'nao_corporativo', 'conversaId', c.id);
  end if;

  -- Já confirmado antes (ou identificação desligada): vincula a pessoa e segue.
  if v_base is not null and (l.confirmado_em is not null or not s.wa_identificar) then
    update imobdesk.at_conversas set pessoa_id = v_base where id = c.id returning * into c;
  end if;

  if s.wa_identificar and (l.confirmado_em is null or v_base is null) and imobdesk.at_auto_conversa(c.id) then
    if v_base is not null then
      -- Achou na base: confirma uma vez ("Você é Fulano (e-mail)?").
      update imobdesk.at_conversas set modo = 'robo',
             ident = jsonb_build_object('passo', 'confirmar', 'tentativas', 0, 'desde', now(), 'pedido', case when v_real <> '' then jsonb_build_array(v_real) else '[]'::jsonb end, 'pessoaId', v_base)
      where id = c.id;
      perform imobdesk.at_auto(c.id, format('Olá! Bem-vindo(a) ao suporte do setor %s. Você é %s (%s)? Responda 1 para Sim ou 2 para Não.', s.nome,
        (select pe.nome from imobdesk.at_pessoas pe where pe.id = v_base),
        coalesce((select pc.valor from imobdesk.at_pessoa_contatos pc where pc.pessoa_id = v_base and pc.tipo = 'email' order by pc.principal desc, pc.id limit 1), 'sem e-mail')));
      return jsonb_build_object('estado', 'identificando', 'conversaId', c.id);
    else
      -- Não achou: pede nome e e-mail para cadastrar.
      update imobdesk.at_conversas set modo = 'robo', ident = jsonb_build_object('passo', 'nome', 'tentativas', 0, 'desde', now(), 'pedido', case when v_real <> '' then jsonb_build_array(v_real) else '[]'::jsonb end)
      where id = c.id;
      perform imobdesk.at_auto(c.id, format('Olá! Bem-vindo(a) ao suporte do setor %s. Ainda não tenho seu cadastro: qual é o seu nome completo?', s.nome));
      return jsonb_build_object('estado', 'identificando', 'conversaId', c.id);
    end if;
  elsif not s.wa_identificar and c.pessoa_id is null then
    -- Setor sem identificação: autocadastro pelo número (como antes).
    update imobdesk.at_conversas
       set pessoa_id = imobdesk.at_pessoa_identificar('whatsapp', v_de, p ->> 'nome', 'WhatsApp ' || s.nome)
     where id = c.id;
  end if;

  return imobdesk.at_seguir_ou_descrever(c.id, case when v_real <> '' then array[v_real] else '{}'::text[] end,
    format('Olá%s! Bem-vindo(a) ao suporte do setor %s.', coalesce(', ' || imobdesk.at_primeiro_nome((select pe.nome from imobdesk.at_pessoas pe where pe.id = c.pessoa_id)), ''), s.nome),
    null);
end;
$$;

/**
 * Reserva o que está pendente para enviar (2 min; quem não confirmar libera de novo). p_conversa limita a uma
 * conversa (envio na hora, depois de uma ação). Devolve {mensagens: [...], repasses: [...]}.
 */
create or replace function imobdesk.at_whatsapp_reservar(p_limite int default 30, p_conversa bigint default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_msgs jsonb;
  v_reps jsonb;
begin
  with alvo as (
    select m.id from imobdesk.at_mensagens m
    where m.status = 'pendente' and m.direcao = 'saida' and m.envio_tentativas < 3
      and (m.envio_reservado_ate is null or m.envio_reservado_ate < now())
      and (p_conversa is null or m.conversa_id = p_conversa)
    order by m.id limit greatest(1, least(coalesce(p_limite, 30), 100))
    for update skip locked
  ), res as (
    update imobdesk.at_mensagens m set envio_reservado_ate = now() + interval '2 minutes' from alvo where m.id = alvo.id returning m.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id, 'texto', r.texto, 'autor', r.autor, 'autorNome', imobdesk.ch_nome_usuario(r.autor_id),
    'telefone', c.telefone, 'canal', n.canal, 'numero', n.numero, 'sessao', n.openwa_sessao, 'setor', s.nome,
    'arquivo', r.arquivo, 'tipo', r.tipo
  ) order by r.id), '[]') into v_msgs
  from res r
  join imobdesk.at_conversas c on c.id = r.conversa_id
  join imobdesk.at_numeros n on n.id = c.numero_id
  join imobdesk.at_setores s on s.id = c.setor_id;

  with alvo as (
    select x.id from imobdesk.at_repasses x
    where x.status = 'pendente' and x.envio_tentativas < 3 and (x.envio_reservado_ate is null or x.envio_reservado_ate < now())
      and (p_conversa is null or x.conversa_id = p_conversa)
    order by x.id limit greatest(1, least(coalesce(p_limite, 30), 100))
    for update skip locked
  ), res as (
    update imobdesk.at_repasses x set envio_reservado_ate = now() + interval '2 minutes' from alvo where x.id = alvo.id returning x.*
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'texto', r.texto, 'citar', r.citar_externo_id, 'sessao', n.openwa_sessao, 'grupo', n.grupo_interno, 'arquivo', r.arquivo) order by r.id), '[]')
  into v_reps
  from res r join imobdesk.at_numeros n on n.id = r.numero_id;

  return jsonb_build_object('mensagens', v_msgs, 'repasses', v_reps);
end;
$$;

/** Tudo o que a tela mostra. Supervisão geral vê todos os setores; o gestor, os dele. */
create or replace function imobdesk.at_openwa_painel()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_sup boolean := imobdesk.at_supervisor();
begin
  if auth.uid() is null or not (v_sup or exists (select 1 from imobdesk.at_setores s where imobdesk.at_gestor_de(s.id))) then
    perform imobdesk.erro('FORBIDDEN', 'Só a gestão do atendimento vê esta tela.');
  end if;
  return jsonb_build_object(
    'superAdmin', imobdesk.eh_super_admin(),
    'supervisor', v_sup,
    'conexao', (select jsonb_build_object('url', c.openwa_url, 'chaveMascara', c.openwa_chave_mascara, 'definidoEm', c.openwa_definido_em,
                                          'verificacao', c.openwa_verificacao, 'autoLigado', c.ligado, 'travaPiloto', c.trava_piloto,
                                          'dominios', to_jsonb(c.dominios_corporativos))
                from imobdesk.at_config c where c.id),
    'webhookUrl', null,
    'setores', coalesce((select jsonb_agg(jsonb_build_object(
        'id', s.id, 'nome', s.nome, 'waIdentificar', s.wa_identificar, 'waSoCorporativo', s.wa_so_corporativo, 'waRespostasAuto', s.wa_respostas_auto, 'waPedirDescricao', s.wa_pedir_descricao,
        'msgNaoCorporativo', s.msg_nao_corporativo, 'gestor', imobdesk.at_gestor_de(s.id),
        'numeros', coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'numero', n.numero, 'canal', n.canal, 'sessao', n.openwa_sessao,
                                                                  'grupo', n.grupo_interno, 'grupoNome', n.grupo_interno_nome) order by n.id)
                             from imobdesk.at_numeros n where n.setor_id = s.id and n.ativo), '[]'),
        'atendentes', coalesce((select jsonb_agg(jsonb_build_object('usuarioId', a.usuario_id, 'nome', u.nome, 'whatsapp', a.whatsapp) order by u.nome)
                                from imobdesk.at_atendentes a join imobdesk.usuarios u on u.id = a.usuario_id
                                where a.setor_id = s.id), '[]')
      ) order by s.nome)
      from imobdesk.at_setores s where s.ativo and (v_sup or imobdesk.at_gestor_de(s.id))), '[]'),
    'linhas', (select count(*) from imobdesk.at_linhas l where l.corporativa)
  );
end;
$$;

/** Regras de WhatsApp do setor (identificação e só linha corporativa). Gestão do setor. */
create or replace function imobdesk.at_setor_whatsapp_salvar(p jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := auth.uid();
  v_setor bigint := (p ->> 'setorId')::bigint;
  v_msg text := btrim(coalesce(p ->> 'msgNaoCorporativo', ''));
begin
  if v_ator is null or not imobdesk.at_gestor_de(v_setor) then
    perform imobdesk.erro('FORBIDDEN', 'Só a gestão do setor altera estas regras.');
  end if;
  if v_msg = '' or length(v_msg) > 1000 then
    perform imobdesk.erro('INVALID_INPUT', 'Escreva a mensagem para quem não é linha corporativa (até 1.000 letras).', 'msgNaoCorporativo');
  end if;
  update imobdesk.at_setores set
    wa_identificar = coalesce((p ->> 'waIdentificar')::boolean, wa_identificar),
    wa_so_corporativo = coalesce((p ->> 'waSoCorporativo')::boolean, wa_so_corporativo),
    wa_respostas_auto = coalesce((p ->> 'waRespostasAuto')::boolean, wa_respostas_auto),
    wa_pedir_descricao = coalesce((p ->> 'waPedirDescricao')::boolean, wa_pedir_descricao),
    msg_nao_corporativo = v_msg, atualizado_em = now(), atualizado_por = v_ator
  where id = v_setor;
  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', 'update', 'Regras de WhatsApp do setor alteradas', null, p, v_setor::text);
end;
$$;

/**
 * Ação na conversa por um usuário (interna: a pública at_conversa_acao confere quem chama).
 * p: {acao: assumir|devolver|transferir|enviar|encerrar, texto?, para?, resolvido?, origem?: 'portal'|'grupo'|'roleta'|'sistema'}
 */
create or replace function imobdesk.at_conversa_executar(p_conversa bigint, p_usuario uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c imobdesk.at_conversas;
  s imobdesk.at_setores;
  v_acao text := coalesce(p ->> 'acao', '');
  v_origem text := coalesce(p ->> 'origem', 'portal');
  v_nome text := coalesce(imobdesk.ch_nome_usuario(p_usuario), 'Atendente');
  v_ticket bigint;
  v_texto text;
  v_msg bigint;
  v_para uuid;
  v_cat text;
  v_resolvido boolean := coalesce((p ->> 'resolvido')::boolean, false);
  v_fim text;
begin
  select * into c from imobdesk.at_conversas x where x.id = p_conversa for update;
  if c.id is null then perform imobdesk.erro('NOT_FOUND', 'Conversa não encontrada.'); end if;
  select * into s from imobdesk.at_setores x where x.id = c.setor_id;
  v_ticket := imobdesk.at_ticket_da_conversa(c.id);
  if c.modo in ('encerrada', 'robo') and v_acao <> 'enviar' then
    perform imobdesk.erro('INVALID_INPUT', case when c.modo = 'robo' then 'O colaborador ainda está respondendo ao atendimento automático (identificação ou descrição do problema). A conversa entra na fila em instantes.' else 'Conversa encerrada. Ela reabre quando o cliente escrever de novo.' end);
  end if;

  if v_acao in ('assumir', 'transferir') then
    v_para := case when v_acao = 'transferir' then nullif(p ->> 'para', '')::uuid else p_usuario end;
    if v_acao = 'transferir' and not exists (select 1 from imobdesk.at_atendentes a where a.usuario_id = v_para and a.setor_id = c.setor_id) then
      perform imobdesk.erro('INVALID_INPUT', 'Escolha um atendente do mesmo setor.', 'para');
    end if;
    if c.atendente_id is not distinct from v_para then return jsonb_build_object('ok', true); end if;
    update imobdesk.at_conversas set modo = 'atendente', atendente_id = v_para, atendente_desde = now(), ultimo_atendente_id = v_para,
           nao_lidas = case when v_origem = 'portal' and v_acao = 'assumir' then 0 else nao_lidas end, atualizado_em = now()
    where id = c.id;
    update imobdesk.at_atendimentos set atendente_id = v_para, assumido_em = coalesce(assumido_em, now()),
           transferencias = transferencias + case when c.atendente_id is not null then 1 else 0 end
    where id = c.atendimento_id;
    if v_origem = 'roleta' then
      update imobdesk.at_atendentes set ultimo_recebido_em = now() where usuario_id = v_para;
    end if;
    -- Ticket: responsável = quem atende; sai de "Novo" para "Em atendimento".
    select st.categoria into v_cat from imobdesk.ch_tickets t join imobdesk.ch_status st on st.id = t.status_id where t.id = v_ticket;
    update imobdesk.ch_tickets set responsavel_id = v_para,
           status_id = case when v_cat in ('novo', 'pendente') then imobdesk.ch_status_de('andamento', 'Em atendimento') else status_id end,
           assumido_em = coalesce(assumido_em, now())
    where id = v_ticket;
    perform imobdesk.at_evento(c.id, case
      when v_origem = 'roleta' then format('Distribuída pela roleta para %s', imobdesk.ch_nome_usuario(v_para))
      when v_acao = 'transferir' then format('Conversa transferida para %s por %s', imobdesk.ch_nome_usuario(v_para), v_nome)
      when c.atendente_id is not null then format('Conversa transferida de %s para %s', imobdesk.ch_nome_usuario(c.atendente_id), v_nome)
      when v_origem in ('grupo', 'celular') then format('%s assumiu ao responder pelo WhatsApp', v_nome)
      else format('%s assumiu a conversa', v_nome) end);
    return jsonb_build_object('ok', true);
  end if;

  if v_acao = 'devolver' then
    update imobdesk.at_conversas set modo = 'fila', atendente_id = null, atendente_desde = null, fila_desde = now(), atualizado_em = now() where id = c.id;
    update imobdesk.at_atendimentos set devolvido_fila = true where id = c.atendimento_id;
    perform imobdesk.at_evento(c.id, case when v_origem = 'sistema' then format('Voltou à fila: %s sem responder há %s min', coalesce(imobdesk.ch_nome_usuario(c.atendente_id), 'atendente'), s.atendente_sem_resposta_min)
                                                    else format('%s devolveu a conversa à fila', v_nome) end);
    return jsonb_build_object('ok', true);
  end if;

  if v_acao = 'enviar' then
    v_texto := left(btrim(coalesce(p ->> 'texto', '')), 4000);
    if v_texto = '' then perform imobdesk.erro('INVALID_INPUT', 'Escreva a mensagem.', 'texto'); end if;
    if c.modo in ('encerrada', 'robo') then
      perform imobdesk.erro('INVALID_INPUT', 'Conversa encerrada. Responda pelo ticket ou espere o cliente escrever.');
    end if;
    -- "RESOLVIDO" (no portal ou no grupo interno) não vai para o colaborador: resolve o ticket e encerra.
    if imobdesk.at_eh_resolvido(v_texto) then
      if c.modo = 'fila' or c.atendente_id is distinct from p_usuario then
        perform imobdesk.at_conversa_executar(c.id, p_usuario, jsonb_build_object('acao', 'assumir', 'origem', v_origem));
      end if;
      return imobdesk.at_conversa_executar(c.id, p_usuario, jsonb_build_object('acao', 'encerrar', 'resolvido', true, 'direto', true, 'origem', v_origem));
    end if;
    if c.modo = 'fila' or c.atendente_id is distinct from p_usuario then
      if c.modo = 'atendente' and c.atendente_id is distinct from p_usuario and not coalesce((p ->> 'podeTomar')::boolean, false) then
        perform imobdesk.erro('FORBIDDEN', format('Esta conversa está com %s.', imobdesk.ch_nome_usuario(c.atendente_id)));
      end if;
      perform imobdesk.at_conversa_executar(c.id, p_usuario, jsonb_build_object('acao', 'assumir', 'origem', v_origem));
    end if;
    insert into imobdesk.at_mensagens (conversa_id, atendimento_id, direcao, autor, autor_id, tipo, texto, status)
    values (c.id, c.atendimento_id, 'saida', 'atendente', p_usuario, 'texto', v_texto, 'pendente')
    returning id into v_msg;
    perform imobdesk.at_ticket_acao(v_ticket, 'saida', p_usuario, v_nome, v_texto, v_msg, 'pendente');
    update imobdesk.at_conversas set ultima_msg_atendente_em = now(), ultima_msg_em = now(), ultima_previa = left('Você: ' || v_texto, 200), nao_lidas = 0, atualizado_em = now()
    where id = c.id;
    update imobdesk.at_atendimentos set primeira_resposta_em = coalesce(primeira_resposta_em, now()) where id = c.atendimento_id;
    if v_origem = 'portal' then
      perform imobdesk.at_repassar(c.id, v_ticket, 'enviado', format('✔ %s respondeu *#%s* pelo sistema:%s"%s"', v_nome, v_ticket, E'\n', left(v_texto, 500)));
    end if;
    return jsonb_build_object('ok', true, 'mensagemId', v_msg);
  end if;

  if v_acao = 'encerrar' then
    -- Ticket: resolvido (pelo diálogo, a RPC pública já validou e gravou; pela palavra RESOLVIDO, resolve aqui direto)
    -- ou continua "Em atendimento".
    if v_resolvido and coalesce((p ->> 'direto')::boolean, false) then
      perform imobdesk.at_ticket_resolver_direto(v_ticket, p_usuario);
    elsif not v_resolvido then
      select st.categoria into v_cat from imobdesk.ch_tickets t join imobdesk.ch_status st on st.id = t.status_id where t.id = v_ticket;
      if v_cat in ('novo', 'pendente', 'andamento') then
        update imobdesk.ch_tickets set status_id = imobdesk.ch_status_de('andamento', 'Em atendimento'), justificativa_id = null where id = v_ticket;
      end if;
    end if;
    -- Mensagem final ao solicitante, sempre com o número do chamado.
    v_fim := replace(s.msg_encerramento, '{ticket}', '#' || coalesce(v_ticket::text, ''));
    v_fim := case
      when v_ticket is null then v_fim
      when v_resolvido then format('✅ Seu chamado *#%s* foi resolvido e encerrado. %s', v_ticket, v_fim)
      when v_origem = 'sistema' then format('Encerramos esta conversa por falta de resposta. Seu chamado *#%s* continua aberto; é só responder aqui para retomar.', v_ticket)
      else format('Seu chamado *#%s* continua em atendimento com a nossa equipe. %s', v_ticket, v_fim) end;
    perform imobdesk.at_auto(c.id, v_fim);
    update imobdesk.at_conversas set modo = 'encerrada', ultimo_atendente_id = coalesce(c.atendente_id, p_usuario, ultimo_atendente_id), atendente_id = null,
           ultima_previa = 'Atendimento encerrado', atualizado_em = now()
    where id = c.id;
    update imobdesk.at_atendimentos set encerrado_em = now(), encerrado_por = p_usuario,
           encerramento = case when v_origem = 'sistema' then 'inatividade' else 'atendente' end
    where id = c.atendimento_id;
    perform imobdesk.at_evento(c.id, case when v_origem = 'sistema' then format('Encerrada por inatividade (%s h sem mensagem do cliente) · ticket #%s em atendimento', s.encerrar_apos_horas, v_ticket)
      else format('%s encerrou a conversa · ticket #%s %s', v_nome, v_ticket, case when v_resolvido then 'resolvido' else 'continua em atendimento' end) end);
    perform imobdesk.at_repassar(c.id, v_ticket, 'aviso', format('✅ *#%s* encerrado%s · %s', v_ticket,
      case when v_origem = 'sistema' then ' por inatividade' else ' por ' || v_nome end, case when v_resolvido then 'resolvido' else 'continua em atendimento' end));
    return jsonb_build_object('ok', true, 'ticketId', v_ticket);
  end if;

  perform imobdesk.erro('INVALID_INPUT', 'Ação inválida.');
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array['at_repassar_arquivo(bigint, bigint, text, text, jsonb)', 'at_seguir_ou_descrever(bigint, text[], text, text)'] loop
    execute format('revoke execute on function imobdesk.%s from public, anon, authenticated', f);
    execute format('grant execute on function imobdesk.%s to service_role', f);
  end loop;
  revoke execute on function imobdesk.at_precisa_descricao(text[]) from public, anon;
  grant execute on function imobdesk.at_precisa_descricao(text[]) to authenticated, service_role;
end;
$$;

notify pgrst, 'reload schema';
