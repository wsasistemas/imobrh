-- Central de acessos do ikvj (Permissões por aplicativo): o Imobdesk se cadastra aqui, com o controle desligado.
-- O cadastro de usuário de cada empresa é feito na tela Usuários do próprio Imobdesk: o "Liberar" da Central
-- grava em imobdesk.usuarios na empresa aberta por quem libera (imobdesk.empresa_atual()).
-- Aditiva: só insere se ainda não existir.

do $$
begin
  if to_regclass('acessos.aplicativos') is null then
    raise notice 'Central de acessos (schema acessos) não existe neste banco: cadastro do app ignorado.';
    return;
  end if;
  execute $i$
    insert into acessos.aplicativos (schema_name, nome, url)
    values ('imobdesk', 'Imobdesk', 'https://imobdesk.imobsystems.com.br')
    on conflict (schema_name) do nothing
  $i$;
  if exists (select 1 from information_schema.columns
              where table_schema = 'acessos' and table_name = 'aplicativos' and column_name = 'perfil_liberar') then
    execute $u$ update acessos.aplicativos set perfil_liberar = 'operador'
                 where schema_name = 'imobdesk' and perfil_liberar is null $u$;
  end if;
end $$;

notify pgrst, 'reload schema';
