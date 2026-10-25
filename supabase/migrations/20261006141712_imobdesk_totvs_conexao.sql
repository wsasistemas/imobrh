
-- Fase 5 (2/2): conexão TOTVS RM do Imobdesk.
--
-- Usa a tabela que já existe (`integration_settings`, lida pelas rotinas de sync portadas na fase 8),
-- mas a senha passa a ficar no Vault: aqui só a referência (segredo_id) e a máscara.
-- A coluna legada `api_password` (texto puro) deixa de ser obrigatória e nunca é gravada pelo portal.
-- O front não lê a tabela: usa as RPCs abaixo, que nunca devolvem a senha.
-- Aditivo: colunas novas, índice novo, NOT NULL relaxado, uma linha nova. Nada é apagado.

alter table imobdesk.integration_settings
  add column if not exists segredo_id uuid,
  add column if not exists senha_mascara text,
  add column if not exists senha_definida_em timestamptz,
  add column if not exists senha_definida_por text,
  add column if not exists ultimo_teste jsonb,
  add column if not exists atualizado_por uuid;

alter table imobdesk.integration_settings alter column api_password drop not null;
alter table imobdesk.integration_settings alter column api_base_url set default '';
alter table imobdesk.integration_settings alter column api_user set default '';

comment on column imobdesk.integration_settings.api_password is
  'LEGADO, não usar: texto puro. A senha do portal fica no Vault (segredo_id).';
comment on column imobdesk.integration_settings.segredo_id is 'vault.secrets.id da senha da API TOTVS RM.';

-- Uma conexão por nome; o portal usa a linha "TOTVS RM".
create unique index if not exists integration_settings_name_key on imobdesk.integration_settings (name);

insert into imobdesk.integration_settings (name, api_base_url, api_user, is_active)
values ('TOTVS RM', '', '', false)
on conflict (name) do nothing;

create or replace trigger integration_settings_atualizado_em
  before update on imobdesk.integration_settings
  for each row execute function imobdesk.definir_atualizado_em();

-- ---------- Leitura para a tela (sem senha) ----------

create or replace function imobdesk.obter_conexao_totvs()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v imobdesk.integration_settings;
begin
  if imobdesk.perfil_de((select auth.uid())) is distinct from 'super_admin' then
    perform imobdesk.erro('FORBIDDEN', 'Somente super admin pode configurar integrações.');
  end if;
  select * into v from imobdesk.integration_settings s where s.name = 'TOTVS RM';
  if v.id is null then
    perform imobdesk.erro('NOT_FOUND', 'Conexão TOTVS RM não encontrada.');
  end if;
  return jsonb_build_object(
    'id', v.id,
    'url', v.api_base_url,
    'user', v.api_user,
    'active', v.is_active,
    'passwordMasked', v.senha_mascara,
    'passwordSetAt', v.senha_definida_em,
    'passwordSetBy', v.senha_definida_por,
    'lastTest', v.ultimo_teste,
    'updatedAt', v.updated_at
  );
end;
$$;

-- ---------- Gravação (senha opcional: vazia mantém a atual) ----------

create or replace function imobdesk.salvar_conexao_totvs(p_url text, p_usuario text, p_senha text, p_ativo boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := (select auth.uid());
  v_atual imobdesk.integration_settings;
  v_url text := regexp_replace(trim(coalesce(p_url, '')), '/+$', '');
  v_usuario text := trim(coalesce(p_usuario, ''));
  v_senha text := coalesce(p_senha, '');
  v_nome_vault text := ('imobdesk_totvs_rm_senha_' || imobdesk.empresa_atual());
  v_id uuid;
  v_antes jsonb := '{}'::jsonb;
  v_depois jsonb := '{}'::jsonb;
begin
  if imobdesk.perfil_de(v_ator) is distinct from 'super_admin' then
    perform imobdesk.erro('FORBIDDEN', 'Somente super admin pode configurar integrações.');
  end if;
  select * into v_atual from imobdesk.integration_settings s where s.name = 'TOTVS RM' for update;
  if v_atual.id is null then
    perform imobdesk.erro('NOT_FOUND', 'Conexão TOTVS RM não encontrada.');
  end if;

  if v_url !~* '^https?://[^\s/]+' or length(v_url) > 300 then
    perform imobdesk.erro('INVALID_INPUT', 'Informe a URL completa, começando com http:// ou https://.', 'url');
  end if;
  if length(v_usuario) not between 1 and 120 then
    perform imobdesk.erro('INVALID_INPUT', 'Informe o usuário de integração.', 'user');
  end if;
  if v_senha <> '' and length(v_senha) > 200 then
    perform imobdesk.erro('INVALID_INPUT', 'Senha longa demais.', 'password');
  end if;
  if v_senha = '' and v_atual.segredo_id is null then
    perform imobdesk.erro('INVALID_INPUT', 'Informe a senha da integração.', 'password');
  end if;

  if v_url is distinct from v_atual.api_base_url then
    v_antes := v_antes || jsonb_build_object('url', v_atual.api_base_url);
    v_depois := v_depois || jsonb_build_object('url', v_url);
  end if;
  if v_usuario is distinct from v_atual.api_user then
    v_antes := v_antes || jsonb_build_object('user', v_atual.api_user);
    v_depois := v_depois || jsonb_build_object('user', v_usuario);
  end if;
  if p_ativo is distinct from v_atual.is_active then
    v_antes := v_antes || jsonb_build_object('active', v_atual.is_active);
    v_depois := v_depois || jsonb_build_object('active', p_ativo);
  end if;

  if v_senha <> '' then
    v_id := coalesce(v_atual.segredo_id, (select s.id from vault.secrets s where s.name = v_nome_vault));
    if v_id is null then
      v_id := vault.create_secret(v_senha, v_nome_vault, 'Senha da API TOTVS RM do Imobdesk');
    else
      perform vault.update_secret(v_id, v_senha);
    end if;
    update imobdesk.integration_settings
    set segredo_id = v_id,
        senha_mascara = '••••••••',
        senha_definida_em = now(),
        senha_definida_por = (select u.nome from imobdesk.usuarios u where u.id = v_ator)
    where id = v_atual.id;
    -- O valor da senha nunca vai para a auditoria.
    perform imobdesk.registrar_auditoria(v_ator, 'integracoes', 'secret', 'Senha da API TOTVS RM substituída', null, null, 'totvs_rm');
  end if;

  if v_depois <> '{}'::jsonb then
    update imobdesk.integration_settings
    set api_base_url = v_url, api_user = v_usuario, is_active = p_ativo, atualizado_por = v_ator
    where id = v_atual.id;
    perform imobdesk.registrar_auditoria(v_ator, 'integracoes', 'config', 'Conexão TOTVS RM alterada', v_antes, v_depois, 'totvs_rm');
  end if;
end;
$$;

-- ---------- Só para Edge Functions (service_role) ----------

create or replace function imobdesk.ler_credencial_totvs()
returns table (url text, usuario text, senha text, ativo boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select s.api_base_url, s.api_user, d.decrypted_secret, s.is_active
  from imobdesk.integration_settings s
  left join vault.decrypted_secrets d on d.id = s.segredo_id
  where s.name = 'TOTVS RM';
$$;

create or replace function imobdesk.registrar_teste_totvs(p_ator uuid, p_ok boolean, p_mensagem text, p_proposta text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_resultado jsonb := jsonb_build_object('at', now(), 'ok', p_ok, 'message', p_mensagem, 'proposalId', p_proposta);
begin
  if imobdesk.perfil_de(p_ator) is distinct from 'super_admin' then
    perform imobdesk.erro('FORBIDDEN', 'Somente super admin pode configurar integrações.');
  end if;
  update imobdesk.integration_settings set ultimo_teste = v_resultado where name = 'TOTVS RM';
  perform imobdesk.registrar_auditoria(p_ator, 'integracoes', 'test',
    case when p_ok then 'Teste de conexão TOTVS RM com sucesso' else 'Falha no teste de conexão TOTVS RM' end,
    null, v_resultado, 'totvs_rm');
  return v_resultado;
end;
$$;

-- O front só passa pelas RPCs acima: nenhum acesso direto à tabela (nem leitura da coluna legada).
revoke all on table imobdesk.integration_settings from anon, authenticated;

revoke all on function
  imobdesk.obter_conexao_totvs(),
  imobdesk.salvar_conexao_totvs(text, text, text, boolean),
  imobdesk.ler_credencial_totvs(),
  imobdesk.registrar_teste_totvs(uuid, boolean, text, text)
from public, anon, authenticated;

grant execute on function
  imobdesk.obter_conexao_totvs(),
  imobdesk.salvar_conexao_totvs(text, text, text, boolean)
to authenticated;

grant execute on function
  imobdesk.ler_credencial_totvs(),
  imobdesk.registrar_teste_totvs(uuid, boolean, text, text)
to service_role;

notify pgrst, 'reload schema';
