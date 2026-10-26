# Design system do Console do RH

O Console do RH usa o design system do **imobdesk**: padrão Apple HIG com a paleta WSA (azul + abóbora, fundo coral),
tema claro e escuro, CSS com tokens e sem Tailwind. Foi uma decisão do Wagner em 25/10/2026, no lugar do imobdisparos
citado no PRD v2. Os tokens e componentes foram copiados do imobdesk (commit de snapshot `afb5ab2`), não reinventados.

Vitrine viva: `npm run dev` e abra `/design-system`, que só existe em desenvolvimento.

## Regras

- **Só tokens.** Nada de cor, raio, sombra ou tamanho de fonte fixo nos componentes: use `var(--…)` de `apps/console/src/index.css`. O tema escuro troca os valores em `[data-tema="escuro"]`.
- **Estado sempre com texto.** Prazo, estado do caso e estado da etapa nunca aparecem só pela cor (`Vencido há 2 dias`, `Atrasada`).
- **Mapa único de estados.** Estados de caso e de etapa usam só `components/ds/estados.ts`, com rótulos de `packages/shared` (contrato da API). Nenhuma tela define cor própria para estado.
- **Alvos de toque de 44 px** e foco visível (`outline` com `--ds-ring`). As animações respeitam `prefers-reduced-motion`.
- **Textos em português do Brasil.**

## O que foi copiado e de onde

Todos os arquivos foram movidos com `git mv` do imobdesk para `apps/console/`.

| No ImobRH | Origem no imobdesk | Conteúdo |
|---|---|---|
| `src/index.css` | `src/index.css` | Tokens base (`--brand`, `--abobora`, `--ink`, `--muted`, `--line`, `--page`, `--surface`, sidebar, badges, sombras), tokens `--ds-*` (cores, tipografia, raios, sombras) e o tema escuro |
| `src/App.css` | `src/App.css` | Casca do app (topbar, sidebar, conteúdo) e utilitários (`.card`, `.btn`, `.input`, `.field`) |
| `src/components/ds/` | `src/components/ds/` | `AlertBanner`, `DetailDialog`, `FilterSelect`, `IconeColorido`, `KpiCard`, `PageHeading`, `Panel`, `Pill`, `ScopeSegmented`, `TablePagination`, `ThLabel`, `Toast`, `useToast`, `ds.css`, `components.css` |
| `src/components/` | `src/components/` | `Sidebar`, `Topbar`, `Breadcrumb`, `PageSkeleton`, `AppErrorBoundary`, `ModuleCard`, `iconesMenu.data.ts` |
| `src/components/MenuAparencia.tsx`, `tema.ts` | `src/features/empresas/` | Tema claro, escuro ou automático, salvo neste navegador |
| `src/features/configuracoes/components/` | idem | `DataTable`, `Sheet.css`, `StatusBadge`, `EmptyState`, `ErrorState`, `Notice`, `PageHeader`, `Pagination`, `PermissionRow`, `SecretField`, `ConfirmDialog`, `UserAvatar`, `ConfigBanner` |
| `src/features/configuracoes/pages/` | idem | Telas Perfis e permissões, Integrações (TOTVS RM e Consultas SQL), Auditoria e Sessões, com a camada de dados trocada para o `app_imobrh` |
| `src/features/auth/` | idem | Login (`AuthShell`, `Login`), sessão e aviso de acesso bloqueado |
| `public/` | `public/` | `wsa-logo.png`, `favicon.svg`, `tema.js`, `boot-guard.js` |
| `docs/mockups/apple-hig-imobdesk.html` | idem | Referência visual aprovada (Apple HIG) |

**Trocado:** a foto do login agora é `public/login-rh.jpg`, do Unsplash (Cytonn Photography, licença Unsplash, uso
livre). Os textos do login também foram reescritos para o RH.

**Não copiado:** componentes de chamado (`QueueTable`, `NewTicketDialog`, `TriagePanel`, `SlaHealth`, `InboundChart`,
`TeamDistribution`). Eles estão no snapshot, se algum dia forem úteis.

## Tokens principais

| Grupo | Tokens |
|---|---|
| Marca | `--brand`, `--brand-hover`, `--brand-soft`, `--abobora`, `--menu-ativo` (degradê azul → abóbora do item ativo) |
| Texto e superfície | `--ink`, `--muted`, `--line`, `--page`, `--surface`, `--table-head`, `--input-border` |
| Situação | `--success-bg/fg`, `--warning-bg/fg`, `--danger-bg/fg`, `--info-bg/fg`, `--neutral-bg/fg` |
| Componentes `ds` | `--ds-primary*`, `--ds-danger*`, `--ds-warning*`, `--ds-success*`, `--ds-neutral-*`, `--ds-ai*`, `--ds-radius-*`, `--ds-fs-*`, `--ds-shadow-*` |
| Tipografia | Inter (400–800) e IBM Plex Mono 500, para protocolo, chapa e CPF |

## Componentes do RH (criados no mesmo estilo)

São os componentes que o imobdesk não tinha, todos em `src/components/ds/rh.tsx` + `rh.css` e exportados por
`components/ds`.

### `EstadoCasoBadge` e `EstadoEtapaBadge`
Selo do estado: um `Pill` com rótulo e tom do mapa único.

| Estado do caso | Rótulo | Tom |
|---|---|---|
| `aberto` | Aberto | azul |
| `em_andamento` | Em andamento | azul |
| `aguardando_colaborador` | Aguardando colaborador | âmbar |
| `aguardando_terceiro` | Aguardando terceiro | âmbar |
| `concluido` | Concluído | verde |
| `cancelado` | Cancelado | neutro |

| Estado da etapa | Rótulo | Tom |
|---|---|---|
| `bloqueada` | Aguardando etapa anterior | neutro |
| `aberta` | A fazer | azul |
| `em_andamento` | Em andamento | azul |
| `concluida` | Concluída | verde |
| `atrasada` | Atrasada | vermelho |
| `erro_rm` | Erro no RM | vermelho |

A lista de estados é proposta da Fase 0 e precisa ser confirmada na Fase 2, com o motor de processos (o PRD v1 só
traz o diagrama).

### `StepperEtapas`
Stepper vertical das etapas do caso, para a coluna esquerda da tela do caso.
- Marca numerada, com ✓ quando concluída, cadeado quando bloqueada e alerta quando atrasada ou com erro no RM.
- Mostra nome, responsável, selo do estado e prazo relativo.
- A etapa atual fica com borda e fundo `--ds-primary` / `--ds-primary-soft` e `aria-current="step"`.
- Com `onSelect`, cada etapa vira botão de 44 px.

### `TimelineCaso`
Linha do tempo do `caso_evento`, que é só INSERT.
- Ícone por ator: pessoa, sistema, TOTVS RM, IA.
- Mostra autor, data e hora e o texto do evento.
- Cada evento leva o selo **Visível ao colaborador** (verde) ou **Nota interna** (neutro), que reflete `visivel_colaborador`.

### `PainelPrazos`
Painel de prazos legais, para a coluna direita do caso e a tela `/prazos`.
- Ordenado pelo vencimento.
- Mostra a base legal (CLT, eSocial) e o prazo relativo.
- O cabeçalho resume a situação: `N vencidos` ou `Em dia`.

`prazoRelativo(venceEm)` (em `estados.ts`) é a regra única de prazo:

| Situação | Texto | Tom |
|---|---|---|
| Venceu | "Vencido há N dias" | vermelho |
| Vence hoje | "Vence hoje" | vermelho |
| Faltam até 3 dias | "Vence em N dias" | âmbar |
| Faltam mais de 3 dias | "Vence em N dias" | azul |

## Padrões de tela

- **Lista com filtros:** `PageHeader` + `card` com busca (`.input--sm` e ícone), filtros, `DataTable` com `ThLabel` e `Pagination`. Exemplos: Usuários e papéis, Vínculos pendentes.
- **Edição lateral:** `Sheet` de 540 px (`sheet__header` / `sheet__body` / `sheet__footer`), com o erro da regra no próprio campo. Exemplos: papéis do usuário, vínculo por CPF.
- **Configuração:** card de integração com o segredo só de escrita e o histórico vindo da auditoria. Exemplo: Integração TOTVS RM.
- **Tela ainda vazia:** `PaginaEmBreve`, com título e descrição do `menuRegistry` e a fase do PRD em que a tela chega.
