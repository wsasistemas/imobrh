# Plano — Colunas nas visões de Tickets (Kanban e Lista)

Pedido do Wagner (10/10/2026):
1. Adicionar colunas na visão Kanban.
2. Renomear as colunas do Kanban.
3. Adicionar colunas de campos do ticket na visão em Lista.

## Análise: o que já existe

| Item | Hoje | Onde |
|---|---|---|
| Adicionar coluna no Kanban | ✅ Já existe, mas só em **Tickets › Configurar visões › aba Kanban** ("Adicionar coluna") | `ConfigurarVisoes.tsx` (AbaKanban) |
| Renomear coluna do Kanban | ✅ Já existe no mesmo lugar (clicar no nome da coluna) | idem |
| Quem pode | Só **Admin e Super admin** (`permissoesVisoes`) | `visoes/permissoes.ts` |
| Colunas da Lista | ⚠️ Só 9 fixas: Solicitante, Status, Responsável, SLA de solução, Origem, Serviço, Equipe, Prioridade, Criado em | `visoes/campos.ts` (`COLUNAS_LISTA`) |
| Ordem das colunas da Lista | ⚠️ Segue a ordem em que foram marcadas; não dá para reordenar | aba Agrupamento |
| Campos adicionais | Existem (`ch_campos`), inclusive com a opção **"usar em visões"**, mas **não** viram coluna | `ch_campos.usar_em_visoes` |
| Dados da lista | Vêm do `ch_painel()`, que **não** traz categoria, setor, 1ª resposta, prazo de resposta, atualizado em, criado por, contato nem os campos adicionais | migração `20261008140000` |

**Conclusão:**
- **Kanban:** a função existe, mas está escondida na tela de configuração. O ganho está em fazer isso **direto no quadro**.
- **Lista:** é trabalho novo de verdade: novas colunas, campos adicionais, escolha e ordem das colunas. O `ch_painel` também precisa trazer mais dados.

## Decisões que preciso de você

| # | Pergunta | Recomendação |
|---|---|---|
| D1 | Quem pode adicionar e renomear coluna do Kanban direto no quadro? | **Admin e Super admin** (como hoje). A coluna vale para todos que usam a visão. |
| D2 | Ao **adicionar** coluna no quadro: a coluna do Kanban é um conjunto de status. A nova coluna pede nome **e** os status que ela agrupa? | **Sim:** um diálogo com o nome e a escolha dos status. Os status já usados em outra coluna aparecem como "mover desta coluna". |
| D3 | Colunas da Lista: escolha da **visão**, igual para todos, ou **de cada pessoa**? | **Da visão**, definida pelo Admin. Opcional na Fase 3: cada pessoa esconde colunas só para si. |
| D4 | Campos adicionais marcados como **internos** podem virar coluna? | **Sim:** a lista é só da equipe, e o solicitante nunca a vê. |

## Fases

### Fase 1 — Kanban: adicionar e renomear direto no quadro (só front)
- [x] Título da coluna com ✏️ (Admin/Super admin). Clicar renomeia no lugar; Enter salva e Esc cancela.
- [x] Botão **"+ Coluna"** no fim do quadro, que abre o diálogo com nome e status (D2).
- [x] Menu ⋯ da coluna: mover para a esquerda/direita e remover. Remover devolve os status para "sem coluna", com confirmação.
- [x] Salva na própria visão (`ch_visao_salvar`, sem mudar o banco), com o aviso "Salvo para todos que usam esta visão".
- [x] Agente (sem permissão) continua vendo o quadro sem esses botões.

### Fase 2 — Lista: novas colunas de campos do ticket
- [x] Migração **aditiva** `20261010120000_imobdesk_lista_colunas.sql`. Em vez de mexer no `ch_painel()`, a função nova `ch_lista_extras()` traz os dados (mesmo filtro de visibilidade), e a Lista só a chama quando usa alguma coluna nova. Ela traz:
  - categoria;
  - setor/departamento;
  - urgência;
  - tags;
  - recebido em;
  - contato do solicitante;
  - criado por;
  - atualizado em;
  - 1ª resposta em;
  - prazo de 1ª resposta;
  - prazo de solução;
  - encerrado em;
  - forma de atendimento;
  - os **campos adicionais** com "usar em visões".
- [x] `COLUNAS_LISTA` ganha as colunas padrão novas. Os campos adicionais entram como `campo:<chave>`, com rótulo do cadastro e valor formatado pelo tipo (data, sim/não, lista, usuário…).
- [x] As células novas na Lista. Campo vazio mostra "—".

### Fase 3 — Lista: escolher e ordenar colunas
- [x] Botão **"Colunas"** na própria Lista (Admin/Super admin). Abre um painel com busca, marcar e desmarcar, e arrastar para ordenar. "Nº e assunto" fica sempre fixo na primeira coluna.
- [x] A aba Agrupamento, em Configurar visões, usa o mesmo seletor (busca e ordem).
- [x] Clicar no cabeçalho ordena a lista por aquela coluna (sem salvar).
- [ ] Opcional, conforme D3: "Esconder para mim", guardado no navegador. **Não feito; fica para quando o Wagner pedir.**

### Fase 4 — Conferência
- [x] Ensaio no Supabase local: o `ch_painel` com os campos novos e o tempo de resposta com volume.
- [x] Prints:
  - Kanban renomeando e adicionando coluna;
  - Lista com campos adicionais;
  - seletor de colunas.
- [x] `npm run build`, lint e testes. Teste de unidade da formatação dos campos adicionais.
- [x] Comandos de produção: a migração e o commit.

## Riscos
- **Painel maior:** o `ch_painel` fica mais pesado com campos adicionais. Mitigação: só os campos com "usar em visões", e o jsonb vem compacto.
- **Status ao renomear ou remover:** renomear não muda status; remover uma coluna não apaga status, só os deixa sem coluna. O banco já valida que toda coluna tem nome.

## Entrega (10/10/2026)

- **Kanban:**
  - ✏️ (ou duplo clique) renomeia no lugar;
  - o menu ⋯ tem Escolher status, mover para a esquerda/direita e Remover. Remover pede confirmação e fica bloqueado quando há uma só coluna;
  - "+ Coluna" pede nome, status e posição, e um status marcado sai da coluna antiga.
  - Arquivos: `KanbanEdicao.tsx` e `Tickets.tsx`.
- **Lista:**
  - 11 colunas padrão novas e os campos adicionais (`campo:<chave>`), formatados pelo tipo (`formatarCampo`);
  - o cabeçalho ordena (▲/▼), só na tela;
  - a tabela rola na horizontal, e só o assunto quebra linha.
- **Seletor de colunas** (`visoes/SeletorColunas.tsx`): busca, marcar e arrastar para ordenar. Usado no botão "Colunas" da Lista (`ColunasLista.tsx`) e na aba Agrupamento.
- **Conferência:**
  - ensaio no banco local: `ch_lista_extras` para Admin; Solicitante barrado;
  - prints de renomear, menu, nova coluna e lista com campos;
  - 154 testes (`tests/visoes-colunas.test.ts`), build e lint.
