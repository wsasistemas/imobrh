# ImobRH (WSA Sistemas)

Sistema de RH separado do imobdesk. Backend: Supabase ikvj (`ikvjaowvpvxojvcfwnct`, schema `app_imobrh`, compartilhado
com o imobdesk e os outros sistemas da WSA) + Edge Functions. Front: Console do RH (`apps/console`, React 19 + Vite +
TypeScript), usado pelos analistas. Colaboradores e gestores usam o app do imobdesk, que chama a API `/rh/*`.
Plano da fase atual: `docs/PLANO-fase0.md`.

## Regras do projeto
- Fonte da verdade: `docs/PRD-imobRH-v2.md`; regras de serviço e etapas: `docs/PRD-imobRH-v1.md`.
- Migrations só aditivas e numeradas (`supabase/migrations/NNNN_*.sql`); nunca editar uma migration já aplicada.
  Aplicadas pelo SQL Editor do ikvj (nunca `supabase db push` nem `config push`: o projeto é compartilhado).
  Migration que cria tabela ou função no schema termina com `select app_imobrh.aplicar_multiempresa();`.
- Toda tabela tem `tenant_id` (empresa de `imobdesk.empresas`), RLS ativo e policy; nenhuma tabela sem policy.
- Segredos só no Vault ou em variáveis das Edge Functions; o front nunca recebe service role nem credencial do RM.
- Toda regra de negócio no backend (Edge Functions ou SQL); o front só exibe e chama a API.
- Respostas da API no formato `{ data, error: { code, message, fields } }`, códigos `VALIDACAO`, `SEM_PERMISSAO`,
  `RM_INDISPONIVEL`, `ESTADO_INVALIDO` (contrato em `supabase/functions/_shared/contrato.ts`, reexportado por
  `packages/shared`).
- Nunca INSERT direto em tabela do RM; escrita só por DataServer.
- Atestado, desligamento e caso sensível: buckets privados separados, URL assinada de 5 minutos, leitura registrada em
  auditoria.
- `caso_evento` e `auditoria` são só INSERT.
- UI só com os tokens e componentes do design system copiado do imobdesk (decisão do Wagner em 25/10/2026, no lugar
  do imobdisparos): tokens em `apps/console/src/index.css`, catálogo em `docs/design-system.md`.
- Textos da interface em português do Brasil.
- Uma fase por vez; ao fim de cada fase, listar critérios de aceite e status.

## Estrutura
- `apps/console`: menu, rotas e permissões saem de `src/config/menuRegistry.ts`; dados por `features/*/services`
  (Supabase ou mock, `VITE_DATA_SOURCE`).
- `supabase/functions`: uma pasta por função; peças comuns em `_shared` (`rm/nucleo.ts` é puro e testado no Vitest).
- `packages/shared`: tipos e JSON Schemas da API.
- Login: gateway `imobdesk-auth` (o mesmo do imobdesk); a origem do Console precisa estar em `AUTH_ALLOWED_ORIGINS`.

Verificação: `npm run lint`, `npm run build` (typecheck), `npm test`, `npm run test:db` e `npm run deno:check`.
