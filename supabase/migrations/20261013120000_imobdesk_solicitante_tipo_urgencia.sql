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
