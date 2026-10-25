# Plano de ação: Gestão de Chamados › Tickets (Kanban ou Lista) com visões configuráveis

Pedido (07/10/2026): criar, dentro de **Gestão de Chamados**, o menu **Tickets**, com visualização em
**Kanban** ou **Lista**. As configurações dessas visões só podem ser feitas pelo **Admin** ou pelo **Super admin**.
O modelo de referência é a configuração de visões da Movidesk (print do Wagner), com as abas
**Principal · Condições · Kanban · Agrupamento**.

Mockup para aprovação: [`docs/mockups/tickets-visoes.html`](mockups/tickets-visoes.html). Ele tem 3 telas no topo
e um seletor de perfil (Admin / Agente).
**Aprovado em 07/10/2026 e implementado no mesmo dia.** Decisões do Wagner:
- **D2:** o status tem **cadastro à parte** (seção Gestão de Chamados › Status), e não lista fixa. Cada status tem uma **categoria** fixa (novo, em andamento, pendente, resolvido, fechado, cancelado), que decide os números do painel. As justificativas ficam no próprio status.
- **D4:** visão **por equipe** (`at_equipes`), e admin e super admin com permissões diferentes. Matriz aplicada (`src/features/chamados/visoes/permissoes.ts` e RPCs):
  - agente: usa as visões habilitadas das suas equipes;
  - admin: vê todas; cria, edita, duplica, habilita e desabilita visões; mexe no cadastro de status;
  - super admin: tudo isso, mais excluir visão e definir o Kanban padrão.
- **D5:** sim, arrastar o cartão muda o status.
- **Demais:** como recomendado.

Fluxo: aprovar o mockup → este plano vira o prompt → fases com checklist binário. Migrations só aditivas,
ensaiadas em `begin … rollback` e aplicadas com `npx supabase db query --linked`.

---

## 1. O que o modelo (Movidesk) faz e como fica aqui

| Movidesk (print) | Imobdesk |
|---|---|
| **Principal:** Habilitado/Desabilitado; tipo Listagem ou Kanban | Igual, mais **Nome**, **Visão padrão ao abrir** e **Quem vê** (todos com acesso a Tickets ou perfis escolhidos) |
| **Condições combinadas** (o ticket atende a *todas*) | Igual: campo + operador + valor; adicionar e remover linhas |
| **Condições independentes** (o ticket atende a *ao menos uma*) | Igual. Com as duas, vale TODAS **e** pelo menos uma das independentes (texto do modelo mantido) |
| Campos: Recebido em, TAG, Campo adicional, Equipe responsável… | Lista fechada de campos (seção 4, D3). O operador e o tipo de valor mudam conforme o campo |
| **Kanban › Colunas e status:** coluna "Status" com os não usados; colunas com status (status › justificativa); adicionar, remover e arrastar colunas | Igual: "Status sem coluna" à esquerda; arrastar status entre colunas e reordenar colunas; renomear clicando no nome |
| **Definir como padrão / Restaurar padrão** | Igual: grava ou recupera o conjunto de colunas padrão do sistema, usado em toda visão nova |
| **Agrupamento** (a aba não aparece no print) | Proposta: agrupar a Lista por campo (equipe, responsável, status, serviço, origem, prioridade), ordem dos grupos, ordenação dos tickets, itens por página e colunas da lista |
| — | No Kanban: ordenação dos cartões e o que acontece ao arrastar um cartão (muda o status, perguntando se a coluna tiver mais de um) |

## 2. Análise do que existe hoje (o que muda o desenho)

1. **Ainda não existe ticket no banco.** A Gestão de Chamados roda sobre o mock (`src/features/dashboard/mock.ts`), e a RPC `rpc_dashboard` ainda não foi feita. As tabelas `at_atendimentos` são os atendimentos da Administração (WhatsApp/e-mail), com outro modelo. **Consequência:** as visões podem ser gravadas no banco já, mas as condições rodam sobre o mock até existir a tabela de tickets (D7).
2. **Status:** hoje os status são Novo, Em atendimento, Aguardando terceiros, Resolvido e Fechado, sem "justificativa". O modelo usa **status + justificativa** (ex.: *Aguardando › Retorno do cliente*), e é isso que se arrasta para as colunas do Kanban. É preciso um cadastro de justificativas (D2).
3. **Não existem TAGs nem campos adicionais** no ticket. O print usa os dois (D3).
4. **Menu:** "Gestão de Chamados" hoje é uma tela só. Para ter "Tickets" dentro dele, vira item com seções (como a Administração: `parent` no `menuRegistry` e abas internas). A tela atual vira a seção **Visão geral**. Os links da Página Inicial (`/gestao-chamados?escopo=…`) passam a apontar para `/gestao-chamados/visao-geral` e o endereço antigo redireciona, sem quebrar nada.
5. **Arrastar e soltar:** o projeto não tem biblioteca para isso. O Kanban de Negócios do PipedriveMKT não arrasta. Para arrastar com mouse **e teclado** (acessível), a recomendação é `@dnd-kit` (D6).
6. **Reuso aprovado:** o formato de filtro **TODAS/QUALQUER** do PipedriveMKT (`{"todas":[…],"qualquer":[…]}`, cond = `{campo, operador, valores[]}`, campos em lista fechada, SQL com `%I/%L`) e a armadilha de desempenho [[postgres-filtro-dinamico-funcao-por-linha-lenta-gerar-sql-nativo]]: gerar SQL nativo, não chamar uma função por linha.

## 3. Desenho

**Menu e rotas**
- `gestao_chamados` (pai) → `gestao_chamados_visao_geral` (`/gestao-chamados/visao-geral`, o painel atual) e `gestao_chamados_tickets` (`/gestao-chamados/tickets`).
- A configuração fica em `/gestao-chamados/tickets/visoes`. Ela não aparece no menu: chega-se pelo botão **Configurar visões**, que só aparece para Admin e Super admin.

**Banco (schema `imobdesk`, só aditivo)**
- `ch_justificativas (id, status, nome, ordem, ativa)`: as justificativas de cada status.
- `ch_visoes (id, nome, habilitada, tipo 'lista'|'kanban', padrao, perfis text[] null = todos, condicoes jsonb, kanban jsonb, agrupamento jsonb, criado_por, atualizado_em)`.
  - `condicoes = {"todas":[{campo, operador, valores[]}], "qualquer":[…]}`.
  - `kanban = {"colunas":[{id, nome, status:[{status, justificativa_id|null}]}], "ordenar":"sla|criado|atualizado|prioridade", "arrastar":"mudar_status|bloqueado"}`.
  - `agrupamento = {"por":"equipe|responsavel|status|servico|origem|prioridade|null", "ordem_grupos":"az|quantidade", "ordenar":"sla|criado|atualizado", "por_pagina":25, "colunas":[…]}`.
- `ch_kanban_padrao (id = 1, colunas jsonb)`: o "Definir como padrão / Restaurar padrão".
- RLS: leitura de `ch_visoes` habilitadas para quem tem `gestao_chamados_tickets` e cujo perfil está em `perfis` (ou `perfis` nulo).
- **Escrita só por RPC** (`ch_visao_salvar`, `ch_visao_excluir`, `ch_kanban_padrao_salvar`), que conferem **perfil admin ou super_admin** e validam campos e operadores contra a lista fechada. Tudo vai para a auditoria.
- Permissões novas (`gestao_chamados_visao_geral`, `gestao_chamados_tickets`) liberadas para admin, ti e operador, como já é hoje com `gestao_chamados`.

**Front**
- `features/chamados/visoes/` com:
  - `campos.ts`: a lista fechada de campos (tipo, operadores e origem dos valores);
  - `avaliar.ts`: avaliador puro de condições TODAS/QUALQUER, com testes. A mesma especificação vai para o SQL quando houver tabela de tickets;
  - `services` (Supabase + mock), `hooks` e as telas `Tickets.tsx` e `ConfigurarVisoes.tsx`.
- **Tickets:**
  - seletor de visão (só as habilitadas que o perfil vê, abrindo na "padrão") e busca;
  - Kanban com contagem por coluna, ou Lista agrupada com total por grupo;
  - o cartão mostra nº, solicitante, equipe, assunto, SLA, responsável e status › justificativa;
  - clicar abre o detalhe do ticket (o mesmo da Visão geral).
- Visual do portal (Inter, vermelho da marca, tokens do `src/index.css`), igual ao mockup.

## 4. Decisões para você confirmar

| # | Decisão | Opções | Recomendação |
|---|---|---|---|
| D1 | **Quem configura visões** | **A.** Regra fixa: só perfil Admin e Super admin. **B.** Uma permissão marcável em Perfis e permissões | **A**, como você pediu ("somente administrador ou superadmin"). A regra fica na RPC, não só na tela |
| D2 | **Status e justificativas** | Status fixos (**Novo, Em atendimento, Aguardando, Resolvido, Fechado, Cancelado, Reaberto**) + justificativas cadastráveis por status | Como ao lado. "Aguardando terceiros" vira *Aguardando* + justificativa (Retorno do cliente, Fornecedor…). No resumo da Página Inicial, Pendentes = Aguardando (qualquer justificativa). O cadastro de justificativas fica numa aba da própria tela Configurar visões |
| D3 | **Campos das condições (v1)** | Recebido em (conta/canal), Origem, Equipe responsável, Responsável (inclui "é o usuário logado"), Solicitante, Serviço, Status, Justificativa, Prioridade, TAG, Criado em, SLA de solução (vencido / vence hoje / no prazo) | Como ao lado, **com TAG** (lista simples de etiquetas no ticket). **Campos adicionais** (ex.: PROTOCOLO) ficam para uma fase própria, porque exigem cadastro de campos personalizados |
| D4 | **Quem vê cada visão** | Todos com acesso a Tickets / perfis escolhidos | As duas opções, como no mockup. As condições continuam valendo por cima do que a pessoa já pode ver |
| D5 | **Arrastar um cartão no Kanban** | Muda o status (pergunta qual, se a coluna tiver mais de um) / não arrasta | **Muda o status**, por quem pode atender o ticket (responsável ou equipe dele; admin pode todos). Configurável por visão |
| D6 | **Biblioteca de arrastar** | `@dnd-kit` (mouse e teclado) / HTML nativo (só mouse) | **`@dnd-kit`**: dependência nova, leve, acessível por teclado |
| D7 | **Dados enquanto não há tabela de tickets** | Visões no banco já, tickets do mock / esperar a tabela de tickets | **Visões no banco já.** As condições rodam no front sobre o mock (mesmo avaliador testado). Quando a tabela de tickets existir, a RPC aplica as mesmas condições em SQL |

## 5. Fases (checklist binário)

### Fase 1: menu, rotas e permissões
- [x] `gestao_chamados` vira pai; seções **Visão geral** e **Tickets** no `menuRegistry`, com abas internas como na Administração.
- [x] Redirecionar `/gestao-chamados?…` para `/gestao-chamados/visao-geral?…`; links da Página Inicial atualizados.
- [x] Migration aditiva: permissões das duas seções para admin, ti e operador (mock igual).

### Fase 2: status, justificativas e TAG
- [x] Tipos: status fixos + `justificativa_id` + `tags[]` no ticket; mock ajustado (Aguardando › justificativas).
- [x] Resumo da Página Inicial e Visão geral continuam com os mesmos números (testes atualizados).
- [x] `ch_justificativas` + RPCs de cadastro (admin/super_admin).

### Fase 3: visões no banco
- [x] `ch_visoes`, `ch_kanban_padrao`, RLS e RPCs `ch_visao_salvar` / `ch_visao_excluir` / `ch_kanban_padrao_salvar`, com validação de campos e operadores e auditoria.
- [x] Ensaio com rollback: admin salva; operador recebe FORBIDDEN; operador lê só as habilitadas do seu perfil; insert direto bloqueado.
- [x] 3 visões iniciais: "Fila de chamados" (Kanban, padrão), "Por equipe" (Lista agrupada) e "Meus tickets" (Responsável = usuário logado).

### Fase 4: avaliador de condições
- [x] `campos.ts` (lista fechada) e `avaliar.ts` (TODAS e QUALQUER), com testes de cada operador e da combinação dos dois blocos.

### Fase 5: tela Tickets
- [x] Seletor de visão, busca, contagem.
- [x] Kanban (`@dnd-kit`): colunas da visão, ordenação, arrastar com mudança de status (pergunta quando a coluna tem vários status).
- [x] Lista agrupada: grupos com total, colunas escolhidas, paginação.
- [x] Clique abre o detalhe; botão "Configurar visões" só para Admin e Super admin.

### Fase 6: tela Configurar visões
- [x] Lista de visões (nova, duplicar, excluir) e editor com as abas **Principal**, **Condições** (operador e valor conforme o campo, pré-visualização da contagem), **Kanban** (status sem coluna, colunas arrastáveis e renomeáveis, padrão/restaurar) e **Agrupamento**.
- [x] Aba **Justificativas** (cadastro por status).
- [x] Rota bloqueada para quem não é Admin ou Super admin (mesmo digitando a URL).

### Fase 7: verificação
- [x] E2E no Edge com "Ver como":
  - admin cria e edita uma visão e ela aparece para o operador;
  - o operador não vê "Configurar visões" e não abre a rota;
  - arrastar um cartão muda o status;
  - a visão desabilitada some do seletor.
- [x] 1440 / 1100 / 390 px: o Kanban rola de lado **dentro do quadro**, sem rolagem lateral da página; a Lista vira cartões no celular.
- [x] `npm run build`, `npm test` e `oxlint` sem erros.

## 6. Resultado (07/10/2026)

- **Banco:** migration `20261007150000_imobdesk_chamados_status_visoes.sql`, ensaiada com rollback e aplicada.
  - Ela cria `ch_status`, `ch_status_justificativas`, `ch_visoes` (índice único para uma só visão padrão) e `ch_kanban_padrao`, além das RPCs `ch_*`, da carga inicial (7 status, 7 justificativas, 3 visões) e das permissões das seções para admin, ti e operador.
  - Ensaio por papel:
    - super admin: cria, exclui e define o Kanban padrão;
    - admin (operador promovido só no ensaio): configura, mas não exclui nem define o padrão;
    - operador: lê status e só as visões habilitadas da sua equipe (0 sem equipe; 1 com equipe e uma visão desabilitada); não configura;
    - condição inválida e valor vazio são rejeitados;
    - leitura direta da tabela e anon são negados.
- **Front:**
  - `src/features/chamados/` (status, visões, avaliador, permissões, dnd, telas Tickets, ConfigurarVisoes e StatusCadastro);
  - `src/pages/GestaoChamados.tsx` (seções e redirecionamento de `/gestao-chamados?…`);
  - `adminOnly` no `menuRegistry`/`policy.ts`, com o selo "Somente admin e super admin" na matriz de permissões.
- **Testes:** 44 (10 novos: avaliador, Kanban, permissões, validação).
- **E2E no Edge:**
  - redirecionamento do link antigo;
  - seções do super admin;
  - arrastar pelo **teclado** (← → pulam de coluna) até Reabertura e pelo **mouse** até uma coluna com 3 status, com o diálogo de escolha;
  - "Mudar status" no detalhe;
  - Lista agrupada;
  - configurar: arrastar status para coluna, criar visão nova só para Sistemas, recusa de condição sem valor;
  - status novo criado;
  - Ana (operadora) vê as visões da equipe e "Meus tickets" só com os dela; Gustavo (sem equipe de TI) vê "Nenhuma visão para a sua equipe";
  - operador não abre Configurar visões nem Status pela URL;
  - 1440, 1100 e 390 px sem rolagem lateral; console limpo.
- **Diferenças em relação ao texto do plano:**
  - as **justificativas** ficaram na tela **Status** (seção própria, D2), e não numa aba de Configurar visões;
  - a opção de ordenação "Atualizado em" saiu, porque o ticket ainda não tem essa data;
  - encerrados (resolvido, fechado e cancelado) aparecem nas visões só se foram encerrados nos últimos 7 dias;
  - as mudanças de status pelo Kanban ficam só na sessão (modo demonstrativo, D7) até existir a tabela de tickets.

## 7. Fora deste plano
- **Tabela real de tickets e a `rpc_dashboard`** (pré-requisito para as visões filtrarem dados reais). Vale um plano próprio, que precisa decidir se os atendimentos da Administração (`at_atendimentos`, WhatsApp/e-mail) **viram tickets** da Gestão de Chamados ou continuam separados.
- **Campos adicionais** personalizados (ex.: PROTOCOLO) nas condições.
- Visões pessoais criadas pelo próprio agente.
