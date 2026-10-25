
-- Fase 3 (3/3): funções usadas só pelas Edge Functions do portal (papel service_role).
--
-- As Edge Functions verificam o JWT de quem chamou e passam o id dele como p_ator. O front não
-- executa nada daqui (revoke de authenticated e anon no fim).

-- Conta de login já existente no auth compartilhado (ex.: usada em outros sistemas da WSA).
create or replace function imobdesk.buscar_usuario_auth(p_email text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select u.id from auth.users u where lower(u.email) = lower(trim(p_email)) limit 1;
$$;

-- Validações do cadastro, antes de mexer no auth (regras 1 e 3 + domínio).
create or replace function imobdesk.validar_cadastro_usuario(p_ator uuid, p_email text, p_perfil text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
begin
  if not imobdesk.tem_permissao_de(p_ator, 'manage_users') then
    perform imobdesk.erro('FORBIDDEN', 'Você não tem permissão para esta ação.');
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    perform imobdesk.erro('EMAIL_DOMAIN_NOT_ALLOWED', 'Informe um e-mail válido.', 'email');
  end if;
  if exists (select 1 from imobdesk.usuarios u where u.email = v_email) then
    perform imobdesk.erro('EMAIL_EXISTS',
      'Este e-mail já pertence a um usuário. Para mudar senha ou perfil, edite o usuário existente.', 'email');
  end if;
  if not imobdesk.pode_atribuir(p_ator, p_perfil) then
    perform imobdesk.erro('ROLE_NOT_ALLOWED', 'Você só pode atribuir perfis do seu nível para baixo.', 'role');
  end if;
end;
$$;

-- p_forma: 'convite' (conta nova convidada), 'senha' (conta nova com senha temporária),
--          'existente' (conta que já existia no auth compartilhado: só libera o acesso ao portal).
create or replace function imobdesk.cadastrar_usuario_portal(
  p_ator uuid, p_id uuid, p_email text, p_nome text, p_perfil text, p_forma text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(trim(p_email));
  v_nome text := trim(coalesce(p_nome, ''));
  v_perfil_label text;
begin
  perform imobdesk.validar_cadastro_usuario(p_ator, v_email, p_perfil);
  if length(v_nome) < 3 then
    perform imobdesk.erro('INVALID_INPUT', 'Informe o nome completo.', 'name');
  end if;
  if p_forma not in ('convite', 'senha', 'existente') then
    perform imobdesk.erro('INVALID_INPUT', 'Forma de acesso inválida.');
  end if;

  insert into imobdesk.usuarios (id, email, nome, perfil_key, status, must_change_password, created_by)
  values (
    p_id, v_email, v_nome, p_perfil,
    case when p_forma = 'senha' then 'active' else 'pending' end,
    p_forma in ('convite', 'senha'),
    p_ator
  );

  v_perfil_label := (select p.label from imobdesk.perfis p where p.key = p_perfil);
  perform imobdesk.registrar_auditoria(
    p_ator, 'usuarios', 'create',
    case p_forma
      when 'convite' then format('Convite enviado para %s (%s)', v_nome, v_perfil_label)
      when 'senha' then format('Conta de %s criada com senha temporária (%s)', v_nome, v_perfil_label)
      else format('Acesso ao portal liberado para %s (%s), que já tinha login em outro sistema WSA', v_nome, v_perfil_label)
    end,
    null, jsonb_build_object('name', v_nome, 'email', v_email, 'role', p_perfil, 'forma', p_forma), p_id::text
  );
end;
$$;

-- Leitura do segredo para a Edge Function de teste de e-mail.
create or replace function imobdesk.ler_segredo_integracao(p_key text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select d.decrypted_secret
  from imobdesk.integracoes i
  join vault.decrypted_secrets d on d.id = i.segredo_id
  where i.key = p_key;
$$;

create or replace function imobdesk.registrar_teste_integracao(p_ator uuid, p_key text, p_ok boolean, p_mensagem text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_resultado jsonb := jsonb_build_object('at', now(), 'ok', p_ok, 'message', p_mensagem);
begin
  if imobdesk.perfil_de(p_ator) is distinct from 'super_admin' then
    perform imobdesk.erro('FORBIDDEN', 'Somente super admin pode configurar integrações.');
  end if;
  update imobdesk.integracoes set ultimo_teste = v_resultado where key = p_key;
  perform imobdesk.registrar_auditoria(p_ator, 'integracoes', 'test',
    case when p_ok then 'E-mail de teste enviado com sucesso' else 'Falha no envio do e-mail de teste' end,
    null, jsonb_build_object('ok', p_ok, 'message', p_mensagem), p_key);
  return v_resultado;
end;
$$;

revoke all on function
  imobdesk.buscar_usuario_auth(text),
  imobdesk.validar_cadastro_usuario(uuid, text, text),
  imobdesk.cadastrar_usuario_portal(uuid, uuid, text, text, text, text),
  imobdesk.ler_segredo_integracao(text),
  imobdesk.registrar_teste_integracao(uuid, text, boolean, text)
from public, anon, authenticated;

grant execute on function
  imobdesk.buscar_usuario_auth(text),
  imobdesk.validar_cadastro_usuario(uuid, text, text),
  imobdesk.cadastrar_usuario_portal(uuid, uuid, text, text, text, text),
  imobdesk.ler_segredo_integracao(text),
  imobdesk.registrar_teste_integracao(uuid, text, boolean, text)
to service_role;

notify pgrst, 'reload schema';
