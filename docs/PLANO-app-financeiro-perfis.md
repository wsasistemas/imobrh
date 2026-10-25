# Plano — App Financeiro por perfil (App do solicitante › Financeiro e menu do portal)

Mockup aprovado em 23/10/2026: [docs/mockups/app-financeiro-perfis.html](mockups/app-financeiro-perfis.html) (seletor "Ver como" com 4 perfis, 9 abas).
Módulo: Solicitações Financeiras. Antes de codar, leia [docs/Solicitacoes-financeiras/CONTEXTO.md](Solicitacoes-financeiras/CONTEXTO.md) e atualize-o no mesmo commit de cada fase.

## Pedido do Wagner

- No app, as telas seguem os três tipos: **Reembolso de despesas**, **Fundo fixo de caixa** (só gestor de setor) e **Adiantamento de numerário**.
- O colaborador comum não vê **Aprovações**, **Conferência financeira** nem **Cadastros financeiros**. Esses itens abrem pelo papel da pessoa e pela permissão do menu.

## Situação em 23/10/2026

- **App** (`src/features/solicitante/financeiro/AppFinanceiro.tsx`):
  - tem só Reembolso e Fundo fixo;
  - o fundo fixo aparece para quem tem valor cadastrado (`temFundoFixo` de `sf_minhas`);
  - o adiantamento aparece só para acompanhar;
  - não há Aprovações, Conferência nem Cadastros.
- **Portal** (`src/config/menuRegistry.ts`):
  - `sf_aprovacoes` é `alwaysVisible`: todo mundo vê o menu, vazio para quem não aprova;
  - `sf_conferencia` depende só da permissão, sem conferir se a pessoa é do setor financeiro.
- **Banco:**
  - `sf_meu_contexto` já devolve `ehAdmin`, `ehFinanceiro` e `ehAprovador`, mas não diz se a pessoa é gestora do setor (`at_setor_gestores`);
  - `sf_rascunho_criar` aceita fundo fixo de quem tem valor cadastrado, mesmo que não seja gestor.

## Decisões do Wagner (aprovadas em 23/10/2026, como recomendado no mockup)

- **D1 — Gestor de setor** é quem está em **Gestão do setor** no cadastro Setores e números (`at_setor_gestores`).
  - Não é um perfil novo.
  - O fundo fixo continua exigindo o valor cadastrado em Cadastros financeiros › Fundo fixo.
- **D2 — Aprovações** aparece para quem é **aprovador ou substituto ativo** em algum setor (`sf_setor_aprovador`, ou substituição por período em `sf_substituicao`) **e** tem a permissão `sf_aprovacoes` no perfil.
  - "Só o setor Financeiro" impediria os gestores de aprovar.
  - **Conferência financeira:** setor financeiro (`sf_eh_financeiro`) + permissão `sf_conferencia`.
  - **Cadastros financeiros:** `adminOnly`, sem mudança.
- **D3 — Mesma regra no menu do portal.**
  - `sf_aprovacoes` deixa de ser `alwaysVisible`.
  - Uma migration aditiva marca `sf_aprovacoes` nos perfis de quem hoje é aprovador ou substituto, para ninguém perder acesso.
- **D4 — Conferência no celular:** só a fila e a decisão item a item (aceitar, pedir ajuste, glosar).
  - Lançamento no SIENGE, programar pagamento e marcar como paga ficam no portal, pelo botão "Continuar no portal".
- **D5 — Adiantamento exige rede** e mostra um aviso claro quando não há.
  - A foto do documento de origem fica guardada no aparelho até o envio.
  - O reembolso continua funcionando sem rede.

## Perguntas em aberto (responder antes da fase indicada)

- [x] **P1 — Fundo fixo de quem não é gestor.** Aplicada a recomendação na Fase 1 (o Wagner pediu para seguir em 23/10/2026).
  - Hoje basta o valor cadastrado. Com D1, a pessoa precisa ser gestora do setor.
  - *Recomendo:*
    - antes de aplicar, a migration lista quem tem fundo fixo ativo e não é gestor;
    - a prestação de contas que já está em andamento segue até o fim;
    - um fundo fixo novo é recusado;
    - em Cadastros financeiros › Fundo fixo, essas pessoas aparecem com o aviso "não é gestor do setor".

## Como funciona por dentro

- **Uma regra só, no banco.** `sf_meu_contexto` passa a devolver o bloco `acesso`:
  - `reembolso`: tem setor em Pessoas;
  - `fundoFixo`: gestor do setor;
  - `temValorFundo`: tem valor de fundo cadastrado;
  - `adiantamento`: tem setor e não tem comprovação vencida (A06);
  - `aprovacoes`: aprovador ou substituto **e** `tem_permissao('sf_aprovacoes')`;
  - `conferencia`: `sf_eh_financeiro` **e** `tem_permissao('sf_conferencia')`;
  - `cadastros`: `ch_eh_admin()`.
  - Também passa a devolver o campo `ehGestor`.
  - O app e o portal leem esse mesmo bloco; nenhum dos dois decide sozinho.
- **O banco também barra.**
  - `sf_rascunho_criar('fundo_fixo')` recusa quem não é gestor, com mensagem clara.
  - As RPCs de aprovação, conferência e cadastros já conferem o papel (`sf_decidir_aprovacao`, `sf_exigir_financeiro`, `sf_exigir_admin`). O menu só esconde; quem garante é o banco.
- **Portal:**
  - o `AccessProvider` esconde `sf_aprovacoes` e `sf_conferencia` quando o `acesso` diz não, no mesmo padrão do `OCULTOS_SEM_WHATSAPP`;
  - a regra vale para o menu, as seções e as rotas;
  - erro na consulta não esconde nada.
- **App:**
  - `/app/financeiro` ganha 3 blocos: **Pedir** (cartões), **Gestão financeira** (só os itens liberados, com contadores) e **Minhas solicitações**;
  - rotas novas: `adiantamento/*` (5 passos), `s/:id/comprovar`, `aprovacoes`, `aprovacoes/:id`, `conferencia`, `conferencia/:id` e `cadastros`;
  - rota digitada sem acesso volta para `/app/financeiro`.
- **Modo simulado:** `sf_meu_contexto` simulado calcula o `acesso` pelo usuário do "Ver como", com os 4 perfis do mockup (Gustavo Reis, Carla Mendes, Ana Lima, Wagner Antunes).

## Fases

### Fase 1 — Banco (migration `20261023150000_imobdesk_sf_acesso_perfil.sql`, só aditiva)
- [x] Função `sf_eh_gestor(uuid)`: a pessoa está em `at_setor_gestores` de algum setor ativo
- [x] Função `sf_eh_aprovador(uuid)`: aprovador ou substituto ativo, ou substituto por período vigente (`sf_substituicao`)
- [x] `sf_meu_contexto` redefinida: mantém os campos de hoje e acrescenta `ehGestor` e o bloco `acesso` (com `adiantamentoBloqueio`, o motivo da A06). Admin recebe Aprovações, Conferência e Cadastros
- [x] `sf_minhas` redefinida: `temFundoFixo` = gestor **e** valor cadastrado; acrescenta `ehGestor` (o cartão desligado mostra o motivo certo)
- [x] `sf_rascunho_criar` redefinida a partir da versão da Fase 5B: fundo fixo exige gestor (P1)
- [x] `sf_cadastros_lista` redefinida: `ehGestor` nos fundos e nos usuários (P1: aviso "não é gestor do setor" na Fase 2)
- [x] `profile_permissions`: marca `sf_aprovacoes` para o perfil de cada usuário que é aprovador ou substituto ativo hoje (`on conflict do nothing`: perfil com a tela desligada fica como está)
- [x] Teste no `test:db` (`tests/db/financeiro-acesso.db.test.ts`, 14 testes; `financeiro-envio` ajustado ao gestor):
  - o colaborador recebe só reembolso e adiantamento;
  - o gestor recebe o fundo fixo;
  - o gestor sem valor recebe o fundo fixo sem `temValorFundo`;
  - quem não é gestor não cria fundo fixo;
  - o aprovador sem permissão não recebe Aprovações;
  - quem tem a permissão de conferência e não é do Financeiro não recebe Conferência;
  - o Admin recebe tudo;
  - o substituto por período recebe Aprovações;
  - a comprovação vencida bloqueia o adiantamento, com o motivo.
- [ ] Aplicar a migration no Supabase compartilhado (o Wagner aplica; o modo automático bloqueia escrita em produção)

### Fase 2 — Serviço, tipos e menu do portal
- [ ] `src/features/financeiro/solicitacoes.ts` / `service.ts`: tipo `AcessoFinanceiro` e `meuContexto()` com o bloco `acesso`; modo simulado pelo "Ver como"
- [ ] Hook `useAcessoFinanceiro` (TanStack Query, `staleTime` de 5 min, chave com o e-mail)
- [ ] `menuRegistry.ts`: `sf_aprovacoes` sem `alwaysVisible`; descrições atualizadas
- [ ] `AccessProvider`: oculta `sf_aprovacoes` / `sf_conferencia` conforme o `acesso` (menu, seções e rotas); erro na consulta não oculta
- [ ] `HomeFinanceiro`: blocos seguem o mesmo `acesso`
- [ ] Portal, Nova solicitação: cartão Fundo fixo só para gestor (`CartoesInicio`)

### Fase 3 — Início do Financeiro no app (abas 1 e 3 do mockup)
- [ ] Tela inicial do App do solicitante: o quadro Financeiro diz "reembolso e adiantamento" ("reembolso, fundo fixo e adiantamento" para o gestor) e mostra um contador com o que espera pela pessoa (aprovações + a conferir)
- [ ] `/app/financeiro`: blocos Pedir, Gestão financeira e Minhas solicitações, como no mockup
- [ ] Cartão Fundo fixo:
  - só para gestor;
  - gestor sem valor cadastrado vê o cartão desligado e o aviso "Peça ao Financeiro para cadastrar em Cadastros financeiros › Fundo fixo".
- [ ] Reembolso e prestação do fundo fixo: fluxo atual, sem mudança (câmera, leitura, rascunho offline)
- [ ] Sem rede: o `acesso` fica guardado no aparelho (última consulta). A Gestão financeira some até a rede voltar; Pedir › Reembolso continua.

### Fase 4 — Adiantamento no app (aba 4)
- [ ] Passo a passo de 5 telas em `/app/financeiro/adiantamento/:id`, com uma barra de progresso:
  1. documento de origem (tipo, foto com leitura `pedido_compra`, valor = total × percentual);
  2. obra e apropriação (obra, centro de custo, centro de apuração, conta caixa, rateio por tarefa somando 100%);
  3. valor e favorecido (valor por extenso, favorecido, CPF/CNPJ, finalidade);
  4. pagamento e prazos (forma, banco, agência, conta, tipo, vencimento, prazo de comprovação calculado pelo setor);
  5. revisar e enviar (checagens A01–A06, cadeia de alçadas, termo de responsabilidade).
- [ ] Mesmas RPCs do portal: `sf_rascunho_criar('adiantamento')`, `sf_adiantamento_salvar`, `sf_checagens_adiantamento`, `sf_enviar`. Lógica do módulo puro `_shared/sf/adiantamento.ts`.
- [ ] D5: sem rede, o cartão Adiantamento avisa "precisa de internet"; a foto do documento de origem fica no IndexedDB até subir
- [ ] Comprovação no app (`s/:id/comprovar`), pelo cartão "Comprovação pendente": foto da NF, checagens A07 e envio (`sf_comprovacao_anexar`, `sf_comprovacao_checar`, `sf_enviar_comprovacao`)
- [ ] Bloqueio A06 (comprovação vencida): cartão desligado com o motivo

### Fase 5 — Aprovações no app (aba 5)
- [ ] `/app/financeiro/aprovacoes`: abas Aguardando mim e Aprovadas por mim, com prazo de cada etapa ("venceu há 2 h", "vence em 20 h"), etapa N de M e alertas
- [ ] `/app/financeiro/aprovacoes/:id`: total, checagens, itens com prévia do comprovante e decisão Reprovar, Devolver ou Aprovar (comentário obrigatório para devolver e reprovar), por `sf_decidir_aprovacao`
- [ ] "Definir substituto (férias)": abre a tela do portal

### Fase 6 — Conferência e Cadastros no app (abas 6 e 7)
- [ ] `/app/financeiro/conferencia`: contadores (a conferir, pendência do solicitante, a comprovar) e a lista pelo "pagar até" (`sf_conferencia_fila`)
- [ ] `/app/financeiro/conferencia/:id`: item a item com o comprovante, declarado × comprovante, regras e a decisão (aceitar, pedir ajuste, glosar), com observação obrigatória quando o item tem alerta (`sf_conferencia_itens`, `sf_decidir_item`, `sf_pedir_ajuste`)
- [ ] D4: botão "Continuar no portal" para o lançamento no SIENGE, programar pagamento e marcar como paga
- [ ] `/app/financeiro/cadastros` (só Admin): valor do fundo fixo de cada gestor (`sf_fundo_fixo_salvar`). Categorias, regras e aprovadores abrem o portal.
- [ ] Ícones novos no `scripts/gerar-icones-setor.mjs` + `npm run icones:setor`

### Fase 7 — Fechamento
- [ ] `npm run lint`, `npm run build`, `npm test` e `npm run test:db` passando
- [ ] Teste no navegador (Playwright, demo local), em celular (390×844) e computador, nos 4 perfis do "Ver como":
  - itens visíveis conforme a tabela "Quem vê o quê" do mockup;
  - rota digitada sem acesso volta para o início;
  - adiantamento ponta a ponta;
  - aprovação com comentário;
  - conferência item a item;
  - sem rede, o reembolso continua.
  - Sem erro no console.
- [ ] Atualizar `docs/Solicitacoes-financeiras/CONTEXTO.md` (seção 10) e o `README.md` do módulo
- [ ] Tutoriais f1–f5 do Centro de Treinamento: conferir se algum balão aponta para o que mudou; se sim, `npm run treinamento:capturar`
- [ ] `npm run demo:publicar`
- [ ] Atualizar a nota do Cerebro `vs-imobdesk-solicitacoes-financeiras`

## Prompt de implementação

> Implemente o App Financeiro por perfil conforme `docs/PLANO-app-financeiro-perfis.md` e o mockup aprovado
> `docs/mockups/app-financeiro-perfis.html`. Leia antes `docs/Solicitacoes-financeiras/CONTEXTO.md`. Siga as decisões D1–D5
> e a resposta de P1. A regra de quem vê o quê fica num lugar só: o bloco `acesso` de `sf_meu_contexto`. O app e o portal
> só leem esse bloco, e o banco recusa a ação mesmo que alguém chame a função direto. Use os padrões do projeto:
> - menu, rotas e permissões só pelo `menuRegistry.ts`;
> - tokens de `src/index.css` e de `solicitante.css`;
> - migration só aditiva;
> - funções `security definer` com `search_path = ''`;
> - mesmas RPCs do portal no app, sem regra duplicada no front;
> - modo simulado pelo "Ver como".
>
> Execute uma fase por vez. Ao fim de cada fase, rode lint, build e testes, marque o checklist deste arquivo (feito / não feito),
> atualize o CONTEXTO.md e mostre o resultado antes de seguir.
