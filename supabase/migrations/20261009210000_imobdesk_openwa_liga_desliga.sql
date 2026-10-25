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
