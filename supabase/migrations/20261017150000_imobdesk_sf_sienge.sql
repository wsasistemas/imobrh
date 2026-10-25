-- Solicitações Financeiras, Fase 5 (parte 2): integração SIENGE (CONTEXTO.md, seção 6; pedido do Wagner, 17/10/2026).
-- Configurações › Integrações › SIENGE: subdomínio, usuário e senha da API (senha no Vault) e os padrões do título
-- (empresa pagadora, tipo de documento, indexador, plano financeiro por tipo, centro de custo padrão). O botão
-- "Lançamento no SIENGE" da conferência chama a Edge Function imobdesk-sf-sienge, que cria o título a pagar
-- (POST /bills), anexa o PDF do formulário e os comprovantes e grava o número do título. Idempotente pelo número SF-…:
-- antes de criar, procura o título com o mesmo documentNumber. Credor inexistente = erro claro, sem cadastro automático.
-- Só aditiva.

create table if not exists imobdesk.sf_sienge_config (
  id                    boolean       primary key default true check (id),
  ativo                 boolean       not null default false,
  ambiente              text          not null default 'homologacao' check (ambiente in ('homologacao', 'producao')),
  subdominio            text          check (subdominio ~ '^[a-z0-9-]{2,60}$'),
  usuario               text          check (length(usuario) <= 120),
  senha_segredo_id      uuid,
  senha_definida_em     timestamptz,
  empresa_id            int           check (empresa_id > 0),
  tipo_documento        text          check (length(tipo_documento) between 1 and 10),
  indexador_id          int           check (indexador_id >= 0),
  plano_reembolso       text          check (plano_reembolso ~ '^\d{1,9}$'),
  plano_fundo_fixo      text          check (plano_fundo_fixo ~ '^\d{1,9}$'),
  plano_adiantamento    text          check (plano_adiantamento ~ '^\d{1,9}$'),
  centro_custo_padrao   int           check (centro_custo_padrao > 0),
  ultimo_teste          jsonb,
  atualizado_em         timestamptz   not null default now(),
  atualizado_por        uuid
);
insert into imobdesk.sf_sienge_config (id) values (true) on conflict (id) do nothing;

alter table imobdesk.sf_solicitacao add column if not exists sienge_status text check (sienge_status in ('lancando', 'erro'));
alter table imobdesk.sf_solicitacao add column if not exists sienge_erro text;
alter table imobdesk.sf_solicitacao add column if not exists sienge_credor_id int;
alter table imobdesk.sf_solicitacao add column if not exists sienge_centro_custo int;
alter table imobdesk.sf_solicitacao add column if not exists sienge_plano text;

do $$
begin
  execute 'alter table imobdesk.sf_sienge_config enable row level security';
  execute 'revoke all on imobdesk.sf_sienge_config from anon, public, authenticated';
  execute 'grant all on imobdesk.sf_sienge_config to service_role';
end;
$$;

-- ---------- Tela da integração (Admin e Super admin) ----------
create or replace function imobdesk.sf_sienge_config_ler()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c imobdesk.sf_sienge_config;
begin
  perform imobdesk.sf_exigir_admin();
  select * into c from imobdesk.sf_sienge_config where id;
  return jsonb_build_object(
    'ativo', c.ativo, 'ambiente', c.ambiente, 'subdominio', c.subdominio, 'usuario', c.usuario,
    'senhaDefinida', c.senha_segredo_id is not null, 'senhaDefinidaEm', c.senha_definida_em,
    'empresaId', c.empresa_id, 'tipoDocumento', c.tipo_documento, 'indexadorId', c.indexador_id,
    'planoReembolso', c.plano_reembolso, 'planoFundoFixo', c.plano_fundo_fixo, 'planoAdiantamento', c.plano_adiantamento,
    'centroCustoPadrao', c.centro_custo_padrao, 'ultimoTeste', c.ultimo_teste, 'atualizadoEm', c.atualizado_em);
end;
$$;

create or replace function imobdesk.sf_sienge_config_salvar(p jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := imobdesk.sf_exigir_admin();
  v_sub text := lower(nullif(btrim(p ->> 'subdominio'), ''));
  v_plano text;
begin
  if v_sub is not null and v_sub !~ '^[a-z0-9-]{2,60}$' then
    perform imobdesk.erro('INVALID_INPUT', 'O subdomínio é só o nome do cliente no endereço (ex.: em api.sienge.com.br/suaempresa/…, é "suaempresa").', 'subdominio');
  end if;
  foreach v_plano in array array[p ->> 'planoReembolso', p ->> 'planoFundoFixo', p ->> 'planoAdiantamento'] loop
    if nullif(btrim(v_plano), '') is not null and btrim(v_plano) !~ '^\d{1,9}$' then
      perform imobdesk.erro('INVALID_INPUT', 'O plano financeiro vai sem máscara, só números (ex.: 2010101).', 'planos');
    end if;
  end loop;
  if coalesce((p ->> 'ativo')::boolean, false) and (v_sub is null or nullif(btrim(p ->> 'usuario'), '') is null
       or nullif(p ->> 'empresaId', '') is null or nullif(btrim(p ->> 'tipoDocumento'), '') is null or nullif(p ->> 'indexadorId', '') is null) then
    perform imobdesk.erro('INVALID_INPUT', 'Para ativar, preencha subdomínio, usuário, empresa, tipo de documento e indexador.', 'ativo');
  end if;
  if coalesce((p ->> 'ativo')::boolean, false) and not exists (select 1 from imobdesk.sf_sienge_config where id and senha_segredo_id is not null) then
    perform imobdesk.erro('INVALID_INPUT', 'Para ativar, salve a senha da API.', 'ativo');
  end if;
  update imobdesk.sf_sienge_config
     set ativo = coalesce((p ->> 'ativo')::boolean, false),
         ambiente = case when p ->> 'ambiente' = 'producao' then 'producao' else 'homologacao' end,
         subdominio = v_sub,
         usuario = left(nullif(btrim(p ->> 'usuario'), ''), 120),
         empresa_id = nullif(p ->> 'empresaId', '')::int,
         tipo_documento = upper(left(nullif(btrim(p ->> 'tipoDocumento'), ''), 10)),
         indexador_id = nullif(p ->> 'indexadorId', '')::int,
         plano_reembolso = nullif(btrim(p ->> 'planoReembolso'), ''),
         plano_fundo_fixo = nullif(btrim(p ->> 'planoFundoFixo'), ''),
         plano_adiantamento = nullif(btrim(p ->> 'planoAdiantamento'), ''),
         centro_custo_padrao = nullif(p ->> 'centroCustoPadrao', '')::int,
         atualizado_em = now(), atualizado_por = v_ator
   where id;
  perform imobdesk.registrar_auditoria(v_ator, 'integracoes', 'update', 'SIENGE: configuração salva', null, p - 'senha', 'sienge');
end;
$$;

/** Senha da API no Vault (nunca volta para a tela). */
create or replace function imobdesk.sf_sienge_senha_salvar(p_senha text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := imobdesk.sf_exigir_admin();
  v_id uuid;
begin
  if length(coalesce(p_senha, '')) < 4 then perform imobdesk.erro('INVALID_INPUT', 'Informe a senha da API do SIENGE.', 'senha'); end if;
  select senha_segredo_id into v_id from imobdesk.sf_sienge_config where id;
  if v_id is null or not exists (select 1 from vault.secrets where id = v_id) then
    v_id := vault.create_secret(p_senha, 'imobdesk_sienge_senha_' || replace(gen_random_uuid()::text, '-', ''), 'Senha da API SIENGE (Imobdesk)');
  else
    perform vault.update_secret(v_id, p_senha);
  end if;
  update imobdesk.sf_sienge_config set senha_segredo_id = v_id, senha_definida_em = now(), ultimo_teste = null,
         atualizado_em = now(), atualizado_por = v_ator where id;
  perform imobdesk.registrar_auditoria(v_ator, 'integracoes', 'update', 'SIENGE: senha da API salva no cofre', null, null, 'sienge');
end;
$$;

-- ---------- Para a Edge Function (service_role) ----------
create or replace function imobdesk.sf_sienge_credenciais()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'ativo', c.ativo, 'ambiente', c.ambiente, 'subdominio', c.subdominio, 'usuario', c.usuario,
    'senha', (select d.decrypted_secret from vault.decrypted_secrets d where d.id = c.senha_segredo_id),
    'empresaId', c.empresa_id, 'tipoDocumento', c.tipo_documento, 'indexadorId', c.indexador_id,
    'planoReembolso', c.plano_reembolso, 'planoFundoFixo', c.plano_fundo_fixo, 'planoAdiantamento', c.plano_adiantamento,
    'centroCustoPadrao', c.centro_custo_padrao)
  from imobdesk.sf_sienge_config c where c.id;
$$;

create or replace function imobdesk.sf_sienge_teste_registrar(p jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  update imobdesk.sf_sienge_config set ultimo_teste = p || jsonb_build_object('em', now()) where id;
$$;

/** Quem pode lançar e consultar listas do SIENGE: Financeiro ou admin (checado com o token da pessoa). */
create or replace function imobdesk.sf_sienge_pode_usar()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.sf_exigir_login();
begin
  return jsonb_build_object('admin', imobdesk.ch_eh_admin(),
                            'financeiro', imobdesk.ch_eh_admin() or imobdesk.sf_eh_financeiro(v_uid));
end;
$$;

/**
 * Pedido de lançamento (chamado com o token do conferente): confere Financeiro, status em_conferencia, todos os itens
 * resolvidos, e trava ("lancando") contra clique duplo. Devolve o que a função precisa (CPF completo só aqui).
 */
create or replace function imobdesk.sf_lancamento_pedido(p_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := imobdesk.sf_exigir_financeiro();
  s imobdesk.sf_solicitacao;
  v_doc text;
begin
  select * into s from imobdesk.sf_solicitacao where id = p_id for update;
  if not found then perform imobdesk.erro('NOT_FOUND', 'Solicitação não encontrada.'); end if;
  if s.status <> 'em_conferencia' then perform imobdesk.erro('INVALID_INPUT', 'A solicitação não está em conferência.'); end if;
  if s.sienge_status = 'lancando' and s.atualizado_em > now() - interval '3 minutes' then
    perform imobdesk.erro('INVALID_INPUT', 'O lançamento já está em andamento. Aguarde.');
  end if;
  if exists (select 1 from imobdesk.sf_item i where i.solicitacao_id = p_id and i.status_conferencia not in ('aceito', 'glosado')) then
    perform imobdesk.erro('INVALID_INPUT', 'Resolva todos os itens (aceitar ou glosar) antes do lançamento.');
  end if;
  if coalesce(s.valor_a_pagar, 0) <= 0 then perform imobdesk.erro('INVALID_INPUT', 'Valor a pagar zerado: não há o que lançar.'); end if;
  select p.documento into v_doc from imobdesk.at_pessoas p where p.id = s.pessoa_id;
  if coalesce(v_doc, '') !~ '^\d{11}$|^\d{14}$' then
    perform imobdesk.erro('INVALID_INPUT', 'O solicitante está sem CPF no cadastro de Pessoas: sem ele não dá para achar o credor no SIENGE.');
  end if;
  update imobdesk.sf_solicitacao set sienge_status = 'lancando', sienge_erro = null, atualizado_em = now() where id = p_id;
  return jsonb_build_object(
    'id', s.id, 'numero', s.numero, 'tipo', s.tipo, 'cpf', v_doc, 'solicitante', (select u.nome from imobdesk.usuarios u where u.id = s.solicitante_id),
    'setor', (select st.nome from imobdesk.at_setores st where st.id = s.setor_id),
    'centroCusto', s.centro_custo, 'centroCustoSetor', (select st.sf_centro_custo_padrao from imobdesk.at_setores st where st.id = s.setor_id),
    'competencia', s.competencia, 'periodoDe', s.periodo_de, 'periodoAte', s.periodo_ate, 'enviadoEm', s.enviado_em,
    'ultimaAprovacaoEm', s.ultima_aprovacao_em, 'pagarAte', s.pagar_ate, 'vencimento', s.vencimento,
    'total', s.total_despesas, 'glosado', s.valor_glosado, 'aPagar', s.valor_a_pagar, 'siengeId', s.sienge_lancamento_id,
    'anexos', coalesce((select jsonb_agg(jsonb_build_object('path', a.storage_path, 'nome', a.nome_arquivo, 'mime', a.mime, 'ordem', i.ordem) order by i.ordem, a.id)
                        from imobdesk.sf_anexo a join imobdesk.sf_item i on i.id = a.item_id
                        where a.solicitacao_id = s.id and i.status_conferencia in ('aceito', 'glosado')), '[]'));
end;
$$;

/** Resultado do lançamento (service_role). Sucesso: lancamento_gerado com o número do título. */
create or replace function imobdesk.sf_lancamento_registrar(p_id bigint, p_ok boolean, p_titulo text, p_erro text, p_detalhe jsonb default '{}')
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_ok then
    update imobdesk.sf_solicitacao
       set status = 'lancamento_gerado', sienge_lancamento_id = p_titulo, sienge_status = null, sienge_erro = null,
           sienge_credor_id = nullif(p_detalhe ->> 'credorId', '')::int, sienge_centro_custo = nullif(p_detalhe ->> 'centroCusto', '')::int,
           sienge_plano = p_detalhe ->> 'plano', atualizado_em = now()
     where id = p_id;
    insert into imobdesk.sf_evento (solicitacao_id, tipo, ator_id, payload)
    values (p_id, 'lancamento_sienge', nullif(p_detalhe ->> 'atorId', '')::uuid, p_detalhe || jsonb_build_object('titulo', p_titulo));
  else
    update imobdesk.sf_solicitacao set sienge_status = 'erro', sienge_erro = left(p_erro, 1000), atualizado_em = now() where id = p_id;
    insert into imobdesk.sf_evento (solicitacao_id, tipo, ator_id, payload)
    values (p_id, 'lancamento_sienge_erro', nullif(p_detalhe ->> 'atorId', '')::uuid, jsonb_build_object('erro', left(p_erro, 1000)));
  end if;
end;
$$;

/** Dados para o PDF do formulário (quem vê a solicitação). CPF completo só no PDF, conforme a seção 6. */
create or replace function imobdesk.sf_pdf_dados(p_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  d jsonb;
begin
  d := imobdesk.sf_detalhe(p_id);
  return d || jsonb_build_object('cpf', (select p.documento from imobdesk.at_pessoas p join imobdesk.sf_solicitacao s on s.pessoa_id = p.id where s.id = p_id));
end;
$$;

/** Situação do lançamento para a conferência e o detalhe (quem vê a solicitação). */
create or replace function imobdesk.sf_sienge_situacao(p_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not imobdesk.sf_pode_ver(p_id) then perform imobdesk.erro('NOT_FOUND', 'Solicitação não encontrada.'); end if;
  return (select jsonb_build_object('titulo', s.sienge_lancamento_id, 'status', s.sienge_status, 'erro', s.sienge_erro,
                                    'credorId', s.sienge_credor_id, 'centroCusto', s.sienge_centro_custo, 'plano', s.sienge_plano,
                                    'configurada', (select c.ativo from imobdesk.sf_sienge_config c where c.id),
                                    'ambiente', (select c.ambiente from imobdesk.sf_sienge_config c where c.id))
          from imobdesk.sf_solicitacao s where s.id = p_id);
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array['sf_sienge_config_ler()', 'sf_sienge_config_salvar(jsonb)', 'sf_sienge_senha_salvar(text)', 'sf_sienge_pode_usar()',
                           'sf_lancamento_pedido(bigint)', 'sf_pdf_dados(bigint)', 'sf_sienge_situacao(bigint)'] loop
    execute format('revoke execute on function imobdesk.%s from public, anon', f);
    execute format('grant execute on function imobdesk.%s to authenticated, service_role', f);
  end loop;
  foreach f in array array['sf_sienge_credenciais()', 'sf_sienge_teste_registrar(jsonb)', 'sf_lancamento_registrar(bigint, boolean, text, text, jsonb)'] loop
    execute format('revoke execute on function imobdesk.%s from public, anon, authenticated', f);
    execute format('grant execute on function imobdesk.%s to service_role', f);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
