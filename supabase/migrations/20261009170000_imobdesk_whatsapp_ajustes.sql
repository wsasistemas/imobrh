-- Ajustes do WhatsApp pedidos pelo Wagner no 1º teste real (09/10/2026):
--  1. Boas-vindas e identificação não saíam: as respostas automáticas dependiam da chave da Zenvia ("ligado" + trava do
--     piloto). Agora cada setor tem a sua (wa_respostas_auto, ligada por padrão) para os números do OpenWA; a Zenvia
--     continua com a regra antiga.
--  2. "Verificar se o número existe na base": a identificação procura também no cadastro de Pessoas (contato WhatsApp
--     ou telefone). Achou → confirma "Você é Fulano (e-mail)?"; não achou → pede nome e e-mail e cadastra. Pessoa com
--     e-mail de domínio da empresa conta como colaborador para "Só linhas corporativas".
--  3. "RESOLVIDO" escrito pelo atendente (portal, grupo interno ou o próprio celular do número) resolve o ticket e
--     encerra; a mensagem final ao solicitante sempre leva o número do chamado.
--  4. Resposta digitada no próprio celular do número do sistema (evento message.sent do OpenWA) entra na conversa e
--     no ticket (at_whatsapp_propria), sem duplicar o eco do que o próprio sistema enviou.
-- Só aditiva: coluna nova e funções trocadas (mesma assinatura) ou novas.

alter table imobdesk.at_setores add column if not exists wa_respostas_auto boolean not null default true;

/** Respostas automáticas valem nesta conversa? OpenWA: chave do setor. Zenvia: "ligado" + trava do piloto (como antes). */
create or replace function imobdesk.at_auto_conversa(p_conversa bigint)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select case when n.canal = 'openwa' then s.wa_respostas_auto else imobdesk.at_auto_permitido(c.telefone) end
    from imobdesk.at_conversas c
    join imobdesk.at_numeros n on n.id = c.numero_id
    join imobdesk.at_setores s on s.id = c.setor_id
    where c.id = p_conversa), false);
$$;

/** "RESOLVIDO" (com ou sem pontuação, maiúsculas ou não) = encerrar resolvendo o ticket. */
create or replace function imobdesk.at_eh_resolvido(p_texto text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select lower(btrim(coalesce(p_texto, ''), ' .!*_')) in ('resolvido', 'resolvida', '#resolvido', 'ok resolvido', 'chamado resolvido');
$$;

/** Resolve o ticket pela palavra RESOLVIDO (sem o diálogo): solução padrão se não houver; o serviço fica o da triagem. */
create or replace function imobdesk.at_ticket_resolver_direto(p_ticket bigint, p_usuario uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update imobdesk.ch_tickets set
    status_id = imobdesk.ch_status_de('resolvido'), justificativa_id = null,
    responsavel_id = coalesce(responsavel_id, p_usuario),
    solucao_aplicada = coalesce(solucao_aplicada,
      format('Resolvido no atendimento pelo WhatsApp por %s.', coalesce(imobdesk.ch_nome_usuario(p_usuario), 'atendente')))
  where id = p_ticket and excluido_em is null;
$$;

/** Resposta automática pendente (sai pelo despachante). OpenWA: chave do setor; Zenvia: "ligado" + trava do piloto. */
create or replace function imobdesk.at_auto(p_conversa bigint, p_texto text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  c imobdesk.at_conversas;
  v_id bigint;
begin
  select * into c from imobdesk.at_conversas x where x.id = p_conversa;
  if c.id is null or nullif(btrim(p_texto), '') is null or not imobdesk.at_auto_conversa(c.id) then
    return null;
  end if;
  insert into imobdesk.at_mensagens (conversa_id, atendimento_id, direcao, autor, tipo, texto, status)
  values (c.id, c.atendimento_id, 'saida', 'auto', 'texto', left(p_texto, 4000), 'pendente')
  returning id into v_id;
  return v_id;
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
    select st.categoria into v_cat from imobdesk.ch_tickets t join imobdesk.ch_status st on st.id = t.status_id where t.id = v_ticket;
    if v_cat in ('pendente', 'resolvido') then
      update imobdesk.ch_tickets
         set status_id = imobdesk.ch_status_de('andamento', case when v_cat = 'resolvido' then 'Reaberto' else 'Em atendimento' end), justificativa_id = null
       where id = v_ticket;
    end if;
    perform imobdesk.at_repassar(c.id, v_ticket, 'mensagem', format(E'💬 *#%s* · %s:\n"%s"', v_ticket, v_nome, left(v_texto, 1500)));
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
        v_ticket := imobdesk.at_entrar_fila(c.id, array(select jsonb_array_elements_text(coalesce(v_ident -> 'pedido', '[]'))),
                                                     format('Obrigado, %s!', imobdesk.at_primeiro_nome(imobdesk.at_nome_da_conversa(c))));
        return jsonb_build_object('estado', 'fila', 'conversaId', c.id, 'ticketId', v_ticket);
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
        v_ticket := imobdesk.at_entrar_fila(c.id, array(select jsonb_array_elements_text(coalesce(v_ident -> 'pedido', '[]'))),
                                                     'Pronto! Da próxima vez eu já te reconheço.');
        return jsonb_build_object('estado', 'fila', 'conversaId', c.id, 'ticketId', v_ticket);
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

    -- Resposta que não serve para o passo: repete a pergunta (3 vezes; depois segue para a fila).
    v_tent := v_tent + 1;
    if v_tent >= 3 then
      v_base := coalesce(nullif(v_ident ->> 'pessoaId', '')::bigint, l.pessoa_id);
      if v_base is not null then update imobdesk.at_conversas set pessoa_id = v_base where id = c.id; end if;
      perform imobdesk.at_evento(c.id, 'Identificação não concluída: segue para a fila');
      v_ticket := imobdesk.at_entrar_fila(c.id, array(select jsonb_array_elements_text(coalesce(v_ident -> 'pedido', '[]'))) || v_texto);
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
             ident = jsonb_build_object('passo', 'confirmar', 'tentativas', 0, 'desde', now(), 'pedido', jsonb_build_array(v_texto), 'pessoaId', v_base)
      where id = c.id;
      perform imobdesk.at_auto(c.id, format('Olá! Bem-vindo(a) ao suporte do setor %s. Você é %s (%s)? Responda 1 para Sim ou 2 para Não.', s.nome,
        (select pe.nome from imobdesk.at_pessoas pe where pe.id = v_base),
        coalesce((select pc.valor from imobdesk.at_pessoa_contatos pc where pc.pessoa_id = v_base and pc.tipo = 'email' order by pc.principal desc, pc.id limit 1), 'sem e-mail')));
      return jsonb_build_object('estado', 'identificando', 'conversaId', c.id);
    else
      -- Não achou: pede nome e e-mail para cadastrar.
      update imobdesk.at_conversas set modo = 'robo', ident = jsonb_build_object('passo', 'nome', 'tentativas', 0, 'desde', now(), 'pedido', jsonb_build_array(v_texto))
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

  v_ticket := imobdesk.at_entrar_fila(c.id, array[v_texto]);
  return jsonb_build_object('estado', 'fila', 'conversaId', c.id, 'ticketId', v_ticket);
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
    perform imobdesk.erro('INVALID_INPUT', case when c.modo = 'robo' then 'O colaborador ainda está se identificando.' else 'Conversa encerrada. Ela reabre quando o cliente escrever de novo.' end);
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

/**
 * Mensagem digitada no próprio celular do número do sistema (OpenWA, evento message.sent). p:
 *   {sessao, para: telefone do colaborador, texto, externoId}
 * Só vale para conversa em atendimento; o eco do que o sistema enviou é ignorado. "RESOLVIDO" encerra resolvendo.
 */
create or replace function imobdesk.at_whatsapp_propria(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  n imobdesk.at_numeros;
  c imobdesk.at_conversas;
  v_para text := regexp_replace(coalesce(p ->> 'para', ''), '\D', '', 'g');
  v_texto text := left(btrim(coalesce(p ->> 'texto', '')), 4000);
  v_ext text := nullif(p ->> 'externoId', '');
  v_usr uuid;
  v_ticket bigint;
  v_eco bigint;
  v_msg bigint;
begin
  select * into n from imobdesk.at_numeros z where z.canal = 'openwa' and z.openwa_sessao = p ->> 'sessao' and z.ativo;
  if n.id is null or v_texto = '' then return jsonb_build_object('estado', 'ignorado', 'motivo', 'sem número ou sem texto'); end if;
  select * into c from imobdesk.at_conversas z where z.numero_id = n.id and z.telefone = v_para for update;
  if c.id is null or c.modo not in ('fila', 'atendente') then
    return jsonb_build_object('estado', 'ignorado', 'motivo', 'conversa fora de atendimento');
  end if;
  -- Eco do que o próprio sistema mandou (o id pode ainda não ter voltado do envio): mesmo texto nos últimos 10 min.
  if v_ext is not null and exists (select 1 from imobdesk.at_mensagens m where m.externo_id = v_ext) then
    return jsonb_build_object('estado', 'eco');
  end if;
  select m.id into v_eco from imobdesk.at_mensagens m
  where m.conversa_id = c.id and m.direcao = 'saida' and m.criado_em > now() - interval '10 minutes'
    and (m.texto = v_texto or v_texto like '%' || m.texto) and (m.externo_id is null or m.externo_id = v_ext)
  order by m.id desc limit 1;
  if v_eco is not null then
    update imobdesk.at_mensagens set externo_id = coalesce(externo_id, v_ext) where id = v_eco;
    return jsonb_build_object('estado', 'eco');
  end if;

  -- Quem respondeu: o atendente da conversa ou o atendente cadastrado com este número.
  v_usr := coalesce(c.atendente_id, (select a.usuario_id from imobdesk.at_atendentes a where a.whatsapp = n.numero and a.setor_id = n.setor_id));
  if v_usr is not null and c.atendente_id is distinct from v_usr then
    perform imobdesk.at_conversa_executar(c.id, v_usr, jsonb_build_object('acao', 'assumir', 'origem', 'celular'));
  end if;
  if imobdesk.at_eh_resolvido(v_texto) then
    return imobdesk.at_conversa_executar(c.id, v_usr, jsonb_build_object('acao', 'encerrar', 'resolvido', true, 'direto', true, 'origem', 'celular'))
           || jsonb_build_object('estado', 'resolvido', 'conversaId', c.id);
  end if;
  v_ticket := imobdesk.at_ticket_da_conversa(c.id);
  insert into imobdesk.at_mensagens (conversa_id, atendimento_id, direcao, autor, autor_id, tipo, texto, status, externo_id)
  values (c.id, c.atendimento_id, 'saida', 'atendente', v_usr, 'texto', v_texto, 'enviada', v_ext)
  returning id into v_msg;
  perform imobdesk.at_ticket_acao(v_ticket, 'saida', v_usr, coalesce(imobdesk.ch_nome_usuario(v_usr), 'Atendente'), v_texto, v_msg, 'enviado');
  update imobdesk.at_conversas set ultima_msg_atendente_em = now(), ultima_msg_em = now(), ultima_previa = left('Você: ' || v_texto, 200), nao_lidas = 0, atualizado_em = now()
  where id = c.id;
  update imobdesk.at_atendimentos set primeira_resposta_em = coalesce(primeira_resposta_em, now()) where id = c.atendimento_id;
  return jsonb_build_object('estado', 'registrada', 'conversaId', c.id, 'ticketId', v_ticket);
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
        'id', s.id, 'nome', s.nome, 'waIdentificar', s.wa_identificar, 'waSoCorporativo', s.wa_so_corporativo, 'waRespostasAuto', s.wa_respostas_auto,
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
    msg_nao_corporativo = v_msg, atualizado_em = now(), atualizado_por = v_ator
  where id = v_setor;
  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', 'update', 'Regras de WhatsApp do setor alteradas', null, p, v_setor::text);
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array['at_auto_conversa(bigint)', 'at_ticket_resolver_direto(bigint, uuid)', 'at_whatsapp_propria(jsonb)'] loop
    execute format('revoke execute on function imobdesk.%s from public, anon, authenticated', f);
    execute format('grant execute on function imobdesk.%s to service_role', f);
  end loop;
  revoke execute on function imobdesk.at_eh_resolvido(text) from public, anon;
  grant execute on function imobdesk.at_eh_resolvido(text) to authenticated, service_role;
end;
$$;

notify pgrst, 'reload schema';
