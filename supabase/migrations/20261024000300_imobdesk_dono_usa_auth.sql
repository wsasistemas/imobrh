-- O imobdesk_dono precisa de USAGE no schema auth: as funções dele chamam auth.uid() e auth.jwt().
-- Sem isso, toda chamada do portal (sessao_atual_confiavel, registrar_acesso, policies de usuarios) devolve
-- 42501 "permission denied for schema auth" (403 no navegador) logo depois do login.
--
-- Na 90_multiempresa o grant de auth ia junto com extensions, storage e vault num comando só. No Supabase o
-- postgres pode não ter GRANT OPTION no auth; aí o Postgres só avisa (warning) e concede os outros schemas.
-- Aqui: tenta o grant direto e, se não pegar, dá ao dono o papel authenticated (que já usa o schema auth).
-- Aditiva: não revoga nada.

do $$
begin
  begin
    execute 'grant usage on schema auth to imobdesk_dono';
  exception when others then
    raise notice 'imobdesk: grant usage on schema auth falhou (%)', sqlerrm;
  end;

  if not has_schema_privilege('imobdesk_dono', 'auth', 'usage') then
    begin
      execute 'grant authenticated to imobdesk_dono';
    exception when others then
      raise notice 'imobdesk: grant authenticated to imobdesk_dono falhou (%)', sqlerrm;
    end;
  end if;

  if not has_schema_privilege('imobdesk_dono', 'auth', 'usage') then
    raise exception 'imobdesk_dono continua sem USAGE no schema auth: conceda pelo suporte do Supabase ou mude o dono das funções.';
  end if;
end;
$$;

select has_schema_privilege('imobdesk_dono', 'auth', 'usage') as dono_usa_auth;
