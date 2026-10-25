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
