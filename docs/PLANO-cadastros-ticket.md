# Plano de ação: cadastros do ticket na Administração

Pedido do Wagner (07/10/2026): dentro de **Administração**, criar os submenus **Serviços**, **Urgências**,
**Categorias**, **Campos adicionais** e **Regras para exibição** (estrutura da Movidesk).

Mockup para aprovação: [`docs/mockups/cadastros-ticket.html`](mockups/cadastros-ticket.html). Os botões no
topo trocam de tela, e "Regras para exibição" tem um teste ao vivo.

**Já feito (07/10/2026):** as 5 seções existem no menu (`menuRegistry`, `parent: "gestao_atendimento"`), só para
Admin e Super admin (`adminOnly`), cada uma com a tela "em construção" e a descrição do que vai ter.

---

## 1. Como os 5 cadastros se ligam ao que já existe

| Cadastro | Para que serve | Liga com |
|---|---|---|
| **Serviços** | O que se pode pedir: árvore de até 3 níveis por setor (TI › Sistemas › ERP Sienge), com equipe responsável, descrição, **prazos de SLA por urgência**, urgência e categoria padrão, e onde fica disponível (agente, intranet, e-mail e WhatsApp pela IA) | É o `ch_servicos` previsto no plano do ticket único (Fase 6). A **descrição** é o que a IA usa para classificar (plano de IA, D3). Substitui os serviços fixos do mock |
| **Urgências** | Níveis (Urgente, Alta, Normal, Baixa), com ordem, cor de uma lista fixa e uma padrão | **Substitui a "Prioridade"** de hoje (visões, Kanban, lista, mock). Entra no prazo de SLA (matriz serviço × urgência) |
| **Categorias** | O tipo do ticket: Dúvida, Problema, Solicitação, Incidente, Melhoria. Pode valer para todos os serviços ou só para alguns | Campo novo no ticket; entra nas condições das visões, nos relatórios e nas regras para exibição |
| **Campos adicionais** | Campos próprios do ticket (PROTOCOLO, Obra/unidade, Patrimônio, Câmera…), com 9 tipos (texto curto, texto longo, número, data, data e hora, lista, várias opções, sim/não, usuário), onde aparecem (abertura, detalhe, encerramento) e obrigatoriedade (sempre, não ou por regra) | Resolve o que ficou fora das visões ("Ticket: Campo adicional: PROTOCOLO" do seu print). Os valores ficam no ticket |
| **Regras para exibição** | "Se [serviço, categoria, urgência, setor, origem ou valor de outro campo] … então [exibir, ocultar, tornar obrigatório, tornar opcional] [campo]". Ordenáveis; havendo conflito, vale a última | Aplicadas no formulário do ticket (novo ticket e detalhe) e, depois, na intranet. **"Obrigatório" também é conferido no banco** ao salvar, porque a tela sozinha não garante |

## 2. Decisões para você confirmar

| # | Decisão | Recomendação |
|---|---|---|
| D1 | **Quem acessa** | Só **Admin e Super admin** (regra fixa, igual às visões de Tickets). Já está assim no menu |
| D2 | **Serviços: níveis** | Até **3 níveis por setor**, como na Movidesk. Só o último nível é escolhido no ticket; os de cima organizam e passam a equipe e os prazos para baixo ("herda") |
| D3 | **SLA** | **Matriz serviço × urgência**, com 1ª resposta e solução em **horas úteis no horário do setor**. Sem prazo no serviço, vale o SLA padrão do setor (plano do ticket único, D6) |
| D4 | **Urgência no lugar de Prioridade** | Sim: um conceito só. A "Prioridade" das visões, do Kanban e do mock passa a se chamar **Urgência** e a vir do cadastro |
| D5 | **Exclusão** | **Nada se exclui depois de usado**: só desativa (como Status). Assim tickets antigos e relatórios não perdem a referência |
| D6 | **Chave do campo adicional** | Cada campo tem uma **chave fixa** (ex.: `protocolo`) gerada do nome e que não muda. Renomear o rótulo não quebra visões, regras nem a IA |
| D7 | **Onde as regras valem** | Formulário de **novo ticket** e **detalhe do ticket** agora; **intranet** quando ela existir. Tickets que chegam por e-mail ou WhatsApp não são barrados por campo obrigatório: o agente preenche ao assumir, e o ticket não pode ser **resolvido** com campo obrigatório vazio |
| D8 | **Visões** | Campos adicionais marcados "podem ser usados nas visões" entram como condição ("Ticket: Campo adicional: PROTOCOLO") e como coluna da Lista. Categoria e Urgência também |

## 3. Fases (checklist binário)

> Os **cadastros (Fases 1 e 2)** não dependem dos tickets reais e podem começar já. O **uso no ticket (Fase 3)** depende da Fase 1 do plano do ticket único (`ch_tickets`).

### Fase 1: banco (feita em 07/10/2026: migration `20261007170000_imobdesk_cadastros_ticket.sql`, ensaiada e aplicada)
- [x] `ch_urgencias`, `ch_categorias` (com serviços permitidos), `ch_servicos` (árvore com `pai_id`, setor, equipe, descrição, urgência e categoria padrão, canais, ativo) e `ch_servicos_sla` (serviço × urgência: 1ª resposta, solução).
- [x] `ch_campos` (chave fixa, rótulo, tipo, opções, ajuda, onde aparece, obrigatoriedade, uso nas visões, ativo) e `ch_regras_exibicao` (ordem, condições jsonb, ações jsonb, ativa).
- [x] RPCs de leitura (quem usa tickets) e escrita (só Admin e Super admin), com validação: até 3 níveis, sem ciclo na árvore, opções obrigatórias para lista, condições e ações da lista fechada. Auditoria. Carga inicial: urgências, categorias e os serviços de TI, CFTV e Administrativo do mockup.
- [x] Ensaio por papel com rollback e aplicação. Também entraram `ch_macros` (tela do ticket, T5), os setores TI, CFTV e Administrativo, as equipes Sistemas, Infraestrutura, CFTV e Administração (com a descrição para a IA) e o SLA/equipe padrão do setor.

### Fase 2: telas (feita em 07/10/2026, `src/features/chamados/cadastros/`)
- [x] **Serviços:** árvore com filtro por setor e busca; editor lateral com matriz de SLA.
- [x] **Urgências** e **Categorias:** listas ordenáveis, padrão e ativa/inativa.
- [x] **Campos adicionais:** editor com tipo, opções, onde aparece e obrigatoriedade; a chave aparece travada depois de criada.
- [x] **Regras para exibição:** lista ordenável com editor de condições e ações e o painel **Testar regras**. A lógica das regras fica numa função pura, com testes (a mesma usada no formulário do ticket).

### Fase 3: uso no ticket
- [ ] Ticket ganha serviço (do catálogo), urgência, categoria e valores dos campos adicionais. O prazo de SLA sai da matriz.
- [ ] Formulário de novo ticket e detalhe aplicam as regras. O banco recusa salvar ou resolver com campo obrigatório vazio (D7).
- [ ] Visões: Categoria, Urgência e campos adicionais como condição e coluna (D8). "Prioridade" vira "Urgência" (D4).

### Fase 4: verificação
- [ ] E2E: admin cadastra serviço, urgência, categoria, campo e regra; o formulário mostra e obriga o campo; o operador não abre os cadastros; 1440/1100/390 px sem rolagem lateral.
- [ ] `npm run build`, `npm test` e `oxlint` sem erros.
