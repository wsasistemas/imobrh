-- Imobdesk · parte 3 de 4 (20261009190000_imobdesk_whatsapp_descricao_print.sql … 20261017110000_imobdesk_sf_formularios.sql).
-- Cole no SQL Editor do ikvj e rode. Tudo numa transação.
begin;

-- ======================================== 20261009190000_imobdesk_whatsapp_descricao_print.sql
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

-- ======================================== 20261009200000_imobdesk_grupo_sem_citacao.sql
-- Grupo interno: resposta do atendente sem citar o pedido (pedido do Wagner, 09/10/2026, depois do 1º teste com o
-- Nathan, que respondeu "oii" no grupo sem citar e o sistema só mandou a dica).
-- Antes: só a mensagem que CITAVA um repasse ia para o colaborador. Agora, em ordem:
--   1. citando um pedido (🆕/💬)                      → aquele atendimento (como antes);
--   2. começando com "#1021 …"                       → o atendimento aberto do ticket #1021;
--   3. sem citação, o atendente está com UM atendimento → esse;
--   4. sem citação, nenhum dele e UM pedido na fila     → ele assume (o ticket fica no nome dele) e a mensagem segue;
--   5. ambíguo                                        → não envia; responde no grupo com a lista "#ticket · nome".
-- "RESOLVIDO" segue a mesma escolha e fecha o ticket (at_conversa_executar). Cada envio é confirmado no grupo.
-- Só aditiva: troca at_grupo_receber (mesma assinatura).

create or replace function imobdesk.at_grupo_receber(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  n imobdesk.at_numeros;
  a imobdesk.at_atendentes;
  x imobdesk.at_repasses;
  c imobdesk.at_conversas;
  v_autor text := regexp_replace(coalesce(p ->> 'autor', ''), '\D', '', 'g');
  v_texto text := left(btrim(coalesce(p ->> 'texto', '')), 4000);
  v_cit text := nullif(p ->> 'citadoId', '');
  v_ext text := nullif(p ->> 'externoId', '');
  v_core text;
  v_res jsonb;
  v_ticket bigint;
  v_conv bigint;
  v_lista text;
  v_qtd int;
  v_minhas bigint[];
  v_fila bigint[];
begin
  select * into n from imobdesk.at_numeros z where z.canal = 'openwa' and z.openwa_sessao = p ->> 'sessao' and z.grupo_interno = p ->> 'grupo' and z.ativo;
  if n.id is null then return jsonb_build_object('estado', 'ignorado', 'motivo', 'grupo não configurado'); end if;
  select * into a from imobdesk.at_atendentes z where z.whatsapp = v_autor and z.setor_id = n.setor_id;
  if a.usuario_id is null then return jsonb_build_object('estado', 'ignorado', 'motivo', 'autor não é atendente do setor'); end if;
  if v_texto = '' then return jsonb_build_object('estado', 'ignorado', 'motivo', 'sem texto'); end if;

  if v_cit is not null then
    -- 1. Citando: o id pode vir completo (true_<grupo>_<id>_<autor>) ou só o miolo; compara pelo miolo.
    v_core := case when v_cit ~ '^(true|false)_' then split_part(v_cit, '_', 3) else v_cit end;
    select * into x from imobdesk.at_repasses r
    where r.numero_id = n.id and r.externo_id is not null and r.conversa_id is not null
      and (r.externo_id = v_cit or split_part(r.externo_id, '_', 3) = v_core or r.externo_id = v_core)
    order by r.id desc limit 1;
    v_conv := x.conversa_id;
    -- Citou uma mensagem que não é pedido (ex.: a dica ou conversa entre atendentes): trata como sem citação.
  end if;

  if v_conv is null and v_texto ~ '^#\d{1,12}\M' then
    -- 2. "#1021 texto": o atendimento aberto do ticket.
    v_ticket := substring(v_texto from '^#(\d{1,12})')::bigint;
    v_texto := btrim(regexp_replace(v_texto, '^#\d{1,12}[[:space:][:punct:]]*', ''));
    select c2.id into v_conv
    from imobdesk.at_conversas c2 join imobdesk.at_atendimentos at2 on at2.id = c2.atendimento_id
    where c2.numero_id = n.id and at2.ticket_id = v_ticket and c2.modo in ('fila', 'atendente');
    if v_conv is null then
      insert into imobdesk.at_repasses (numero_id, tipo, texto, citar_externo_id)
      values (n.id, 'aviso', format('⚠️ Não há atendimento aberto no WhatsApp para o *#%s*. Se ele foi encerrado, responda pelo ticket no sistema.', v_ticket), v_ext);
      return jsonb_build_object('estado', 'ticket_sem_conversa', 'ticketId', v_ticket);
    end if;
    if v_texto = '' then
      insert into imobdesk.at_repasses (numero_id, tipo, texto, citar_externo_id)
      values (n.id, 'aviso', format('💡 Escreva a mensagem depois do número, ex.: *#%s Já liberei o acesso* (ou *#%s RESOLVIDO*).', v_ticket, v_ticket), v_ext);
      return jsonb_build_object('estado', 'sem_texto');
    end if;
  end if;

  if v_conv is null then
    -- 3/4. Sem citação: o atendimento dele, se for um só; senão o único pedido na fila.
    v_minhas := array(select c2.id from imobdesk.at_conversas c2
                      where c2.numero_id = n.id and c2.modo = 'atendente' and c2.atendente_id = a.usuario_id order by c2.ultima_msg_em desc);
    v_fila := array(select c2.id from imobdesk.at_conversas c2
                    where c2.numero_id = n.id and c2.modo = 'fila' order by c2.fila_desde);
    if cardinality(v_minhas) = 1 then
      v_conv := v_minhas[1];
    elsif cardinality(v_minhas) = 0 and cardinality(v_fila) = 1 then
      v_conv := v_fila[1];
    else
      -- 5. Ambíguo (ou nada aberto): não envia; mostra o que está aberto. A conversa entre atendentes continua livre:
      --    sem nada aberto, a dica sai no máximo a cada 30 min.
      select count(*), string_agg(format('*#%s* · %s%s', at2.ticket_id, imobdesk.at_nome_da_conversa(c2),
               case when c2.atendente_id is null then ' (na fila)' when c2.atendente_id = a.usuario_id then ' (com você)'
                    else ' (com ' || coalesce(imobdesk.at_primeiro_nome(imobdesk.ch_nome_usuario(c2.atendente_id)), 'outro') || ')' end),
               E'\n' order by c2.ultima_msg_em desc)
        into v_qtd, v_lista
      from imobdesk.at_conversas c2 join imobdesk.at_atendimentos at2 on at2.id = c2.atendimento_id
      where c2.numero_id = n.id and c2.modo in ('fila', 'atendente');
      if coalesce(v_qtd, 0) = 0 then
        if a.grupo_dica_em is null or a.grupo_dica_em < now() - interval '30 minutes' then
          update imobdesk.at_atendentes set grupo_dica_em = now() where usuario_id = a.usuario_id;
          insert into imobdesk.at_repasses (numero_id, tipo, texto, citar_externo_id)
          values (n.id, 'aviso', '💡 Nenhum pedido aberto agora. Quando chegar um (🆕), responda citando o pedido ou começando com o número, ex.: *#1021 Já resolvi*.', v_ext);
        end if;
        return jsonb_build_object('estado', 'sem_pedido_aberto');
      end if;
      insert into imobdesk.at_repasses (numero_id, tipo, texto, citar_externo_id)
      values (n.id, 'aviso', format(E'💡 Não enviei: há %s pedidos abertos. Cite o pedido ou comece com o número (ex.: *#1021 sua mensagem*):\n%s', v_qtd, v_lista), v_ext);
      return jsonb_build_object('estado', 'ambiguo', 'abertos', v_qtd);
    end if;
  end if;

  select * into c from imobdesk.at_conversas z where z.id = v_conv;
  v_ticket := imobdesk.at_ticket_da_conversa(c.id);
  if c.modo in ('encerrada', 'robo') then
    insert into imobdesk.at_repasses (numero_id, conversa_id, ticket_id, tipo, texto, citar_externo_id)
    values (n.id, c.id, v_ticket, 'aviso', format('⚠️ O atendimento do *#%s* já foi encerrado. Para falar com o colaborador, responda pelo ticket no sistema.', v_ticket), v_ext);
    return jsonb_build_object('estado', 'encerrada');
  end if;
  if c.modo = 'atendente' and c.atendente_id is distinct from a.usuario_id and not exists (
       select 1 from imobdesk.at_setor_gestores g where g.setor_id = c.setor_id and g.usuario_id = a.usuario_id) then
    insert into imobdesk.at_repasses (numero_id, conversa_id, ticket_id, tipo, texto, citar_externo_id)
    values (n.id, c.id, v_ticket, 'aviso', format('⚠️ O *#%s* está com %s. Combine com ele(a) ou peça a transferência.', v_ticket, imobdesk.ch_nome_usuario(c.atendente_id)), v_ext);
    return jsonb_build_object('estado', 'com_outro');
  end if;

  -- Envia como o atendente (assume se estava na fila; "RESOLVIDO" fecha o ticket e avisa o colaborador).
  v_res := imobdesk.at_conversa_executar(c.id, a.usuario_id, jsonb_build_object('acao', 'enviar', 'texto', v_texto, 'origem', 'grupo', 'podeTomar', true));
  insert into imobdesk.at_repasses (numero_id, conversa_id, ticket_id, tipo, texto, citar_externo_id)
  values (n.id, c.id, v_ticket, 'enviado',
          case when imobdesk.at_eh_resolvido(v_texto)
               then format('✅ *#%s* resolvido por %s. %s foi avisado(a).', v_ticket, imobdesk.ch_nome_usuario(a.usuario_id), imobdesk.at_nome_da_conversa(c))
               else format('✔ Enviado a %s (*#%s*)%s', imobdesk.at_nome_da_conversa(c), v_ticket,
                           case when c.modo = 'fila' then ' · atendimento assumido por ' || imobdesk.ch_nome_usuario(a.usuario_id) else '' end) end,
          v_ext);
  return jsonb_build_object('estado', 'enviada', 'conversaId', c.id, 'ticketId', v_ticket) || coalesce(v_res, '{}');
end;
$$;

notify pgrst, 'reload schema';

-- ======================================== 20261009210000_imobdesk_openwa_liga_desliga.sql
-- Chave geral do WhatsApp OpenWA (pedido do Wagner, 09/10/2026): o administrador desliga o recebimento e o envio
-- pelo OpenWA sem perder a configuração. Desligado: o webhook ignora as mensagens (nada vira conversa nem ticket) e o
-- despachante não envia nada pelo OpenWA; o que estava pendente é cancelado ao desligar, para não sair mensagem velha
-- ao religar. A Zenvia e o e-mail não mudam. Só aditiva.

alter table imobdesk.at_config add column if not exists openwa_ligado boolean not null default true;
alter table imobdesk.at_config add column if not exists openwa_ligado_em timestamptz;
alter table imobdesk.at_config add column if not exists openwa_ligado_por uuid;

/** Liga ou desliga o OpenWA. Supervisão geral ou super admin. Ao desligar, cancela o que estava esperando envio. */
create or replace function imobdesk.at_openwa_ligar(p_ligado boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := auth.uid();
  v_msgs int := 0;
  v_reps int := 0;
begin
  if v_ator is null or not (imobdesk.at_supervisor() or imobdesk.eh_super_admin()) then
    perform imobdesk.erro('FORBIDDEN', 'Só a supervisão geral liga ou desliga o WhatsApp OpenWA.');
  end if;
  update imobdesk.at_config set openwa_ligado = coalesce(p_ligado, true), openwa_ligado_em = now(), openwa_ligado_por = v_ator where id;
  if not coalesce(p_ligado, true) then
    update imobdesk.at_mensagens m set status = 'falhou', erro = 'WhatsApp OpenWA desligado pelo administrador.', envio_reservado_ate = null
    from imobdesk.at_conversas c join imobdesk.at_numeros n on n.id = c.numero_id
    where m.conversa_id = c.id and n.canal = 'openwa' and m.status = 'pendente' and m.direcao = 'saida';
    get diagnostics v_msgs = row_count;
    update imobdesk.at_repasses set status = 'falhou', erro = 'WhatsApp OpenWA desligado pelo administrador.', envio_reservado_ate = null
    where status = 'pendente';
    get diagnostics v_reps = row_count;
  end if;
  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', 'update',
    case when p_ligado then 'WhatsApp OpenWA ligado' else format('WhatsApp OpenWA desligado (%s mensagens e %s repasses pendentes cancelados)', v_msgs, v_reps) end,
    null, jsonb_build_object('ligado', p_ligado), 'at_config');
  return jsonb_build_object('ligado', p_ligado, 'canceladas', v_msgs + v_reps);
end;
$$;

/** Para as Edge Functions (webhook e despachante). */
create or replace function imobdesk.at_openwa_ligado()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select c.openwa_ligado from imobdesk.at_config c where c.id), true);
$$;

-- Despachante: com o OpenWA desligado, não reserva nada que sairia por ele (a Zenvia segue normal).
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
      and (imobdesk.at_openwa_ligado()
           or not exists (select 1 from imobdesk.at_conversas cx join imobdesk.at_numeros nx on nx.id = cx.numero_id
                          where cx.id = m.conversa_id and nx.canal = 'openwa'))
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
    where x.status = 'pendente' and x.envio_tentativas < 3 and imobdesk.at_openwa_ligado() and (x.envio_reservado_ate is null or x.envio_reservado_ate < now())
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
                                          'dominios', to_jsonb(c.dominios_corporativos), 'ligado', c.openwa_ligado)
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

do $$
begin
  revoke execute on function imobdesk.at_openwa_ligar(boolean) from public, anon;
  grant execute on function imobdesk.at_openwa_ligar(boolean) to authenticated, service_role;
  revoke execute on function imobdesk.at_openwa_ligado() from public, anon, authenticated;
  grant execute on function imobdesk.at_openwa_ligado() to service_role;
end;
$$;

notify pgrst, 'reload schema';

-- ======================================== 20261009220000_imobdesk_whatsapp_oculta_abas.sql
-- WhatsApp OpenWA desligado esconde Conversas e Monitor de atendimento; só Admin e Super admin ligam/desligam
-- (pedido do Wagner, 09/10/2026). As abas também mostram a Zenvia: ficam visíveis enquanto houver WhatsApp em uso —
-- número OpenWA ativo com o recurso ligado, ou número Zenvia ativo. Só aditiva (funções trocadas, mesma assinatura).

/** Há WhatsApp em uso? Qualquer usuário logado consulta (só devolve sim/não). */
create or replace function imobdesk.at_whatsapp_disponivel()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from imobdesk.at_numeros n
    where n.ativo and (n.canal = 'zenvia' or (n.canal = 'openwa' and imobdesk.at_openwa_ligado())));
$$;
revoke execute on function imobdesk.at_whatsapp_disponivel() from public, anon;
grant execute on function imobdesk.at_whatsapp_disponivel() to authenticated, service_role;

/** Liga ou desliga o OpenWA. Só Administrador ou Super admin. Ao desligar, cancela o que estava esperando envio. */
create or replace function imobdesk.at_openwa_ligar(p_ligado boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := auth.uid();
  v_msgs int := 0;
  v_reps int := 0;
begin
  if v_ator is null or not imobdesk.ch_eh_admin() then
    perform imobdesk.erro('FORBIDDEN', 'Só o Administrador ou o Super admin liga ou desliga o WhatsApp OpenWA.');
  end if;
  update imobdesk.at_config set openwa_ligado = coalesce(p_ligado, true), openwa_ligado_em = now(), openwa_ligado_por = v_ator where id;
  if not coalesce(p_ligado, true) then
    update imobdesk.at_mensagens m set status = 'falhou', erro = 'WhatsApp OpenWA desligado pelo administrador.', envio_reservado_ate = null
    from imobdesk.at_conversas c join imobdesk.at_numeros n on n.id = c.numero_id
    where m.conversa_id = c.id and n.canal = 'openwa' and m.status = 'pendente' and m.direcao = 'saida';
    get diagnostics v_msgs = row_count;
    update imobdesk.at_repasses set status = 'falhou', erro = 'WhatsApp OpenWA desligado pelo administrador.', envio_reservado_ate = null
    where status = 'pendente';
    get diagnostics v_reps = row_count;
  end if;
  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', 'update',
    case when p_ligado then 'WhatsApp OpenWA ligado' else format('WhatsApp OpenWA desligado (%s mensagens e %s repasses pendentes cancelados)', v_msgs, v_reps) end,
    null, jsonb_build_object('ligado', p_ligado), 'at_config');
  return jsonb_build_object('ligado', p_ligado, 'canceladas', v_msgs + v_reps);
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
  if auth.uid() is null or not (v_sup or imobdesk.ch_eh_admin() or exists (select 1 from imobdesk.at_setores s where imobdesk.at_gestor_de(s.id))) then
    perform imobdesk.erro('FORBIDDEN', 'Só a gestão do atendimento vê esta tela.');
  end if;
  return jsonb_build_object(
    'superAdmin', imobdesk.eh_super_admin(),
    'podeLigar', imobdesk.ch_eh_admin(),
    'supervisor', v_sup,
    'conexao', (select jsonb_build_object('url', c.openwa_url, 'chaveMascara', c.openwa_chave_mascara, 'definidoEm', c.openwa_definido_em,
                                          'verificacao', c.openwa_verificacao, 'autoLigado', c.ligado, 'travaPiloto', c.trava_piloto,
                                          'dominios', to_jsonb(c.dominios_corporativos), 'ligado', c.openwa_ligado)
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

notify pgrst, 'reload schema';

-- ======================================== 20261010100000_imobdesk_solicitante.sql
-- App do solicitante: app do solicitante (docs/PLANO-app-solicitante.md, Fase 1; mockup aprovado em 10/10/2026).
-- Quem é da empresa (cadastro ou domínio de e-mail) entra e ganha o perfil "Solicitante", escolhe o departamento (Setor ligado para o app),
-- abre chamado (serviço do canal Portal, descrição, foto/arquivo) e acompanha só os próprios tickets.
-- Só aditiva: perfil, colunas, tabelas, bucket, políticas e funções novas. Nada é apagado nem trocado.

-- ======================================================================= perfil e permissão

insert into imobdesk.perfis (key, label, description, ordem, is_system)
values ('solicitante', 'Solicitante', 'Só o app App do solicitante: abre e acompanha os próprios chamados. Dado automaticamente no 1º acesso.',
        coalesce((select max(ordem) from imobdesk.perfis), 0) + 1, true)
on conflict (key) do nothing;

-- Administração › App do solicitante: quem já configura Setores e números.
insert into imobdesk.profile_permissions (role, permission_id, enabled)
select distinct pp.role, 'gestao_atendimento_solicitante', true
from imobdesk.profile_permissions pp
where pp.permission_id = 'gestao_atendimento_setores' and pp.enabled
on conflict (role, permission_id) do nothing;
-- e o Admin (as funções da Administração do App do solicitante já liberam ch_eh_admin()).
insert into imobdesk.profile_permissions (role, permission_id, enabled)
values ('admin', 'gestao_atendimento_solicitante', true)
on conflict (role, permission_id) do nothing;

-- ======================================================================= estrutura

alter table imobdesk.at_setores add column if not exists cd_visivel boolean not null default false;
alter table imobdesk.at_setores add column if not exists cd_icone text check (length(cd_icone) <= 16);
alter table imobdesk.at_setores add column if not exists cd_descricao text check (length(cd_descricao) <= 200);
alter table imobdesk.at_setores add column if not exists cd_ordem int not null default 0;

-- Os três departamentos do pedido (TI, Administrativo/Administração e CFTV), se já existirem, aparecem no app.
update imobdesk.at_setores set cd_visivel = true,
  cd_icone = coalesce(cd_icone, case when lower(nome) = 'ti' then '💻' when lower(nome) = 'cftv' then '📹' else '🏢' end),
  cd_descricao = coalesce(cd_descricao, case when lower(nome) = 'ti' then 'Sistemas, acesso e senha, e-mail, internet, impressora, equipamentos'
                                             when lower(nome) = 'cftv' then 'Câmeras, gravações, imagens de ocorrências, portaria'
                                             else 'Material corporativo, estacionamento, portador, salas de reunião e visitantes' end),
  cd_ordem = case when lower(nome) = 'ti' then 1 when lower(nome) = 'cftv' then 3 else 2 end
where lower(nome) in ('ti', 'administrativo', 'administração', 'administracao', 'cftv') and not cd_visivel;

create table if not exists imobdesk.cd_config (
  id             boolean     primary key default true check (id),
  quadros        jsonb       not null default '{"meus": true, "avisos": true, "solucoes": true, "whatsapp": true, "perfil": true}',
  whatsapp       text        check (whatsapp ~ '^\d{12,13}$'),
  boas_vindas    text        not null default 'Como podemos ajudar?' check (length(boas_vindas) <= 120),
  atualizado_em  timestamptz not null default now(),
  atualizado_por uuid
);
insert into imobdesk.cd_config (id) values (true) on conflict (id) do nothing;

create table if not exists imobdesk.cd_avisos (
  id            bigint      generated by default as identity primary key,
  setor_id      bigint      references imobdesk.at_setores (id) on delete cascade,   -- null = todos os departamentos
  titulo        text        not null check (length(btrim(titulo)) between 3 and 90),
  texto         text        not null default '' check (length(texto) <= 600),
  tipo          text        not null default 'comunicado' check (tipo in ('comunicado', 'manutencao', 'alerta', 'resolvido')),
  link          text        check (link ~ '^https://'),
  inicio        timestamptz not null default now(),
  fim           timestamptz,
  ativo         boolean     not null default true,
  criado_por    uuid,
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  check (fim is null or fim > inicio)
);
create index if not exists cd_avisos_periodo_idx on imobdesk.cd_avisos (inicio, fim) where ativo;

create table if not exists imobdesk.cd_solucoes (
  id            bigint      generated by default as identity primary key,
  setor_id      bigint      not null references imobdesk.at_setores (id) on delete cascade,
  servico_id    bigint      references imobdesk.ch_servicos (id) on delete set null,
  ticket_id     bigint      references imobdesk.ch_tickets (id) on delete set null,     -- de onde veio (opcional)
  titulo        text        not null check (length(btrim(titulo)) between 3 and 120),
  texto         text        not null check (length(btrim(texto)) between 3 and 4000),
  publicado     boolean     not null default true,
  usos          int         not null default 0,
  criado_por    uuid,
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create index if not exists cd_solucoes_setor_idx on imobdesk.cd_solucoes (setor_id, servico_id) where publicado;

-- Última vez que a pessoa abriu o ticket no app ("Nova resposta").
create table if not exists imobdesk.cd_vistos (
  usuario_id uuid        not null references auth.users (id) on delete cascade,
  ticket_id  bigint      not null references imobdesk.ch_tickets (id) on delete cascade,
  visto_em   timestamptz not null default now(),
  primary key (usuario_id, ticket_id)
);

alter table imobdesk.cd_config enable row level security;
alter table imobdesk.cd_avisos enable row level security;
alter table imobdesk.cd_solucoes enable row level security;
alter table imobdesk.cd_vistos enable row level security;
revoke all on imobdesk.cd_config, imobdesk.cd_avisos, imobdesk.cd_solucoes, imobdesk.cd_vistos
  from anon, authenticated;

-- ======================================================================= helpers

/** Sessão válida de quem é da empresa (cadastro ou domínio de e-mail) (sem exigir linha em usuarios: o 1º acesso ainda não tem). */
create or replace function imobdesk.cd_sessao_ok()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
     and imobdesk.sessao_confiavel()
     and exists (select 1 from auth.users u where u.id = (select auth.uid()) and imobdesk.dominio_permitido(u.email));
$$;

/** Quem a tela mostra: o próprio usuário ou, para simular (só leitura), quem a Administração escolheu. */
create or replace function imobdesk.cd_quem(p_como uuid default null)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not imobdesk.cd_sessao_ok() then
    perform imobdesk.erro('FORBIDDEN', 'Entre com o e-mail da sua empresa.');
  end if;
  if exists (select 1 from imobdesk.usuarios u where u.id = (select auth.uid()) and u.status = 'inactive') then
    perform imobdesk.erro('FORBIDDEN', 'Seu acesso está bloqueado. Fale com a TI.');
  end if;
  if p_como is null or p_como = (select auth.uid()) then return (select auth.uid()); end if;
  if not (imobdesk.ch_eh_admin() or imobdesk.tem_permissao('gestao_atendimento_solicitante')) then
    perform imobdesk.erro('FORBIDDEN', 'Só a Administração do App do solicitante pode simular um solicitante.');
  end if;
  return p_como;
end;
$$;

create or replace function imobdesk.cd_email_de(p_usuario uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select lower(u.email) from auth.users u where u.id = p_usuario;
$$;

/** Pessoa (Cadastros › Pessoas) ligada ao e-mail do usuário. */
create or replace function imobdesk.cd_pessoa_de(p_usuario uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select c.pessoa_id from imobdesk.at_pessoa_contatos c
  where c.tipo = 'email' and c.valor = imobdesk.cd_email_de(p_usuario)
  order by c.principal desc, c.id limit 1;
$$;

/** "Sistemas › TOTVS › Sistema PVI". */
create or replace function imobdesk.cd_trilha(p_servico bigint)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  with recursive t as (
    select s.id, s.pai_id, s.nome, 0 as n from imobdesk.ch_servicos s where s.id = p_servico
    union all
    select s.id, s.pai_id, s.nome, t.n + 1 from imobdesk.ch_servicos s join t on s.id = t.pai_id where t.n < 5
  )
  select string_agg(nome, ' › ' order by n desc) from t;
$$;

/** O ticket é do solicitante? (pessoa do e-mail dele, ou aberto por ele no app). */
create or replace function imobdesk.cd_ticket_meu(p_id bigint, p_usuario uuid)
returns imobdesk.ch_tickets
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  t imobdesk.ch_tickets;
  v_pessoa bigint := imobdesk.cd_pessoa_de(p_usuario);
begin
  select * into t from imobdesk.ch_tickets x
  where x.id = p_id and x.excluido_em is null
    and ((v_pessoa is not null and x.solicitante_pessoa_id = v_pessoa) or (x.origem = 'intranet' and x.criado_por = p_usuario));
  if t.id is null then perform imobdesk.erro('NOT_FOUND', 'Chamado não encontrado.'); end if;
  return t;
end;
$$;

create or replace function imobdesk.cd_status_json(p_status bigint)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('id', s.id, 'nome', s.nome, 'categoria', s.categoria) from imobdesk.ch_status s where s.id = p_status;
$$;

/** Anexos enviados pelo app: só do bucket imobdesk-solicitante, na pasta do próprio usuário, e que existem. */
create or replace function imobdesk.cd_anexos_validos(p jsonb, p_usuario uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  a jsonb;
  v_out jsonb := '[]';
  v_path text;
begin
  if p is null or jsonb_typeof(p) <> 'array' then return '[]'; end if;
  if jsonb_array_length(p) > 5 then perform imobdesk.erro('INVALID_INPUT', 'Envie no máximo 5 arquivos.', 'anexos'); end if;
  for a in select * from jsonb_array_elements(p) loop
    v_path := a ->> 'path';
    if v_path is null or split_part(v_path, '/', 1) <> p_usuario::text
       or not exists (select 1 from storage.objects o where o.bucket_id = 'imobdesk-solicitante' and o.name = v_path) then
      perform imobdesk.erro('INVALID_INPUT', 'Arquivo anexado não encontrado. Anexe de novo.', 'anexos');
    end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'bucket', 'imobdesk-solicitante', 'path', v_path, 'nome', left(coalesce(nullif(a ->> 'nome', ''), split_part(v_path, '/', 2)), 160),
      'mime', left(coalesce(a ->> 'mime', 'application/octet-stream'), 120), 'tamanho', nullif(a ->> 'tamanho', '')::bigint));
  end loop;
  return v_out;
end;
$$;

-- ======================================================================= app do solicitante

/**
 * Entrada no app. No 1º acesso cria o usuário com o perfil Solicitante e liga a pessoa pelo e-mail.
 * Quem já tem outro perfil continua com ele. Com p_como (Administração), só lê.
 */
create or replace function imobdesk.cd_entrar(p_como uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.cd_quem(p_como);
  v_simula boolean := v_uid <> (select auth.uid());
  v_email text := imobdesk.cd_email_de(v_uid);
  v_meta jsonb;
  v_nome text;
  v_pessoa bigint;
  u imobdesk.usuarios;
  v_tel text;
begin
  select * into u from imobdesk.usuarios x where x.id = v_uid;
  if not v_simula then
    if u.id is null then
      select coalesce(a.raw_user_meta_data, '{}') into v_meta from auth.users a where a.id = v_uid;
      v_nome := coalesce(nullif(btrim(v_meta ->> 'full_name'), ''), nullif(btrim(v_meta ->> 'name'), ''),
                         initcap(replace(replace(split_part(v_email, '@', 1), '.', ' '), '_', ' ')));
      if length(v_nome) < 3 then v_nome := v_email; end if;
      insert into imobdesk.usuarios (id, email, nome, perfil_key, status, last_access_at)
      values (v_uid, v_email, v_nome, 'solicitante', 'active', now())
      on conflict do nothing;
      select * into u from imobdesk.usuarios x where x.id = v_uid;
    end if;
    v_pessoa := imobdesk.cd_pessoa_de(v_uid);
    if v_pessoa is null then
      v_pessoa := imobdesk.at_pessoa_identificar('email', v_email, u.nome, 'App do solicitante');
    end if;
  else
    if u.id is null then perform imobdesk.erro('NOT_FOUND', 'Essa pessoa ainda não entrou no App do solicitante.'); end if;
    v_pessoa := imobdesk.cd_pessoa_de(v_uid);
  end if;

  select c.valor into v_tel from imobdesk.at_pessoa_contatos c
  where c.pessoa_id = v_pessoa and c.tipo in ('whatsapp', 'telefone') order by c.principal desc, (c.tipo = 'whatsapp') desc, c.id limit 1;

  return jsonb_build_object(
    'usuarioId', v_uid,
    'nome', coalesce((select nullif(pe.nome, v_email) from imobdesk.at_pessoas pe where pe.id = v_pessoa), u.nome),
    'email', v_email,
    'telefone', v_tel,
    'pessoaId', v_pessoa,
    'perfil', u.perfil_key,
    'equipe', coalesce(u.perfil_key, 'solicitante') <> 'solicitante',
    'simulando', v_simula,
    'setores', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'nome', s.nome, 'icone', coalesce(s.cd_icone, '🎫'), 'descricao', s.cd_descricao)
                                          order by s.cd_ordem, s.nome)
                         from imobdesk.at_setores s where s.ativo and s.cd_visivel), '[]'),
    'config', (select jsonb_build_object('quadros', c.quadros, 'whatsapp', c.whatsapp, 'boasVindas', c.boas_vindas) from imobdesk.cd_config c where c.id));
end;
$$;

/** Meu perfil: nome e telefone corporativo (WhatsApp). O telefone identifica a pessoa no WhatsApp do suporte. */
create or replace function imobdesk.cd_perfil_salvar(p jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.cd_quem(null);
  v_pessoa bigint := imobdesk.cd_pessoa_de(v_uid);
  v_nome text := btrim(coalesce(p ->> 'nome', ''));
  v_tel text := imobdesk.at_contato_normalizar('whatsapp', p ->> 'telefone');
  v_dono bigint;
begin
  if v_pessoa is null then perform imobdesk.erro('INVALID_INPUT', 'Entre no app de novo para concluir o cadastro.'); end if;
  if length(v_nome) < 3 or length(v_nome) > 160 then perform imobdesk.erro('INVALID_INPUT', 'Informe seu nome completo.', 'nome'); end if;
  if coalesce(p ->> 'telefone', '') <> '' and v_tel !~ '^55\d{10,11}$' then
    perform imobdesk.erro('INVALID_INPUT', 'Telefone inválido. Use DDD + número, ex.: (21) 99999-9999.', 'telefone');
  end if;
  update imobdesk.at_pessoas set nome = v_nome where id = v_pessoa;
  update imobdesk.usuarios set nome = v_nome, updated_at = now() where id = v_uid and perfil_key = 'solicitante';
  if coalesce(p ->> 'telefone', '') <> '' then
    select c.pessoa_id into v_dono from imobdesk.at_pessoa_contatos c
    where c.valor = v_tel and c.tipo in ('whatsapp', 'telefone') order by (c.pessoa_id = v_pessoa) desc limit 1;
    if v_dono is not null and v_dono <> v_pessoa then
      perform imobdesk.erro('INVALID_INPUT', 'Este número já está no cadastro de outra pessoa. Fale com a TI.', 'telefone');
    end if;
    update imobdesk.at_pessoa_contatos set principal = false where pessoa_id = v_pessoa and tipo = 'whatsapp' and valor <> v_tel;
    insert into imobdesk.at_pessoa_contatos (pessoa_id, tipo, valor, principal) values (v_pessoa, 'whatsapp', v_tel, true)
    on conflict (tipo, valor) do update set principal = true;
  end if;
end;
$$;

/** Árvore de serviços do departamento, só os do canal Portal (intranet). */
create or replace function imobdesk.cd_servicos(p_setor bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform imobdesk.cd_quem(null);
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', s.id, 'paiId', s.pai_id, 'nome', s.nome, 'nivel', s.nivel, 'descricao', s.descricao) order by s.nivel, s.ordem, s.nome)
    from imobdesk.ch_servicos s join imobdesk.at_setores st on st.id = s.setor_id
    where s.setor_id = p_setor and s.ativo and 'intranet' = any (s.canais) and st.ativo and st.cd_visivel
      -- só quando o pai também aparece (um pai desligado esconde os filhos)
      and (s.pai_id is null or exists (select 1 from imobdesk.ch_servicos pa where pa.id = s.pai_id and pa.ativo and 'intranet' = any (pa.canais)))), '[]');
end;
$$;

/** Lista dos meus chamados (resumo para o início e para "Meus chamados"). p_filtro: abertos | resolvidos | todos. */
create or replace function imobdesk.cd_meus_chamados(p_filtro text default 'abertos', p_como uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.cd_quem(p_como);
  v_pessoa bigint := imobdesk.cd_pessoa_de(v_uid);
begin
  return (
    with meus as (
      select t.* from imobdesk.ch_tickets t
      where t.excluido_em is null and t.mesclado_em_id is null
        and ((v_pessoa is not null and t.solicitante_pessoa_id = v_pessoa) or (t.origem = 'intranet' and t.criado_por = v_uid))
    )
    select jsonb_build_object(
      'abertos', (select count(*) from meus where encerrado_em is null),
      'recentes', (select count(*) from meus where criado_em > now() - interval '90 days'),
      'novos', (select count(*) from meus m where exists (
                  select 1 from imobdesk.ch_ticket_acoes a where a.ticket_id = m.id and a.tipo = 'publica' and a.direcao = 'saida'
                    and a.criado_em > coalesce((select v.visto_em from imobdesk.cd_vistos v where v.usuario_id = v_uid and v.ticket_id = m.id), '-infinity'))),
      'itens', coalesce((
        select jsonb_agg(x.j order by x.ordem desc) from (
          select m.atualizado_em as ordem, jsonb_build_object(
            'id', m.id, 'assunto', m.assunto, 'origem', m.origem,
            'setor', (select s.nome from imobdesk.at_setores s where s.id = m.setor_id),
            'servico', imobdesk.cd_trilha(m.servico_id),
            'status', imobdesk.cd_status_json(m.status_id),
            'responsavel', (select u.nome from imobdesk.usuarios u where u.id = m.responsavel_id),
            'criadoEm', m.criado_em, 'slaRespostaAte', m.sla_resposta_ate, 'primeiraRespostaEm', m.primeira_resposta_em, 'encerradoEm', m.encerrado_em,
            'ultima', (select jsonb_build_object('autor', a.autor_nome, 'texto', left(a.texto, 140), 'direcao', a.direcao, 'em', a.criado_em)
                       from imobdesk.ch_ticket_acoes a where a.ticket_id = m.id and a.tipo = 'publica' order by a.numero desc limit 1),
            'novo', exists (select 1 from imobdesk.ch_ticket_acoes a where a.ticket_id = m.id and a.tipo = 'publica' and a.direcao = 'saida'
                              and a.criado_em > coalesce((select v.visto_em from imobdesk.cd_vistos v where v.usuario_id = v_uid and v.ticket_id = m.id), '-infinity'))
          ) as j
          from meus m
          where coalesce(p_filtro, 'abertos') = 'todos'
             or (p_filtro = 'abertos' and m.encerrado_em is null)
             or (p_filtro = 'resolvidos' and m.encerrado_em is not null)
          order by m.atualizado_em desc limit 100
        ) x), '[]'))
  );
end;
$$;

/** Início do departamento: avisos no ar e soluções mais usadas. */
create or replace function imobdesk.cd_avisos_listar(p_setor bigint default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform imobdesk.cd_quem(null);
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', a.id, 'titulo', a.titulo, 'texto', a.texto, 'tipo', a.tipo, 'link', a.link, 'inicio', a.inicio, 'fim', a.fim,
                                        'setor', (select s.nome from imobdesk.at_setores s where s.id = a.setor_id)) order by a.inicio desc)
    from imobdesk.cd_avisos a
    where a.ativo and a.inicio <= now() and (a.fim is null or a.fim > now() - interval '2 days')
      and (a.setor_id is null or p_setor is null or a.setor_id = p_setor)), '[]');
end;
$$;

/** Soluções publicadas do departamento. Com p_servico, as do serviço e dos níveis acima (a dica "Talvez resolva"). */
create or replace function imobdesk.cd_solucoes_listar(p_setor bigint, p_servico bigint default null, p_busca text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_trilha bigint[];
begin
  perform imobdesk.cd_quem(null);
  if p_servico is not null then
    with recursive t as (
      select s.id, s.pai_id, 0 n from imobdesk.ch_servicos s where s.id = p_servico
      union all select s.id, s.pai_id, t.n + 1 from imobdesk.ch_servicos s join t on s.id = t.pai_id where t.n < 5)
    select array_agg(id) into v_trilha from t;
  end if;
  return coalesce((
    select jsonb_agg(x.j order by x.usos desc) from (
      select so.usos, jsonb_build_object('id', so.id, 'titulo', so.titulo, 'texto', so.texto, 'usos', so.usos,
                                         'servico', imobdesk.cd_trilha(so.servico_id)) j
      from imobdesk.cd_solucoes so
      where so.publicado and so.setor_id = p_setor
        and (v_trilha is null or so.servico_id = any (v_trilha))
        and (coalesce(btrim(p_busca), '') = '' or so.titulo ilike '%' || btrim(p_busca) || '%' or so.texto ilike '%' || btrim(p_busca) || '%')
      order by so.usos desc limit case when p_servico is null then 50 else 3 end) x), '[]');
end;
$$;

/** "Ver solução" abriu: conta o uso (ordena a lista). */
create or replace function imobdesk.cd_solucao_usada(p_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform imobdesk.cd_quem(null);
  update imobdesk.cd_solucoes set usos = usos + 1 where id = p_id and publicado;
end;
$$;

/** Abre o chamado pelo app. Serviço opcional ("Outro assunto"): a equipe classifica. */
create or replace function imobdesk.cd_ticket_criar(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.cd_quem(null);
  v_email text := imobdesk.cd_email_de(v_uid);
  v_pessoa bigint := imobdesk.cd_pessoa_de(v_uid);
  v_setor bigint := nullif(p ->> 'setorId', '')::bigint;
  v_servico bigint := nullif(p ->> 'servicoId', '')::bigint;
  v_texto text := btrim(coalesce(p ->> 'descricao', ''));
  v_anexos jsonb := imobdesk.cd_anexos_validos(p -> 'anexos', v_uid);
  v_urg bigint;
  v_nome text;
  v_id bigint;
  t imobdesk.ch_tickets;
begin
  if v_pessoa is null then perform imobdesk.erro('INVALID_INPUT', 'Entre no app de novo para concluir o cadastro.'); end if;
  if not exists (select 1 from imobdesk.at_setores s where s.id = v_setor and s.ativo and s.cd_visivel) then
    perform imobdesk.erro('INVALID_INPUT', 'Escolha o departamento.', 'setorId');
  end if;
  if v_servico is not null and not exists (
       select 1 from imobdesk.ch_servicos s where s.id = v_servico and s.setor_id = v_setor and s.ativo and 'intranet' = any (s.canais)) then
    perform imobdesk.erro('INVALID_INPUT', 'Escolha o tipo de serviço de novo.', 'servicoId');
  end if;
  if length(v_texto) < 5 then perform imobdesk.erro('INVALID_INPUT', 'Descreva o que está acontecendo.', 'descricao'); end if;
  if length(v_texto) > 4000 then perform imobdesk.erro('INVALID_INPUT', 'A descrição passou de 4.000 caracteres.', 'descricao'); end if;
  if (select count(*) from imobdesk.ch_tickets x where x.criado_por = v_uid and x.origem = 'intranet' and x.criado_em > now() - interval '1 hour') >= 15 then
    perform imobdesk.erro('INVALID_INPUT', 'Muitos chamados em pouco tempo. Aguarde um pouco ou fale com a equipe.');
  end if;
  if (p ->> 'urgente')::boolean is true then
    select u.id into v_urg from imobdesk.ch_urgencias u where lower(u.nome) = 'alta' limit 1;
  end if;
  select pe.nome into v_nome from imobdesk.at_pessoas pe where pe.id = v_pessoa;

  insert into imobdesk.ch_tickets (assunto, origem, recebido_em, solicitante_pessoa_id, solicitante_nome, solicitante_contato, setor_id, servico_id,
                                             categoria_id, urgencia_id, status_id, criado_por)
  values (left(regexp_replace(split_part(v_texto, E'\n', 1), '\s+', ' ', 'g'), 120), 'intranet', 'App do solicitante', v_pessoa, left(v_nome, 160), v_email, v_setor, v_servico,
          coalesce((select s.categoria_padrao_id from imobdesk.ch_servicos s where s.id = v_servico), (select c.id from imobdesk.ch_categorias c where c.padrao limit 1)),
          coalesce(v_urg, (select s.urgencia_padrao_id from imobdesk.ch_servicos s where s.id = v_servico), (select u.id from imobdesk.ch_urgencias u where u.padrao limit 1)),
          coalesce((select s.id from imobdesk.ch_status s where s.categoria = 'novo' and s.ativo order by s.ordem limit 1), 1),
          v_uid)
  returning * into t;
  v_id := t.id;

  insert into imobdesk.ch_ticket_acoes (ticket_id, numero, tipo, canal, direcao, autor_id, autor_nome, texto, anexos, envio_status)
  values (v_id, 1, 'publica', 'portal', 'entrada', v_uid, left(v_nome, 160), v_texto, v_anexos, 'nao_se_aplica');
  insert into imobdesk.cd_vistos (usuario_id, ticket_id) values (v_uid, v_id) on conflict do nothing;

  return jsonb_build_object('id', v_id, 'servico', imobdesk.cd_trilha(v_servico), 'slaRespostaAte', t.sla_resposta_ate,
                            'setor', (select s.nome from imobdesk.at_setores s where s.id = v_setor));
end;
$$;

/** Detalhe do chamado no app: só as ações públicas e os marcos (criado, status, responsável). */
create or replace function imobdesk.cd_chamado(p_id bigint, p_como uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.cd_quem(p_como);
  t imobdesk.ch_tickets := imobdesk.cd_ticket_meu(p_id, v_uid);
  v_cat text := (select s.categoria from imobdesk.ch_status s where s.id = t.status_id);
begin
  if p_como is null then
    insert into imobdesk.cd_vistos (usuario_id, ticket_id, visto_em) values (v_uid, p_id, now())
    on conflict (usuario_id, ticket_id) do update set visto_em = now();
  end if;
  return jsonb_build_object(
    'id', t.id, 'assunto', t.assunto, 'origem', t.origem,
    'setor', (select s.nome from imobdesk.at_setores s where s.id = t.setor_id),
    'servico', imobdesk.cd_trilha(t.servico_id),
    'status', imobdesk.cd_status_json(t.status_id),
    'responsavel', (select u.nome from imobdesk.usuarios u where u.id = t.responsavel_id),
    'criadoEm', t.criado_em, 'slaRespostaAte', t.sla_resposta_ate, 'encerradoEm', t.encerrado_em,
    'solucao', case when v_cat in ('resolvido', 'fechado') then t.solucao_aplicada end,
    'podeResponder', v_cat not in ('fechado', 'cancelado') and t.mesclado_em_id is null,
    'aguardandoConfirmacao', v_cat = 'resolvido',
    'mescladoEm', t.mesclado_em_id,
    'acoes', coalesce((select jsonb_agg(jsonb_build_object('numero', a.numero, 'direcao', a.direcao, 'canal', a.canal, 'autorNome', a.autor_nome,
                                                           'texto', a.texto, 'anexos', a.anexos, 'criadoEm', a.criado_em) order by a.criado_em, a.numero)
                       from imobdesk.ch_ticket_acoes a where a.ticket_id = t.id and a.tipo = 'publica'), '[]'),
    'eventos', coalesce((select jsonb_agg(jsonb_build_object('tipo', e.tipo, 'criadoEm', e.criado_em,
                                                             'descricao', case e.tipo
                                                               when 'criado' then 'Chamado aberto'
                                                               when 'status' then 'Status: ' || coalesce((select s.nome from imobdesk.ch_status s where s.id = (e.para ->> 'statusId')::bigint), '—')
                                                               else e.descricao end,
                                                             'autorNome', e.autor_nome) order by e.criado_em)
                         from imobdesk.ch_ticket_eventos e where e.ticket_id = t.id and e.tipo in ('criado', 'status', 'responsavel')), '[]'));
end;
$$;

/** Resposta do solicitante pelo app. Se o ticket estava Aguardando, volta para Em atendimento; se Resolvido, reabre. */
create or replace function imobdesk.cd_chamado_responder(p_id bigint, p jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.cd_quem(null);
  t imobdesk.ch_tickets := imobdesk.cd_ticket_meu(p_id, v_uid);
  v_cat text := (select s.categoria from imobdesk.ch_status s where s.id = t.status_id);
  v_texto text := btrim(coalesce(p ->> 'texto', ''));
  v_anexos jsonb := imobdesk.cd_anexos_validos(p -> 'anexos', v_uid);
  v_num int;
begin
  if v_cat in ('fechado', 'cancelado') or t.mesclado_em_id is not null then
    perform imobdesk.erro('INVALID_INPUT', 'Este chamado foi encerrado. Abra um novo chamado.');
  end if;
  if length(v_texto) = 0 and jsonb_array_length(v_anexos) = 0 then perform imobdesk.erro('INVALID_INPUT', 'Escreva a mensagem.', 'texto'); end if;
  if length(v_texto) > 4000 then perform imobdesk.erro('INVALID_INPUT', 'A mensagem passou de 4.000 caracteres.', 'texto'); end if;
  perform 1 from imobdesk.ch_tickets x where x.id = p_id for update;
  v_num := coalesce((select max(a.numero) from imobdesk.ch_ticket_acoes a where a.ticket_id = p_id), 0) + 1;
  insert into imobdesk.ch_ticket_acoes (ticket_id, numero, tipo, canal, direcao, autor_id, autor_nome, texto, anexos, envio_status)
  values (p_id, v_num, 'publica', 'portal', 'entrada', v_uid, t.solicitante_nome, coalesce(nullif(v_texto, ''), '📎 Arquivo'), v_anexos, 'nao_se_aplica');
  if v_cat = 'pendente' then
    update imobdesk.ch_tickets set status_id = coalesce((select s.id from imobdesk.ch_status s where s.categoria = 'andamento' and s.ativo order by s.ordem limit 1), status_id), justificativa_id = null
    where id = p_id;
  elsif v_cat = 'resolvido' then
    perform imobdesk.cd_reabrir(p_id);
  else
    update imobdesk.ch_tickets set atualizado_em = now() where id = p_id;
  end if;
  insert into imobdesk.cd_vistos (usuario_id, ticket_id, visto_em) values (v_uid, p_id, now())
  on conflict (usuario_id, ticket_id) do update set visto_em = now();
end;
$$;

create or replace function imobdesk.cd_reabrir(p_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status bigint := coalesce((select s.id from imobdesk.ch_status s where s.categoria = 'andamento' and s.ativo and lower(s.nome) = 'reaberto' limit 1),
                              (select s.id from imobdesk.ch_status s where s.categoria = 'andamento' and s.ativo order by s.ordem limit 1));
begin
  update imobdesk.ch_tickets set status_id = v_status,
    justificativa_id = (select j.id from imobdesk.ch_status_justificativas j where j.status_id = v_status and lower(j.nome) = 'pelo cliente' limit 1)
  where id = p_id;
end;
$$;

/** "A TI marcou como resolvido. Ficou bom?" Sim fecha; Não reabre (com o comentário, se houver). */
create or replace function imobdesk.cd_chamado_confirmar(p_id bigint, p_resolveu boolean, p_comentario text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.cd_quem(null);
  t imobdesk.ch_tickets := imobdesk.cd_ticket_meu(p_id, v_uid);
  v_num int;
begin
  if (select s.categoria from imobdesk.ch_status s where s.id = t.status_id) <> 'resolvido' then
    perform imobdesk.erro('INVALID_INPUT', 'Este chamado não está aguardando a sua confirmação.');
  end if;
  v_num := coalesce((select max(a.numero) from imobdesk.ch_ticket_acoes a where a.ticket_id = p_id), 0) + 1;
  insert into imobdesk.ch_ticket_acoes (ticket_id, numero, tipo, canal, direcao, autor_id, autor_nome, texto, envio_status)
  values (p_id, v_num, 'publica', 'portal', 'entrada', v_uid, t.solicitante_nome,
          case when p_resolveu then '✅ Confirmei: o problema foi resolvido.' else '❌ Não resolveu.' end
            || coalesce(E'\n' || nullif(left(btrim(p_comentario), 2000), ''), ''), 'nao_se_aplica');
  if p_resolveu then
    update imobdesk.ch_tickets set status_id = coalesce((select s.id from imobdesk.ch_status s where s.categoria = 'fechado' and s.ativo order by s.ordem limit 1), status_id)
    where id = p_id;
  else
    perform imobdesk.cd_reabrir(p_id);
  end if;
end;
$$;

-- ======================================================================= Administração › App do solicitante

create or replace function imobdesk.cd_admin_checar()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (imobdesk.ch_eh_admin() or imobdesk.tem_permissao('gestao_atendimento_solicitante')) then
    perform imobdesk.erro('FORBIDDEN', 'Sem acesso à Administração do App do solicitante.');
  end if;
end;
$$;

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
                         from imobdesk.at_setores s where s.ativo), '[]'),
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

create or replace function imobdesk.cd_admin_pessoas(p_busca text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform imobdesk.cd_admin_checar();
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', u.id, 'nome', u.nome, 'email', u.email, 'perfil', u.perfil_key) order by u.nome)
    from (select * from imobdesk.usuarios x
          where x.status <> 'inactive' and (x.nome ilike '%' || btrim(coalesce(p_busca, '')) || '%' or x.email ilike '%' || btrim(coalesce(p_busca, '')) || '%')
          order by x.nome limit 20) u), '[]');
end;
$$;

create or replace function imobdesk.cd_admin_setor_salvar(p_id bigint, p jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform imobdesk.cd_admin_checar();
  if not exists (select 1 from imobdesk.at_setores s where s.id = p_id) then perform imobdesk.erro('NOT_FOUND', 'Setor não encontrado.'); end if;
  update imobdesk.at_setores set
    cd_visivel = coalesce((p ->> 'visivel')::boolean, cd_visivel),
    cd_icone = case when p ? 'icone' then nullif(left(btrim(p ->> 'icone'), 16), '') else cd_icone end,
    cd_descricao = case when p ? 'descricao' then nullif(left(btrim(p ->> 'descricao'), 200), '') else cd_descricao end,
    cd_ordem = coalesce((p ->> 'ordem')::int, cd_ordem),
    atualizado_em = now(), atualizado_por = (select auth.uid())
  where id = p_id;
end;
$$;

create or replace function imobdesk.cd_admin_config_salvar(p jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_wa text := imobdesk.at_contato_normalizar('whatsapp', p ->> 'whatsapp');
begin
  perform imobdesk.cd_admin_checar();
  if p ? 'whatsapp' and coalesce(p ->> 'whatsapp', '') <> '' and v_wa !~ '^\d{12,13}$' then
    perform imobdesk.erro('INVALID_INPUT', 'Número de WhatsApp inválido. Use DDD + número.', 'whatsapp');
  end if;
  if p ? 'boasVindas' and length(btrim(coalesce(p ->> 'boasVindas', ''))) not between 3 and 120 then
    perform imobdesk.erro('INVALID_INPUT', 'O texto de boas-vindas deve ter de 3 a 120 caracteres.', 'boasVindas');
  end if;
  update imobdesk.cd_config set
    quadros = case when jsonb_typeof(p -> 'quadros') = 'object' then quadros || (p -> 'quadros') else quadros end,
    whatsapp = case when p ? 'whatsapp' then nullif(v_wa, '') else whatsapp end,
    boas_vindas = case when p ? 'boasVindas' then btrim(p ->> 'boasVindas') else boas_vindas end,
    atualizado_em = now(), atualizado_por = (select auth.uid())
  where id;
end;
$$;

create or replace function imobdesk.cd_aviso_salvar(p jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint := nullif(p ->> 'id', '')::bigint;
  v_titulo text := btrim(coalesce(p ->> 'titulo', ''));
  v_inicio timestamptz := coalesce(nullif(p ->> 'inicio', '')::timestamptz, now());
  v_fim timestamptz := nullif(p ->> 'fim', '')::timestamptz;
begin
  perform imobdesk.cd_admin_checar();
  if length(v_titulo) not between 3 and 90 then perform imobdesk.erro('INVALID_INPUT', 'O título deve ter de 3 a 90 caracteres.', 'titulo'); end if;
  if v_fim is not null and v_fim <= v_inicio then perform imobdesk.erro('INVALID_INPUT', 'O fim precisa ser depois do início.', 'fim'); end if;
  if coalesce(p ->> 'tipo', 'comunicado') not in ('comunicado', 'manutencao', 'alerta', 'resolvido') then perform imobdesk.erro('INVALID_INPUT', 'Tipo inválido.', 'tipo'); end if;
  if coalesce(p ->> 'link', '') <> '' and p ->> 'link' !~ '^https://' then perform imobdesk.erro('INVALID_INPUT', 'O link deve começar com https://', 'link'); end if;
  if v_id is null then
    insert into imobdesk.cd_avisos (setor_id, titulo, texto, tipo, link, inicio, fim, ativo, criado_por)
    values (nullif(p ->> 'setorId', '')::bigint, v_titulo, left(coalesce(p ->> 'texto', ''), 600), coalesce(p ->> 'tipo', 'comunicado'), nullif(p ->> 'link', ''),
            v_inicio, v_fim, coalesce((p ->> 'ativo')::boolean, true), (select auth.uid()))
    returning id into v_id;
  else
    update imobdesk.cd_avisos set setor_id = nullif(p ->> 'setorId', '')::bigint, titulo = v_titulo, texto = left(coalesce(p ->> 'texto', ''), 600),
      tipo = coalesce(p ->> 'tipo', 'comunicado'), link = nullif(p ->> 'link', ''), inicio = v_inicio, fim = v_fim,
      ativo = coalesce((p ->> 'ativo')::boolean, ativo), atualizado_em = now()
    where id = v_id;
    if not found then perform imobdesk.erro('NOT_FOUND', 'Aviso não encontrado.'); end if;
  end if;
  return v_id;
end;
$$;

create or replace function imobdesk.cd_aviso_excluir(p_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform imobdesk.cd_admin_checar();
  delete from imobdesk.cd_avisos where id = p_id;
end;
$$;

create or replace function imobdesk.cd_solucao_salvar(p jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint := nullif(p ->> 'id', '')::bigint;
  v_setor bigint := nullif(p ->> 'setorId', '')::bigint;
  v_servico bigint := nullif(p ->> 'servicoId', '')::bigint;
begin
  perform imobdesk.cd_admin_checar();
  if not exists (select 1 from imobdesk.at_setores s where s.id = v_setor) then perform imobdesk.erro('INVALID_INPUT', 'Escolha o departamento.', 'setorId'); end if;
  if v_servico is not null and not exists (select 1 from imobdesk.ch_servicos s where s.id = v_servico and s.setor_id = v_setor) then
    perform imobdesk.erro('INVALID_INPUT', 'O serviço não é deste departamento.', 'servicoId');
  end if;
  if length(btrim(coalesce(p ->> 'titulo', ''))) not between 3 and 120 then perform imobdesk.erro('INVALID_INPUT', 'O título deve ter de 3 a 120 caracteres.', 'titulo'); end if;
  if length(btrim(coalesce(p ->> 'texto', ''))) not between 3 and 4000 then perform imobdesk.erro('INVALID_INPUT', 'Escreva a solução (até 4.000 caracteres).', 'texto'); end if;
  if v_id is null then
    insert into imobdesk.cd_solucoes (setor_id, servico_id, ticket_id, titulo, texto, publicado, criado_por)
    values (v_setor, v_servico, nullif(p ->> 'ticketId', '')::bigint, btrim(p ->> 'titulo'), btrim(p ->> 'texto'), coalesce((p ->> 'publicado')::boolean, true), (select auth.uid()))
    returning id into v_id;
  else
    update imobdesk.cd_solucoes set setor_id = v_setor, servico_id = v_servico, titulo = btrim(p ->> 'titulo'), texto = btrim(p ->> 'texto'),
      publicado = coalesce((p ->> 'publicado')::boolean, publicado), atualizado_em = now()
    where id = v_id;
    if not found then perform imobdesk.erro('NOT_FOUND', 'Solução não encontrada.'); end if;
  end if;
  return v_id;
end;
$$;

create or replace function imobdesk.cd_solucao_excluir(p_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform imobdesk.cd_admin_checar();
  delete from imobdesk.cd_solucoes where id = p_id;
end;
$$;

-- ======================================================================= anexos (bucket privado, 10 MB)

insert into storage.buckets (id, name, public, file_size_limit)
values ('imobdesk-solicitante', 'imobdesk-solicitante', false, 10485760)
on conflict (id) do nothing;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'imobdesk-solicitante: gravar na própria pasta') then
    create policy "imobdesk-solicitante: gravar na própria pasta" on storage.objects for insert to authenticated
      with check (bucket_id = 'imobdesk-solicitante' and (storage.foldername(name))[1] = (select auth.uid())::text and (select imobdesk.cd_sessao_ok()));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'imobdesk-solicitante: apagar da própria pasta') then
    create policy "imobdesk-solicitante: apagar da própria pasta" on storage.objects for delete to authenticated
      using (bucket_id = 'imobdesk-solicitante' and (storage.foldername(name))[1] = (select auth.uid())::text and (select imobdesk.cd_sessao_ok()));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'imobdesk-solicitante: leitura') then
    create policy "imobdesk-solicitante: leitura" on storage.objects for select to authenticated
      using (bucket_id = 'imobdesk-solicitante'
             and (((storage.foldername(name))[1] = (select auth.uid())::text and (select imobdesk.cd_sessao_ok()))
                  or (select imobdesk.ch_eh_admin() or imobdesk.tem_permissao('gestao_chamados_tickets')
                             or imobdesk.tem_permissao('gestao_atendimento_solicitante'))));
  end if;
end;
$$;

-- ======================================================================= permissões das funções

do $$
declare
  f text;
begin
  foreach f in array array['cd_sessao_ok()', 'cd_entrar(uuid)', 'cd_perfil_salvar(jsonb)', 'cd_servicos(bigint)', 'cd_meus_chamados(text, uuid)',
                           'cd_avisos_listar(bigint)', 'cd_solucoes_listar(bigint, bigint, text)', 'cd_solucao_usada(bigint)', 'cd_ticket_criar(jsonb)',
                           'cd_chamado(bigint, uuid)', 'cd_chamado_responder(bigint, jsonb)', 'cd_chamado_confirmar(bigint, boolean, text)',
                           'cd_admin_painel()', 'cd_admin_pessoas(text)', 'cd_admin_setor_salvar(bigint, jsonb)', 'cd_admin_config_salvar(jsonb)',
                           'cd_aviso_salvar(jsonb)', 'cd_aviso_excluir(bigint)', 'cd_solucao_salvar(jsonb)', 'cd_solucao_excluir(bigint)'] loop
    execute format('revoke execute on function imobdesk.%s from public, anon', f);
    execute format('grant execute on function imobdesk.%s to authenticated, service_role', f);
  end loop;
  -- Internas: só chamadas pelas funções acima.
  foreach f in array array['cd_quem(uuid)', 'cd_email_de(uuid)', 'cd_pessoa_de(uuid)', 'cd_trilha(bigint)', 'cd_ticket_meu(bigint, uuid)',
                           'cd_status_json(bigint)', 'cd_anexos_validos(jsonb, uuid)', 'cd_reabrir(bigint)', 'cd_admin_checar()'] loop
    execute format('revoke execute on function imobdesk.%s from public, anon, authenticated', f);
    execute format('grant execute on function imobdesk.%s to service_role', f);
  end loop;
end;
$$;

-- Permissões por aplicativo (Central): tabelas novas com a mesma proteção das outras, se o controle estiver ligado.
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

-- ======================================== 20261010110000_imobdesk_servicos_administrativo.sql
-- Árvore de serviços do setor Administrativo (pedido do Wagner, 10/10/2026), dentro da raiz "Administrativo".
-- A descrição de cada serviço orienta o solicitante no App do solicitante e vai para a IA de triagem.
-- Categoria padrão "Solicitação", urgência "Normal"; equipe herdada da raiz (Administração). Todos os canais.
-- Aditiva: só inclui o que ainda não existe (mesmo setor, pai e nome); não mexe no exemplo "Solicitação administrativa".
do $$
declare
  v_setor bigint := (select id from imobdesk.at_setores where lower(nome) in ('administrativo', 'administração', 'administracao') order by id limit 1);
  v_raiz bigint;
  v_cat bigint := (select id from imobdesk.ch_categorias where lower(nome) in ('solicitação', 'solicitacao') limit 1);
  v_urg bigint := (select id from imobdesk.ch_urgencias where lower(nome) = 'normal' limit 1);
  r record;
begin
  if v_setor is null then
    raise notice 'Setor Administrativo não encontrado: nada a fazer.';
    return;
  end if;
  select id into v_raiz from imobdesk.ch_servicos
  where setor_id = v_setor and pai_id is null and lower(btrim(nome)) in ('administrativo', 'administração', 'administracao') order by id limit 1;
  if v_raiz is null then
    insert into imobdesk.ch_servicos (setor_id, nivel, nome, canais, ordem)
    values (v_setor, 1, 'Administrativo', '{agente,intranet,email,whatsapp}', 1)
    returning id into v_raiz;
  end if;

  for r in select * from (values
    (1, 'Solicitação de Material Corporativo',
     'Utilize esta categoria para solicitar materiais de uso corporativo necessários para o desempenho das atividades. Informe o material desejado e a quantidade necessária para facilitar o atendimento.'),
    (2, 'Solicitação de Adesão ao Estacionamento',
     'Utilize esta categoria para solicitar adesão, alteração ou cancelamento de acesso ao estacionamento corporativo. Informe os dados do veículo (modelo, placa e cor), bem como seus dados pessoais (nome, CPF e contato corporativo). A liberação estará sujeita às normas internas da empresa responsável pela gestão do estacionamento.'),
    (3, 'Solicitação ao Portador',
     E'Utilize esta categoria para solicitar serviços do portador, como transporte de malotes entre obras, envio e coleta de documentos, entrega ou retirada de materiais junto a clientes e fornecedores. Informe o local de origem e destino, o responsável e contato para recebimento, a descrição do material e a data necessária para a realização do serviço.\nImportante: As solicitações devem ser registradas impreterivelmente até às 17h do dia útil anterior à rota programada, para que possam ser incluídas no planejamento do portador.'),
    (4, 'Agendamento de salas de reunião e autorização de Acesso a Visitantes',
     'Utilize esta categoria para solicitar o agendamento de salas de reunião, assim como o cadastro e a autorização de acesso de visitantes às dependências da empresa. Informe o nome completo do visitante, CPF (quando aplicável), empresa de origem, data e horário da visita, colaborador responsável pelo atendimento e demais informações necessárias para o controle de acesso.')
  ) as x(ordem, nome, descricao)
  loop
    continue when exists (select 1 from imobdesk.ch_servicos s
                          where s.setor_id = v_setor and s.pai_id = v_raiz and lower(btrim(s.nome)) = lower(r.nome));
    insert into imobdesk.ch_servicos (pai_id, setor_id, nivel, nome, descricao, urgencia_padrao_id, categoria_padrao_id, canais, ativo, ordem)
    values (v_raiz, v_setor, 2, r.nome, r.descricao, v_urg, v_cat, '{agente,intranet,email,whatsapp}', true, r.ordem);
  end loop;
end;
$$;

notify pgrst, 'reload schema';

-- ======================================== 20261010120000_imobdesk_lista_colunas.sql
-- Colunas da Lista de Tickets com campos do ticket (docs/PLANO-visoes-colunas.md, Fase 2; aprovado em 10/10/2026).
-- O ch_painel() não muda: esta função traz só os dados extras das colunas novas, e a Lista só chama quando a visão
-- usa alguma delas. Mesmo filtro de visibilidade do ch_painel (os mesmos tickets, nem um a mais).
-- Campos adicionais: só os ativos com "usar em visões"; os do tipo usuário vêm com o nome da pessoa.
-- Só aditiva: uma função nova.

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
          'contato', t.solicitante_contato,
          'criado_por', case when t.criado_por is null then null else imobdesk.ch_nome_usuario(t.criado_por) end,
          'atualizado_em', t.atualizado_em,
          'primeira_resposta_em', t.primeira_resposta_em,
          'sla_resposta_ate', t.sla_resposta_ate,
          'sla_solucao_ate', t.sla_solucao_ate,
          'encerrado_em', t.encerrado_em,
          'campos', coalesce((select jsonb_object_agg(c.chave,
                                case when c.tipo = 'usuario' and (t.campos ->> c.chave) ~* '^[0-9a-f-]{36}$'
                                     then to_jsonb(imobdesk.ch_nome_usuario((t.campos ->> c.chave)::uuid))
                                     else t.campos -> c.chave end)
                              from cmp c where t.campos ? c.chave and jsonb_typeof(t.campos -> c.chave) <> 'null'), '{}')))
        from vis t), '{}'))
  );
end;
$$;

revoke execute on function imobdesk.ch_lista_extras() from public, anon;
grant execute on function imobdesk.ch_lista_extras() to authenticated, service_role;

notify pgrst, 'reload schema';

-- ======================================== 20261010130000_imobdesk_solicitante_empreendimentos.sql
-- App do solicitante: empreendimentos do site da empresa no carrossel e na tela Avisos quando não há aviso
-- (pedido do Wagner, 10/10/2026). O site (WordPress) não expõe os empreendimentos na API; a Edge
-- Uma Edge Function pode ler o site da empresa e guardar aqui por algumas horas (o app não
-- depende do site estar no ar a cada abertura). Só aditiva: uma tabela de cache e duas funções (service_role).

create table if not exists imobdesk.cd_empreendimentos_cache (
  id            boolean     primary key default true check (id),
  itens         jsonb       not null default '[]',
  atualizado_em timestamptz,
  erro          text        check (length(erro) <= 300)
);
insert into imobdesk.cd_empreendimentos_cache (id) values (true) on conflict (id) do nothing;
alter table imobdesk.cd_empreendimentos_cache enable row level security;
revoke all on imobdesk.cd_empreendimentos_cache from anon, authenticated;

create or replace function imobdesk.cd_empreendimentos_ler()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('itens', c.itens, 'atualizadoEm', c.atualizado_em, 'erro', c.erro)
  from imobdesk.cd_empreendimentos_cache c where c.id;
$$;

/** Grava a leitura do site. Lista vazia (site fora ou mudou o layout) não apaga a última boa: só registra o erro. */
create or replace function imobdesk.cd_empreendimentos_gravar(p_itens jsonb, p_erro text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if jsonb_typeof(p_itens) = 'array' and jsonb_array_length(p_itens) > 0 then
    update imobdesk.cd_empreendimentos_cache set itens = p_itens, atualizado_em = now(), erro = null where id;
  else
    update imobdesk.cd_empreendimentos_cache set erro = left(coalesce(p_erro, 'Nenhum empreendimento lido.'), 300) where id;
  end if;
end;
$$;

revoke execute on function imobdesk.cd_empreendimentos_ler() from public, anon, authenticated;
revoke execute on function imobdesk.cd_empreendimentos_gravar(jsonb, text) from public, anon, authenticated;
grant execute on function imobdesk.cd_empreendimentos_ler() to service_role;
grant execute on function imobdesk.cd_empreendimentos_gravar(jsonb, text) to service_role;

notify pgrst, 'reload schema';

-- ======================================== 20261010140000_imobdesk_login_libera_apos_troca.sql
-- Login: trocar a senha não liberava a conta e a tentativa barrada prolongava o bloqueio (10/10/2026).
-- Caso real: o Wagner errou a senha algumas vezes, trocou pelo link (15:22:12) e, 5 s depois, foi barrado por
-- RATE_LIMIT_IP_ACCOUNT (SEC_AUTH_006, 5 tentativas do mesmo IP na mesma conta em 15 min). Duas falhas somadas:
--   1. o limite de IP + conta (e o de conta) contava TODA tentativa, inclusive as barradas (denied) e os logins
--      certos (success): cada nova tentativa durante o bloqueio gerava outra linha e empurrava o bloqueio;
--   2. security_apos_troca_senha zerava o controle da conta, mas não essas contagens (vêm de security_attempts).
-- Correção: os limites da CONTA contam só failure/pending e só depois de security_auth_control.contar_desde, que a
-- troca de senha marca. Os limites do IP (rajada, spray, por hora) continuam contando tudo.
-- Só aditiva: uma coluna nova e as duas funções trocadas (mesma assinatura e mesmas permissões).

alter table imobdesk.security_auth_control add column if not exists contar_desde timestamptz;

create or replace function imobdesk.security_auth_begin(
  p_kind text,
  p_email text,
  p_ip text,
  p_request_id uuid,
  p_domain_allowed boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_email text := imobdesk.security_normalize_email(p_email);
  v_ip text := coalesce(nullif(trim(p_ip), ''), 'unknown');
  v_user_hash text;
  v_ip_hash text;
  c imobdesk.security_auth_control;
  v_block imobdesk.security_ip_blocks;
  v_ip_1m integer; v_ip_15m integer; v_ip_1h integer; v_ip_burst integer;
  v_ipacc_15m integer; v_acc_15m integer; v_acc_recover_1h integer; v_ip_recover_15m integer;
  v_spray integer; v_dist integer;
  v_last_ip_attempt timestamptz;
  v_last_acct_attempt timestamptz;
  v_risk integer := 0;
  v_ip_risk integer := 0;
  v_signals text[] := '{}';
  v_reason text;
  v_event text;
  v_severity text := 'warning';
  v_attempt uuid;
begin
  if p_kind not in ('login', 'recover') or v_email = '' or length(v_email) > 254 or length(v_ip) > 64 then
    raise exception 'security_auth_begin: parâmetros inválidos';
  end if;

  v_user_hash := imobdesk.security_hash('acct', v_email);
  v_ip_hash := imobdesk.security_hash('ip', v_ip);

  -- Serializa por IP e por conta (sempre nesta ordem). Fecha a corrida "todas leem 4 e passam".
  perform pg_advisory_xact_lock(hashtextextended('sec:ip:' || v_ip_hash, 0));
  perform pg_advisory_xact_lock(hashtextextended('sec:acct:' || v_user_hash, 0));

  if random() < 0.01 then
    perform imobdesk.security_cleanup();
  end if;

  insert into imobdesk.security_auth_control (user_hash) values (v_user_hash) on conflict (user_hash) do nothing;
  select * into c from imobdesk.security_auth_control where user_hash = v_user_hash for update;
  select * into v_block from imobdesk.security_ip_blocks where ip_hash = v_ip_hash;

  -- Contagens ANTES desta tentativa.
  select count(*) filter (where a.created_at > v_now - interval '1 minute' and a.kind = p_kind),
         count(*) filter (where a.created_at > v_now - interval '15 minutes' and a.kind = p_kind),
         count(*) filter (where a.kind = p_kind),
         count(*) filter (where a.created_at > v_now - make_interval(secs => imobdesk.security_cfg('velocity_window_ms') / 1000.0)),
         count(*) filter (where a.kind = 'recover' and a.created_at > v_now - interval '15 minutes'),
         max(a.created_at)
    into v_ip_1m, v_ip_15m, v_ip_1h, v_ip_burst, v_ip_recover_15m, v_last_ip_attempt
  from imobdesk.security_attempts a
  where a.ip_hash = v_ip_hash and a.created_at > v_now - interval '1 hour';

  -- Limites da CONTA (IP + conta e conta): só senha errada de verdade (failure) ou em andamento (pending), e só depois
  -- da última troca de senha. Tentativa barrada (denied) não é palpite de senha: contá-la fazia cada nova tentativa
  -- durante o bloqueio empurrar o bloqueio para frente. Os limites do IP continuam contando tudo.
  select count(*) filter (where a.ip_hash = v_ip_hash and a.created_at > v_now - interval '15 minutes' and a.kind = 'login'
                                and a.outcome in ('failure', 'pending') and a.created_at > coalesce(c.contar_desde, '-infinity'::timestamptz)),
         count(*) filter (where a.created_at > v_now - interval '15 minutes' and a.kind = 'login'
                                and a.outcome in ('failure', 'pending') and a.created_at > coalesce(c.contar_desde, '-infinity'::timestamptz)),
         count(*) filter (where a.kind = 'recover'),
         max(a.created_at) filter (where a.kind = 'login')
    into v_ipacc_15m, v_acc_15m, v_acc_recover_1h, v_last_acct_attempt
  from imobdesk.security_attempts a
  where a.user_hash = v_user_hash and a.created_at > v_now - interval '1 hour';

  -- Contas distintas por este IP (5 min) e IPs distintos nesta conta (15 min), contando a atual.
  select count(distinct u) into v_spray from (
    select a.user_hash as u from imobdesk.security_attempts a
    where a.ip_hash = v_ip_hash and a.created_at > v_now - interval '5 minutes'
    union select v_user_hash
  ) x;
  select count(distinct i) into v_dist from (
    select a.ip_hash as i from imobdesk.security_attempts a
    where a.user_hash = v_user_hash and a.created_at > v_now - interval '15 minutes' and a.kind = 'login'
      and a.created_at > coalesce(c.contar_desde, '-infinity'::timestamptz)
    union select v_ip_hash
  ) x;

  -- ---------- Risco (sinais combinados; nenhum sinal isolado decide sozinho) ----------
  -- Sinais da CONTA (falhas, muitos IPs) e sinais do IP (rajada, muitas contas, paralelismo,
  -- bloqueio recente) somam no risco; mas só os do IP podem levar a bloquear o IP — senão um
  -- usuário errando a senha bloquearia todo o escritório atrás do mesmo NAT.
  if c.failed_attempts > 0 then
    v_risk := v_risk + least(c.failed_attempts * 10, 40); v_signals := array_append(v_signals, 'senha_invalida');
  end if;
  if v_dist >= 3 then
    v_risk := v_risk + 30; v_signals := array_append(v_signals, 'muitos_ips_mesma_conta');
  end if;
  if v_ip_1m >= 5 then
    v_ip_risk := v_ip_risk + 20; v_signals := array_append(v_signals, 'muitas_tentativas');
  end if;
  if v_spray >= 4 then
    v_ip_risk := v_ip_risk + 30; v_signals := array_append(v_signals, 'muitas_contas_mesmo_ip');
  end if;
  if v_ip_burst >= imobdesk.security_cfg('velocity_max') then
    v_ip_risk := v_ip_risk + 30; v_signals := array_append(v_signals, 'velocidade_anormal');
  end if;
  if c.inflight_until > v_now then
    v_ip_risk := v_ip_risk + 40; v_signals := array_append(v_signals, 'requisicoes_paralelas');
  end if;
  if v_block.ip_hash is not null and v_block.last_block_at > v_now - interval '24 hours' then
    v_ip_risk := v_ip_risk + 40; v_signals := array_append(v_signals, 'ip_bloqueado_recentemente');
  end if;
  v_risk := least(v_risk + v_ip_risk, 100);

  -- ---------- Decisão (primeira regra que nega vence) ----------
  if not p_domain_allowed then
    v_reason := 'SEC_AUTH_013'; v_event := 'LOGIN_BLOCKED'; v_severity := 'info';
  elsif v_block.blocked_until > v_now then
    v_reason := 'SEC_AUTH_004'; v_event := 'LOGIN_BLOCKED';
  elsif p_kind = 'recover' then
    if v_ip_recover_15m >= imobdesk.security_cfg('recover_ip_15m')
       or v_acc_recover_1h >= imobdesk.security_cfg('recover_account_1h') then
      v_reason := 'SEC_AUTH_020'; v_event := 'RATE_LIMIT_RECOVER';
    end if;
  elsif v_spray > imobdesk.security_cfg('spray_accounts_5m') then
    v_reason := 'SEC_AUTH_008'; v_event := 'PASSWORD_SPRAY_DETECTED'; v_severity := 'critical';
    perform imobdesk.security_block_ip(v_ip_hash, imobdesk.security_cfg('spray_block_min'), 'PASSWORD_SPRAY');
  elsif v_ip_1m >= imobdesk.security_cfg('ip_attempts_1m')
     or v_ip_15m >= imobdesk.security_cfg('ip_attempts_15m')
     or v_ip_1h >= imobdesk.security_cfg('ip_attempts_1h') then
    v_reason := 'SEC_AUTH_005'; v_event := 'RATE_LIMIT_IP';
  elsif c.locked_until > v_now then
    -- Bloqueada continua bloqueada mesmo com a senha certa: nem chega ao Auth.
    v_reason := 'SEC_AUTH_001'; v_event := 'LOGIN_BLOCKED';
  elsif c.inflight_until > v_now then
    v_reason := 'SEC_AUTH_003'; v_event := 'BOT_PATTERN';
  elsif c.next_allowed_at > v_now then
    v_reason := 'SEC_AUTH_002'; v_event := 'LOGIN_BLOCKED'; v_severity := 'info';
  elsif v_ipacc_15m >= imobdesk.security_cfg('ip_account_attempts_15m') then
    v_reason := 'SEC_AUTH_006'; v_event := 'RATE_LIMIT_IP_ACCOUNT';
  elsif v_dist > imobdesk.security_cfg('distributed_ips_15m') then
    -- Muitos IPs na mesma conta: a conta é bloqueada (independe do IP de onde vier a próxima).
    v_reason := 'SEC_AUTH_009'; v_event := 'DISTRIBUTED_ATTACK'; v_severity := 'critical';
    update imobdesk.security_auth_control
    set lock_level = c.lock_level + 1,
        locked_until = v_now + make_interval(mins => imobdesk.security_lock_minutes(c.lock_level + 1)),
        last_lock_at = v_now, updated_at = v_now
    where user_hash = v_user_hash;
  elsif v_acc_15m >= imobdesk.security_cfg('account_attempts_15m') then
    v_reason := 'SEC_AUTH_007'; v_event := 'RATE_LIMIT_ACCOUNT';
  elsif v_risk >= imobdesk.security_cfg('risk_critical') and v_ip_risk >= 30 then
    v_reason := 'SEC_AUTH_012'; v_event := 'BOT_PATTERN'; v_severity := 'critical';
    perform imobdesk.security_block_ip(v_ip_hash, imobdesk.security_cfg('risk_critical_block_min'), 'RISK_CRITICAL');
  elsif v_risk >= imobdesk.security_cfg('risk_block') and v_ip_risk >= 30 then
    v_reason := 'SEC_AUTH_011'; v_event := 'BOT_PATTERN';
    perform imobdesk.security_block_ip(v_ip_hash, imobdesk.security_cfg('risk_block_min'), 'RISK_BLOCK');
  elsif v_risk >= imobdesk.security_cfg('risk_cooldown')
     and greatest(v_last_ip_attempt, v_last_acct_attempt) > v_now - make_interval(secs => imobdesk.security_cfg('risk_cooldown_seconds')) then
    -- Risco médio (ou alto só por sinais da conta): exige intervalo mínimo entre tentativas.
    v_reason := 'SEC_AUTH_010'; v_event := 'LOGIN_BLOCKED'; v_severity := 'info';
  end if;

  update imobdesk.security_auth_control set risk_score = v_risk, updated_at = v_now where user_hash = v_user_hash;

  if v_reason is not null then
    insert into imobdesk.security_attempts (kind, ip_hash, user_hash, outcome, reason, risk_score, request_id, finished_at)
    values (p_kind, v_ip_hash, v_user_hash, 'denied', v_reason, v_risk, p_request_id, v_now);
    perform imobdesk.security_log_event(v_event, v_severity, p_request_id, v_ip_hash, v_ip, v_user_hash, c.user_id,
      v_email, v_reason, v_risk, jsonb_build_object('kind', p_kind, 'signals', to_jsonb(v_signals)));
    return jsonb_build_object('allowed', false, 'reason', v_reason, 'risk', v_risk);
  end if;

  -- Permitida: reserva a conta (uma tentativa por vez) e registra a tentativa em andamento.
  if p_kind = 'login' then
    update imobdesk.security_auth_control
    set inflight_until = v_now + make_interval(secs => imobdesk.security_cfg('account_inflight_seconds')), updated_at = v_now
    where user_hash = v_user_hash;
  end if;
  insert into imobdesk.security_attempts (kind, ip_hash, user_hash, outcome, risk_score, request_id)
  values (p_kind, v_ip_hash, v_user_hash, 'pending', v_risk, p_request_id)
  returning id into v_attempt;

  return jsonb_build_object('allowed', true, 'attempt_id', v_attempt, 'risk', v_risk);
end;
$$;

create or replace function imobdesk.security_apos_troca_senha()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_sid uuid;
  v_email text;
  v_hash text;
begin
  if v_uid is null or not imobdesk.sessao_confiavel() then
    perform imobdesk.erro('UNAUTHENTICATED', 'Sua sessão expirou. Entre novamente.');
  end if;
  begin
    v_sid := (auth.jwt() ->> 'session_id')::uuid;
  exception when others then
    v_sid := null;
  end;
  select imobdesk.security_normalize_email(u.email) into v_email from auth.users u where u.id = v_uid;
  v_hash := imobdesk.security_hash('acct', v_email);

  update imobdesk.security_auth_control
  set failed_attempts = 0, locked_until = null, next_allowed_at = null, inflight_until = null,
      contar_desde = now(), user_id = v_uid, updated_at = now()
  where user_hash = v_hash;

  update imobdesk.security_sessions
  set revoked_at = now(), revoked_reason = 'password_changed'
  where user_id = v_uid and revoked_at is null and session_id is distinct from v_sid;

  perform imobdesk.security_log_event('SESSION_REVOKED', 'info', null, null, null, v_hash, v_uid, v_email,
    'PASSWORD_CHANGED', null, jsonb_build_object('scope', 'others'));
end;
$$;

-- De carona (achado pelo teste "anon não tem privilégio" ao rodar a suíte): a função da migração 20261009150000 ficou
-- executável por anon. É só um "case" do canal, mas a regra do schema é nenhum privilégio para anon.
revoke execute on function imobdesk.ch_forma_atendimento_do_canal(text) from public, anon;
grant execute on function imobdesk.ch_forma_atendimento_do_canal(text) to authenticated, service_role;

notify pgrst, 'reload schema';

-- ======================================== 20261010150000_imobdesk_solicitante_empreendimentos_rpc.sql
-- App do solicitante: os empreendimentos não apareciam no celular na versão publicada (10/10/2026).
-- O cache estava cheio (32, lidos às 14:54) e a Edge respondia, mas a tela dependia de uma chamada à Edge com a
-- checagem de sessão própria dela: qualquer falha nesse caminho (ex.: sessão antiga encerrada pela troca de senha,
-- com o app já aberto) virava o card "Tudo funcionando por aqui". Agora o app lê o cache por esta RPC, com a mesma
-- checagem do resto do app (cd_quem); a Edge só atualiza o cache quando ele estiver vazio ou velho.
-- Só aditiva: uma função nova.

create or replace function imobdesk.cd_empreendimentos()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform imobdesk.cd_quem(null);
  return (select jsonb_build_object('itens', c.itens, 'atualizadoEm', c.atualizado_em)
          from imobdesk.cd_empreendimentos_cache c where c.id);
end;
$$;

revoke execute on function imobdesk.cd_empreendimentos() from public, anon;
grant execute on function imobdesk.cd_empreendimentos() to authenticated, service_role;

notify pgrst, 'reload schema';

-- ======================================== 20261012100000_imobdesk_empreendimentos.sql
-- Empreendimentos (docs/PLANO-empreendimentos-cftv.md, aprovado em 12/10/2026).
-- Administração › Empreendimentos: cadastro (nomes da Movidesk) e, por setor, se o App do solicitante pede o empreendimento
-- e se a IA identifica o empreendimento nos chamados que chegam sem ele. Decisões do Wagner: só Admin e Super admin
-- alteram (D1); só o CFTV usa por enquanto (D2); IA aplica sozinha a partir de 80% (D3); no App do solicitante o
-- solicitante do CFTV escolhe o empreendimento depois do setor (D4); nomes iguais aos da Movidesk (D5).
-- Só aditiva: tabelas e colunas novas; cd_ticket_criar e ch_lista_extras redefinidas com o empreendimento.

-- ---------- Cadastro ----------
create table if not exists imobdesk.ch_empreendimentos (
  id              bigint      generated by default as identity primary key,
  nome            text        not null check (length(btrim(nome)) between 2 and 120),
  apelidos        text[]      not null default '{}',             -- como as pessoas escrevem no chamado (ajuda a IA)
  cidade          text,
  endereco        text,
  observacao      text,                                          -- aparece para o técnico no ticket
  ativo           boolean     not null default true,
  criado_em       timestamptz not null default now(),
  atualizado_em   timestamptz not null default now(),
  atualizado_por  uuid
);
create unique index if not exists ch_empreendimentos_nome_uq on imobdesk.ch_empreendimentos (lower(btrim(nome)));

-- Por setor: pedir no app e IA.
create table if not exists imobdesk.ch_empreendimento_config (
  setor_id        bigint      primary key references imobdesk.at_setores (id) on delete cascade,
  pedir_no_app    boolean     not null default false,
  ia_ligada       boolean     not null default false,
  limiar          int         not null default 80 check (limiar between 50 and 100),
  ia_desde        timestamptz not null default now(),             -- tickets criados antes disto não são avaliados
  atualizado_em   timestamptz not null default now(),
  atualizado_por  uuid
);

alter table imobdesk.ch_tickets add column if not exists empreendimento_id bigint references imobdesk.ch_empreendimentos (id) on delete set null;
alter table imobdesk.ch_tickets add column if not exists empreendimento_origem text check (empreendimento_origem in ('ia', 'manual', 'solicitante'));
create index if not exists ch_tickets_empreendimento_idx on imobdesk.ch_tickets (empreendimento_id) where empreendimento_id is not null;

-- Resultado da IA por ticket (o último vale; erro tenta de novo até 3 vezes).
create table if not exists imobdesk.ch_ticket_ia_empreendimento (
  id                 bigint      generated always as identity primary key,
  ticket_id          bigint      not null references imobdesk.ch_tickets (id) on delete cascade,
  situacao           text        not null check (situacao in ('aplicado', 'baixa_confianca', 'erro')),
  empreendimento_id  bigint      references imobdesk.ch_empreendimentos (id) on delete set null,
  confianca          int         check (confianca between 0 and 100),
  motivo             text,
  sugestoes          bigint[]    not null default '{}',
  modelo             text,
  tokens_entrada     int,
  tokens_saida       int,
  ms                 int,
  erro               text,
  criado_em          timestamptz not null default now()
);
create index if not exists ch_ticket_ia_emp_ticket_idx on imobdesk.ch_ticket_ia_empreendimento (ticket_id, criado_em desc);

do $$
declare
  t text;
begin
  foreach t in array array['ch_empreendimentos', 'ch_empreendimento_config', 'ch_ticket_ia_empreendimento'] loop
    execute format('alter table imobdesk.%I enable row level security', t);
    execute format('revoke all on imobdesk.%I from anon, public, authenticated', t);
    execute format('grant all on imobdesk.%I to service_role', t);
  end loop;
end;
$$;

-- Nomes do campo "Empreendimento" da Movidesk (prints de 12/10/2026), na ordem de lá.
insert into imobdesk.ch_empreendimentos (nome)
select x.nome
from unnest(array[
  'DUO STILE RESIDENZIALE', 'DUO DISEGNO RESIDENZIALE', 'RAJA SOCIEDADE UNIPESSOAL LTDA', 'CONDOMINIO RESIDENCIAL LIFE',
  'CONDOMINIO EDIFICIO VILA DE ESPANA', 'CONDOMINIO EDIFICIO SUNFLOWER', 'CONDOMINIO VILLA DEL MAR', 'CONDOMINIO DO EDIFICIO VILA FIRENZE',
  'CONDOMINIO VILA FERRARA', 'CONDOMINIO PERSONALISE RESIDENCE', 'CONDOMINIO LUMINA OFFICES', 'CONDOMINIO VILLA LUNA',
  'CONDOMINIO VILLA SOLE', 'CONDOMINIO VILLA MARE', 'CONDOMINIO VILLA STELLA', 'SPE C5 EMPREENDIMENTOS IMOBILIARIOS LTDA',
  'SPE VILLA LUNA EMPREENDIMENTOS LTDA', 'SPE VILLA SOLE EMPREENDIMENTOS LTDA', 'SPE PERSONALISE EMPREENDIMENTOS LTDA',
  'SPE VILLA MARE EMPREENDIMENTOS LTDA', 'SPE ORIGINAL OFFICES EMPREENDIMENTOS LTDA', 'SPE LUMINA OFFICES EMPREENDIMENTO LTDA',
  'CONDOMINIO VILLA CIELO', 'CONDOMINIO LUMINA WORKSTATION', 'CONDOMINIO VILLA AQUA', 'SPE VILLA AQUA EMPREENDIMENTOS IMOBILIARIOS LTDA',
  'CONDOMINIO GRAND VILLAGE', 'TI WONDERFULL EMPREENDIMENTOS IMOBILIARIOS SPE LTDA', 'CONDOMINIO DO EDIFICIO VILLA DEL PARADISO',
  'VERCELLI RESIDENCIAL', 'CONDOMINIO LIFE RESORT CAMPO GRANDE', 'CONDOMINIO COMERCIAL LIFE', 'CONDOMINIO VILLA FIORI',
  'CONDOMINIO LIFE RESIDENCIAL 4 FASE', 'CONDOMINIO VILLAGE GARDEN', 'LUMINA CORPORATE', 'CONDOMINIO VILLA ESPLENDORE',
  'CONDOMINIO SUNSET CLUB RESIDENCE II', 'CONDOMINIO A3 OFFICES', 'CONDOMINIO A4 OFFICES',
  'TIC SCENARIUM EMPREENDIMENTOS IMOBILIARIOS SPE LTDA', 'TC A4 OFFICES EMPREENDIMENTOS IMOBILIARIOS SPE LTDA',
  'CONDOMINIO SCENARIUM RESIDENCE', 'CONDOMINIO LIFE RESORT CAMPO GRANDE II', 'CONDOMINIO SUNSET CLUB RESIDENCE I',
  'C SUNSET CLUB EMPREENDIMENTOS IMOBILIARIOS SPE LTDA', 'C WONDERFULL EMPREENDIMENTOS IMOBILIARIOS SPE LTDA',
  'C CONTEMPORANEO EMPREENDIMENTOS IMOBILIARIOS SPE LTDA', 'TC NEXUS I EMPREENDIMENTOS IMOBILIARIOS SPE LTDA',
  'T GROTA FUNDA EMPREENDIMENTOS IMOBILIARIOS LTDA', 'IC GROTA FUNDA EMPREENDIMENTOS IMOBILIARIOS SPE LTDA',
  'TIC BRISE EMPREENDIMENTOS IMOBILIARIOS SPE LTDA', 'TI ITAGUAI EMPREENDIMENTOS IMOBILIARIOS SPE LTDA',
  'TI FRANCISCO BICALHO EMPREENDIMENTOS IMOBILIARIOS SPE LTDA', 'TIC RARO EMPREENDIMENTOS IMOBILIARIOS SPE LTDA',
  'CENTRO METROPOLITANO PARTICIPACOES IMOBILIARIAS LTDA', 'CONDOMINIO NOIR DESIGN APARTMENTS', 'CONDOMINIO NOIR PLUS DESIGN APARTMENTS',
  'CONDOMINIO WINGS RESIDENCES', 'CONDOMINIO OCEANSIDE RESIDENCE', 'ETEHE RESIDENCIAL', 'MURANO RESIDENCIAL', 'CORBUSIER 201',
  'WAY BARRA BONITA', 'CONDOMINIO ARTE JARDIM', 'WIDE RESIDENCES', 'ATLANTIS RJ EMPREENDIMENTOS IMOBILIARIOS LTDA',
  'TIC FRAMES EMPREENDIMENTOS IMOBILIÁRIOS SPE LTDA', 'C3 EMPREENDIMENTOS IMOBILIARIOS LTDA', 'CONDOMINIO NEXUS',
  'CONDOMINIO ARTE BOTANICA RESIDENCIAL', 'SOFISTICATO RESIDENCE', 'CONDOMINIO ARTE DESIGN', 'CONDOMINIO ARTE WAVE',
  'NEXUS HOTEL & RESIDENCE', 'ARTE WOOD RESIDENCES', 'ARTE WAVE SURF RESIDENCES', 'CONTEMPORANEO DESING RESORT I',
  'CONDOMINIO A5 OFFICES', 'FEEL PONTAL OCEANICO', 'FEEL NATURE'
]) as x(nome)
on conflict ((lower(btrim(nome)))) do nothing;

-- CFTV: o app pede o empreendimento e a IA identifica nos demais canais (D2, D3, D4).
insert into imobdesk.ch_empreendimento_config (setor_id, pedir_no_app, ia_ligada, limiar)
select s.id, true, true, 80 from imobdesk.at_setores s where lower(s.nome) = 'cftv'
on conflict (setor_id) do nothing;

-- ---------- Administração (leitura: quem usa a Gestão de Chamados; escrita: Admin e Super admin) ----------

/** Cadastro e configuração por setor. */
create or replace function imobdesk.ch_empreendimentos_lista()
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
    'empreendimentos', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'nome', e.nome, 'apelidos', e.apelidos, 'cidade', e.cidade, 'endereco', e.endereco,
                                                                     'observacao', e.observacao, 'ativo', e.ativo,
                                                                     'tickets', (select count(*) from imobdesk.ch_tickets t where t.empreendimento_id = e.id and t.excluido_em is null))
                                                  order by lower(e.nome))
                                 from imobdesk.ch_empreendimentos e), '[]'),
    'setores', coalesce((select jsonb_agg(jsonb_build_object('setorId', s.id, 'setor', s.nome, 'pedirNoApp', coalesce(c.pedir_no_app, false),
                                                             'iaLigada', coalesce(c.ia_ligada, false), 'limiar', coalesce(c.limiar, 80))
                                          order by s.nome)
                         from imobdesk.at_setores s left join imobdesk.ch_empreendimento_config c on c.setor_id = s.id
                         where s.ativo), '[]'));
end;
$$;

create or replace function imobdesk.ch_empreendimento_salvar(p jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := imobdesk.ch_exigir_admin();
  v_id bigint := nullif(p ->> 'id', '')::bigint;
  v_nome text := regexp_replace(btrim(coalesce(p ->> 'nome', '')), '\s+', ' ', 'g');
  v_apelidos text[];
begin
  if length(v_nome) not between 2 and 120 then perform imobdesk.erro('INVALID_INPUT', 'Informe o nome (2 a 120 letras).', 'nome'); end if;
  if exists (select 1 from imobdesk.ch_empreendimentos e where lower(btrim(e.nome)) = lower(v_nome) and e.id is distinct from v_id) then
    perform imobdesk.erro('DUPLICATE', 'Já existe um empreendimento com esse nome.', 'nome');
  end if;
  -- Sem repetir (ignora maiúsculas), na ordem digitada.
  select coalesce(array_agg(a order by o), '{}') into v_apelidos
  from (select distinct on (lower(a)) a, o
        from (select left(regexp_replace(btrim(x), '\s+', ' ', 'g'), 60) as a, o
              from jsonb_array_elements_text(coalesce(p -> 'apelidos', '[]')) with ordinality j(x, o)) y
        where length(a) >= 2
        order by lower(a), o) z;
  if cardinality(v_apelidos) > 20 then perform imobdesk.erro('INVALID_INPUT', 'No máximo 20 apelidos.', 'apelidos'); end if;
  if v_id is null then
    insert into imobdesk.ch_empreendimentos (nome, apelidos, cidade, endereco, observacao, ativo, atualizado_por)
    values (v_nome, v_apelidos, left(nullif(btrim(p ->> 'cidade'), ''), 80), left(nullif(btrim(p ->> 'endereco'), ''), 200),
            left(nullif(btrim(p ->> 'observacao'), ''), 500), coalesce((p ->> 'ativo')::boolean, true), v_ator)
    returning id into v_id;
  else
    update imobdesk.ch_empreendimentos
       set nome = v_nome, apelidos = v_apelidos, cidade = left(nullif(btrim(p ->> 'cidade'), ''), 80), endereco = left(nullif(btrim(p ->> 'endereco'), ''), 200),
           observacao = left(nullif(btrim(p ->> 'observacao'), ''), 500), ativo = coalesce((p ->> 'ativo')::boolean, ativo), atualizado_em = now(), atualizado_por = v_ator
     where id = v_id;
    if not found then perform imobdesk.erro('NOT_FOUND', 'Empreendimento não encontrado.'); end if;
  end if;
  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', 'update', format('Empreendimento "%s" salvo', v_nome), null, p, v_id::text);
  return v_id;
end;
$$;

/** Configuração de um setor. Ligar a IA vale para os tickets criados a partir de agora. */
create or replace function imobdesk.ch_empreendimento_config_salvar(p jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := imobdesk.ch_exigir_admin();
  v_setor bigint := nullif(p ->> 'setorId', '')::bigint;
  v_ia boolean := coalesce((p ->> 'iaLigada')::boolean, false);
  v_limiar int := coalesce(nullif(p ->> 'limiar', '')::int, 80);
begin
  if not exists (select 1 from imobdesk.at_setores s where s.id = v_setor) then perform imobdesk.erro('NOT_FOUND', 'Setor não encontrado.'); end if;
  if v_limiar not between 50 and 100 then perform imobdesk.erro('INVALID_INPUT', 'O limiar vai de 50 a 100%.', 'limiar'); end if;
  insert into imobdesk.ch_empreendimento_config as c (setor_id, pedir_no_app, ia_ligada, limiar, ia_desde, atualizado_por)
  values (v_setor, coalesce((p ->> 'pedirNoApp')::boolean, false), v_ia, v_limiar, now(), v_ator)
  on conflict (setor_id) do update
    set pedir_no_app = excluded.pedir_no_app, ia_ligada = excluded.ia_ligada, limiar = excluded.limiar,
        ia_desde = case when excluded.ia_ligada and not c.ia_ligada then now() else c.ia_desde end,
        atualizado_em = now(), atualizado_por = v_ator;
  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', 'update', 'Empreendimentos: configuração do setor salva', null, p, v_setor::text);
end;
$$;

-- ---------- Ticket ----------

/** Empreendimento do ticket, se o setor usa, e a última avaliação da IA (com as sugestões). */
create or replace function imobdesk.ch_ticket_empreendimento(p_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  t imobdesk.ch_tickets := imobdesk.ch_ticket_visivel(p_id);
  e imobdesk.ch_empreendimentos;
  i imobdesk.ch_ticket_ia_empreendimento;
begin
  select * into e from imobdesk.ch_empreendimentos x where x.id = t.empreendimento_id;
  select * into i from imobdesk.ch_ticket_ia_empreendimento x where x.ticket_id = p_id and x.situacao <> 'erro' order by x.criado_em desc limit 1;
  return jsonb_build_object(
    'usa', t.empreendimento_id is not null or exists (select 1 from imobdesk.ch_empreendimento_config c where c.setor_id = t.setor_id and (c.ia_ligada or c.pedir_no_app)),
    'empreendimento', case when e.id is null then null else jsonb_build_object('id', e.id, 'nome', e.nome, 'cidade', e.cidade, 'endereco', e.endereco, 'observacao', e.observacao) end,
    'origem', t.empreendimento_origem,
    'ia', case when i.id is null then null else jsonb_build_object(
      'situacao', i.situacao, 'confianca', i.confianca, 'motivo', i.motivo, 'criadoEm', i.criado_em,
      'sugestoes', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'nome', x.nome) order by s.ord)
                             from unnest(i.sugestoes) with ordinality s(id, ord) join imobdesk.ch_empreendimentos x on x.id = s.id and x.ativo), '[]')) end,
    'opcoes', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'nome', x.nome) order by lower(x.nome))
                        from imobdesk.ch_empreendimentos x where x.ativo or x.id = t.empreendimento_id), '[]'));
end;
$$;

/** Agente define (ou limpa) o empreendimento. Fica no histórico; a IA não mexe mais neste ticket. */
create or replace function imobdesk.ch_ticket_empreendimento_definir(p_id bigint, p_empreendimento bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  t imobdesk.ch_tickets := imobdesk.ch_ticket_visivel(p_id);
  v_uid uuid := (select auth.uid());
  v_de text := (select x.nome from imobdesk.ch_empreendimentos x where x.id = t.empreendimento_id);
  v_para text;
begin
  if t.excluido_em is not null then perform imobdesk.erro('INVALID_INPUT', 'Ticket excluído.'); end if;
  if t.mesclado_em_id is not null then perform imobdesk.erro('INVALID_INPUT', format('Este ticket foi mesclado em #%s.', t.mesclado_em_id)); end if;
  if p_empreendimento is not null then
    select x.nome into v_para from imobdesk.ch_empreendimentos x where x.id = p_empreendimento and (x.ativo or x.id = t.empreendimento_id);
    if v_para is null then perform imobdesk.erro('INVALID_INPUT', 'Empreendimento inválido.', 'empreendimentoId'); end if;
  end if;
  if p_empreendimento is not distinct from t.empreendimento_id then return; end if;
  update imobdesk.ch_tickets set empreendimento_id = p_empreendimento, empreendimento_origem = case when p_empreendimento is null then null else 'manual' end
   where id = p_id;
  insert into imobdesk.ch_ticket_eventos (ticket_id, tipo, descricao, de, para, autor_id, autor_nome)
  values (p_id, 'empreendimento',
          case when p_empreendimento is null then format('Empreendimento removido (era %s)', coalesce(v_de, '—'))
               else format('Empreendimento: %s', v_para) end,
          jsonb_build_object('empreendimentoId', t.empreendimento_id), jsonb_build_object('empreendimentoId', p_empreendimento),
          v_uid, coalesce(imobdesk.ch_nome_usuario(v_uid), 'Sistema'));
end;
$$;

-- ---------- IA (Edge imobdesk-ia, service_role) ----------

/** Tickets a avaliar: setor com IA de empreendimento ligada, sem empreendimento, abertos depois de ligar. */
create or replace function imobdesk.ch_ia_empreendimentos_pendentes(p_limite int default 10)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with fila as (
    select t.id, t.assunto,
           coalesce((select a.texto from imobdesk.ch_ticket_acoes a where a.ticket_id = t.id order by a.numero limit 1), '') as descricao
    from imobdesk.ch_tickets t
    join imobdesk.ch_empreendimento_config cfg on cfg.setor_id = t.setor_id and cfg.ia_ligada
    where t.empreendimento_id is null and t.excluido_em is null and t.mesclado_em_id is null and t.encerrado_em is null
      and t.criado_em >= cfg.ia_desde
      and not exists (select 1 from imobdesk.ch_ticket_ia_empreendimento i where i.ticket_id = t.id and i.situacao <> 'erro')
      and (select count(*) from imobdesk.ch_ticket_ia_empreendimento i where i.ticket_id = t.id and i.situacao = 'erro') < 3
    order by t.id
    limit greatest(1, least(p_limite, 50))
  ), lista as (
    select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'nome', e.nome, 'apelidos', e.apelidos, 'cidade', e.cidade) order by lower(e.nome)), '[]') as j
    from imobdesk.ch_empreendimentos e where e.ativo
  )
  select coalesce(jsonb_agg(jsonb_build_object('ticketId', f.id, 'assunto', f.assunto, 'descricao', left(f.descricao, 20000),
                                               'empreendimentos', (select j from lista)) order by f.id), '[]')
  from fila f;
$$;

/**
 * Grava a avaliação. Confiança ≥ limiar e o ticket ainda sem empreendimento → aplica e registra no histórico;
 * senão guarda as sugestões ("Revisar empreendimento" na tela do ticket).
 */
create or replace function imobdesk.ch_ia_empreendimento_registrar(p_ticket bigint, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t imobdesk.ch_tickets;
  cfg imobdesk.ch_empreendimento_config;
  v_emp bigint := nullif(p ->> 'empreendimentoId', '')::bigint;
  v_conf int := least(100, greatest(0, coalesce(nullif(p ->> 'confianca', '')::int, 0)));
  v_sug bigint[];
  v_situacao text;
  v_nome text;
begin
  select * into t from imobdesk.ch_tickets x where x.id = p_ticket for update;
  if t.id is null then return jsonb_build_object('situacao', 'inexistente'); end if;
  select * into cfg from imobdesk.ch_empreendimento_config c where c.setor_id = t.setor_id;

  if nullif(p ->> 'erro', '') is not null then
    insert into imobdesk.ch_ticket_ia_empreendimento (ticket_id, situacao, modelo, ms, erro)
    values (p_ticket, 'erro', p ->> 'modelo', nullif(p ->> 'ms', '')::int, left(p ->> 'erro', 1000));
    return jsonb_build_object('situacao', 'erro');
  end if;

  if v_emp is not null and not exists (select 1 from imobdesk.ch_empreendimentos e where e.id = v_emp and e.ativo) then v_emp := null; end if;
  select coalesce(array_agg(s.id order by s.ord), '{}') into v_sug
  from (select distinct on (x::bigint) x::bigint as id, o as ord from jsonb_array_elements_text(coalesce(p -> 'sugestoes', '[]')) with ordinality j(x, o) order by x::bigint, o) s
  where exists (select 1 from imobdesk.ch_empreendimentos e where e.id = s.id and e.ativo);
  if v_emp is not null and not (v_emp = any (v_sug)) then v_sug := array[v_emp] || v_sug; end if;
  v_sug := v_sug[1:3];

  v_situacao := case when v_emp is not null and v_conf >= coalesce(cfg.limiar, 80) and t.empreendimento_id is null then 'aplicado' else 'baixa_confianca' end;
  insert into imobdesk.ch_ticket_ia_empreendimento (ticket_id, situacao, empreendimento_id, confianca, motivo, sugestoes, modelo, tokens_entrada, tokens_saida, ms)
  values (p_ticket, v_situacao, v_emp, v_conf, left(p ->> 'motivo', 300), v_sug, p ->> 'modelo',
          nullif(p ->> 'tokensEntrada', '')::int, nullif(p ->> 'tokensSaida', '')::int, nullif(p ->> 'ms', '')::int);

  v_nome := (select e.nome from imobdesk.ch_empreendimentos e where e.id = v_emp);
  if v_situacao = 'aplicado' then
    update imobdesk.ch_tickets set empreendimento_id = v_emp, empreendimento_origem = 'ia' where id = p_ticket;
  end if;
  insert into imobdesk.ch_ticket_eventos (ticket_id, tipo, descricao, autor_nome)
  values (p_ticket, 'ia',
          case when v_situacao = 'aplicado'
               then format('Empreendimento identificado pela IA (%s%%): %s', v_conf, v_nome)
               else format('Empreendimento incerto pela IA (%s%%)%s', v_conf, case when v_nome is not null then ': ' || v_nome else '' end) end
          || case when nullif(btrim(p ->> 'motivo'), '') is not null then ' — ' || left(btrim(p ->> 'motivo'), 200) else '' end,
          'IA');
  return jsonb_build_object('situacao', v_situacao, 'empreendimento', v_nome, 'confianca', v_conf);
end;
$$;

-- ---------- App do solicitante ----------

/** O setor pede o empreendimento no app? E a lista (ativos). */
create or replace function imobdesk.cd_setor_empreendimentos(p_setor bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform imobdesk.cd_quem(null);
  if not exists (select 1 from imobdesk.ch_empreendimento_config c where c.setor_id = p_setor and c.pedir_no_app) then
    return jsonb_build_object('pedir', false, 'lista', '[]'::jsonb);
  end if;
  return jsonb_build_object('pedir', true, 'lista', coalesce((
    select jsonb_agg(jsonb_build_object('id', e.id, 'nome', e.nome, 'apelidos', e.apelidos, 'cidade', e.cidade) order by lower(e.nome))
    from imobdesk.ch_empreendimentos e where e.ativo), '[]'));
end;
$$;

-- Igual à de 20261010100000, mais o empreendimento (obrigatório quando o setor pede no app).
create or replace function imobdesk.cd_ticket_criar(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.cd_quem(null);
  v_email text := imobdesk.cd_email_de(v_uid);
  v_pessoa bigint := imobdesk.cd_pessoa_de(v_uid);
  v_setor bigint := nullif(p ->> 'setorId', '')::bigint;
  v_servico bigint := nullif(p ->> 'servicoId', '')::bigint;
  v_emp bigint := nullif(p ->> 'empreendimentoId', '')::bigint;
  v_texto text := btrim(coalesce(p ->> 'descricao', ''));
  v_anexos jsonb := imobdesk.cd_anexos_validos(p -> 'anexos', v_uid);
  v_urg bigint;
  v_nome text;
  v_id bigint;
  t imobdesk.ch_tickets;
begin
  if v_pessoa is null then perform imobdesk.erro('INVALID_INPUT', 'Entre no app de novo para concluir o cadastro.'); end if;
  if not exists (select 1 from imobdesk.at_setores s where s.id = v_setor and s.ativo and s.cd_visivel) then
    perform imobdesk.erro('INVALID_INPUT', 'Escolha o departamento.', 'setorId');
  end if;
  if exists (select 1 from imobdesk.ch_empreendimento_config c where c.setor_id = v_setor and c.pedir_no_app) then
    if not exists (select 1 from imobdesk.ch_empreendimentos e where e.id = v_emp and e.ativo) then
      perform imobdesk.erro('INVALID_INPUT', 'Escolha o empreendimento.', 'empreendimentoId');
    end if;
  else
    v_emp := null;
  end if;
  if v_servico is not null and not exists (
       select 1 from imobdesk.ch_servicos s where s.id = v_servico and s.setor_id = v_setor and s.ativo and 'intranet' = any (s.canais)) then
    perform imobdesk.erro('INVALID_INPUT', 'Escolha o tipo de serviço de novo.', 'servicoId');
  end if;
  if length(v_texto) < 5 then perform imobdesk.erro('INVALID_INPUT', 'Descreva o que está acontecendo.', 'descricao'); end if;
  if length(v_texto) > 4000 then perform imobdesk.erro('INVALID_INPUT', 'A descrição passou de 4.000 caracteres.', 'descricao'); end if;
  if (select count(*) from imobdesk.ch_tickets x where x.criado_por = v_uid and x.origem = 'intranet' and x.criado_em > now() - interval '1 hour') >= 15 then
    perform imobdesk.erro('INVALID_INPUT', 'Muitos chamados em pouco tempo. Aguarde um pouco ou fale com a equipe.');
  end if;
  if (p ->> 'urgente')::boolean is true then
    select u.id into v_urg from imobdesk.ch_urgencias u where lower(u.nome) = 'alta' limit 1;
  end if;
  select pe.nome into v_nome from imobdesk.at_pessoas pe where pe.id = v_pessoa;

  insert into imobdesk.ch_tickets (assunto, origem, recebido_em, solicitante_pessoa_id, solicitante_nome, solicitante_contato, setor_id, servico_id,
                                             categoria_id, urgencia_id, status_id, criado_por, empreendimento_id, empreendimento_origem)
  values (left(regexp_replace(split_part(v_texto, E'\n', 1), '\s+', ' ', 'g'), 120), 'intranet', 'App do solicitante', v_pessoa, left(v_nome, 160), v_email, v_setor, v_servico,
          coalesce((select s.categoria_padrao_id from imobdesk.ch_servicos s where s.id = v_servico), (select c.id from imobdesk.ch_categorias c where c.padrao limit 1)),
          coalesce(v_urg, (select s.urgencia_padrao_id from imobdesk.ch_servicos s where s.id = v_servico), (select u.id from imobdesk.ch_urgencias u where u.padrao limit 1)),
          coalesce((select s.id from imobdesk.ch_status s where s.categoria = 'novo' and s.ativo order by s.ordem limit 1), 1),
          v_uid, v_emp, case when v_emp is not null then 'solicitante' end)
  returning * into t;
  v_id := t.id;

  insert into imobdesk.ch_ticket_acoes (ticket_id, numero, tipo, canal, direcao, autor_id, autor_nome, texto, anexos, envio_status)
  values (v_id, 1, 'publica', 'portal', 'entrada', v_uid, left(v_nome, 160), v_texto, v_anexos, 'nao_se_aplica');
  insert into imobdesk.cd_vistos (usuario_id, ticket_id) values (v_uid, v_id) on conflict do nothing;

  return jsonb_build_object('id', v_id, 'servico', imobdesk.cd_trilha(v_servico), 'slaRespostaAte', t.sla_resposta_ate,
                            'setor', (select s.nome from imobdesk.at_setores s where s.id = v_setor),
                            'empreendimento', (select e.nome from imobdesk.ch_empreendimentos e where e.id = v_emp));
end;
$$;

-- ---------- Lista de Tickets: coluna "Empreendimento" (igual à de 20261010120000, mais o empreendimento) ----------
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

do $$
declare
  f text;
begin
  foreach f in array array[
    'ch_empreendimentos_lista()', 'ch_empreendimento_salvar(jsonb)', 'ch_empreendimento_config_salvar(jsonb)',
    'ch_ticket_empreendimento(bigint)', 'ch_ticket_empreendimento_definir(bigint, bigint)', 'cd_setor_empreendimentos(bigint)',
    'cd_ticket_criar(jsonb)', 'ch_lista_extras()'
  ] loop
    execute format('revoke execute on function imobdesk.%s from public, anon', f);
    execute format('grant execute on function imobdesk.%s to authenticated, service_role', f);
  end loop;
  foreach f in array array['ch_ia_empreendimentos_pendentes(int)', 'ch_ia_empreendimento_registrar(bigint, jsonb)'] loop
    execute format('revoke execute on function imobdesk.%s from public, anon, authenticated', f);
    execute format('grant execute on function imobdesk.%s to service_role', f);
  end loop;
end;
$$;

notify pgrst, 'reload schema';

-- ======================================== 20261013100000_imobdesk_solucao_automatica.sql
-- "Solução aplicada" automática (Wagner, 13/10/2026): o agente não preenche mais o campo. Ao resolver ou fechar sem
-- solução, ela vem da última resposta ao solicitante (texto + nomes dos anexos); sem resposta pública, da última nota
-- interna. É a base de conhecimento (sugestões e App do solicitante), por isso o campo saiu da tela do ticket.
-- Só troca funções (create or replace); nenhum dado muda.

/** Texto da solução a partir das ações de saída do ticket: a resposta pública mais recente; senão a nota interna mais recente. */
create or replace function imobdesk.ch_solucao_da_resposta(p_ticket bigint)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select left(
           btrim(a.texto) ||
           coalesce(E'\n\nAnexos: ' || (select string_agg(coalesce(x ->> 'nome', x ->> 'name', x ->> 'arquivo', 'imagem'), ', ')
                                          from jsonb_array_elements(case when jsonb_typeof(a.anexos) = 'array' then a.anexos else '[]' end) x), ''),
           20000)
    from imobdesk.ch_ticket_acoes a
   where a.ticket_id = p_ticket and a.direcao = 'saida' and length(btrim(coalesce(a.texto, ''))) > 0
   order by (a.tipo = 'publica') desc, a.numero desc
   limit 1;
$$;

/**
 * Altera o ticket. Só as chaves enviadas mudam. Resolver ou fechar exige os campos obrigatórios; a "Solução aplicada",
 * se vazia, vem da última resposta ao solicitante (ch_solucao_da_resposta). Alterar o prazo à mão: gestor do setor,
 * Admin ou Super admin, com justificativa.
 */
create or replace function imobdesk.ch_ticket_atualizar(p_id bigint, p jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  t imobdesk.ch_tickets := imobdesk.ch_ticket_visivel(p_id);
  n imobdesk.ch_tickets;
  v_cat text;
  v_pend text[];
begin
  if t.excluido_em is not null then perform imobdesk.erro('INVALID_INPUT', 'Ticket excluído.'); end if;
  if t.mesclado_em_id is not null then perform imobdesk.erro('INVALID_INPUT', format('Este ticket foi mesclado em #%s.', t.mesclado_em_id)); end if;
  n := t;
  if p ? 'servicoId' then n.servico_id := nullif(p ->> 'servicoId', '')::bigint;
    if n.servico_id is not null then
      n.setor_id := (select s.setor_id from imobdesk.ch_servicos s where s.id = n.servico_id and s.ativo);
      if n.setor_id is null then perform imobdesk.erro('INVALID_INPUT', 'Serviço inválido.', 'servicoId'); end if;
      if not (p ? 'equipeId') then n.equipe_id := null; end if;   -- o gatilho põe a equipe do serviço
    end if;
  end if;
  if p ? 'categoriaId' then n.categoria_id := nullif(p ->> 'categoriaId', '')::bigint; end if;
  if p ? 'urgenciaId' then n.urgencia_id := coalesce(nullif(p ->> 'urgenciaId', '')::bigint, n.urgencia_id); end if;
  if p ? 'equipeId' then n.equipe_id := nullif(p ->> 'equipeId', '')::bigint; end if;
  if p ? 'responsavelId' then n.responsavel_id := nullif(p ->> 'responsavelId', '')::uuid; end if;
  if p ? 'statusId' then n.status_id := (p ->> 'statusId')::bigint; n.justificativa_id := nullif(p ->> 'justificativaId', '')::bigint; end if;
  if p ? 'tags' then n.tags := coalesce(array(select distinct btrim(x) from jsonb_array_elements_text(p -> 'tags') x where btrim(x) <> ''), '{}'); end if;
  if p ? 'cc' then n.cc := coalesce(array(select distinct lower(btrim(x)) from jsonb_array_elements_text(p -> 'cc') x where btrim(x) <> ''), '{}'); end if;
  if p ? 'campos' then n.campos := t.campos || coalesce(p -> 'campos', '{}'); end if;
  if p ? 'assunto' and length(btrim(p ->> 'assunto')) > 0 then n.assunto := btrim(p ->> 'assunto'); end if;
  if p ? 'solucaoAplicada' then n.solucao_aplicada := nullif(btrim(p ->> 'solucaoAplicada'), ''); end if;
  if p ? 'solicitantePessoaId' then
    n.solicitante_pessoa_id := nullif(p ->> 'solicitantePessoaId', '')::bigint;
    select pe.nome into n.solicitante_nome from imobdesk.at_pessoas pe where pe.id = n.solicitante_pessoa_id;
    if n.solicitante_nome is null then perform imobdesk.erro('INVALID_INPUT', 'Solicitante não encontrado.', 'solicitante'); end if;
  end if;
  if p ? 'slaSolucaoAte' then
    if not (imobdesk.ch_eh_admin() or imobdesk.at_gestor_de(t.setor_id)) then
      perform imobdesk.erro('FORBIDDEN', 'Só o gestor do setor, Admin ou Super admin alteram o prazo.');
    end if;
    if length(btrim(coalesce(p ->> 'slaJustificativa', ''))) < 5 then perform imobdesk.erro('INVALID_INPUT', 'Explique por que o prazo mudou.', 'slaJustificativa'); end if;
    n.sla_solucao_ate := (p ->> 'slaSolucaoAte')::timestamptz;
    n.sla_manual := true;
  end if;

  v_cat := (select s.categoria from imobdesk.ch_status s where s.id = n.status_id and s.ativo);
  if v_cat is null then perform imobdesk.erro('INVALID_INPUT', 'Status inválido.', 'statusId'); end if;
  if v_cat in ('resolvido', 'fechado') then
    v_pend := imobdesk.ch_campos_pendentes(n);
    if cardinality(v_pend) > 0 then
      perform imobdesk.erro('INVALID_INPUT', 'Preencha antes de resolver: ' || array_to_string(v_pend, ', ') || '.', 'campos');
    end if;
    if n.servico_id is null then perform imobdesk.erro('INVALID_INPUT', 'Escolha o serviço antes de resolver.', 'servicoId'); end if;
    if n.solucao_aplicada is null then n.solucao_aplicada := imobdesk.ch_solucao_da_resposta(p_id); end if;
    if n.solucao_aplicada is null then
      perform imobdesk.erro('INVALID_INPUT', 'Responda ao solicitante antes de resolver: o texto da resposta vira a solução aplicada.', 'texto');
    end if;
  end if;

  update imobdesk.ch_tickets set
    servico_id = n.servico_id, setor_id = n.setor_id, categoria_id = n.categoria_id, urgencia_id = n.urgencia_id, equipe_id = n.equipe_id,
    responsavel_id = n.responsavel_id, status_id = n.status_id, justificativa_id = n.justificativa_id, tags = n.tags, cc = n.cc, campos = n.campos,
    assunto = n.assunto, solucao_aplicada = n.solucao_aplicada, solicitante_pessoa_id = n.solicitante_pessoa_id, solicitante_nome = n.solicitante_nome,
    sla_solucao_ate = n.sla_solucao_ate, sla_manual = n.sla_manual
  where id = p_id;

  if p ? 'slaSolucaoAte' then
    insert into imobdesk.ch_ticket_eventos (ticket_id, tipo, descricao, autor_id, autor_nome)
    values (p_id, 'sla_justificativa', 'Motivo: ' || btrim(p ->> 'slaJustificativa'), (select auth.uid()), imobdesk.ch_nome_usuario((select auth.uid())));
  end if;
end;
$$;

-- Helper interno: só as funções do banco chamam.
revoke execute on function imobdesk.ch_solucao_da_resposta(bigint) from public, anon, authenticated;
grant execute on function imobdesk.ch_solucao_da_resposta(bigint) to service_role;

notify pgrst, 'reload schema';

-- ======================================== 20261013110000_imobdesk_solucao_automatica_gatilhos.sql
-- "Solução aplicada" automática também nos gatilhos (Wagner, 13/10/2026): resolver ou fechar por gatilho sem solução
-- usa a última resposta ao solicitante (ch_solucao_da_resposta, migration 20261013100000). Só troca a função.

/**
 * Aplica as ações do gatilho no ticket e devolve o resumo. Resolver ou fechar segue as mesmas regras do agente
 * (serviço e obrigatórios); sem solução aplicada, usa a última resposta. Se faltar algo, a execução fica como "erro".
 */
create or replace function imobdesk.ch_gatilho_aplicar(p_ticket bigint, g imobdesk.ch_gatilhos)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  t imobdesk.ch_tickets;
  n imobdesk.ch_tickets;
  a jsonb;
  v_feito text[] := '{}';
  v_cat text;
  v_pend text[];
  v_lider uuid;
  v_texto text;
  v_canal text;
  v_num int;
  v_quem uuid[];
begin
  select * into t from imobdesk.ch_tickets x where x.id = p_ticket for update;
  n := t;
  for a in select * from jsonb_array_elements(g.acoes) loop
    v_lider := (select e.lider_id from imobdesk.at_equipes e where e.id = n.equipe_id);
    case a ->> 'tipo'
      when 'status' then
        n.status_id := (a ->> 'statusId')::bigint;
        n.justificativa_id := nullif(a ->> 'justificativaId', '')::bigint;
        v_feito := array_append(v_feito, ('status → ' || coalesce((select s.nome from imobdesk.ch_status s where s.id = n.status_id), '?'))::text);
      when 'equipe' then
        n.equipe_id := nullif(a ->> 'equipeId', '')::bigint;
        v_feito := array_append(v_feito, ('equipe → ' || coalesce((select e.nome from imobdesk.at_equipes e where e.id = n.equipe_id), 'nenhuma'))::text);
      when 'responsavel' then
        n.responsavel_id := case a ->> 'modo'
          when 'pessoa' then nullif(a ->> 'usuarioId', '')::uuid
          when 'lider' then v_lider
          else null end;
        v_feito := array_append(v_feito, ('responsável → ' || coalesce((select u.nome from imobdesk.usuarios u where u.id = n.responsavel_id), 'ninguém'))::text);
      when 'urgencia' then
        n.urgencia_id := coalesce(nullif(a ->> 'urgenciaId', '')::bigint, n.urgencia_id);
        v_feito := array_append(v_feito, ('urgência → ' || (select u.nome from imobdesk.ch_urgencias u where u.id = n.urgencia_id))::text);
      when 'categoria' then
        n.categoria_id := nullif(a ->> 'categoriaId', '')::bigint;
        v_feito := array_append(v_feito, ('categoria → ' || coalesce((select c.nome from imobdesk.ch_categorias c where c.id = n.categoria_id), 'nenhuma'))::text);
      when 'servico' then
        n.servico_id := nullif(a ->> 'servicoId', '')::bigint;
        if n.servico_id is not null then
          n.setor_id := coalesce((select s.setor_id from imobdesk.ch_servicos s where s.id = n.servico_id and s.ativo), n.setor_id);
          n.equipe_id := null;   -- o trigger põe a equipe do serviço
        end if;
        v_feito := array_append(v_feito, ('serviço → ' || coalesce((select s.nome from imobdesk.ch_servicos s where s.id = n.servico_id), 'nenhum'))::text);
      when 'tags_adicionar' then
        n.tags := array(select distinct x from unnest(n.tags || array(select btrim(y) from jsonb_array_elements_text(coalesce(a -> 'tags', '[]')) y where btrim(y) <> '')) x);
        v_feito := array_append(v_feito, 'tags adicionadas'::text);
      when 'tags_remover' then
        n.tags := array(select x from unnest(n.tags) x where not x = any (array(select btrim(y) from jsonb_array_elements_text(coalesce(a -> 'tags', '[]')) y)));
        v_feito := array_append(v_feito, 'tags removidas'::text);
      when 'campo' then
        n.campos := n.campos || jsonb_build_object(a ->> 'chave', a -> 'valor');
        v_feito := array_append(v_feito, ('campo ' || (a ->> 'chave'))::text);
      when 'solucao' then
        if n.solucao_aplicada is null then
          n.solucao_aplicada := nullif(btrim(a ->> 'texto'), '');
          v_feito := array_append(v_feito, 'solução aplicada preenchida'::text);
        end if;
      when 'nota_interna' then
        v_num := coalesce((select max(x.numero) from imobdesk.ch_ticket_acoes x where x.ticket_id = p_ticket), 0) + 1;
        insert into imobdesk.ch_ticket_acoes (ticket_id, numero, tipo, canal, direcao, autor_nome, texto, envio_status)
        values (p_ticket, v_num, 'interna', 'portal', 'saida', 'Gatilho: ' || g.nome, coalesce(nullif(btrim(a ->> 'texto'), ''), g.nome), 'nao_se_aplica');
        v_feito := array_append(v_feito, 'nota interna'::text);
      when 'responder_macro' then
        select m.texto into v_texto from imobdesk.ch_macros m where m.id = nullif(a ->> 'macroId', '')::bigint and m.ativa;
        if v_texto is null then perform imobdesk.erro('INVALID_INPUT', 'A macro da resposta não existe ou está inativa.'); end if;
        v_texto := replace(replace(replace(v_texto,
                     '{{solicitante.nome}}', split_part(btrim(n.solicitante_nome), ' ', 1)),
                     '{{ticket.numero}}', n.id::text),
                     '{{agente.nome}}', coalesce((select u.nome from imobdesk.usuarios u where u.id = n.responsavel_id), 'Equipe de atendimento'));
        v_canal := case when n.origem in ('email', 'whatsapp') then n.origem else 'portal' end;
        v_num := coalesce((select max(x.numero) from imobdesk.ch_ticket_acoes x where x.ticket_id = p_ticket), 0) + 1;
        insert into imobdesk.ch_ticket_acoes (ticket_id, numero, tipo, canal, direcao, autor_nome, texto, envio_status)
        values (p_ticket, v_num, 'publica', v_canal, 'saida', 'Gatilho: ' || g.nome, v_texto, case when v_canal in ('email', 'whatsapp') then 'pendente' else 'nao_se_aplica' end);
        if n.primeira_resposta_em is null then n.primeira_resposta_em := now(); end if;
        v_feito := array_append(v_feito, 'resposta ao solicitante'::text);
      when 'seguidor' then
        insert into imobdesk.ch_ticket_seguidores (ticket_id, usuario_id)
        select p_ticket, u from (select case a ->> 'modo' when 'lider' then v_lider when 'responsavel' then n.responsavel_id else nullif(a ->> 'usuarioId', '')::uuid end u) s
         where u is not null
        on conflict do nothing;
        v_feito := array_append(v_feito, 'seguidor'::text);
      when 'avisar' then
        v_quem := case a ->> 'quem'
          when 'responsavel' then array[n.responsavel_id]
          when 'lider' then array[v_lider]
          when 'seguidores' then array(select s.usuario_id from imobdesk.ch_ticket_seguidores s where s.ticket_id = p_ticket)
          when 'equipe' then array(select m.usuario_id from imobdesk.at_equipe_membros m where m.equipe_id = n.equipe_id)
          when 'pessoa' then array[nullif(a ->> 'usuarioId', '')::uuid]
          else '{}'::uuid[] end;
        perform imobdesk.ch_notificar(v_quem, p_ticket, format('Ticket #%s: %s', n.id, n.assunto), coalesce(nullif(btrim(a ->> 'texto'), ''), g.nome));
        v_feito := array_append(v_feito, ('aviso (' || coalesce(a ->> 'quem', '?') || ')')::text);
      else
        perform imobdesk.erro('INVALID_INPUT', format('Ação desconhecida: %s', a ->> 'tipo'));
    end case;
  end loop;

  v_cat := (select s.categoria from imobdesk.ch_status s where s.id = n.status_id and s.ativo);
  if v_cat is null then perform imobdesk.erro('INVALID_INPUT', 'Status do gatilho inválido ou inativo.'); end if;
  if v_cat in ('resolvido', 'fechado') and t.status_id is distinct from n.status_id then
    v_pend := imobdesk.ch_campos_pendentes(n);
    if cardinality(v_pend) > 0 then perform imobdesk.erro('INVALID_INPUT', 'Para resolver falta: ' || array_to_string(v_pend, ', ') || '.'); end if;
    if n.servico_id is null then perform imobdesk.erro('INVALID_INPUT', 'Para resolver falta o serviço.'); end if;
    if n.solucao_aplicada is null then n.solucao_aplicada := imobdesk.ch_solucao_da_resposta(p_ticket); end if;
    if n.solucao_aplicada is null then perform imobdesk.erro('INVALID_INPUT', 'Para resolver falta uma resposta ao solicitante (vira a "Solução aplicada").'); end if;
  end if;

  update imobdesk.ch_tickets set
    servico_id = n.servico_id, setor_id = n.setor_id, categoria_id = n.categoria_id, urgencia_id = n.urgencia_id, equipe_id = n.equipe_id,
    responsavel_id = n.responsavel_id, status_id = n.status_id, justificativa_id = n.justificativa_id, tags = n.tags, campos = n.campos,
    solucao_aplicada = n.solucao_aplicada, primeira_resposta_em = n.primeira_resposta_em
  where id = p_ticket
    and (servico_id, setor_id, categoria_id, urgencia_id, equipe_id, responsavel_id, status_id, justificativa_id, tags, campos, solucao_aplicada, primeira_resposta_em)
        is distinct from (n.servico_id, n.setor_id, n.categoria_id, n.urgencia_id, n.equipe_id, n.responsavel_id, n.status_id, n.justificativa_id, n.tags, n.campos, n.solucao_aplicada, n.primeira_resposta_em);

  return array_to_string(v_feito, '; ');
end;
$$;

notify pgrst, 'reload schema';

-- ======================================== 20261013120000_imobdesk_solicitante_tipo_urgencia.sql
-- App do solicitante: "É urgente?" virou "Tipo urgência" (Wagner, 13/10/2026), com 4 respostas ligadas ao cadastro de urgências:
--   normal → urgência do serviço (ou a padrão) · prazo ("Tenho prazo") → Alta · grave → Alta · parado ("Estou parado") → Urgente.
-- A resposta também vira tag do ticket (tenho-prazo, grave, estou-parado) para a equipe distinguir. O app antigo ainda
-- manda {urgente: true}: continua indo para Alta. Igual à de 20261012100000, só muda a urgência e as tags.

create or replace function imobdesk.cd_ticket_criar(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.cd_quem(null);
  v_email text := imobdesk.cd_email_de(v_uid);
  v_pessoa bigint := imobdesk.cd_pessoa_de(v_uid);
  v_setor bigint := nullif(p ->> 'setorId', '')::bigint;
  v_servico bigint := nullif(p ->> 'servicoId', '')::bigint;
  v_emp bigint := nullif(p ->> 'empreendimentoId', '')::bigint;
  v_texto text := btrim(coalesce(p ->> 'descricao', ''));
  v_anexos jsonb := imobdesk.cd_anexos_validos(p -> 'anexos', v_uid);
  v_urg bigint;
  v_tipo text := lower(coalesce(nullif(p ->> 'urgencia', ''), case when (p ->> 'urgente')::boolean is true then 'legado' else 'normal' end));
  v_nome text;
  v_id bigint;
  t imobdesk.ch_tickets;
begin
  if v_pessoa is null then perform imobdesk.erro('INVALID_INPUT', 'Entre no app de novo para concluir o cadastro.'); end if;
  if not exists (select 1 from imobdesk.at_setores s where s.id = v_setor and s.ativo and s.cd_visivel) then
    perform imobdesk.erro('INVALID_INPUT', 'Escolha o departamento.', 'setorId');
  end if;
  if exists (select 1 from imobdesk.ch_empreendimento_config c where c.setor_id = v_setor and c.pedir_no_app) then
    if not exists (select 1 from imobdesk.ch_empreendimentos e where e.id = v_emp and e.ativo) then
      perform imobdesk.erro('INVALID_INPUT', 'Escolha o empreendimento.', 'empreendimentoId');
    end if;
  else
    v_emp := null;
  end if;
  if v_servico is not null and not exists (
       select 1 from imobdesk.ch_servicos s where s.id = v_servico and s.setor_id = v_setor and s.ativo and 'intranet' = any (s.canais)) then
    perform imobdesk.erro('INVALID_INPUT', 'Escolha o tipo de serviço de novo.', 'servicoId');
  end if;
  if length(v_texto) < 5 then perform imobdesk.erro('INVALID_INPUT', 'Descreva o que está acontecendo.', 'descricao'); end if;
  if length(v_texto) > 4000 then perform imobdesk.erro('INVALID_INPUT', 'A descrição passou de 4.000 caracteres.', 'descricao'); end if;
  if (select count(*) from imobdesk.ch_tickets x where x.criado_por = v_uid and x.origem = 'intranet' and x.criado_em > now() - interval '1 hour') >= 15 then
    perform imobdesk.erro('INVALID_INPUT', 'Muitos chamados em pouco tempo. Aguarde um pouco ou fale com a equipe.');
  end if;
  if v_tipo not in ('normal', 'prazo', 'grave', 'parado', 'legado') then
    perform imobdesk.erro('INVALID_INPUT', 'Escolha o tipo de urgência.', 'urgencia');
  end if;
  if v_tipo <> 'normal' then
    select u.id into v_urg from imobdesk.ch_urgencias u
     where lower(u.nome) = case when v_tipo = 'parado' then 'urgente' else 'alta' end and u.ativa limit 1;
  end if;
  select pe.nome into v_nome from imobdesk.at_pessoas pe where pe.id = v_pessoa;

  insert into imobdesk.ch_tickets (assunto, origem, recebido_em, solicitante_pessoa_id, solicitante_nome, solicitante_contato, setor_id, servico_id,
                                             categoria_id, urgencia_id, status_id, criado_por, empreendimento_id, empreendimento_origem, tags)
  values (left(regexp_replace(split_part(v_texto, E'\n', 1), '\s+', ' ', 'g'), 120), 'intranet', 'App do solicitante', v_pessoa, left(v_nome, 160), v_email, v_setor, v_servico,
          coalesce((select s.categoria_padrao_id from imobdesk.ch_servicos s where s.id = v_servico), (select c.id from imobdesk.ch_categorias c where c.padrao limit 1)),
          coalesce(v_urg, (select s.urgencia_padrao_id from imobdesk.ch_servicos s where s.id = v_servico), (select u.id from imobdesk.ch_urgencias u where u.padrao limit 1)),
          coalesce((select s.id from imobdesk.ch_status s where s.categoria = 'novo' and s.ativo order by s.ordem limit 1), 1),
          v_uid, v_emp, case when v_emp is not null then 'solicitante' end,
          case v_tipo when 'prazo' then array['tenho-prazo'] when 'grave' then array['grave'] when 'parado' then array['estou-parado'] else '{}'::text[] end)
  returning * into t;
  v_id := t.id;

  insert into imobdesk.ch_ticket_acoes (ticket_id, numero, tipo, canal, direcao, autor_id, autor_nome, texto, anexos, envio_status)
  values (v_id, 1, 'publica', 'portal', 'entrada', v_uid, left(v_nome, 160), v_texto, v_anexos, 'nao_se_aplica');
  insert into imobdesk.cd_vistos (usuario_id, ticket_id) values (v_uid, v_id) on conflict do nothing;

  return jsonb_build_object('id', v_id, 'servico', imobdesk.cd_trilha(v_servico), 'slaRespostaAte', t.sla_resposta_ate,
                            'setor', (select s.nome from imobdesk.at_setores s where s.id = v_setor),
                            'empreendimento', (select e.nome from imobdesk.ch_empreendimentos e where e.id = v_emp));
end;
$$;

notify pgrst, 'reload schema';

-- ======================================== 20261013130000_imobdesk_solicitante_tecnico.sql
-- App do solicitante · modo Técnico (mockup docs/mockups/app-solicitante-tecnico.html, aprovado pelo Wagner em 13/10/2026).
--   D1 só membros de uma equipe de setor com "técnico no app" (hoje o CFTV);
--   D2 o técnico vê todos os chamados do setor e registra atendimento só nos dele;
--   D4 sem agendamento: data e hora do cartão = abertura e prazo do SLA (automático);
--   D5 pelo menos 1 foto para Resolvido; D6 o tipo de resolução define o status e o texto vira a Solução aplicada.
-- Aditiva: 1 coluna nova, funções novas e 1 policy nova de leitura no bucket imobdesk-solicitante.

alter table imobdesk.at_setores add column if not exists cd_tecnico boolean not null default false;
comment on column imobdesk.at_setores.cd_tecnico is 'App do solicitante: os membros das equipes do setor entram no app pela aba Técnico.';
update imobdesk.at_setores set cd_tecnico = true where lower(btrim(nome)) = 'cftv' and not cd_tecnico;

-- ======================================================================= helpers

/** Setores em que o usuário é técnico no app (membro de equipe ativa de setor ativo com cd_tecnico). */
create or replace function imobdesk.cd_tec_setores(p_usuario uuid)
returns bigint[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(distinct s.id), '{}')
    from imobdesk.at_equipe_membros m
    join imobdesk.at_equipes e on e.id = m.equipe_id and e.ativa
    join imobdesk.at_setores s on s.id = e.setor_id and s.ativo and s.cd_tecnico
   where m.usuario_id = p_usuario;
$$;

/** Usuário da sessão, se for técnico; senão erro. */
create or replace function imobdesk.cd_tec_quem()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.cd_quem(null);
begin
  if cardinality(imobdesk.cd_tec_setores(v_uid)) = 0 then
    perform imobdesk.erro('FORBIDDEN', format('Seu usuário não está numa equipe do %s. Entre como Colaborador ou peça à TI para incluir você na equipe.',
      coalesce((select string_agg(s.nome, ', ' order by s.nome) from imobdesk.at_setores s where s.ativo and s.cd_tecnico), 'setor técnico')));
  end if;
  return v_uid;
end;
$$;

/** Ticket de um setor em que o usuário é técnico. */
create or replace function imobdesk.cd_tec_ticket(p_id bigint, p_usuario uuid)
returns imobdesk.ch_tickets
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  t imobdesk.ch_tickets;
begin
  select * into t from imobdesk.ch_tickets x
   where x.id = p_id and x.excluido_em is null and x.setor_id = any (imobdesk.cd_tec_setores(p_usuario));
  if t.id is null then perform imobdesk.erro('NOT_FOUND', 'Chamado não encontrado.'); end if;
  return t;
end;
$$;

/** Telefone do solicitante: WhatsApp/telefone do cadastro da pessoa; senão o contato do ticket, se for número. */
create or replace function imobdesk.cd_tec_telefone(t imobdesk.ch_tickets)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select c.valor from imobdesk.at_pessoa_contatos c where c.pessoa_id = t.solicitante_pessoa_id and c.tipo in ('whatsapp', 'telefone')
      order by c.principal desc, (c.tipo = 'whatsapp') desc, c.id limit 1),
    case when t.solicitante_contato ~ '^\+?[0-9 ()-]{8,}$' then t.solicitante_contato end);
$$;

/** Resumo do ticket para a lista e o detalhe do técnico. */
create or replace function imobdesk.cd_tec_resumo(t imobdesk.ch_tickets, p_usuario uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', t.id, 'assunto', t.assunto, 'origem', t.origem,
    'servico', imobdesk.cd_trilha(t.servico_id),
    'status', imobdesk.cd_status_json(t.status_id),
    'justificativa', (select j.nome from imobdesk.ch_status_justificativas j where j.id = t.justificativa_id),
    'urgencia', (select u.nome from imobdesk.ch_urgencias u where u.id = t.urgencia_id),
    'tags', to_jsonb(t.tags),
    'empreendimento', (select e.nome from imobdesk.ch_empreendimentos e where e.id = t.empreendimento_id),
    'solicitante', t.solicitante_nome,
    'telefone', imobdesk.cd_tec_telefone(t),
    'criadoEm', t.criado_em, 'slaSolucaoAte', t.sla_solucao_ate, 'slaPausadoDesde', t.sla_pausado_desde, 'encerradoEm', t.encerrado_em,
    'responsavelId', t.responsavel_id,
    'responsavel', (select u.nome from imobdesk.usuarios u where u.id = t.responsavel_id),
    'meu', coalesce(t.responsavel_id = p_usuario, false));
$$;

-- ======================================================================= RPCs do app (modo Técnico)

/** Entrada pela aba Técnico. */
create or replace function imobdesk.cd_tec_entrar()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.cd_tec_quem();
  v_setores bigint[] := imobdesk.cd_tec_setores(v_uid);
begin
  return jsonb_build_object(
    'usuarioId', v_uid,
    'nome', coalesce((select u.nome from imobdesk.usuarios u where u.id = v_uid), imobdesk.cd_email_de(v_uid)),
    'email', imobdesk.cd_email_de(v_uid),
    'setores', (select jsonb_agg(jsonb_build_object('id', s.id, 'nome', s.nome) order by s.nome) from imobdesk.at_setores s where s.id = any (v_setores)));
end;
$$;

/** Chamados dos setores do técnico: todos os abertos e os encerrados nos últimos p_dias (padrão 30). Os filtros são na tela. */
create or replace function imobdesk.cd_tec_chamados(p_dias int default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.cd_tec_quem();
  v_setores bigint[] := imobdesk.cd_tec_setores(v_uid);
begin
  return coalesce((
    select jsonb_agg(imobdesk.cd_tec_resumo(t, v_uid) order by (t.encerrado_em is not null), t.sla_solucao_ate nulls last, t.id desc)
      from (select * from imobdesk.ch_tickets x
             where x.setor_id = any (v_setores) and x.excluido_em is null and x.mesclado_em_id is null
               and (x.encerrado_em is null or x.encerrado_em >= now() - make_interval(days => least(greatest(coalesce(p_dias, 30), 1), 180)))
             order by x.id desc limit 500) t), '[]');
end;
$$;

/** Detalhe para o técnico. */
create or replace function imobdesk.cd_tec_chamado(p_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.cd_tec_quem();
  t imobdesk.ch_tickets := imobdesk.cd_tec_ticket(p_id, v_uid);
  v_cat text := (select s.categoria from imobdesk.ch_status s where s.id = t.status_id);
  v_aberto boolean := v_cat not in ('resolvido', 'fechado', 'cancelado') and t.mesclado_em_id is null;
begin
  return imobdesk.cd_tec_resumo(t, v_uid) || jsonb_build_object(
    'setor', (select s.nome from imobdesk.at_setores s where s.id = t.setor_id),
    'servicoId', t.servico_id,
    'local', (select jsonb_build_object('nome', e.nome, 'cidade', e.cidade, 'endereco', e.endereco, 'observacao', e.observacao)
                from imobdesk.ch_empreendimentos e where e.id = t.empreendimento_id),
    'email', (select c.valor from imobdesk.at_pessoa_contatos c where c.pessoa_id = t.solicitante_pessoa_id and c.tipo = 'email' order by c.principal desc, c.id limit 1),
    'solucao', t.solucao_aplicada,
    'podeAtribuir', v_aberto and t.responsavel_id is null,
    'podeAtender', v_aberto and coalesce(t.responsavel_id = v_uid, false),
    -- Sem serviço (ex.: "Outro assunto"), o técnico escolhe ao concluir: Resolvido exige serviço.
    'servicos', case when t.servico_id is null then coalesce((
        select jsonb_agg(jsonb_build_object('id', s.id, 'rotulo', imobdesk.cd_trilha(s.id)) order by imobdesk.cd_trilha(s.id))
          from imobdesk.ch_servicos s
         where s.setor_id = t.setor_id and s.ativo and not exists (select 1 from imobdesk.ch_servicos f where f.pai_id = s.id and f.ativo)), '[]') end,
    'acoes', coalesce((select jsonb_agg(jsonb_build_object('numero', a.numero, 'direcao', a.direcao, 'autorNome', a.autor_nome, 'texto', a.texto,
                                                           'anexos', a.anexos, 'criadoEm', a.criado_em) order by a.criado_em, a.numero)
                         from imobdesk.ch_ticket_acoes a where a.ticket_id = t.id and a.tipo = 'publica'), '[]'),
    'eventos', coalesce((select jsonb_agg(jsonb_build_object('tipo', e.tipo, 'criadoEm', e.criado_em, 'autorNome', e.autor_nome,
                                                             'descricao', case e.tipo
                                                               when 'criado' then 'Chamado aberto'
                                                               when 'status' then 'Status: ' || coalesce((select s.nome from imobdesk.ch_status s where s.id = (e.para ->> 'statusId')::bigint), '—')
                                                               else e.descricao end) order by e.criado_em desc)
                           from imobdesk.ch_ticket_eventos e where e.ticket_id = t.id and e.tipo in ('criado', 'status', 'responsavel')), '[]'));
end;
$$;

/** Atribuir-me: só sem responsável. Fica com o técnico, na equipe dele do setor, e vai para Em atendimento. */
create or replace function imobdesk.cd_tec_atribuir(p_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.cd_tec_quem();
  t imobdesk.ch_tickets := imobdesk.cd_tec_ticket(p_id, v_uid);
  v_cat text := (select s.categoria from imobdesk.ch_status s where s.id = t.status_id);
  v_equipe bigint;
begin
  perform 1 from imobdesk.ch_tickets x where x.id = p_id for update;
  select * into t from imobdesk.ch_tickets x where x.id = p_id;
  if v_cat in ('resolvido', 'fechado', 'cancelado') or t.mesclado_em_id is not null then
    perform imobdesk.erro('INVALID_INPUT', 'Este chamado já foi encerrado.');
  end if;
  if t.responsavel_id = v_uid then return; end if;
  if t.responsavel_id is not null then
    perform imobdesk.erro('INVALID_INPUT', format('Este chamado já está com %s.', coalesce((select u.nome from imobdesk.usuarios u where u.id = t.responsavel_id), 'outro técnico')));
  end if;
  -- A equipe atual, se o técnico for dela; senão uma equipe dele no setor.
  v_equipe := case when exists (select 1 from imobdesk.at_equipe_membros m where m.equipe_id = t.equipe_id and m.usuario_id = v_uid) then t.equipe_id
                   else (select e.id from imobdesk.at_equipe_membros m join imobdesk.at_equipes e on e.id = m.equipe_id and e.ativa
                          where m.usuario_id = v_uid and e.setor_id = t.setor_id order by e.id limit 1) end;
  update imobdesk.ch_tickets set
    responsavel_id = v_uid, equipe_id = coalesce(v_equipe, equipe_id),
    status_id = case when v_cat in ('novo', 'pendente')
                     then coalesce((select s.id from imobdesk.ch_status s where s.categoria = 'andamento' and s.ativo and lower(s.nome) = 'em atendimento' limit 1),
                                   (select s.id from imobdesk.ch_status s where s.categoria = 'andamento' and s.ativo order by s.ordem limit 1), status_id)
                     else status_id end,
    justificativa_id = case when v_cat in ('novo', 'pendente') then null else justificativa_id end
  where id = p_id;
end;
$$;

/**
 * Concluir atendimento: resposta pública ao solicitante (texto + fotos) e o status pelo tipo de resolução.
 *   resolvido → Resolvido (exige 1 foto, serviço e obrigatórios; o texto vira a Solução aplicada)
 *   voltar → Em atendimento · peca → Aguardando·Fornecedor · orcamento → Aguardando·Cotação
 *   aprovacao → Aguardando·Aprovação do gestor (avisa o líder da equipe) · sem_acesso → Aguardando·Retorno do cliente
 *   nao_procede → Cancelado
 */
create or replace function imobdesk.cd_tec_concluir(p_id bigint, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.cd_tec_quem();
  t imobdesk.ch_tickets := imobdesk.cd_tec_ticket(p_id, v_uid);
  n imobdesk.ch_tickets;
  v_tipo text := coalesce(p ->> 'tipo', '');
  v_texto text := btrim(coalesce(p ->> 'texto', ''));
  v_fotos jsonb := imobdesk.cd_anexos_validos(p -> 'fotos', v_uid);
  v_servico bigint := nullif(p ->> 'servicoId', '')::bigint;
  v_cat text;
  v_just text;
  v_status bigint;
  v_justificativa bigint;
  v_pend text[];
  v_canal text;
  v_num int;
  v_nome text := coalesce((select u.nome from imobdesk.usuarios u where u.id = v_uid), 'Técnico');
begin
  perform 1 from imobdesk.ch_tickets x where x.id = p_id for update;
  select * into t from imobdesk.ch_tickets x where x.id = p_id;
  if t.responsavel_id is distinct from v_uid then perform imobdesk.erro('FORBIDDEN', 'Só o técnico responsável registra o atendimento. Use "Atribuir-me" primeiro.'); end if;
  if (select s.categoria from imobdesk.ch_status s where s.id = t.status_id) in ('resolvido', 'fechado', 'cancelado') or t.mesclado_em_id is not null then
    perform imobdesk.erro('INVALID_INPUT', 'Este chamado já foi encerrado.');
  end if;
  if v_tipo not in ('resolvido', 'voltar', 'peca', 'orcamento', 'aprovacao', 'sem_acesso', 'nao_procede') then
    perform imobdesk.erro('INVALID_INPUT', 'Escolha o tipo de resolução.', 'tipo');
  end if;
  if length(v_texto) < 5 then perform imobdesk.erro('INVALID_INPUT', 'Escreva o que foi feito.', 'texto'); end if;
  if length(v_texto) > 4000 then perform imobdesk.erro('INVALID_INPUT', 'O texto passou de 4.000 caracteres.', 'texto'); end if;
  if v_tipo = 'resolvido' and jsonb_array_length(v_fotos) = 0 then
    perform imobdesk.erro('INVALID_INPUT', 'Tire pelo menos 1 foto do atendimento para concluir como Resolvido.', 'fotos');
  end if;

  v_cat := case v_tipo when 'resolvido' then 'resolvido' when 'voltar' then 'andamento' when 'nao_procede' then 'cancelado' else 'pendente' end;
  v_just := case v_tipo when 'peca' then 'fornecedor' when 'orcamento' then 'cotação' when 'aprovacao' then 'aprovação do gestor' when 'sem_acesso' then 'retorno do cliente' end;
  if v_cat = 'pendente' then
    select j.status_id, j.id into v_status, v_justificativa
      from imobdesk.ch_status_justificativas j join imobdesk.ch_status s on s.id = j.status_id and s.ativo and s.categoria = 'pendente'
     where j.ativa and lower(btrim(j.nome)) = v_just order by s.ordem, j.ordem limit 1;
    v_status := coalesce(v_status, (select s.id from imobdesk.ch_status s where s.categoria = 'pendente' and s.ativo order by s.ordem limit 1));
  elsif v_cat = 'andamento' then
    v_status := t.status_id;
    v_justificativa := t.justificativa_id;
    if (select s.categoria from imobdesk.ch_status s where s.id = t.status_id) <> 'andamento' then
      v_status := coalesce((select s.id from imobdesk.ch_status s where s.categoria = 'andamento' and s.ativo and lower(s.nome) = 'em atendimento' limit 1),
                           (select s.id from imobdesk.ch_status s where s.categoria = 'andamento' and s.ativo order by s.ordem limit 1));
      v_justificativa := null;
    end if;
  else
    v_status := (select s.id from imobdesk.ch_status s where s.categoria = v_cat and s.ativo order by s.ordem limit 1);
  end if;
  if v_status is null then perform imobdesk.erro('INVALID_INPUT', 'Status de destino não cadastrado. Fale com a TI.'); end if;

  n := t;
  n.status_id := v_status;
  n.justificativa_id := v_justificativa;
  if v_servico is not null and v_servico is distinct from t.servico_id then
    if not exists (select 1 from imobdesk.ch_servicos s where s.id = v_servico and s.setor_id = t.setor_id and s.ativo) then
      perform imobdesk.erro('INVALID_INPUT', 'Escolha o serviço de novo.', 'servicoId');
    end if;
    n.servico_id := v_servico;
  end if;
  if v_cat = 'resolvido' then
    if n.servico_id is null then perform imobdesk.erro('INVALID_INPUT', 'Escolha o serviço antes de concluir como Resolvido.', 'servicoId'); end if;
    v_pend := imobdesk.ch_campos_pendentes(n);
    if cardinality(v_pend) > 0 then
      perform imobdesk.erro('INVALID_INPUT', 'Falta preencher no portal: ' || array_to_string(v_pend, ', ') || '. Peça ao gestor.', 'campos');
    end if;
    n.solucao_aplicada := coalesce(n.solucao_aplicada, left(v_texto, 20000));
  end if;

  -- Resposta ao solicitante pelo canal do ticket (como ch_ticket_acao).
  v_canal := case when t.origem in ('email', 'whatsapp') then t.origem else 'portal' end;
  v_num := coalesce((select max(a.numero) from imobdesk.ch_ticket_acoes a where a.ticket_id = p_id), 0) + 1;
  insert into imobdesk.ch_ticket_acoes (ticket_id, numero, tipo, canal, direcao, autor_id, autor_nome, texto, anexos, envio_status)
  values (p_id, v_num, 'publica', v_canal, 'saida', v_uid, v_nome, v_texto, v_fotos,
          case when v_canal in ('email', 'whatsapp') then 'pendente' else 'nao_se_aplica' end);

  update imobdesk.ch_tickets set
    status_id = n.status_id, justificativa_id = n.justificativa_id, servico_id = n.servico_id,
    solucao_aplicada = n.solucao_aplicada, primeira_resposta_em = coalesce(primeira_resposta_em, now())
  where id = p_id;

  if v_tipo = 'aprovacao' then
    perform imobdesk.ch_notificar(array[(select e.lider_id from imobdesk.at_equipes e where e.id = t.equipe_id)], p_id,
      format('Ticket #%s precisa de aprovação', p_id), format('%s: %s', v_nome, left(v_texto, 300)));
  end if;

  return jsonb_build_object('status', (select s.nome from imobdesk.ch_status s where s.id = n.status_id),
                            'justificativa', (select j.nome from imobdesk.ch_status_justificativas j where j.id = n.justificativa_id));
end;
$$;

-- ======================================================================= arquivos

/**
 * Leitura de arquivos do bucket imobdesk-solicitante citados em ações públicas: o solicitante do chamado (fotos do técnico)
 * e os técnicos do setor (fotos do solicitante). Usada pela policy de leitura abaixo.
 */
create or replace function imobdesk.cd_pode_ler_arquivo(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select imobdesk.cd_sessao_ok() and exists (
    select 1
      from imobdesk.ch_ticket_acoes a
      join imobdesk.ch_tickets t on t.id = a.ticket_id and t.excluido_em is null
     where a.tipo = 'publica'
       and a.anexos @> jsonb_build_array(jsonb_build_object('path', p_name))
       and (t.setor_id = any (imobdesk.cd_tec_setores((select auth.uid())))
            or (t.origem = 'intranet' and t.criado_por = (select auth.uid()))
            or t.solicitante_pessoa_id = imobdesk.cd_pessoa_de((select auth.uid()))));
$$;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'imobdesk-solicitante: leitura pelo chamado') then
    create policy "imobdesk-solicitante: leitura pelo chamado" on storage.objects for select to authenticated
      using (bucket_id = 'imobdesk-solicitante' and (select imobdesk.cd_pode_ler_arquivo(name)));
  end if;
end;
$$;

-- ======================================================================= permissões

do $$
declare
  f text;
begin
  foreach f in array array['cd_tec_entrar()', 'cd_tec_chamados(int)', 'cd_tec_chamado(bigint)', 'cd_tec_atribuir(bigint)', 'cd_tec_concluir(bigint, jsonb)', 'cd_pode_ler_arquivo(text)'] loop
    execute format('revoke execute on function imobdesk.%s from public, anon', f);
    execute format('grant execute on function imobdesk.%s to authenticated, service_role', f);
  end loop;
  foreach f in array array['cd_tec_setores(uuid)', 'cd_tec_quem()', 'cd_tec_ticket(bigint, uuid)', 'cd_tec_telefone(imobdesk.ch_tickets)',
                           'cd_tec_resumo(imobdesk.ch_tickets, uuid)'] loop
    execute format('revoke execute on function imobdesk.%s from public, anon, authenticated', f);
    execute format('grant execute on function imobdesk.%s to service_role', f);
  end loop;
end;
$$;

notify pgrst, 'reload schema';

-- ======================================== 20261013140000_imobdesk_solicitante_tecnico_campos.sql
-- App do solicitante · Técnico: campos adicionais obrigatórios no "Registrar atendimento" (13/10/2026).
-- O #1036 (serviço com o campo "Câmera" obrigatório por regra) não concluía: o app só dizia "falta preencher no portal".
-- Agora cd_tec_chamado devolve os campos obrigatórios visíveis do ticket e cd_tec_concluir grava p.campos antes de validar.
-- Só troca as duas funções (create or replace).

/** Detalhe para o técnico. */
create or replace function imobdesk.cd_tec_chamado(p_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.cd_tec_quem();
  t imobdesk.ch_tickets := imobdesk.cd_tec_ticket(p_id, v_uid);
  v_cat text := (select s.categoria from imobdesk.ch_status s where s.id = t.status_id);
  v_aberto boolean := v_cat not in ('resolvido', 'fechado', 'cancelado') and t.mesclado_em_id is null;
begin
  return imobdesk.cd_tec_resumo(t, v_uid) || jsonb_build_object(
    'setor', (select s.nome from imobdesk.at_setores s where s.id = t.setor_id),
    'servicoId', t.servico_id,
    'local', (select jsonb_build_object('nome', e.nome, 'cidade', e.cidade, 'endereco', e.endereco, 'observacao', e.observacao)
                from imobdesk.ch_empreendimentos e where e.id = t.empreendimento_id),
    'email', (select c.valor from imobdesk.at_pessoa_contatos c where c.pessoa_id = t.solicitante_pessoa_id and c.tipo = 'email' order by c.principal desc, c.id limit 1),
    'solucao', t.solucao_aplicada,
    'podeAtribuir', v_aberto and t.responsavel_id is null,
    'podeAtender', v_aberto and coalesce(t.responsavel_id = v_uid, false),
    -- Campos adicionais obrigatórios para resolver (regras de exibição deste ticket), com o valor atual.
    'campos', coalesce((select jsonb_agg(jsonb_build_object('chave', c.chave, 'rotulo', c.rotulo, 'tipo', c.tipo, 'opcoes', to_jsonb(c.opcoes),
                                                            'ajuda', c.ajuda, 'valor', t.campos -> c.chave) order by c.ordem, c.rotulo)
                          from imobdesk.ch_campos_estado(t) e join imobdesk.ch_campos c on c.chave = e.chave and c.ativo
                         where e.visivel and e.obrigatorio and c.tipo <> 'usuario'), '[]'),
    -- Sem serviço (ex.: "Outro assunto"), o técnico escolhe ao concluir: Resolvido exige serviço.
    'servicos', case when t.servico_id is null then coalesce((
        select jsonb_agg(jsonb_build_object('id', s.id, 'rotulo', imobdesk.cd_trilha(s.id)) order by imobdesk.cd_trilha(s.id))
          from imobdesk.ch_servicos s
         where s.setor_id = t.setor_id and s.ativo and not exists (select 1 from imobdesk.ch_servicos f where f.pai_id = s.id and f.ativo)), '[]') end,
    'acoes', coalesce((select jsonb_agg(jsonb_build_object('numero', a.numero, 'direcao', a.direcao, 'autorNome', a.autor_nome, 'texto', a.texto,
                                                           'anexos', a.anexos, 'criadoEm', a.criado_em) order by a.criado_em, a.numero)
                         from imobdesk.ch_ticket_acoes a where a.ticket_id = t.id and a.tipo = 'publica'), '[]'),
    'eventos', coalesce((select jsonb_agg(jsonb_build_object('tipo', e.tipo, 'criadoEm', e.criado_em, 'autorNome', e.autor_nome,
                                                             'descricao', case e.tipo
                                                               when 'criado' then 'Chamado aberto'
                                                               when 'status' then 'Status: ' || coalesce((select s.nome from imobdesk.ch_status s where s.id = (e.para ->> 'statusId')::bigint), '—')
                                                               else e.descricao end) order by e.criado_em desc)
                           from imobdesk.ch_ticket_eventos e where e.ticket_id = t.id and e.tipo in ('criado', 'status', 'responsavel')), '[]'));
end;
$$;


/**
 * Concluir atendimento: resposta pública ao solicitante (texto + fotos) e o status pelo tipo de resolução.
 *   resolvido → Resolvido (exige 1 foto, serviço e obrigatórios; o texto vira a Solução aplicada)
 *   voltar → Em atendimento · peca → Aguardando·Fornecedor · orcamento → Aguardando·Cotação
 *   aprovacao → Aguardando·Aprovação do gestor (avisa o líder da equipe) · sem_acesso → Aguardando·Retorno do cliente
 *   nao_procede → Cancelado
 * p.campos: valores dos campos adicionais (só chaves de campos ativos), gravados antes de validar.
 */
create or replace function imobdesk.cd_tec_concluir(p_id bigint, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.cd_tec_quem();
  t imobdesk.ch_tickets := imobdesk.cd_tec_ticket(p_id, v_uid);
  n imobdesk.ch_tickets;
  v_tipo text := coalesce(p ->> 'tipo', '');
  v_texto text := btrim(coalesce(p ->> 'texto', ''));
  v_fotos jsonb := imobdesk.cd_anexos_validos(p -> 'fotos', v_uid);
  v_servico bigint := nullif(p ->> 'servicoId', '')::bigint;
  v_campos jsonb := case when jsonb_typeof(p -> 'campos') = 'object' then p -> 'campos' else '{}' end;
  v_cat text;
  v_just text;
  v_status bigint;
  v_justificativa bigint;
  v_pend text[];
  v_canal text;
  v_num int;
  v_nome text := coalesce((select u.nome from imobdesk.usuarios u where u.id = v_uid), 'Técnico');
begin
  perform 1 from imobdesk.ch_tickets x where x.id = p_id for update;
  select * into t from imobdesk.ch_tickets x where x.id = p_id;
  if t.responsavel_id is distinct from v_uid then perform imobdesk.erro('FORBIDDEN', 'Só o técnico responsável registra o atendimento. Use "Atribuir-me" primeiro.'); end if;
  if (select s.categoria from imobdesk.ch_status s where s.id = t.status_id) in ('resolvido', 'fechado', 'cancelado') or t.mesclado_em_id is not null then
    perform imobdesk.erro('INVALID_INPUT', 'Este chamado já foi encerrado.');
  end if;
  if v_tipo not in ('resolvido', 'voltar', 'peca', 'orcamento', 'aprovacao', 'sem_acesso', 'nao_procede') then
    perform imobdesk.erro('INVALID_INPUT', 'Escolha o tipo de resolução.', 'tipo');
  end if;
  if length(v_texto) < 5 then perform imobdesk.erro('INVALID_INPUT', 'Escreva o que foi feito.', 'texto'); end if;
  if length(v_texto) > 4000 then perform imobdesk.erro('INVALID_INPUT', 'O texto passou de 4.000 caracteres.', 'texto'); end if;
  if v_tipo = 'resolvido' and jsonb_array_length(v_fotos) = 0 then
    perform imobdesk.erro('INVALID_INPUT', 'Tire pelo menos 1 foto do atendimento para concluir como Resolvido.', 'fotos');
  end if;

  v_cat := case v_tipo when 'resolvido' then 'resolvido' when 'voltar' then 'andamento' when 'nao_procede' then 'cancelado' else 'pendente' end;
  v_just := case v_tipo when 'peca' then 'fornecedor' when 'orcamento' then 'cotação' when 'aprovacao' then 'aprovação do gestor' when 'sem_acesso' then 'retorno do cliente' end;
  if v_cat = 'pendente' then
    select j.status_id, j.id into v_status, v_justificativa
      from imobdesk.ch_status_justificativas j join imobdesk.ch_status s on s.id = j.status_id and s.ativo and s.categoria = 'pendente'
     where j.ativa and lower(btrim(j.nome)) = v_just order by s.ordem, j.ordem limit 1;
    v_status := coalesce(v_status, (select s.id from imobdesk.ch_status s where s.categoria = 'pendente' and s.ativo order by s.ordem limit 1));
  elsif v_cat = 'andamento' then
    v_status := t.status_id;
    v_justificativa := t.justificativa_id;
    if (select s.categoria from imobdesk.ch_status s where s.id = t.status_id) <> 'andamento' then
      v_status := coalesce((select s.id from imobdesk.ch_status s where s.categoria = 'andamento' and s.ativo and lower(s.nome) = 'em atendimento' limit 1),
                           (select s.id from imobdesk.ch_status s where s.categoria = 'andamento' and s.ativo order by s.ordem limit 1));
      v_justificativa := null;
    end if;
  else
    v_status := (select s.id from imobdesk.ch_status s where s.categoria = v_cat and s.ativo order by s.ordem limit 1);
  end if;
  if v_status is null then perform imobdesk.erro('INVALID_INPUT', 'Status de destino não cadastrado. Fale com a TI.'); end if;

  n := t;
  n.status_id := v_status;
  n.justificativa_id := v_justificativa;
  if v_servico is not null and v_servico is distinct from t.servico_id then
    if not exists (select 1 from imobdesk.ch_servicos s where s.id = v_servico and s.setor_id = t.setor_id and s.ativo) then
      perform imobdesk.erro('INVALID_INPUT', 'Escolha o serviço de novo.', 'servicoId');
    end if;
    n.servico_id := v_servico;
  end if;
  if exists (select 1 from jsonb_object_keys(v_campos) k where not exists (select 1 from imobdesk.ch_campos c where c.chave = k and c.ativo)) then
    perform imobdesk.erro('INVALID_INPUT', 'Campo adicional inválido. Abra o chamado de novo.', 'campos');
  end if;
  n.campos := t.campos || v_campos;
  if v_cat = 'resolvido' then
    if n.servico_id is null then perform imobdesk.erro('INVALID_INPUT', 'Escolha o serviço antes de concluir como Resolvido.', 'servicoId'); end if;
    v_pend := imobdesk.ch_campos_pendentes(n);
    if cardinality(v_pend) > 0 then
      perform imobdesk.erro('INVALID_INPUT', 'Preencha antes de concluir: ' || array_to_string(v_pend, ', ') || '.', 'campos');
    end if;
    n.solucao_aplicada := coalesce(n.solucao_aplicada, left(v_texto, 20000));
  end if;

  -- Resposta ao solicitante pelo canal do ticket (como ch_ticket_acao).
  v_canal := case when t.origem in ('email', 'whatsapp') then t.origem else 'portal' end;
  v_num := coalesce((select max(a.numero) from imobdesk.ch_ticket_acoes a where a.ticket_id = p_id), 0) + 1;
  insert into imobdesk.ch_ticket_acoes (ticket_id, numero, tipo, canal, direcao, autor_id, autor_nome, texto, anexos, envio_status)
  values (p_id, v_num, 'publica', v_canal, 'saida', v_uid, v_nome, v_texto, v_fotos,
          case when v_canal in ('email', 'whatsapp') then 'pendente' else 'nao_se_aplica' end);

  update imobdesk.ch_tickets set
    status_id = n.status_id, justificativa_id = n.justificativa_id, servico_id = n.servico_id, campos = n.campos,
    solucao_aplicada = n.solucao_aplicada, primeira_resposta_em = coalesce(primeira_resposta_em, now())
  where id = p_id;

  if v_tipo = 'aprovacao' then
    perform imobdesk.ch_notificar(array[(select e.lider_id from imobdesk.at_equipes e where e.id = t.equipe_id)], p_id,
      format('Ticket #%s precisa de aprovação', p_id), format('%s: %s', v_nome, left(v_texto, 300)));
  end if;

  return jsonb_build_object('status', (select s.nome from imobdesk.ch_status s where s.id = n.status_id),
                            'justificativa', (select j.nome from imobdesk.ch_status_justificativas j where j.id = n.justificativa_id));
end;
$$;


notify pgrst, 'reload schema';

-- ======================================== 20261013150000_imobdesk_cftv_sem_campo_camera.sql
-- CFTV sem o campo "Câmera" (pedido do Wagner, 13/10/2026). O campo era exemplo da carga inicial (20261007170000) e a
-- regra "Câmera no CFTV" o tornava obrigatório para resolver qualquer chamado do CFTV (portal e App do solicitante Técnico).
-- Sem apagar nada: o campo fica inativo (some do portal e do app) e a regra perde só a ação "obrigar Câmera";
-- continua exibindo "Data do ocorrido" no CFTV. Valores já gravados nos tickets ficam como estão.

update imobdesk.ch_campos set ativo = false, atualizado_em = now()
 where chave = 'camera' and ativo;

update imobdesk.ch_regras_exibicao r
   set acoes = coalesce((select jsonb_agg(a) from jsonb_array_elements(r.acoes) a where a ->> 'campo' <> 'camera'), '[]'),
       atualizado_em = now()
 where r.acoes @> '[{"campo": "camera"}]';

-- ======================================== 20261016100000_imobdesk_setor_solicitante.sql
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

-- ======================================== 20261016110000_imobdesk_recebe_chamados_app.sql
-- "Receber chamado" marcado = o setor aparece no App do solicitante como opção para abrir chamado (pedido do Wagner, 16/10/2026).
-- Ao marcar, o setor fica visível no app; ao desmarcar, sai. A Administração do App do solicitante ainda pode esconder um setor
-- que recebe, mas não pode mostrar um que não recebe. Só aditiva: redefine o gatilho da 20261016100000.

create or replace function imobdesk.at_setores_recebe_regra()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.recebe_chamados then
    -- Passou a receber (ou nasceu recebendo): entra no app.
    if tg_op = 'INSERT' or not old.recebe_chamados then
      new.cd_visivel := true;
    end if;
  elsif new.cd_visivel then
    if tg_op = 'INSERT' or old.recebe_chamados then
      new.cd_visivel := false;  -- setor novo ou que deixou de receber: sai do app
    else
      perform imobdesk.erro('INVALID_INPUT', format('O setor %s não recebe chamados. Marque "Receber chamado" em Setores e números para mostrá-lo no App do solicitante.', new.nome));
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function imobdesk.at_setores_recebe_regra() from public, anon, authenticated;

-- Setores que já recebem e ainda não estão no app (ex.: Financeiro).
update imobdesk.at_setores set cd_visivel = true where recebe_chamados and ativo and not cd_visivel;

notify pgrst, 'reload schema';

-- ======================================== 20261016120000_imobdesk_solicitante_icones.sql
-- App do solicitante: ícones coloridos do Iconify nos departamentos (pedido do Wagner, 16/10/2026). O campo cd_icone passa a
-- guardar o nome do ícone ("fluent-color:people-team-24", até 60 letras) além do emoji. Nenhum dado é apagado: só o
-- limite do campo cresce (16 → 60) e os 4 setores que recebem chamado ganham um ícone colorido no lugar do emoji.

alter table imobdesk.at_setores drop constraint if exists at_setores_cd_icone_check;
alter table imobdesk.at_setores add constraint at_setores_cd_icone_check check (length(cd_icone) <= 60);

create or replace function imobdesk.cd_admin_setor_salvar(p_id bigint, p jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform imobdesk.cd_admin_checar();
  if not exists (select 1 from imobdesk.at_setores s where s.id = p_id) then perform imobdesk.erro('NOT_FOUND', 'Setor não encontrado.'); end if;
  update imobdesk.at_setores set
    cd_visivel = coalesce((p ->> 'visivel')::boolean, cd_visivel),
    cd_icone = case when p ? 'icone' then nullif(left(btrim(p ->> 'icone'), 60), '') else cd_icone end,
    cd_descricao = case when p ? 'descricao' then nullif(left(btrim(p ->> 'descricao'), 200), '') else cd_descricao end,
    cd_ordem = coalesce((p ->> 'ordem')::int, cd_ordem),
    atualizado_em = now(), atualizado_por = (select auth.uid())
  where id = p_id;
end;
$$;

update imobdesk.at_setores s set cd_icone = x.icone
from (values ('ti', '💻', 'fluent-color:code-block-24'), ('cftv', '📹', 'flat-color-icons:multiple-cameras'),
             ('administrativo', '🏢', 'flat-color-icons:briefcase'), ('financeiro', null, 'flat-color-icons:money-transfer')) x(nome, antes, icone)
where lower(btrim(s.nome)) = x.nome and s.cd_icone is not distinct from x.antes;

notify pgrst, 'reload schema';

-- ======================================== 20261017100000_imobdesk_sf_base.sql
-- Solicitações Financeiras, Fase 1: estrutura (docs/Solicitacoes-financeiras/CONTEXTO.md; mockup aprovado em 17/10/2026).
-- Reembolso, Fundo fixo e Adiantamento de numerário. A cadeia de aprovação é do SETOR da pessoa (decisão do Wagner,
-- 17/10/2026): colunas sf_* em at_setores e aprovadores em sf_setor_aprovador (no lugar de equipe/equipe_aprovador do PRD).
-- Padrão do portal: RLS ligada, nada liberado a anon/authenticated; leitura e escrita só por RPC security definer.
-- Status só muda por RPC (Fases 2 a 5). Só aditiva: tabelas e colunas novas; nada existente é alterado.

-- ---------- Setor: configuração da aprovação financeira ----------
alter table imobdesk.at_setores add column if not exists sf_setor_obra boolean not null default false;
alter table imobdesk.at_setores add column if not exists sf_financeiro boolean not null default false;
alter table imobdesk.at_setores add column if not exists sf_modo_aprovacao text not null default 'sequencial'
  check (sf_modo_aprovacao in ('sequencial', 'paralelo', 'qualquer_um'));
alter table imobdesk.at_setores add column if not exists sf_prazo_horas int not null default 48 check (sf_prazo_horas between 1 and 720);
alter table imobdesk.at_setores add column if not exists sf_acao_prazo_vencido text not null default 'escalar'
  check (sf_acao_prazo_vencido in ('lembrar', 'escalar'));
alter table imobdesk.at_setores add column if not exists sf_centro_custo_padrao text check (length(sf_centro_custo_padrao) <= 60);
alter table imobdesk.at_setores add column if not exists sf_prazo_comprovacao_dias int not null default 30 check (sf_prazo_comprovacao_dias between 1 and 365);
alter table imobdesk.at_setores add column if not exists sf_acao_comprovacao_vencida text not null default 'avisar_bloquear'
  check (sf_acao_comprovacao_vencida in ('avisar', 'avisar_bloquear'));
-- [LIMITE] do PRD: nulo = ainda não definido (sem limite).
alter table imobdesk.at_setores add column if not exists sf_limite_adiantamentos_abertos int check (sf_limite_adiantamentos_abertos between 1 and 99);
alter table imobdesk.at_setores add column if not exists sf_atualizado_em timestamptz;
alter table imobdesk.at_setores add column if not exists sf_atualizado_por uuid;

-- Aprovadores por setor. Reembolso/fundo fixo: entra quem tem alçada mínima <= total. Adiantamento: 4 níveis fixos
-- (planejamento só em setor de obra, gerente sempre, diretor e presidente acima da alçada).
create table if not exists imobdesk.sf_setor_aprovador (
  id                bigint        generated always as identity primary key,
  setor_id          bigint        not null references imobdesk.at_setores (id) on delete cascade,
  tipo_solicitacao  text          not null check (tipo_solicitacao in ('reembolso_fundo_fixo', 'adiantamento')),
  ordem             int           not null check (ordem between 1 and 20),
  papel             text          not null check (length(btrim(papel)) between 2 and 40),
  aprovador_id      uuid          not null references imobdesk.usuarios (id) on delete cascade,
  substituto_id     uuid          references imobdesk.usuarios (id) on delete set null,
  condicao          text          not null default 'sempre' check (condicao in ('sempre', 'obra', 'valor_acima')),
  alcada_minima     numeric(14,2) check (alcada_minima >= 0),
  ativo             boolean       not null default true,
  criado_em         timestamptz   not null default now(),
  atualizado_em     timestamptz   not null default now(),
  atualizado_por    uuid,
  unique (setor_id, tipo_solicitacao, ordem),
  check (substituto_id is distinct from aprovador_id),
  check (tipo_solicitacao <> 'adiantamento' or papel in ('planejamento', 'gerente', 'diretor', 'presidente'))
);
create index if not exists sf_setor_aprovador_aprovador_idx on imobdesk.sf_setor_aprovador (aprovador_id);
create index if not exists sf_setor_aprovador_substituto_idx on imobdesk.sf_setor_aprovador (substituto_id) where substituto_id is not null;

-- ---------- Cadastros ----------
create table if not exists imobdesk.sf_fundo_fixo (
  id              bigint        generated always as identity primary key,
  usuario_id      uuid          not null references imobdesk.usuarios (id) on delete cascade,
  valor           numeric(14,2) not null check (valor > 0),
  vigente_desde   date          not null default current_date,
  ativo           boolean       not null default true,
  criado_em       timestamptz   not null default now(),
  atualizado_em   timestamptz   not null default now(),
  atualizado_por  uuid
);
-- Um valor vigente por colaborador.
create unique index if not exists sf_fundo_fixo_ativo_uq on imobdesk.sf_fundo_fixo (usuario_id) where ativo;

create table if not exists imobdesk.sf_categoria_motivo (
  id              bigint        generated always as identity primary key,
  nome            text          not null check (length(btrim(nome)) between 2 and 60),
  descricao       text          check (length(descricao) <= 300),
  palavras_chave  text[]        not null default '{}',
  teto_valor      numeric(14,2) check (teto_valor > 0),
  ordem           int           not null default 0,
  ativo           boolean       not null default true,
  criado_em       timestamptz   not null default now(),
  atualizado_em   timestamptz   not null default now(),
  atualizado_por  uuid
);
create unique index if not exists sf_categoria_motivo_nome_uq on imobdesk.sf_categoria_motivo (lower(btrim(nome)));

-- Regras de aceitação (R01–R10 e A01–A07). Parâmetros editáveis pelo admin; [PRAZO], tolerância etc. ficam aqui.
create table if not exists imobdesk.sf_regra (
  codigo          text          primary key check (codigo ~ '^[RA][0-9]{2}$'),
  nome            text          not null,
  descricao       text          not null,
  aplica_a        text          not null check (aplica_a in ('reembolso_fundo_fixo', 'adiantamento')),
  severidade      text          not null check (severidade in ('alerta', 'bloqueio')),
  ativo           boolean       not null default true,
  parametros      jsonb         not null default '{}',
  atualizado_em   timestamptz   not null default now(),
  atualizado_por  uuid
);

-- ---------- Solicitação ----------
-- Número SF-AAAA-NNNN: contador por ano.
create table if not exists imobdesk.sf_numerador (
  ano     int primary key,
  ultimo  int not null default 0
);

create table if not exists imobdesk.sf_solicitacao (
  id                     bigint        generated always as identity primary key,
  numero                 text          not null unique,
  tipo                   text          not null check (tipo in ('reembolso', 'fundo_fixo', 'adiantamento')),
  solicitante_id         uuid          not null references imobdesk.usuarios (id),
  pessoa_id              bigint        references imobdesk.at_pessoas (id) on delete set null,
  setor_id               bigint        references imobdesk.at_setores (id) on delete set null,
  status                 text          not null default 'rascunho' check (status in (
                           'rascunho', 'em_aprovacao', 'devolvida', 'reprovada', 'cancelada', 'em_conferencia', 'pendencia_solicitante',
                           'lancamento_gerado', 'pagamento_programado', 'paga', 'comprovacao_pendente', 'comprovacao_em_conferencia',
                           'devolucao_pendente', 'encerrada')),
  ciclo                  int           not null default 1 check (ciclo >= 1),
  etapa_atual            int,
  -- Competência (reembolso e fundo fixo)
  centro_custo           text          check (length(centro_custo) <= 60),
  competencia            date          check (competencia is null or extract(day from competencia) = 1),
  periodo_de             date,
  periodo_ate            date          check (periodo_ate is null or periodo_de is null or periodo_ate >= periodo_de),
  -- Totais
  valor_fundo_fixo       numeric(14,2),
  saldo_inicial          numeric(14,2),
  total_despesas         numeric(14,2) not null default 0,
  saldo_final            numeric(14,2),
  valor_glosado          numeric(14,2) not null default 0 check (valor_glosado >= 0),
  valor_a_pagar          numeric(14,2),
  -- Aceite eletrônico (substitui as assinaturas)
  aceite_em              timestamptz,
  aceite_ip              text,
  aceite_user_agent      text,
  -- Prazos e integração
  enviado_em             timestamptz,
  ultima_aprovacao_em    timestamptz,
  pagar_ate              date,
  sienge_lancamento_id   text,
  -- Adiantamento de numerário (modelo padrão)
  valor_adiantamento     numeric(14,2) check (valor_adiantamento > 0),
  obra                   text          check (length(obra) <= 160),
  conta_caixa            text          check (length(conta_caixa) <= 40),
  conta_pagamento        text          check (length(conta_pagamento) <= 120),
  centro_apuracao        text          check (length(centro_apuracao) <= 60),
  favorecido             text          check (length(favorecido) <= 160),
  favorecido_doc         text          check (favorecido_doc ~ '^\d{11}$|^\d{14}$'),
  finalidade             text          check (length(finalidade) <= 500),
  forma_pagamento        text          check (forma_pagamento in ('deposito', 'boleto', 'cheque', 'dinheiro')),
  banco                  text          check (length(banco) <= 60),
  agencia                text          check (length(agencia) <= 20),
  conta                  text          check (length(conta) <= 30),
  tipo_conta             text          check (tipo_conta in ('corrente', 'poupanca')),
  vencimento             date,
  prazo_comprovacao      date,
  pedido_numero          text          check (length(pedido_numero) <= 40),
  pedido_valor           numeric(14,2) check (pedido_valor > 0),
  pedido_percentual      numeric(5,2)  check (pedido_percentual > 0 and pedido_percentual <= 100),
  status_comprovacao     text          check (status_comprovacao in ('pendente', 'enviada', 'aceita', 'devolucao', 'vencida')),
  criado_em              timestamptz   not null default now(),
  atualizado_em          timestamptz   not null default now()
);
create index if not exists sf_solicitacao_solicitante_idx on imobdesk.sf_solicitacao (solicitante_id, criado_em desc);
create index if not exists sf_solicitacao_status_idx on imobdesk.sf_solicitacao (status);
create index if not exists sf_solicitacao_setor_idx on imobdesk.sf_solicitacao (setor_id);

create or replace function imobdesk.sf_solicitacao_numerar()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ano int := extract(year from now())::int;
  v_n int;
begin
  if new.numero is null or new.numero = '' then
    insert into imobdesk.sf_numerador as n (ano, ultimo) values (v_ano, 1)
    on conflict (ano) do update set ultimo = n.ultimo + 1
    returning ultimo into v_n;
    new.numero := format('SF-%s-%s', v_ano, lpad(v_n::text, 4, '0'));
  end if;
  return new;
end;
$$;
revoke execute on function imobdesk.sf_solicitacao_numerar() from public, anon, authenticated;
drop trigger if exists sf_solicitacao_numerar on imobdesk.sf_solicitacao;
create trigger sf_solicitacao_numerar before insert on imobdesk.sf_solicitacao
  for each row execute function imobdesk.sf_solicitacao_numerar();

create table if not exists imobdesk.sf_item (
  id                     bigint        generated always as identity primary key,
  solicitacao_id         bigint        not null references imobdesk.sf_solicitacao (id) on delete cascade,
  ordem                  int           not null default 1,
  data                   date,
  valor                  numeric(14,2) check (valor >= 0),
  descricao_favorecido   text          check (length(descricao_favorecido) <= 200),
  motivo                 text          check (length(motivo) <= 200),
  categoria_id           bigint        references imobdesk.sf_categoria_motivo (id) on delete set null,
  origem                 text          not null default 'manual' check (origem in ('manual', 'ocr_confirmado', 'ocr_editado')),
  status_conferencia     text          not null default 'pendente' check (status_conferencia in ('pendente', 'aceito', 'ajuste', 'glosado')),
  valor_glosado          numeric(14,2) not null default 0 check (valor_glosado >= 0),
  obs_conferente         text          check (length(obs_conferente) <= 1000),
  criado_em              timestamptz   not null default now(),
  atualizado_em          timestamptz   not null default now()
);
create index if not exists sf_item_solicitacao_idx on imobdesk.sf_item (solicitacao_id, ordem);

create table if not exists imobdesk.sf_anexo (
  id              bigint        generated always as identity primary key,
  solicitacao_id  bigint        not null references imobdesk.sf_solicitacao (id) on delete cascade,
  item_id         bigint        references imobdesk.sf_item (id) on delete set null,
  finalidade      text          not null default 'comprovante' check (finalidade in ('comprovante', 'documento_origem', 'comprovacao')),
  storage_path    text          not null,
  nome_arquivo    text          not null check (length(nome_arquivo) <= 200),
  mime            text          not null,
  tamanho         bigint        not null check (tamanho between 1 and 10485760),
  sha256          text          not null check (sha256 ~ '^[0-9a-f]{64}$'),
  ocr_status      text          not null default 'fila' check (ocr_status in ('fila', 'lendo', 'lido', 'ilegivel', 'erro')),
  ocr_json        jsonb,
  ocr_confianca   numeric(4,3)  check (ocr_confianca between 0 and 1),
  chave_acesso    text          check (chave_acesso ~ '^\d{44}$'),
  criado_em       timestamptz   not null default now(),
  criado_por      uuid
);
create index if not exists sf_anexo_solicitacao_idx on imobdesk.sf_anexo (solicitacao_id);
create index if not exists sf_anexo_item_idx on imobdesk.sf_anexo (item_id) where item_id is not null;
create index if not exists sf_anexo_sha_idx on imobdesk.sf_anexo (sha256);

create table if not exists imobdesk.sf_regra_resultado (
  id              bigint      generated always as identity primary key,
  solicitacao_id  bigint      not null references imobdesk.sf_solicitacao (id) on delete cascade,
  item_id         bigint      references imobdesk.sf_item (id) on delete cascade,
  regra_codigo    text        not null references imobdesk.sf_regra (codigo),
  resultado       text        not null check (resultado in ('ok', 'alerta', 'bloqueio')),
  detalhe         text,
  avaliado_em     timestamptz not null default now()
);
create index if not exists sf_regra_resultado_sol_idx on imobdesk.sf_regra_resultado (solicitacao_id, item_id);

-- Etapas congeladas no envio (ciclo recomeça do nível 1 após devolução).
create table if not exists imobdesk.sf_aprovacao (
  id              bigint      generated always as identity primary key,
  solicitacao_id  bigint      not null references imobdesk.sf_solicitacao (id) on delete cascade,
  ciclo           int         not null,
  nivel           int         not null,
  papel           text        not null,
  aprovador_id    uuid        references imobdesk.usuarios (id),
  substituto_id   uuid        references imobdesk.usuarios (id),
  status          text        not null default 'pendente' check (status in ('pendente', 'aguardando', 'aprovado', 'devolvido', 'reprovado', 'pulado', 'nao_exigido')),
  comentario      text        check (length(comentario) <= 2000),
  prazo_em        timestamptz,
  lembrete_em     timestamptz,
  escalado_em     timestamptz,
  decidido_em     timestamptz,
  decidido_por    uuid        references imobdesk.usuarios (id),
  unique (solicitacao_id, ciclo, nivel)
);
create index if not exists sf_aprovacao_aprovador_idx on imobdesk.sf_aprovacao (aprovador_id, status);
create index if not exists sf_aprovacao_substituto_idx on imobdesk.sf_aprovacao (substituto_id) where substituto_id is not null;

-- Log imutável de tudo o que aconteceu (a timeline sai daqui e de sf_aprovacao).
create table if not exists imobdesk.sf_evento (
  id              bigint      generated always as identity primary key,
  solicitacao_id  bigint      not null references imobdesk.sf_solicitacao (id) on delete cascade,
  tipo            text        not null check (length(tipo) between 2 and 60),
  ator_id         uuid,
  payload         jsonb       not null default '{}',
  ip              text,
  user_agent      text,
  criado_em       timestamptz not null default now()
);
create index if not exists sf_evento_sol_idx on imobdesk.sf_evento (solicitacao_id, criado_em);

create or replace function imobdesk.sf_evento_imutavel()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- A exclusão em cascata da solicitação (só service_role) continua possível.
  if tg_op = 'UPDATE' then
    raise exception 'sf_evento é imutável';
  end if;
  return old;
end;
$$;
revoke execute on function imobdesk.sf_evento_imutavel() from public, anon, authenticated;
drop trigger if exists sf_evento_imutavel on imobdesk.sf_evento;
create trigger sf_evento_imutavel before update on imobdesk.sf_evento
  for each row execute function imobdesk.sf_evento_imutavel();

create table if not exists imobdesk.sf_rateio (
  id              bigint        generated always as identity primary key,
  solicitacao_id  bigint        not null references imobdesk.sf_solicitacao (id) on delete cascade,
  tarefa          text          not null check (length(btrim(tarefa)) between 1 and 40),
  porcentagem     numeric(5,2)  not null check (porcentagem > 0 and porcentagem <= 100),
  valor           numeric(14,2) not null check (valor >= 0)
);
create index if not exists sf_rateio_sol_idx on imobdesk.sf_rateio (solicitacao_id);

create table if not exists imobdesk.sf_comprovacao (
  id              bigint        generated always as identity primary key,
  solicitacao_id  bigint        not null references imobdesk.sf_solicitacao (id) on delete cascade,
  anexo_id        bigint        references imobdesk.sf_anexo (id) on delete set null,
  tipo_documento  text          check (tipo_documento in ('nfe', 'nfce', 'cupom', 'recibo', 'outro')),
  emitente_doc    text          check (emitente_doc ~ '^\d{11}$|^\d{14}$'),
  emissao         date,
  valor           numeric(14,2) check (valor >= 0),
  saldo_devolver  numeric(14,2) not null default 0 check (saldo_devolver >= 0),
  saldo_pagar     numeric(14,2) not null default 0 check (saldo_pagar >= 0),
  conferida_por   uuid          references imobdesk.usuarios (id),
  conferida_em    timestamptz,
  criado_em       timestamptz   not null default now()
);
create index if not exists sf_comprovacao_sol_idx on imobdesk.sf_comprovacao (solicitacao_id);

-- ---------- Acesso: tudo fechado, só RPC ----------
do $$
declare
  t text;
begin
  foreach t in array array['sf_setor_aprovador', 'sf_fundo_fixo', 'sf_categoria_motivo', 'sf_regra', 'sf_numerador', 'sf_solicitacao', 'sf_item',
                           'sf_anexo', 'sf_regra_resultado', 'sf_aprovacao', 'sf_evento', 'sf_rateio', 'sf_comprovacao'] loop
    execute format('alter table imobdesk.%I enable row level security', t);
    execute format('revoke all on imobdesk.%I from anon, public, authenticated', t);
    execute format('grant all on imobdesk.%I to service_role', t);
  end loop;
end;
$$;

-- Bucket privado dos comprovantes (políticas e upload na Fase 2; URLs assinadas de 5 min).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('imobdesk-sf-comprovantes', 'imobdesk-sf-comprovantes', false, 10485760,
        array['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp', 'application/pdf'])
on conflict (id) do nothing;

-- ======================================== 20261017100100_imobdesk_sf_seeds.sql
-- Solicitações Financeiras, Fase 1: cargas iniciais (CONTEXTO.md, seções 5 e 9).
-- Regras R01–R10 e A01–A07 com os parâmetros que o PRD fixa; o que está em aberto ([PRAZO] da R09, itens proibidos da R07)
-- fica nulo/vazio até o admin preencher em Cadastros financeiros. Só insere o que não existe.

insert into imobdesk.sf_regra (codigo, nome, descricao, aplica_a, severidade, parametros) values
  ('R01', 'Comprovante anexado', 'Toda linha tem ao menos um comprovante.', 'reembolso_fundo_fixo', 'bloqueio', '{}'),
  ('R02', 'Legível', 'Legibilidade de data, valor e favorecido a partir do limiar; abaixo dele o campo não é copiado.', 'reembolso_fundo_fixo', 'alerta', '{"limiar": 0.80}'),
  ('R03', 'Data no período', 'Data do comprovante entre o início e o fim do período da competência.', 'reembolso_fundo_fixo', 'alerta', '{}'),
  ('R04', 'Valor confere', 'Valor do comprovante igual ao declarado, dentro da tolerância.', 'reembolso_fundo_fixo', 'alerta', '{"tolerancia": 0}'),
  ('R05', 'Documento fiscal', 'NF-e, NFC-e, cupom ou recibo com CNPJ/CPF do emissor.', 'reembolso_fundo_fixo', 'alerta', '{}'),
  ('R06', 'Sem duplicidade', 'Arquivo (SHA-256) e combinação CNPJ + data + valor não usados em outra solicitação.', 'reembolso_fundo_fixo', 'bloqueio', '{}'),
  ('R07', 'Categoria permitida', 'Itens lidos não batem com a lista de itens proibidos.', 'reembolso_fundo_fixo', 'alerta', '{"itens_proibidos": []}'),
  ('R08', 'Limite por categoria', 'Valor do item até o teto da categoria de motivo, quando houver teto.', 'reembolso_fundo_fixo', 'alerta', '{}'),
  ('R09', 'Prazo de envio', 'Solicitação enviada até N dias após o fim da competência.', 'reembolso_fundo_fixo', 'alerta', '{"dias": null}'),
  ('R10', 'Saldo do fundo fixo', 'Despesas totais até o saldo inicial do fundo fixo.', 'reembolso_fundo_fixo', 'bloqueio', '{}'),
  ('A01', 'Documento de origem', 'Pedido de compras, proposta ou e-mail anexado.', 'adiantamento', 'bloqueio', '{}'),
  ('A02', 'Valor × pedido', 'Valor adiantado até o valor do pedido × percentual da condição.', 'adiantamento', 'alerta', '{}'),
  ('A03', 'Favorecido × pedido', 'CNPJ do favorecido igual ao do fornecedor do pedido.', 'adiantamento', 'alerta', '{}'),
  ('A04', 'Titularidade bancária', 'Conta informada pertence ao CPF/CNPJ do favorecido (conferência do Financeiro).', 'adiantamento', 'alerta', '{}'),
  ('A05', 'Rateio', 'Soma das porcentagens por tarefa igual a 100%.', 'adiantamento', 'bloqueio', '{}'),
  ('A06', 'Adiantamento em aberto', 'Pedido sem outro adiantamento não comprovado; solicitante abaixo do limite e sem comprovação vencida.', 'adiantamento', 'bloqueio', '{}'),
  ('A07', 'Comprovação', 'Emitente = favorecido, emissão após o pagamento e no prazo, valor ≥ adiantado, nota não usada antes.', 'adiantamento', 'alerta', '{}')
on conflict (codigo) do nothing;

insert into imobdesk.sf_categoria_motivo (nome, palavras_chave, ordem)
select x.nome, x.chaves, x.ordem
from (values
  ('Material de obra', array['cimento', 'areia', 'tijolo', 'argamassa', 'tinta'], 1),
  ('Ferramentas', array['disco', 'broca', 'martelo', 'chave', 'serra'], 2),
  ('EPI', array['luva', 'óculos', 'capacete', 'bota', 'protetor'], 3),
  ('Combustível', array['gasolina', 'etanol', 'diesel', 'posto'], 4),
  ('Transporte', array['uber', '99', 'táxi', 'pedágio', 'ônibus'], 5),
  ('Estacionamento', array['estacionamento', 'park', 'garagem'], 6),
  ('Alimentação', array['refeição', 'almoço', 'restaurante', 'lanche'], 7),
  ('Copa/mantimentos', array['café', 'açúcar', 'água', 'biscoito'], 8),
  ('Material de escritório', array['papel', 'caneta', 'toner', 'grampo'], 9),
  ('Outros', array[]::text[], 10)
) as x(nome, chaves, ordem)
where not exists (select 1 from imobdesk.sf_categoria_motivo c where lower(btrim(c.nome)) = lower(x.nome));

-- O setor Financeiro confere as solicitações; setores cujo nome começa com "Obra" são de obra.
-- Só na primeira vez: depois, quem manda é a aba Aprovação financeira do setor.
do $$
begin
  if not exists (select 1 from imobdesk.at_setores where sf_financeiro) then
    update imobdesk.at_setores set sf_financeiro = true where lower(btrim(nome)) = 'financeiro';
  end if;
  if not exists (select 1 from imobdesk.at_setores where sf_setor_obra) then
    update imobdesk.at_setores set sf_setor_obra = true where lower(btrim(nome)) like 'obra%';
  end if;
end;
$$;

-- ======================================== 20261017100200_imobdesk_sf_rpc_cadastros.sql
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

-- ======================================== 20261017110000_imobdesk_sf_formularios.sql
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

commit;
