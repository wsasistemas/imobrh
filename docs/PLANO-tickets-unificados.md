# Plano de ação: ticket único (WhatsApp, e-mail, intranet e agente viram tickets da Gestão de Chamados)

Decisão do Wagner (07/10/2026): **todos os atendimentos de WhatsApp e e-mail da Administração viram tickets
da Gestão de Chamados.** O ticket passa a ser a unidade de trabalho do portal, venha de onde vier.

Fluxo: aprovar este plano (e o mockup da tela do ticket, na Fase 5) → fases com checklist binário.
Migrations só aditivas, ensaiadas em `begin … rollback` por papel e aplicadas com `npx supabase db query --linked`.

---

## 1. O que existe hoje

| Peça | Situação | Onde |
|---|---|---|
| WhatsApp (Zenvia) | Conversa por (número do setor, telefone). Cada ciclo fila → atendimento → encerramento é um registro em `at_atendimentos`, que alimenta o Monitor | `at_conversas`, `at_atendimentos`, `at_mensagens`, webhook `imobdesk-zenvia-webhook` |
| E-mail | Contas por setor autorizadas. A **leitura automática (F4) e o envio (F5) ainda não existem**. `at_email_recebidos` foi pensado como "fila" de entrada (`pendente → virou_chamado`) | `at_email_*`, função `imobdesk-email` |
| Gestão de Chamados | Painel, Tickets (visões) e Status prontos, mas os **tickets vêm do mock** | `src/features/dashboard/mock.ts`, `ch_status`, `ch_visoes` |
| Organização | **Setor** (Administração: números, contas, fila, horário, gestores) e **Equipe** (grupo de pessoas, pode pertencer a um setor) | `at_setores`, `at_equipes` |

**Banco real hoje (07/10/2026):** 0 conversas, 0 atendimentos, 0 e-mails, 0 setores, 0 equipes. Não há dado
para converter: dá para desenhar o ticket do jeito certo, sem legado.

## 2. Desenho proposto

```
 WhatsApp (Zenvia) ──► at_conversas ──┐
 E-mail (Gmail/IMAP) ─► at_email_recebidos ─┤
 Intranet / Agente ─────────────────────┤──► ch_tickets  ◄── ch_status / justificativas (cadastro)
                                         │       │   ▲
                                         │       │   └── ch_servicos (catálogo: equipe, SLA, prioridade)
                                         │       ├──► ch_ticket_eventos (histórico: status, responsável, equipe, notas)
                                         │       └──► mensagens: at_mensagens (WhatsApp) + at_email_* (e-mail)
                                         ▼
          Visão geral (rpc_dashboard) · Tickets (visões em SQL) · Página Inicial · Monitor
```

- **`ch_tickets`** é a fonte única:
  - número (sequência única para todos os canais), assunto, solicitante (nome e contato), **origem** (WhatsApp, E-mail, Intranet, Agente) e **recebido em** (número ou conta);
  - setor, equipe, serviço, responsável, status e justificativa (do cadastro), prioridade e TAGs;
  - tempos: criado, entrou na fila, assumido, primeira resposta, prazo do SLA, encerrado e motivo do encerramento;
  - `conversa_id` ou `email_thread` para ligar as mensagens.
- **`at_atendimentos` deixa de ser usada** (fica no banco, vazia, porque a migration é só aditiva). Os mesmos campos passam para o ticket, e o **Monitor passa a ler `ch_tickets`**.
- **`ch_ticket_eventos`:** histórico de tudo o que mudou no ticket, com autor e hora. Base da linha do tempo e da auditoria do ticket.
- **`ch_servicos`:** o catálogo (ERP Sienge, Rede/VPN…) com equipe, SLA e prioridade padrão. Hoje é só mock.
- **Visões em SQL:** a RPC de Tickets aplica as condições salvas em `ch_visoes`, no mesmo formato já validado por `ch_condicao_valida`. O SQL é gerado nativo, nunca uma função por linha ([[postgres-filtro-dinamico-funcao-por-linha-lenta-gerar-sql-nativo]]).
- **`rpc_dashboard`:** devolve o formato que o painel já usa (`src/features/dashboard/types.ts`). A troca no front fica só em `useDashboardData()`.

## 3. Decisões para você confirmar

| # | Decisão | Opções | Recomendação |
|---|---|---|---|
| D1 | **Tabela do ticket** | Nova `ch_tickets` como fonte única / ampliar `at_atendimentos` | **`ch_tickets` nova.** `at_atendimentos` é só WhatsApp e está vazia; o Monitor passa a ler o ticket |
| D2 | **WhatsApp: quando nasce um ticket** | A cada novo ciclo da conversa (cliente escreve e não há ticket aberto) | Como ao lado. Se o cliente voltar em **até 24 h** depois de resolvido, **reabre o mesmo ticket** (status Reaberto); depois disso, ticket novo. O campo `reaberto_em_24h` já previa isso |
| D3 | **E-mail: quando nasce um ticket** | E-mail novo = ticket novo; resposta (`In-Reply-To`, `References` ou `[#número]` no assunto) entra no mesmo ticket | Como ao lado. Resposta a ticket resolvido há até **7 dias** reabre; depois disso, ticket novo. Abre ticket de **qualquer remetente**, menos uma lista de bloqueio (noreply, mailer-daemon, os próprios endereços do portal) |
| D4 | **Status automáticos** | Entrou na fila → **Novo**; assumido → **Em atendimento**; encerrado pelo atendente → **Resolvido**; encerrado por inatividade → **Fechado** | Como ao lado, e **Resolvido vira Fechado sozinho em 72 h** se o cliente não responder. As regras usam a **categoria** do cadastro de status, então continuam valendo se você renomear os status |
| D5 | **Equipe e serviço do ticket que chega** | Equipe padrão do setor / sem equipe (triagem manual) | **Equipe padrão do setor** (campo novo em Setores e números, opcional). Sem padrão, entra "Sem equipe" para triagem. O serviço começa vazio até a triagem (manual agora; a IA da Triagem inteligente depois) |
| D6 | **Prazo do SLA** | Horas corridas / **horas úteis no horário do setor** | **Horas úteis no horário do setor** (o horário já existe em Fila e horários). O prazo vem do serviço; sem serviço, de um **SLA padrão do setor** (campo novo, ex.: 8 h úteis) |
| D7 | **Quem vê quais tickets** | Agente: os dos seus setores e equipes, mais os dele. Gestor de setor: todos do setor. Admin/Super admin: todos | Como ao lado. "Minha equipe" no painel = equipes da pessoa. As visões filtram por cima disso |
| D8 | **Onde se responde** | WhatsApp continua na **Central de atendimento** (chat) e mostra o nº e o status do ticket; **e-mail responde de dentro do ticket** | Como ao lado. A tela do ticket mostra a conversa inteira (WhatsApp ou e-mail) e o histórico. **Mockup antes de construir (Fase 5)** |
| D9 | **Número do ticket** | Uma sequência para todos os canais, sem prefixo | **Uma sequência única** (como na Movidesk). O canal aparece como Origem |

## 4. Fases (checklist binário)

### Fase 1: modelo do ticket no banco (feita em 07/10/2026: migration `20261007171000_imobdesk_tickets.sql`, ensaiada e aplicada)
- [x] `ch_tickets`, `ch_ticket_eventos`, `ch_servicos`; `at_setores.equipe_padrao_id` e `sla_padrao_horas`; `at_conversas.ticket_id`.
- [x] Função do prazo em horas úteis pelo horário do setor (D6), com testes de borda: fim de semana, fora do horário e virada de dia.
- [x] RLS (D7) e RPCs: lista por visão (condições em SQL), detalhe, assumir, mudar status, equipe, serviço, prioridade e TAGs, nota interna. Toda mudança grava evento e auditoria.
- [x] Ensaio por papel (agente, gestor de setor, admin, super admin, anon) com rollback, depois aplicar. O ensaio achou e corrigiu uma brecha: ticket sem responsável ficava visível para quem não devia (comparação com NULL dentro de `not`).
- Diferença: as condições das visões continuam aplicadas no front sobre o `ch_painel()`, que já entrega só os tickets que a pessoa pode ver. Levar as condições para SQL fica para quando o volume pedir.

### Fase 2: painel e Tickets lendo do banco (feita em 07/10/2026)
- [x] `rpc_dashboard` no formato de `types.ts`. `useDashboardData()` e Tickets trocam o mock pela RPC (o mock continua no modo simulado).
- [x] Arrastar no Kanban e "Mudar status" gravam de verdade (evento + auditoria) via `ch_ticket_atualizar`; o banco explica o que falta para resolver.
- [x] "Novo ticket" (Agente/Intranet) grava em `ch_tickets` (`ch_ticket_criar`). Serviço do painel: `src/features/dashboard/service.ts` (mock em memória, compartilhado entre as telas, ou RPC).

### Fase 3: WhatsApp vira ticket
- [ ] Webhook: mensagem nova sem ticket aberto → cria ticket (D2); volta em até 24 h → reabre.
- [ ] Central: mostra o nº e o status do ticket; assumir e encerrar mudam o status (D4).
- [ ] Monitor passa a ler `ch_tickets` (mesmos indicadores).

### Fase 4: e-mail vira ticket
- [ ] Leitura automática (F4 do plano de contas de e-mail, pg_cron 1 min) cria ou anexa ao ticket (D3).
- [ ] Envio (F5) responde do ticket com `[#número]` no assunto e `In-Reply-To` para manter a conversa.

### Fase 5: tela do ticket
- [ ] **Mockup para aprovação** da tela do ticket: cabeçalho (nº, status, SLA, responsável, equipe, serviço, prioridade, TAGs), conversa (WhatsApp ou e-mail), histórico e ações.
- [ ] Implementação depois da aprovação.

### Fase 6: catálogo de serviços e SLA
- [ ] Cadastro de serviços (admin): nome, equipe, SLA em horas úteis e prioridade padrão.
- [ ] Setores ganham "equipe padrão" e "SLA padrão" (D5, D6).
- [ ] Fechamento automático de Resolvido em 72 h (D4), por pg_cron.

### Fase 7: verificação
- [ ] Do começo ao fim no ambiente real:
  - WhatsApp de teste cria ticket, o atendente assume e encerra, e o cliente volta em 24 h e reabre;
  - um e-mail cria ticket e a resposta entra no mesmo.
- [ ] Os números do painel, da Página Inicial e do Monitor batem com o banco.
- [ ] Cada perfil vê só o que deve (D7). `npm run build`, `npm test` e `oxlint` sem erros.

## 5. Fora deste plano
- Triagem por IA (classificar o serviço automaticamente): a tela mostra o painel, mas a IA fica para depois.
- Pesquisa de satisfação ao encerrar.
- Campos adicionais personalizados nas condições das visões.
