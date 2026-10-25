# Imobdesk (WSA Sistemas)

Helpdesk multiempresa. React 19 + Vite + TypeScript, Supabase ikvj (`ikvjaowvpvxojvcfwnct`, schema `imobdesk`,
compartilhado com os outros sistemas da WSA). Menu, rotas e permissões saem de `src/config/menuRegistry.ts`.
Tokens visuais em `src/index.css`. Plano em andamento: `docs/PLANO-imobdesk-wsa.md`.

## Banco
- Migrations só aditivas em `supabase/migrations`, aplicadas pelo SQL Editor do ikvj (nunca `supabase db push`
  nem `config push`: o projeto é compartilhado).
- Multiempresa: toda tabela do app tem `tenant_id` (empresa contratante, `imobdesk.empresas`), RLS forçada e a
  policy restritiva `imobdesk_tenant`; tabelas e funções são do papel `imobdesk_dono` (sem BYPASSRLS).
  Migration que cria tabela ou função no schema termina com `select imobdesk.aplicar_multiempresa();`.
- Edge Function com service_role informa a empresa no cabeçalho `x-empresa-id`.

Verificação: `npm run lint`, `npm run build` (typecheck), `npm test` e `npm run test:db`.

## Módulo Solicitações Financeiras

Antes de qualquer alteração neste módulo, leia docs/Solicitacoes-financeiras/CONTEXTO.md. Quando uma regra, estado, tabela ou componente mudar, atualize o CONTEXTO.md no mesmo commit.
