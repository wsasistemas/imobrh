-- WhatsApp pelo OpenWA, opção A (docs/PLANO-conversas-whatsapp-openwa.md, Fase 3; aprovado em 09/10/2026).
-- O colaborador fala no privado com o número do sistema do setor; cada pedido é repassado ao grupo interno só de
-- atendentes; a resposta que CITA o repasse (no celular ou no sistema) chega ao privado do colaborador.
-- Credenciais (URL do OpenWA, API key) e o segredo do webhook ficam no Vault. Linhas corporativas (planilha da
-- operadora) e o WhatsApp de cada atendente são cadastrados aqui. Só aditiva.

-- ======================================================================= credenciais

alter table imobdesk.at_config add column if not exists openwa_url text check (openwa_url ~ '^https?://[^\s]+$');
alter table imobdesk.at_config add column if not exists openwa_chave_id uuid;
alter table imobdesk.at_config add column if not exists openwa_chave_mascara text;
alter table imobdesk.at_config add column if not exists openwa_definido_em timestamptz;
alter table imobdesk.at_config add column if not exists openwa_verificacao jsonb;

-- Segredo do webhook (HMAC-SHA256 do corpo, cabeçalho X-OpenWA-Signature). Gerado uma vez; a Edge cadastra no OpenWA.
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'imobdesk_openwa_webhook') then
    perform vault.create_secret(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'imobdesk_openwa_webhook',
      'Segredo do webhook do OpenWA (Imobdesk)');
  end if;
end;
$$;

-- Eventos crus do webhook (idempotência pelo idempotencyKey do OpenWA e diagnóstico).
create table if not exists imobdesk.at_eventos_openwa (
  id           bigint      generated always as identity primary key,
  recebido_em  timestamptz not null default now(),
  chave        text        unique,
  evento       text,
  sessao       text,
  payload      jsonb       not null,
  resultado    jsonb
);
create index if not exists at_eventos_openwa_recebido_idx on imobdesk.at_eventos_openwa (recebido_em desc);
alter table imobdesk.at_eventos_openwa enable row level security;
revoke all on imobdesk.at_eventos_openwa from anon, public, authenticated;
grant all on imobdesk.at_eventos_openwa to service_role;

/** URL do OpenWA e, se informada, a API key (Vault). Só o super admin. */
create or replace function imobdesk.at_openwa_salvar(p jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := auth.uid();
  v_url text := rtrim(btrim(coalesce(p ->> 'url', '')), '/');
  v_chave text := btrim(coalesce(p ->> 'chave', ''));
  v_id uuid;
begin
  if v_ator is null or not imobdesk.eh_super_admin() then
    perform imobdesk.erro('FORBIDDEN', 'Só o super admin altera a conexão do OpenWA.');
  end if;
  if v_url !~ '^https?://[^\s]+$' then
    perform imobdesk.erro('INVALID_INPUT', 'Informe a URL do OpenWA (ex.: https://xxxx.trycloudflare.com).', 'url');
  end if;
  if v_chave <> '' then
    if v_chave !~ '^[A-Za-z0-9_.-]+$' or length(v_chave) not between 16 and 300 then
      perform imobdesk.erro('INVALID_INPUT', 'API key inválida: copie a chave inteira do OpenWA (data/.api-key).', 'chave');
    end if;
    v_id := coalesce((select c.openwa_chave_id from imobdesk.at_config c where c.id),
                     (select s.id from vault.secrets s where s.name = ('imobdesk_openwa_chave_' || imobdesk.empresa_atual())));
    if v_id is null then
      v_id := vault.create_secret(v_chave, ('imobdesk_openwa_chave_' || imobdesk.empresa_atual()), 'API key do OpenWA (Imobdesk)');
    else
      perform vault.update_secret(v_id, v_chave);
    end if;
    update imobdesk.at_config set openwa_chave_id = v_id, openwa_chave_mascara = '••••••••' || right(v_chave, 4) where id;
  end if;
  update imobdesk.at_config set openwa_url = v_url, openwa_definido_em = now(), openwa_verificacao = null, atualizado_em = now(), atualizado_por = v_ator where id;
  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', 'update', 'Conexão do OpenWA alterada', null, jsonb_build_object('url', v_url), 'at_config');
end;
$$;

/** Só para as Edge Functions. */
create or replace function imobdesk.at_ler_credencial_openwa()
returns table (url text, chave text, webhook_segredo text)
language sql
stable
security definer
set search_path = ''
as $$
  select c.openwa_url,
         (select d.decrypted_secret from vault.decrypted_secrets d where d.id = c.openwa_chave_id),
         (select d.decrypted_secret from vault.decrypted_secrets d where d.name = 'imobdesk_openwa_webhook')
  from imobdesk.at_config c where c.id;
$$;

-- ======================================================================= tela "WhatsApp OpenWA"

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
        'id', s.id, 'nome', s.nome, 'waIdentificar', s.wa_identificar, 'waSoCorporativo', s.wa_so_corporativo,
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

/** Número → canal (zenvia/openwa), sessão do OpenWA e grupo interno. Supervisão geral. */
create or replace function imobdesk.at_openwa_numero_salvar(p jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := auth.uid();
  v_id bigint := (p ->> 'numeroId')::bigint;
  v_canal text := coalesce(nullif(p ->> 'canal', ''), 'zenvia');
  v_sessao text := nullif(btrim(p ->> 'sessao'), '');
  v_grupo text := nullif(btrim(p ->> 'grupo'), '');
  v_antes jsonb;
begin
  if v_ator is null or not imobdesk.at_supervisor() then
    perform imobdesk.erro('FORBIDDEN', 'Só a supervisão geral configura os números.');
  end if;
  select to_jsonb(n) into v_antes from imobdesk.at_numeros n where n.id = v_id;
  if v_antes is null then perform imobdesk.erro('NOT_FOUND', 'Número não encontrado.'); end if;
  if v_canal not in ('zenvia', 'openwa') then perform imobdesk.erro('INVALID_INPUT', 'Canal inválido.', 'canal'); end if;
  if v_canal = 'openwa' and v_sessao is null then
    perform imobdesk.erro('INVALID_INPUT', 'Informe a sessão do OpenWA deste número.', 'sessao');
  end if;
  if v_grupo is not null and v_grupo !~ '@g\.us$' then
    perform imobdesk.erro('INVALID_INPUT', 'Escolha um grupo do WhatsApp (id terminando em @g.us).', 'grupo');
  end if;
  if v_sessao is not null and exists (select 1 from imobdesk.at_numeros n where n.openwa_sessao = v_sessao and n.ativo and n.id <> v_id) then
    perform imobdesk.erro('DUPLICATE', 'Esta sessão já está em outro número.', 'sessao');
  end if;
  update imobdesk.at_numeros set canal = v_canal,
    openwa_sessao = case when v_canal = 'openwa' then v_sessao end,
    grupo_interno = case when v_canal = 'openwa' then v_grupo end,
    grupo_interno_nome = case when v_canal = 'openwa' then nullif(left(btrim(p ->> 'grupoNome'), 120), '') end
  where id = v_id;
  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', 'update', format('Número %s: canal %s', v_antes ->> 'numero', v_canal),
    v_antes, (select to_jsonb(n) from imobdesk.at_numeros n where n.id = v_id), v_id::text);
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
    msg_nao_corporativo = v_msg, atualizado_em = now(), atualizado_por = v_ator
  where id = v_setor;
  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', 'update', 'Regras de WhatsApp do setor alteradas', null, p, v_setor::text);
end;
$$;

/** WhatsApp pessoal do atendente (quem responde no grupo interno). Gestão do setor ou o próprio atendente. */
create or replace function imobdesk.at_atendente_whatsapp_salvar(p jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := auth.uid();
  v_usuario uuid := (p ->> 'usuarioId')::uuid;
  v_setor bigint := (select a.setor_id from imobdesk.at_atendentes a where a.usuario_id = v_usuario);
  v_num text := nullif(imobdesk.at_contato_normalizar('whatsapp', p ->> 'whatsapp'), '');
begin
  if v_setor is null then perform imobdesk.erro('NOT_FOUND', 'Atendente não encontrado.'); end if;
  if v_ator is null or not (v_ator = v_usuario or imobdesk.at_gestor_de(v_setor)) then
    perform imobdesk.erro('FORBIDDEN', 'Só a gestão do setor altera o WhatsApp de outro atendente.');
  end if;
  if v_num is not null and v_num !~ '^\d{10,15}$' then
    perform imobdesk.erro('INVALID_INPUT', 'Telefone inválido (com DDD).', 'whatsapp');
  end if;
  if v_num is not null and exists (select 1 from imobdesk.at_atendentes a where a.whatsapp = v_num and a.usuario_id <> v_usuario) then
    perform imobdesk.erro('DUPLICATE', 'Este número já está em outro atendente.', 'whatsapp');
  end if;
  update imobdesk.at_atendentes set whatsapp = v_num where usuario_id = v_usuario;
end;
$$;

-- ======================================================================= linhas corporativas

/** Linhas cadastradas (corporativas e confirmadas), com a pessoa. Gestão do atendimento. */
create or replace function imobdesk.at_linhas_lista(p_busca text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_q text := lower(btrim(coalesce(p_busca, '')));
begin
  if auth.uid() is null or not (imobdesk.at_supervisor() or exists (select 1 from imobdesk.at_setores s where imobdesk.at_gestor_de(s.id))) then
    perform imobdesk.erro('FORBIDDEN', 'Só a gestão do atendimento vê as linhas.');
  end if;
  return coalesce((
    select jsonb_agg(x order by x ->> 'pessoa' nulls last, x ->> 'numero')
    from (
      select jsonb_build_object('numero', l.numero, 'corporativa', l.corporativa, 'confirmadoEm', l.confirmado_em, 'observacao', l.observacao,
                                'pessoaId', l.pessoa_id, 'pessoa', pe.nome,
                                'email', (select pc.valor from imobdesk.at_pessoa_contatos pc where pc.pessoa_id = l.pessoa_id and pc.tipo = 'email' order by pc.principal desc, pc.id limit 1)) x
      from imobdesk.at_linhas l
      left join imobdesk.at_pessoas pe on pe.id = l.pessoa_id
      where v_q = '' or l.numero like '%' || regexp_replace(v_q, '\D', '', 'g') || '%' and regexp_replace(v_q, '\D', '', 'g') <> ''
         or lower(coalesce(pe.nome, '')) like '%' || v_q || '%' or lower(coalesce(l.observacao, '')) like '%' || v_q || '%'
      limit 2000
    ) y
  ), '[]');
end;
$$;

/**
 * Importa/salva linhas corporativas. p: [{numero, nome?, email?, observacao?}]. Com e-mail, liga (ou cria) a
 * pessoa; o colaborador ainda confirma no 1º contato. Devolve {salvas, invalidas: [numero]}.
 */
create or replace function imobdesk.at_linhas_importar(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := auth.uid();
  r jsonb;
  v_num text;
  v_email text;
  v_pessoa bigint;
  v_salvas int := 0;
  v_invalidas text[] := '{}';
begin
  if v_ator is null or not imobdesk.at_supervisor() then
    perform imobdesk.erro('FORBIDDEN', 'Só a supervisão geral cadastra linhas corporativas.');
  end if;
  if jsonb_typeof(p) <> 'array' or jsonb_array_length(p) > 5000 then
    perform imobdesk.erro('INVALID_INPUT', 'Envie até 5.000 linhas por vez.');
  end if;
  for r in select * from jsonb_array_elements(p) loop
    v_num := imobdesk.at_contato_normalizar('whatsapp', r ->> 'numero');
    if v_num !~ '^\d{10,15}$' then
      v_invalidas := v_invalidas || left(coalesce(r ->> 'numero', ''), 30);
      continue;
    end if;
    v_pessoa := null;
    v_email := lower(btrim(coalesce(r ->> 'email', '')));
    if v_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
      v_pessoa := imobdesk.at_pessoa_identificar('email', v_email, nullif(btrim(r ->> 'nome'), ''), 'Linhas corporativas');
      insert into imobdesk.at_pessoa_contatos (pessoa_id, tipo, valor, principal)
      values (v_pessoa, 'whatsapp', v_num, not exists (select 1 from imobdesk.at_pessoa_contatos x where x.pessoa_id = v_pessoa and x.tipo = 'whatsapp'))
      on conflict (tipo, valor) do update set pessoa_id = excluded.pessoa_id;
    end if;
    insert into imobdesk.at_linhas (numero, pessoa_id, corporativa, observacao, atualizado_por)
    values (v_num, v_pessoa, true, nullif(left(btrim(r ->> 'observacao'), 200), ''), v_ator)
    on conflict (numero) do update set corporativa = true,
      pessoa_id = coalesce(excluded.pessoa_id, imobdesk.at_linhas.pessoa_id),
      -- Mudou a pessoa da linha: precisa confirmar de novo.
      confirmado_em = case when excluded.pessoa_id is not null and excluded.pessoa_id is distinct from imobdesk.at_linhas.pessoa_id then null
                           else imobdesk.at_linhas.confirmado_em end,
      observacao = coalesce(excluded.observacao, imobdesk.at_linhas.observacao),
      atualizado_em = now(), atualizado_por = v_ator;
    v_salvas := v_salvas + 1;
  end loop;
  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', 'update', format('Linhas corporativas: %s salvas, %s inválidas', v_salvas, cardinality(v_invalidas)), null, null, 'at_linhas');
  return jsonb_build_object('salvas', v_salvas, 'invalidas', to_jsonb(v_invalidas));
end;
$$;

/** Tira a linha da lista corporativa (o histórico da pessoa continua). */
create or replace function imobdesk.at_linha_remover(p_numero text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := auth.uid();
begin
  if v_ator is null or not imobdesk.at_supervisor() then
    perform imobdesk.erro('FORBIDDEN', 'Só a supervisão geral altera as linhas corporativas.');
  end if;
  delete from imobdesk.at_linhas where numero = regexp_replace(coalesce(p_numero, ''), '\D', '', 'g');
  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', 'delete', 'Linha corporativa removida: ' || coalesce(p_numero, ''), null, null, 'at_linhas');
end;
$$;

-- ======================================================================= grupo interno

/**
 * Mensagem no grupo interno de atendentes (OpenWA, service role). p:
 *   {sessao, grupo, autor: telefone de quem escreveu, texto, citadoId?, externoId}
 * Resposta citando um repasse → vai ao colaborador como resposta do atendente. Sem citação → dica (1 a cada 30 min).
 */
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
  v_core text;
  v_res jsonb;
begin
  select * into n from imobdesk.at_numeros z where z.canal = 'openwa' and z.openwa_sessao = p ->> 'sessao' and z.grupo_interno = p ->> 'grupo' and z.ativo;
  if n.id is null then return jsonb_build_object('estado', 'ignorado', 'motivo', 'grupo não configurado'); end if;
  select * into a from imobdesk.at_atendentes z where z.whatsapp = v_autor and z.setor_id = n.setor_id;
  if a.usuario_id is null then return jsonb_build_object('estado', 'ignorado', 'motivo', 'autor não é atendente do setor'); end if;
  if v_texto = '' then return jsonb_build_object('estado', 'ignorado', 'motivo', 'sem texto'); end if;

  if v_cit is null then
    -- Conversa entre atendentes é livre; a dica sai no máximo a cada 30 min por atendente.
    if a.grupo_dica_em is null or a.grupo_dica_em < now() - interval '30 minutes' then
      update imobdesk.at_atendentes set grupo_dica_em = now() where usuario_id = a.usuario_id;
      insert into imobdesk.at_repasses (numero_id, tipo, texto, citar_externo_id)
      values (n.id, 'aviso', '💡 Para responder a um colaborador, toque e segure o pedido (🆕 ou 💬) e escolha *Responder*. Mensagens sem citação ficam só aqui no grupo.', nullif(p ->> 'externoId', ''));
    end if;
    return jsonb_build_object('estado', 'sem_citacao');
  end if;

  -- O id citado pode vir completo (true_<grupo>_<id>_<autor>) ou só o miolo: compara pelo miolo.
  v_core := case when v_cit ~ '^(true|false)_' then split_part(v_cit, '_', 3) else v_cit end;
  select * into x from imobdesk.at_repasses r
  where r.numero_id = n.id and r.externo_id is not null and r.conversa_id is not null
    and (r.externo_id = v_cit or split_part(r.externo_id, '_', 3) = v_core or r.externo_id = v_core)
  order by r.id desc limit 1;
  if x.id is null then
    insert into imobdesk.at_repasses (numero_id, tipo, texto, citar_externo_id)
    values (n.id, 'aviso', '⚠️ Não achei o pedido citado. Cite a mensagem 🆕 ou 💬 do colaborador.', nullif(p ->> 'externoId', ''));
    return jsonb_build_object('estado', 'citacao_desconhecida');
  end if;

  select * into c from imobdesk.at_conversas z where z.id = x.conversa_id;
  if c.modo in ('encerrada', 'robo') then
    insert into imobdesk.at_repasses (numero_id, conversa_id, ticket_id, tipo, texto, citar_externo_id)
    values (n.id, c.id, x.ticket_id, 'aviso', format('⚠️ O atendimento do *#%s* já foi encerrado. Para falar com o colaborador, responda pelo ticket no sistema.', x.ticket_id), nullif(p ->> 'externoId', ''));
    return jsonb_build_object('estado', 'encerrada');
  end if;
  if c.modo = 'atendente' and c.atendente_id is distinct from a.usuario_id and not exists (
       select 1 from imobdesk.at_setor_gestores g where g.setor_id = c.setor_id and g.usuario_id = a.usuario_id) then
    insert into imobdesk.at_repasses (numero_id, conversa_id, ticket_id, tipo, texto, citar_externo_id)
    values (n.id, c.id, x.ticket_id, 'aviso', format('⚠️ O *#%s* está com %s. Combine com ele(a) ou peça a transferência.', x.ticket_id, imobdesk.ch_nome_usuario(c.atendente_id)),
            nullif(p ->> 'externoId', ''));
    return jsonb_build_object('estado', 'com_outro');
  end if;

  v_res := imobdesk.at_conversa_executar(c.id, a.usuario_id, jsonb_build_object('acao', 'enviar', 'texto', v_texto, 'origem', 'grupo', 'podeTomar', true));
  insert into imobdesk.at_repasses (numero_id, conversa_id, ticket_id, tipo, texto, citar_externo_id)
  values (n.id, c.id, x.ticket_id, 'enviado', format('✔ Enviado a %s (*#%s*)', imobdesk.at_nome_da_conversa(c), x.ticket_id), nullif(p ->> 'externoId', ''));
  return jsonb_build_object('estado', 'enviada', 'conversaId', c.id, 'ticketId', x.ticket_id) || coalesce(v_res, '{}');
end;
$$;

/** Resultado do "Testar conexão" (Edge). */
create or replace function imobdesk.at_openwa_verificacao_salvar(p jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  update imobdesk.at_config set openwa_verificacao = p where id;
$$;

-- ======================================================================= permissões

do $$
declare
  f text;
begin
  foreach f in array array['at_openwa_salvar(jsonb)', 'at_openwa_painel()', 'at_openwa_numero_salvar(jsonb)', 'at_setor_whatsapp_salvar(jsonb)',
                           'at_atendente_whatsapp_salvar(jsonb)', 'at_linhas_lista(text)', 'at_linhas_importar(jsonb)', 'at_linha_remover(text)'] loop
    execute format('revoke execute on function imobdesk.%s from public, anon', f);
    execute format('grant execute on function imobdesk.%s to authenticated, service_role', f);
  end loop;
  foreach f in array array['at_ler_credencial_openwa()', 'at_grupo_receber(jsonb)', 'at_openwa_verificacao_salvar(jsonb)'] loop
    execute format('revoke execute on function imobdesk.%s from public, anon, authenticated', f);
    execute format('grant execute on function imobdesk.%s to service_role', f);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
