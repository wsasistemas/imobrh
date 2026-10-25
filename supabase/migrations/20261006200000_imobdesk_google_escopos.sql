-- Contas de e-mail · Google Workspace: escopos configuráveis e Client ID guardado (06/10/2026).
-- Se a empresa já usa a Delegação em todo o domínio (Admin › Segurança › Controles de API › Clientes da API) com o
-- escopo https://mail.google.com/. Na delegação, o Google só emite o token se os escopos pedidos estiverem
-- exatamente na lista do cliente; por isso o portal pede os mesmos escopos cadastrados lá. Só aditiva.

alter table imobdesk.at_config add column if not exists google_sa_client_id text;
alter table imobdesk.at_config add column if not exists google_escopos text[] not null default '{https://mail.google.com/}';

-- Reescreve a função (mesma assinatura) para guardar também o client_id, que a TI informa em "Adicionar novo".
create or replace function imobdesk.at_google_sa_salvar(p_json text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := auth.uid();
  j jsonb;
  v_id uuid;
begin
  if v_ator is null or not imobdesk.eh_super_admin() then
    perform imobdesk.erro('FORBIDDEN', 'Só o super admin configura o Google Workspace.');
  end if;
  begin
    j := p_json::jsonb;
  exception when others then
    perform imobdesk.erro('INVALID_INPUT', 'Arquivo inválido: envie o JSON da chave da conta de serviço do Google Cloud.', 'chave');
  end;
  if j ->> 'type' is distinct from 'service_account' or coalesce(j ->> 'client_email', '') = '' or coalesce(j ->> 'private_key', '') not like '-----BEGIN PRIVATE KEY-----%' then
    perform imobdesk.erro('INVALID_INPUT', 'O JSON precisa ser de uma conta de serviço (type, client_email e private_key).', 'chave');
  end if;
  v_id := coalesce((select c.google_sa_segredo_id from imobdesk.at_config c where c.id),
                   (select s.id from vault.secrets s where s.name = ('imobdesk_google_sa_' || imobdesk.empresa_atual())));
  if v_id is null then
    v_id := vault.create_secret(p_json, ('imobdesk_google_sa_' || imobdesk.empresa_atual()), 'Chave da conta de serviço do Google Workspace (Imobdesk)');
  else
    perform vault.update_secret(v_id, p_json);
  end if;
  update imobdesk.at_config set google_sa_segredo_id = v_id, google_sa_email = j ->> 'client_email', google_sa_client_id = j ->> 'client_id',
    google_sa_definido_em = now(), google_verificacao = null, atualizado_em = now(), atualizado_por = v_ator where id;
  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', 'secret', 'Chave da conta de serviço do Google Workspace substituída',
    null, jsonb_build_object('client_email', j ->> 'client_email', 'client_id', j ->> 'client_id'), 'at_config');
end;
$$;

-- Escopos que o portal pede ao Google (precisam ser os mesmos autorizados em "Clientes da API").
create or replace function imobdesk.at_google_escopos_salvar(p_escopos text[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := auth.uid();
  v_permitidos text[] := array['https://mail.google.com/', 'https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/gmail.send',
                               'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.labels'];
  v_antes text[];
begin
  if v_ator is null or not imobdesk.eh_super_admin() then
    perform imobdesk.erro('FORBIDDEN', 'Só o super admin configura o Google Workspace.');
  end if;
  if coalesce(cardinality(p_escopos), 0) = 0 or exists (select 1 from unnest(p_escopos) e where not (e = any (v_permitidos))) then
    perform imobdesk.erro('INVALID_INPUT', 'Escopo não suportado pelo portal.', 'escopos');
  end if;
  select c.google_escopos into v_antes from imobdesk.at_config c where c.id;
  update imobdesk.at_config set google_escopos = (select array_agg(distinct e order by e) from unnest(p_escopos) e),
    google_verificacao = null, atualizado_em = now(), atualizado_por = v_ator where id;
  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', 'config', 'Escopos do Google Workspace alterados',
    jsonb_build_object('escopos', to_jsonb(v_antes)), jsonb_build_object('escopos', to_jsonb(p_escopos)), 'at_config');
end;
$$;

revoke execute on function imobdesk.at_google_escopos_salvar(text[]) from public, anon;
grant execute on function imobdesk.at_google_escopos_salvar(text[]) to authenticated, service_role;

notify pgrst, 'reload schema';
