# Plano — Centro de Treinamento (tour por balões sobre as telas do sistema)

Mockup aprovado e commitado em 20/10/2026 (`0c44f61`): [docs/mockups/centro-treinamento.html](mockups/centro-treinamento.html).
Telas de referência capturadas da demonstração em [docs/mockups/centro-treinamento/](mockups/centro-treinamento/).

## Situação em 23/10/2026

O menu existe (`centro_treinamento` em `menuRegistry.ts`, página `src/pages/CentroTreinamento.tsx`), mas está vazio.
Os 11 módulos, os balões e as perguntas existem só no mockup (`MODULOS` e `QUIZ`). Esse arquivo é uma página HTML solta, e o portal não lê.
Por isso a tela mostra "Nenhum tutorial publicado".

## Decisões do Wagner

- **D1 — Sem voz:** cada balão tem só título e explicação.
- **D2 — Balões sobre a própria tela do sistema:**
  - a tela capturada aparece inteira;
  - o botão explicado fica contornado e o resto da tela fica escurecido;
  - o balão aponta para o botão.
  - No fim do módulo, o botão "Praticar na demonstração" abre https://imobdesk-demo.vercel.app na rota do módulo.
- **D3 — Cada pessoa vê o seu setor:**
  - TI, Administrativo e CFTV veem a trilha **Gestão de Tickets** (t1–t6);
  - Financeiro vê **Solicitações Financeiras** (f1–f5);
  - o setor vem do cadastro (`sf_setor_do_usuario`);
  - o Admin vê todos os módulos em Gerenciar tutoriais.
- **D4 — Progresso no banco:** passo atual e conclusão por pessoa e módulo, em migration aditiva. A pessoa retoma de onde parou, em qualquer computador.
- **D5 — Demonstração pronta para captura:** feito (`872ee21`). O App do solicitante do modo demo agora tem setores, serviços e chamados.

## Perguntas P1–P4 (aprovadas pelo Wagner em 23/10/2026, como recomendado)

- [x] **P1 — Setores fora dos 4** (Cobrança, Engenharia, Comercial…). Esses setores só abrem chamados e pedem reembolso.
  - *Aprovado:* trilha "Colaborador" (padrão, `tr_trilhas.padrao`) com os módulos de solicitante: t6 (abrir chamado), f1 (reembolso) e f2 (celular).
- [x] **P2 — Módulos de gestor** (t5 Monitor, f3 Aprovar).
  - *Aprovado:* `tr_modulos.restricao` = `gestor_setor` (t5: `at_setor_gestores` ou supervisão) ou `aprovador` (f3: aprovador/substituto ativo em `sf_setor_aprovador`).
  - Assim, quem atende não recebe um módulo de uma tela que não abre.
- [x] **P3 — Usuário sem cadastro em Pessoas** (sem setor).
  - *Aprovado:* trilha "Colaborador" e o aviso "Peça para incluir você em Pessoas".
- [x] **P4 — Onde fica o conteúdo dos balões.**
  - *Aprovado:* no banco, carregado pela migration com o conteúdo do mockup. O editor de "Gerenciar tutoriais" (mockup) muda o texto e a posição sem precisar de deploy.

## Como funciona por dentro

- **Conteúdo:**
  - tabelas `tr_trilhas`, `tr_trilha_setores`, `tr_modulos` e `tr_passos`;
  - em `tr_passos`, o `alvo` é `[x, y, largura, altura]` em % da tela, como no mockup;
  - as imagens das telas ficam em `public/treinamento/<tela>.webp`.
- **Progresso:** tabela `tr_progresso` com `usuario_id`, `modulo_id`, `passo_atual`, `concluido_em` e `atualizado_em`.
- **Segurança:**
  - RLS ligada e sem acesso direto às tabelas: tudo passa por funções `tr_*` `security definer`;
  - quem lê o conteúdo é o usuário autenticado;
  - quem escreve no conteúdo é só Admin ou Super admin;
  - cada pessoa grava só o próprio progresso;
  - a resposta da pergunta é conferida no banco (o gabarito não vai para o navegador).
- **Telas:**
  - um script captura as telas na demonstração com Playwright (`playwright-core` + msedge, modo `demo`);
  - a faixa `.dev-switcher`/`.topbar__status` fica escondida nas capturas;
  - "Recapturar telas" é o comando `npm run treinamento:capturar`, não um botão que roda no navegador.
- **Modo simulado:** `DATA_SOURCE === "mock"` lê o mesmo conteúdo de um arquivo TS de seed (via `import()` dinâmico, fora do pacote de produção) e guarda o progresso em memória.
- **Rotas:**
  - `/centro-treinamento` mostra "Meus treinamentos";
  - `/centro-treinamento/:modulo` abre o tour;
  - `/centro-treinamento/gerenciar` é uma seção com `parent: "centro_treinamento"` e permissão própria, só para Admin.

## Fases

### Fase 1 — Banco (migração `20261023100000_imobdesk_treinamento.sql`, só aditiva)
- [x] Tabelas:
  - `tr_trilhas`, `tr_trilha_setores`;
  - `tr_modulos` (trilha, papel, título, descrição, minutos, rota na demo, celular, pergunta, opções, resposta certa, status rascunho/publicado, ordem);
  - `tr_passos` (módulo, ordem, tela, título, texto, alvo, posição do balão);
  - `tr_progresso`.
- [x] `tr_trilha_modulos` (um módulo em várias trilhas: t6, f1 e f2 também estão na Colaborador)
- [x] RLS ligada nas 6 tabelas, sem política de acesso direto
- [x] Carga inicial com o conteúdo do mockup: 3 trilhas (Gestão de Tickets, Solicitações Financeiras e Colaborador), 11 módulos, 60 balões e 11 perguntas
- [x] Funções:
  - `tr_meus_treinamentos(p_setor)`: trilha do setor (com `p_setor`, só Admin, "ver como setor"), módulos publicados e progresso;
  - `tr_modulo(p_id)`: passos, sem gabarito;
  - `tr_progresso_salvar`;
  - `tr_responder`: confere a resposta e marca a conclusão.
- [x] Funções do Admin:
  - `tr_admin_painel`;
  - `tr_modulo_salvar`, `tr_passo_salvar`, `tr_passo_excluir`, `tr_passos_reordenar`;
  - `tr_progresso_por_setor`, `tr_progresso_pessoas`.
- [x] `tr_trilha_setores_salvar` (Admin liga setores a uma trilha; a carga liga TI, CFTV, Administrativo e Financeiro pelo nome)
- [x] Permissão `centro_treinamento_gerenciar`, ligada só a Admin
- [x] Teste no `test:db` (`tests/db/treinamento.db.test.ts`, 17 testes):
  - a pessoa vê só a trilha do próprio setor;
  - a pessoa grava só o próprio progresso;
  - resposta errada não conclui;
  - quem não é Admin não consegue editar.
- [ ] Aplicar a migration no Supabase compartilhado (aguardando o Wagner autorizar)

### Fase 2 — Telas capturadas
- [x] `scripts/capturar-treinamento.mjs`:
  - sobe a demo, entra com o usuário fictício e captura as 16 telas do mockup (desktop 1440×900, celular 390×844);
  - grava em `public/treinamento/*.webp`.
- [x] Script `treinamento:capturar` no `package.json`
- [x] Conferir as capturas: a faixa DEV não aparece (`visibility: hidden`, sem mexer no layout), só há dados fictícios e cada tela ficou abaixo de 200 KB (23–108 KB)
- [x] Os 60 contornos do mockup conferidos sobre as telas novas (desenho dos alvos por script): todos no botão certo

### Fase 3 — Serviço e tipos
- [x] `src/features/treinamento/types.ts`, `service.ts` e `hooks.ts`: chamadas às funções `tr_*` pelo padrão `fromPostgrest`/`fromFunction`
- [x] Modo simulado:
  - `src/features/treinamento/seed.ts` com o conteúdo do mockup;
  - progresso em memória;
  - setor pelo `setorMock`.
- [x] Hooks TanStack Query: `useMeusTreinamentos`, `useModulo`, `useSalvarProgresso`, `useResponder`

### Fase 4 — Tour por balões
- [x] Componente `TourPlayer`:
  - a tela inteira, com o alvo contornado e o resto escurecido;
  - o balão se posiciona sozinho (direita, esquerda, abaixo ou acima) e se reposiciona ao redimensionar.
- [x] Moldura de celular para os módulos `celular`
- [x] Controles:
  - Voltar e Próximo;
  - lista de passos ao lado, para pular para qualquer passo;
  - teclado (← → Esc);
  - "Passar sozinho" com ritmo Devagar, Normal ou Rápido.
- [x] A troca de imagem lê o passo atual na hora da troca (armadilha do mockup: cliques rápidos mostravam a tela errada)
- [x] Salva o passo atual ao avançar e retoma de onde parou
- [x] Cartão final:
  - pergunta, com "Acertou" (módulo concluído) ou "Reveja os passos";
  - botão "Praticar na demonstração".
- [x] `.classe[hidden] { display: none }` no cartão final (armadilha do mockup: o cartão ficava por cima do módulo seguinte)

### Fase 5 — Meus treinamentos
- [x] `CentroTreinamento.tsx`:
  - a página inicial passa a ser "Meus treinamentos", no lugar da lista de seções;
  - hero "Olá, <nome>. Sua trilha: <trilha>", com módulos concluídos e minutos.
- [x] Cartões dos módulos com capa, papel ("Quem atende", "Quem aprova"…), duração, barra de progresso e Começar, Continuar ou Rever
- [x] Aviso para quem não tem setor (P3)
- [x] Admin: seletor "Ver como setor"

### Fase 6 — Gerenciar tutoriais (Admin)
- [x] Seções `centro_treinamento_meus` (todos) e `centro_treinamento_gerenciar` (adminOnly) no `menuRegistry`, com ícone colorido (`npm run icones:setor`)
- [x] Tabela de módulos com setores, para quem, balões, duração, concluíram, status, Editar e ▶
- [x] Novo módulo, com título, trilha, papel, duração, rota, pergunta e status
- [x] Editor de balão:
  - lista dos balões do módulo;
  - escolha da tela;
  - contorno arrastável e redimensionável;
  - posição do balão;
  - título e explicação (aviso acima de 220 caracteres);
  - Salvar e Ver no tour.
- [x] Progresso por setor: pessoas, concluíram tudo, em andamento e não começaram, com "Ver pessoas"
- [x] Trilha de cada setor (fora do mockup): o Admin troca a trilha de um setor; sem trilha, segue a padrão

### Fase 7 — Fechamento
- [x] `npm run lint`, `npm run build`, `npm test` e `npm run test:db` passando
- [x] Teste no navegador (Playwright, demo local e publicada), em computador e celular: lista, tour, teclado, pergunta errada/certa, retomada no passo, "ver como" Financeiro, editor com arraste do contorno. Sem erro no console.
- [x] `npm run demo:publicar` (https://imobdesk-demo.vercel.app/centro-treinamento); a limpeza da pasta temporária agora tolera o EPERM do Windows
- [x] Atualizar a nota do Cerebro `vs-imobdesk-centro-treinamento`

## Como ficou (23/10/2026)

- **Rotas:** `/centro-treinamento` vai para `/centro-treinamento/meus`; o tour abre por cima em `/centro-treinamento/meus/<id do módulo>` (link compartilhável; Esc ou Fechar voltam).
- **Código:** `src/features/treinamento/` (`types`, `service` com o modo simulado, `hooks`, `TourPlayer`, `MeusTreinamentos`, `GerenciarTutoriais`, `EditorModulo`, `treinamento.css`, `conteudo.ts` só para a demonstração).
- **Telas:** `public/treinamento/*.webp`, geradas por `npm run treinamento:capturar`. Mudou uma tela do sistema? Rode de novo e confira os contornos em Gerenciar tutoriais.
- **Pendente:** aplicar a migration `20261023100000_imobdesk_treinamento.sql` no Supabase compartilhado. O modo automático do Claude Code bloqueia escrita em produção; o Wagner aplica. Se o portal for publicado antes disso, a tela do Centro de Treinamento mostra erro (as funções `tr_*` não existem): aplique a migration primeiro.

## Prompt de implementação

> Implemente o Centro de Treinamento do Imobdesk conforme `docs/PLANO-centro-treinamento.md` e o mockup aprovado
> `docs/mockups/centro-treinamento.html`. Os textos dos balões, os alvos e as perguntas saem dos arrays `MODULOS` e `QUIZ` do mockup,
> sem reescrever. Siga as decisões D1–D4 e as respostas de P1–P4. Use os padrões do projeto:
> - menu, rotas e permissões só pelo `menuRegistry.ts`;
> - tokens de `src/index.css`;
> - migration só aditiva;
> - funções `security definer` com `search_path = ''`;
> - modo simulado com `import()` dinâmico.
>
> Execute uma fase por vez. Ao fim de cada fase, rode lint, build e testes, marque o checklist deste arquivo (feito / não feito)
> e mostre o resultado antes de seguir.
