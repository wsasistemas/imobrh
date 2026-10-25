
-- Fase 3 (1/3): base das RPCs do Imobdesk — erro padronizado, regras de hierarquia e auditoria.
--
-- Erros de regra saem com errcode P0001: message = texto para a tela, detail = código
-- (mesmo ServiceErrorCode do front), hint = campo do formulário. O PostgREST devolve isso como
-- { code, message, details, hint } e o serviço Supabase do front converte em ServiceError.
-- Funções "de ator" recebem o usuário explicitamente: as RPCs passam auth.uid(); as Edge Functions,
-- que rodam com service_role (sem auth.uid()), passam o id do JWT verificado.

create or replace function imobdesk.erro(p_codigo text, p_mensagem text, p_campo text default null)
returns void
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = 'P0001', message = p_mensagem, detail = p_codigo, hint = coalesce(p_campo, '');
end;
$$;

-- ---------- Perfil e permissão de um usuário qualquer ----------

create or replace function imobdesk.perfil_de(p_usuario uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select u.perfil_key
  from imobdesk.usuarios u
  where u.id = p_usuario and u.status <> 'inactive';
$$;

create or replace function imobdesk.tem_permissao_de(p_usuario uuid, p_permissao text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when imobdesk.perfil_de(p_usuario) is null then false
    when imobdesk.perfil_de(p_usuario) = 'super_admin' then true
    else exists (
      select 1 from imobdesk.profile_permissions pp
      where pp.role = imobdesk.perfil_de(p_usuario) and pp.permission_id = p_permissao and pp.enabled
    )
  end;
$$;

-- A versão usada nas policies passa a delegar para a de ator (mesma regra num lugar só).
create or replace function imobdesk.tem_permissao(p_permissao text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select imobdesk.tem_permissao_de((select auth.uid()), p_permissao);
$$;

-- ---------- Hierarquia ----------

/** Nível do perfil (0 = mais alto). Perfil inexistente ou nulo fica abaixo de todos. */
create or replace function imobdesk.nivel_perfil(p_perfil text)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select p.ordem from imobdesk.perfis p where p.key = p_perfil), 2147483647);
$$;

/** Regra 3: atribui-se só o próprio nível e os abaixo dele. */
create or replace function imobdesk.pode_atribuir(p_ator uuid, p_perfil text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select imobdesk.perfil_de(p_ator) is not null
     and exists (select 1 from imobdesk.perfis p where p.key = p_perfil)
     and imobdesk.nivel_perfil(p_perfil) >= imobdesk.nivel_perfil(imobdesk.perfil_de(p_ator));
$$;

/** Cadastro de perfis: só Super admin e Admin com a permissão de perfis. */
create or replace function imobdesk.eh_gestor_perfis(p_ator uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(imobdesk.perfil_de(p_ator) in ('super_admin', 'admin'), false)
     and imobdesk.tem_permissao_de(p_ator, 'manage_permissions');
$$;

/** Super admin gerencia todos os perfis (menos o próprio Super admin); Admin, só os abaixo dele. */
create or replace function imobdesk.pode_gerenciar_perfil(p_ator uuid, p_perfil text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select imobdesk.eh_gestor_perfis(p_ator)
     and p_perfil <> 'super_admin'
     and (
       imobdesk.perfil_de(p_ator) = 'super_admin'
       or imobdesk.nivel_perfil(p_perfil) > imobdesk.nivel_perfil(imobdesk.perfil_de(p_ator))
     );
$$;

create or replace function imobdesk.pode_posicionar_abaixo(p_ator uuid, p_perfil text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select imobdesk.eh_gestor_perfis(p_ator)
     and exists (select 1 from imobdesk.perfis p where p.key = p_perfil)
     and imobdesk.nivel_perfil(p_perfil) >= imobdesk.nivel_perfil(imobdesk.perfil_de(p_ator));
$$;

-- ---------- Auditoria (só funções do portal gravam; o front nunca) ----------

create or replace function imobdesk.registrar_auditoria(
  p_ator uuid,
  p_modulo text,
  p_acao text,
  p_descricao text,
  p_antes jsonb default null,
  p_depois jsonb default null,
  p_alvo text default null
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into imobdesk.audit_logs
    (action_type, menu_module, description, entity_type, entity_id, user_id, user_email, ator_nome, old_values, new_values, origem)
  select p_acao, p_modulo, p_descricao, p_modulo, p_alvo, p_ator, u.email, coalesce(u.nome, 'Sistema'), p_antes, p_depois, 'Portal web'
  from (select 1) as uma_linha
  left join imobdesk.usuarios u on u.id = p_ator;
$$;

-- Chave estável a partir do nome (ex.: "Supervisor de vendas" → "supervisor_de_vendas").
create or replace function imobdesk.gerar_chave_perfil(p_label text)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_base text;
  v_chave text;
  v_sufixo integer := 2;
begin
  v_base := translate(lower(trim(p_label)), 'áàâãäéèêëíìîïóòôõöúùûüçñ', 'aaaaaeeeeiiiiooooouuuucn');
  v_base := trim(both '_' from regexp_replace(v_base, '[^a-z0-9]+', '_', 'g'));
  v_base := left(coalesce(nullif(v_base, ''), 'perfil'), 50);
  if length(v_base) < 2 then
    v_base := 'perfil_' || v_base;
  end if;
  v_chave := v_base;
  while exists (select 1 from imobdesk.perfis p where p.key = v_chave) loop
    v_chave := v_base || '_' || v_sufixo;
    v_sufixo := v_sufixo + 1;
  end loop;
  return v_chave;
end;
$$;

-- Nenhuma destas é chamada direto pelo front: são peças das RPCs e das Edge Functions.
revoke all on function
  imobdesk.erro(text, text, text),
  imobdesk.perfil_de(uuid),
  imobdesk.tem_permissao_de(uuid, text),
  imobdesk.nivel_perfil(text),
  imobdesk.pode_atribuir(uuid, text),
  imobdesk.eh_gestor_perfis(uuid),
  imobdesk.pode_gerenciar_perfil(uuid, text),
  imobdesk.pode_posicionar_abaixo(uuid, text),
  imobdesk.registrar_auditoria(uuid, text, text, text, jsonb, jsonb, text),
  imobdesk.gerar_chave_perfil(text)
from public, anon, authenticated;

grant execute on function
  imobdesk.perfil_de(uuid),
  imobdesk.tem_permissao_de(uuid, text),
  imobdesk.nivel_perfil(text),
  imobdesk.pode_atribuir(uuid, text),
  imobdesk.eh_gestor_perfis(uuid),
  imobdesk.pode_gerenciar_perfil(uuid, text),
  imobdesk.pode_posicionar_abaixo(uuid, text),
  imobdesk.registrar_auditoria(uuid, text, text, text, jsonb, jsonb, text)
to service_role;
