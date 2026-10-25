-- Gestão de Atendimento — F3: credenciais da Zenvia no Vault. Uma conta (um token) para todos os números
-- dos setores. Só aditiva. O token nunca volta ao navegador: a tela vê só a máscara.

-- Chave que a Zenvia manda no cabeçalho do webhook (gerada uma vez; só a Edge Function lê).
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'imobdesk_zenvia_webhook') then
    perform vault.create_secret(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'imobdesk_zenvia_webhook',
      'Chave do webhook da Zenvia (Imobdesk)');
  end if;
end;
$$;

create or replace function imobdesk.at_zenvia_salvar_token(p_token text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := auth.uid();
  v_token text := btrim(coalesce(p_token, ''));
  v_id uuid;
begin
  if v_ator is null or not imobdesk.eh_super_admin() then
    perform imobdesk.erro('FORBIDDEN', 'Só o super admin altera a conexão do WhatsApp.');
  end if;
  if v_token !~ '^[A-Za-z0-9_-]{20,200}$' then
    perform imobdesk.erro('INVALID_INPUT', 'Token inválido: copie o token inteiro da Zenvia (Console › API).', 'token');
  end if;
  v_id := coalesce((select c.token_segredo_id from imobdesk.at_config c where c.id),
                   (select s.id from vault.secrets s where s.name = ('imobdesk_zenvia_token_' || imobdesk.empresa_atual())));
  if v_id is null then
    v_id := vault.create_secret(v_token, ('imobdesk_zenvia_token_' || imobdesk.empresa_atual()), 'Token da API Zenvia (Imobdesk)');
  else
    perform vault.update_secret(v_id, v_token);
  end if;
  update imobdesk.at_config set token_segredo_id = v_id, token_mascara = '••••••••' || right(v_token, 4),
    token_definido_em = now(), verificacao = null, atualizado_em = now(), atualizado_por = v_ator where id;
  update imobdesk.at_numeros set verificacao = null;
  -- O valor do token nunca vai para a auditoria.
  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', 'update', 'Token da API Zenvia substituído', null, null, 'at_config');
end;
$$;
revoke execute on function imobdesk.at_zenvia_salvar_token(text) from public, anon;
grant execute on function imobdesk.at_zenvia_salvar_token(text) to authenticated, service_role;

-- Só para as Edge Functions (service_role).
create or replace function imobdesk.at_ler_credencial_zenvia()
returns table (token text, webhook_chave text)
language sql
stable
security definer
set search_path = ''
as $$
  select (select d.decrypted_secret from vault.decrypted_secrets d join imobdesk.at_config c on c.token_segredo_id = d.id where c.id),
         (select d.decrypted_secret from vault.decrypted_secrets d where d.name = 'imobdesk_zenvia_webhook');
$$;
revoke execute on function imobdesk.at_ler_credencial_zenvia() from public, anon, authenticated;
grant execute on function imobdesk.at_ler_credencial_zenvia() to service_role;

notify pgrst, 'reload schema';
