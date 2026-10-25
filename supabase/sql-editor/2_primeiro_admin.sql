-- Imobdesk · 1º Super admin da WSA e 1ª empresa. Rode depois das partes 1_estrutura_parte*.sql.
-- Troque os três valores abaixo. O login precisa já existir no Authentication do ikvj (é o mesmo dos outros
-- sistemas da WSA). Pode rodar de novo: não duplica nada.

do $$
declare
  v_email   text   := 'wsasistemas.ia@gmail.com';     -- login do Super admin da WSA
  v_empresa text   := 'Empresa Piloto';               -- nome da 1ª empresa cliente
  v_dominios text[] := '{}';                          -- domínios de e-mail dos solicitantes, ex.: '{suaempresa.com.br}'
  v_uid uuid;
  v_id uuid;
  v_slug text;
begin
  select u.id into v_uid from auth.users u where lower(u.email) = lower(v_email);
  if v_uid is null then
    raise exception 'O login % não existe no Authentication do ikvj. Crie o usuário lá e rode de novo.', v_email;
  end if;

  insert into imobdesk.admins_wsa (usuario_id) values (v_uid) on conflict do nothing;

  v_slug := trim(both '-' from regexp_replace(translate(lower(v_empresa), 'áàâãäéèêëíìîïóòôõöúùûüçñ', 'aaaaaeeeeiiiiooooouuuucn'), '[^a-z0-9]+', '-', 'g'));
  select e.id into v_id from imobdesk.empresas e where e.slug = v_slug;
  if v_id is null then
    insert into imobdesk.empresas (nome, slug, dominios_email, criado_por)
    values (v_empresa, v_slug, v_dominios, v_uid) returning id into v_id;
    perform imobdesk.empresa_copiar_modelo(v_id);
  end if;

  perform set_config('imobdesk.empresa_id', v_id::text, true);
  insert into imobdesk.usuarios (id, email, nome, perfil_key, status)
  values (v_uid, lower(v_email), 'Super admin WSA', 'super_admin', 'active')
  on conflict on constraint usuarios_pkey do update set perfil_key = 'super_admin', status = 'active';
  perform set_config('imobdesk.empresa_id', '', true);

  insert into imobdesk.usuario_preferencias (usuario_id, empresa_id) values (v_uid, v_id)
  on conflict on constraint usuario_preferencias_pkey do update set empresa_id = excluded.empresa_id;

  raise notice 'Pronto: % é Super admin da WSA e entra em % (%).', v_email, v_empresa, v_id;
end $$;

-- Conferência: deve listar a empresa e o Super admin.
select e.nome, e.slug, u.email, u.perfil_key, u.status
  from imobdesk.empresas e join imobdesk.usuarios u on u.tenant_id = e.id
 where not e.modelo order by e.nome;
