# ImobRH — Plano da Fase 0 (Fundação)

Fonte: `docs/PRD-imobRH-v2.md` (seção "Fases de construção") e o Prompt 1 de `docs/prompt-imobrh-vscode.md`.
Os PRDs foram convertidos dos `.docx` para Markdown em 25/10/2026.

## Decisões do Wagner (25/10/2026) que ajustam o prompt

| Tema | Prompt / PRD v2 | Decidido |
|---|---|---|
| Design system | Copiar do imobdisparos (Tailwind + shadcn/ui) | Copiar do **imobdesk** (Apple HIG, paleta WSA azul + abóbora, tema claro e escuro, CSS com tokens) |
| Stack de UI | A mesma do imobdisparos | A do imobdesk: React 19, Vite 8, react-router 8, TanStack Query 5, CSS puro com tokens, lucide + Iconify, sonner |
| Reaproveitamento do imobdesk | — | Só o menu **Configurações**, o login, o layout (lateral e topo) e o design system |
| Submenus de Configurações | — | Ficam: Usuários e papéis, Integração TOTVS RM, Auditoria e Sessões ativas. Saem: Equipes, Pessoas, Empresas, Permissões por aplicativo, Zenvia e SIENGE |
| Login | Supabase Auth compartilhado | A tela de login do imobdesk, com a foto trocada por uma do setor de RH |
| Projeto Supabase | `<<ID_DO_PROJETO_SUPABASE>>` | ikvj (`ikvjaowvpvxojvcfwnct`), schema `app_imobrh` |
| Código antigo | — | Snapshot no commit `afb5ab2`; o que não é usado foi removido |

## Arquitetura da Fase 0

- **Monorepo com npm workspaces:** `apps/console` (Console do RH), `packages/shared` (tipos e JSON Schemas); `supabase/` e `tests/db` ficam na raiz.
- **Multiempresa:** `tenant_id` aponta para `imobdesk.empresas`. `app_imobrh.empresa_atual()` reaproveita `imobdesk.empresa_atual()`, então a empresa do usuário e o cabeçalho `x-empresa-id` da service_role seguem a regra do imobdesk. RLS forçada, policy restritiva de tenant e policies por papel.
- **Login:** pelo gateway `imobdesk-auth`, o mesmo do imobdesk. Ele exige um usuário do imobdesk e registra a sessão. A origem do Console precisa entrar em `AUTH_ALLOWED_ORIGINS`. Depois do login, `GET /rh/me` decide o que a pessoa vê; quem não tem nenhum papel de RH recebe o aviso de acesso negado.
- **Configurações apontando para o `app_imobrh`:** as telas mantêm os contratos de serviço do imobdesk (`services/contracts.ts`) e o modo simulado. A camada Supabase passa a falar com o `app_imobrh`:
  - Usuários e papéis: os 8 papéis do PRD são fixos, com uma matriz de menus por papel;
  - Integração TOTVS RM: conexão com a senha no Vault, Consultas SQL `API.RH.*` e o modo mock ou real (`RM_MODO`);
  - Auditoria: tabela `app_imobrh.auditoria`, só INSERT;
  - Sessões ativas: sessões do Auth de quem tem papel de RH.
- **Menu:**
  - Principal: Caixa do RH (`/`), Meus casos e Prazos legais;
  - Configurações: Modelos de processo, Alçadas, Vínculos pendentes, Usuários e papéis, Integração TOTVS RM, Auditoria e Sessões ativas.

## Checklist

- [x] 0.1 Estrutura `apps/console` com o design system, o layout, o login e Configurações copiados do imobdesk
- [x] 0.2 `CLAUDE.md` do ImobRH, workspaces e o Console compilando com o menu RH e as Configurações reduzidas
- [x] 0.3 Migration `0001`: schema `app_imobrh` com colaborador_vinculo, papel_usuario, substituicao e auditoria, mais as tabelas das Configurações (permissões por papel, conexão RM, consultas SQL)
- [x] 0.4 Testes de RLS (`npm run test:db`): um colaborador não lê dados de outro; só compliance lê caso sensível
- [x] 0.5 Edge Functions `rm-token`, `rm-funcionario` e `rm-hierarquia` (mock ou real, cache de 1 h) e `rh-me`
- [x] 0.6 Console: login com a foto de RH, guarda por papel, tela Vínculos pendentes e as demais como página vazia com título
- [x] 0.7 `docs/design-system.md` e `docs/consultas-rm.md`
- [x] 0.8 Verificação: `npm run lint`, `npm run build`, `npm test`, `npm run test:db`

## Ajustes feitos durante a fase

- Edge Function a mais: `rm-consultas`, que testa uma Consulta SQL pela tela. O prompt pedia `rm-token`, `rm-funcionario`, `rm-hierarquia` e `rh-me`; as quatro existem.
- Matriz padrão de menus por papel no banco (`app_imobrh.permissoes_padrao`). Sem ela, um RH novo não veria nada. A tabela `papel_permissao` guarda só o que a empresa mudar.
- `caso_sensivel` criada vazia (migration 0002) para o teste de RLS do compliance.
- Senha e "esqueci a senha" ficam no imobdesk (login compartilhado). O Console não tem troca de senha.

## Ações do Wagner (fora do código)

- Incluir a origem do Console (dev: `http://localhost:5174`) em `AUTH_ALLOWED_ORIGINS` da função `imobdesk-auth` no ikvj.
- Aplicar as migrations `app_imobrh` pelo SQL Editor do ikvj e expor o schema na API.
- Publicar as Edge Functions e criar no Vault a credencial do usuário de integração do RM.
