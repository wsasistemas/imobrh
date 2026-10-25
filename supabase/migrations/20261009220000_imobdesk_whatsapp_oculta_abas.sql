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
