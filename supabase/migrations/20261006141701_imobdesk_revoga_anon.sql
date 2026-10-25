
-- Fase 1 da conexão do Imobdesk ao schema `imobdesk` (projeto compartilhado da WSA (ikvj)).
--
-- O papel `anon` (requisição sem login) tinha SELECT/INSERT/UPDATE/DELETE em todas as tabelas do
-- schema, protegido só pela RLS. Antes de expor `imobdesk` na API, o anon perde qualquer acesso.
-- Só remove permissões: nenhuma tabela, coluna ou dado é alterado. Os papéis `authenticated` e
-- `service_role` continuam como estão (as policies deles são refeitas na fase 2).

revoke usage on schema imobdesk from anon;

revoke all on all tables in schema imobdesk from anon;
revoke all on all sequences in schema imobdesk from anon;
revoke all on all functions in schema imobdesk from anon;

-- Objetos criados no futuro neste schema também nascem sem acesso para o anon.
alter default privileges in schema imobdesk revoke all on tables from anon;
alter default privileges in schema imobdesk revoke all on sequences from anon;
alter default privileges in schema imobdesk revoke all on functions from anon;
