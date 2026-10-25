# Plano de ação: Administração › Gatilhos (automações do ticket)

> **Aprovado em 07/10/2026 com as recomendações G1 a G7.** Entregues G-1 a G-5, menos o aviso por e-mail (Etapa 4).
> Migration `20261007210000_imobdesk_gatilhos.sql` aplicada.

O pedido do Wagner (07/10/2026) veio com um print da tela **Gatilhos** da Movidesk. O que ele pediu:
- criar, em Administração, o submenu **Gatilhos**;
- com ele, montar automações do ticket a partir das variáveis, como na Movidesk.

O mockup para aprovação está em [`docs/mockups/gatilhos.html`](mockups/gatilhos.html). Ele tem três partes:
- a lista dos gatilhos;
- o editor, com as abas Principal, Condições e Ações;
- o painel **Simular em um ticket** e a tela **Execuções**.

---

## 1. Análise: Movidesk × portal

| Na Movidesk (print) | No portal | Observação |
|---|---|---|
| Abas **Principal / Condições / Ações** | Iguais | — |
| Nome | Igual | Obrigatório e único |
| **Gatilho para** (Tickets, Pessoas…) | Só **Tickets** por enquanto; o campo já aparece | Pessoas fica para depois (G1) |
| "O gatilho precisa de pelo menos uma **condição de disparo**" | Bloco **Dispara quando**, com os acontecimentos lado a lado (ver 1.1) | Na Movidesk o disparo se mistura às condições. Separado, fica mais claro |
| **Atende TODAS** as condições (Se [campo] [valor] 🗑 ⊕) | Igual: Se [campo] [operador] [valor] | Reaproveita o editor de condições das Regras para exibição e das Visões |
| **Atende QUALQUER** condição | Igual; vazio não filtra | — |
| **Ações** (lista 🗑 ⊕) | Igual: [ação] [valor], na ordem | Ver 1.3 |
| Cancelar · Salvar e criar um novo · Salvar | Iguais | — |
| (não tem) | **Ativo**, **ordem** na lista, **Simular em um ticket** e **Execuções** | Para o admin confiar no que montou e achar erro |

### 1.1 Disparos

| Disparo | De onde vem |
|---|---|
| Ticket criado | `ch_ticket_criar`, e e-mail ou WhatsApp a partir da Etapa 4 |
| Ticket alterado (qualquer campo) | `ch_ticket_atualizar` |
| Status alterado | Idem, quando muda `status_id` ou a justificativa |
| Ação do solicitante recebida | `ch_ticket_acoes` com direção "entrada" (e-mail ou WhatsApp, Etapa 4) |
| Ação do agente adicionada | `ch_ticket_acoes` com direção "saída" ou nota interna |
| **Tempo no status ≥ N h úteis** | Verificação periódica (G3); usa `ch_somar_horas_uteis` |
| **SLA vence em ≤ N h** / **SLA vencido** | Verificação periódica (G3) |

### 1.2 Condições (variáveis)

Status/justificativa, urgência, categoria, serviço (inclui "está dentro de" um nó da árvore), equipe, responsável
(é / preenchido / vazio), setor, origem, tags, assunto ou texto contém, **cada campo adicional**, horário (dentro ou fora
do expediente do setor) e "ação feita por" (solicitante / agente / IA). Operadores: é, não é, é um de, não é um de,
contém, não contém, preenchido, vazio.

### 1.3 Ações

**Mudar o ticket:**
- alterar status (com justificativa), equipe, responsável (pessoa / para quem disparou / líder da equipe / ninguém), urgência, categoria e serviço;
- adicionar e remover tags;
- preencher um campo adicional;
- adicionar seguidor.

**Escrever:**
- adicionar nota interna;
- responder ao solicitante usando uma **macro**. Até a Etapa 4, a resposta fica "pendente de envio", como na tela do ticket.

**Avisar:**
- avisar pessoas (responsável, seguidores, líder, uma pessoa);
- avisar a equipe.

O aviso é dentro do portal (sino), e por e-mail depois da Etapa 4 (G4).

## 2. Pontos de atenção

1. **Laço infinito.** Exemplo: o gatilho A muda o status, o que dispara o B, que muda de volta. Regra: **ações feitas por gatilho não disparam gatilhos** (G2). Num mesmo evento, os gatilhos rodam **na ordem da lista**, e cada um enxerga o que os anteriores mudaram.
2. **Gatilho de tempo precisa de um relógio.** Hoje o banco tem `pg_net`, mas **não tem `pg_cron`**. Sem algo rodando a cada poucos minutos, não existe "48 h no status" nem "SLA vence em 2 h" (G3).
3. **Repetição.** Um gatilho de tempo veria o mesmo ticket a cada 5 minutos. Por isso há a tabela de execuções, com chave única por gatilho, ticket e entrada no status (ou "uma vez por ticket", opção da aba Principal).
4. **Resolver por gatilho segue as mesmas regras do agente:**
   - o banco exige serviço, os campos obrigatórios e a "Solução aplicada";
   - se faltar algo, a execução fica como **Erro** e o ticket não muda (exemplo na tela Execuções).
5. **Não pode travar o ticket.** O erro de um gatilho é gravado em Execuções e no histórico do ticket. Ele não desfaz a ação do agente que disparou.
6. **Avisos não existem ainda.** O sino do topo não tem tabela por trás. A ação "Avisar" precisa de `ch_notificacoes` e do sino lendo dela (G4).
7. **Permissão.** Como os outros cadastros da Administração, só **Admin e Super admin** (`adminOnly`).
8. **IA (Etapa 5).** A triagem da IA entra como "ação feita por: IA". O disparo "classificado pela IA" pode ser adicionado ali, sem refazer nada.

## 3. Decisões (recomendação; confirme ou ajuste)

| # | Decisão | Recomendação |
|---|---|---|
| G1 | "Gatilho para" | Só **Tickets** agora. O campo já fica na tela para Pessoas no futuro |
| G2 | Encadeamento | **Ações de gatilho não disparam outros gatilhos**. No mesmo evento, rodam na ordem da lista |
| G3 | Relógio dos gatilhos de tempo | **Ativar `pg_cron`** no projeto Supabase (compartilhado com outros sistemas da WSA), rodando a cada **5 min** só a função deste schema. Alternativa: Cron da Vercel chamando uma Edge Function |
| G4 | Ação "Avisar" | Nesta entrega: aviso no **sino do portal** (tabela nova `ch_notificacoes`). Por e-mail, depois da Etapa 4 |
| G5 | Responder ao solicitante por gatilho | Só por **macro**, não com texto solto, para o texto ficar revisado e reutilizável |
| G6 | Quando entra na ordem geral | **Logo após a Etapa 4** (e-mail e WhatsApp viram ticket), porque o principal gatilho, "cliente respondeu", depende dela. G-1 e G-2 podem vir antes, se você preferir |
| G7 | Gatilhos de exemplo | Criar os 4 da lista do mockup **inativos**, para o admin revisar e ligar |

## 4. Fases (checklist binário)

### G-1: banco
- [x] Tabelas:
  - `ch_gatilhos`: nome, para, disparos jsonb, condições TODAS/QUALQUER jsonb, ações jsonb, ordem, ativo, execução única;
  - `ch_gatilho_execucoes`: gatilho, ticket, disparo, chave única, resultado, erro, quando.
- [x] RPCs `ch_gatilhos_lista`, `ch_gatilho_salvar` (valida pelo menos um disparo e uma ação) e `ch_gatilho_ordenar`, só para admin e super admin. Também `ch_gatilho_simular(p_id, p_ticket)` e `ch_gatilho_execucoes(p_dias)`.
- [x] Avaliador `ch_gatilho_atende(ticket, condicoes)`: os mesmos operadores do front, com campo adicional e horário útil.
- [x] Executor `ch_gatilhos_rodar(ticket, disparo)`:
  - chamado no fim de `ch_ticket_criar`, `ch_ticket_atualizar` e `ch_ticket_acao`;
  - flag de sessão impede o encadeamento;
  - cada gatilho num bloco protegido (o erro vai para Execuções e não para o ticket);
  - registra no histórico "Gatilho: …".
- [x] Ensaio em `begin…rollback` por perfil, depois aplicar. Migration só aditiva.

### G-2: tela
- [x] Item `gestao_atendimento_gatilhos` no menuRegistry (adminOnly) e rota em Administração.
- [x] Lista: ordem com setas e arrastar, situação, contagem dos últimos 7 dias, Novo gatilho.
- [x] Editor com abas Principal, Condições e Ações:
  - Dispara quando;
  - TODAS e QUALQUER, com o valor de acordo com o campo (listas dos cadastros, pessoas, tags);
  - ações com valor de acordo com a ação (status, equipe, macro…);
  - Cancelar / Salvar e criar um novo / Salvar.
- [x] Simular em um ticket (mostra ✔/✘ por condição, sem gravar).
- [x] Tela Execuções (filtro por gatilho, resultado e erro).
- [x] Modo simulado (mock) igual ao real, para testar sem banco.

### G-3: gatilhos de tempo
- [x] Agendar `ch_gatilhos_tempo()` a cada 5 min (job `imobdesk-gatilhos-5min`). O `pg_cron` já estava instalado no projeto, então nada precisou ser ativado.
- [x] Disparos "tempo no status ≥ N h úteis", "SLA vence em ≤ N h" e "SLA vencido", sem repetir (chave por entrada no status).

### G-4: avisos
- [x] Tabela `ch_notificacoes`, RPCs de listar e marcar como lida, e o sino do topo mostrando os avisos (link para o ticket).
- [x] Ações "Avisar pessoas", "Avisar equipe" e "Adicionar seguidor".
- [ ] Aviso por e-mail (depende da Etapa 4).

### G-5: verificação
- [x] Testes de unidade do avaliador de condições (front) e ensaio SQL dos cenários:
  - cliente respondeu → Em atendimento;
  - 48 h → resolvido com erro por falta de solução;
  - um gatilho não dispara outro;
  - operador não acessa.
- [x] E2E da tela em 1440, 1100 e 390 px; `npm run build`, `npm test` e `oxlint` sem erros.
- [x] Gatilhos de exemplo criados inativos (G7) e guia curto para o admin em [`docs/GUIA-gatilhos.md`](GUIA-gatilhos.md).
