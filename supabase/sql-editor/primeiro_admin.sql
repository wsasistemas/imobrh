-- ImobRH · primeiro Administrador do Console do RH (rodar no SQL Editor do ikvj DEPOIS das migrations 0001 e 0002).
-- Não é migration: é a carga inicial de um login. Troque o e-mail se precisar e rode o arquivo inteiro.
-- O login precisa existir no imobdesk (imobdesk.usuarios) na empresa em que vai administrar o RH.

insert into app_imobrh.papel_usuario (tenant_id, user_id, papel, origem)
select u.tenant_id, u.id, 'admin', 'manual'
  from imobdesk.usuarios u
 where lower(u.email) = lower('wsasistemas.ia@gmail.com')
   and u.status <> 'inactive'
on conflict (tenant_id, user_id, papel) do nothing;

-- Conferência: uma linha por empresa em que o login virou Administrador do ImobRH.
select e.nome as empresa, u.email, p.papel, p.created_at
  from app_imobrh.papel_usuario p
  join imobdesk.usuarios u on u.id = p.user_id and u.tenant_id = p.tenant_id
  join imobdesk.empresas e on e.id = p.tenant_id
 where lower(u.email) = lower('wsasistemas.ia@gmail.com');
