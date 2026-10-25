# Plano — "Receber chamado" no setor + "Setor do solicitante" no ticket

Status: **aprovado e implementado** · 16/10/2026 (migration `20261016100000_imobdesk_setor_solicitante.sql`)

## 1. O pedido, em uma frase

Separar os setores em dois papéis:

| Flag **Receber chamado** | Papel do setor | Exemplo hoje |
|---|---|---|
| Marcada | **Atende**: tem fila, agentes, serviços, equipes; ticket pode ser dele | TI, CFTV |
| Desmarcada | **Só solicita**: só serve para identificar de onde vem quem abriu | Financeiro, Comercial, Contratos… |

E todo ticket passa a mostrar o campo **Setor** (do solicitante). Sem vínculo → **"A identificar"**.

## 2. O que existe hoje (analisado)

- `at_setores` não tem nenhum indicador de papel — todo setor é tratado como setor de atendimento.
- `ch_tickets.setor_id` (obrigatório) é o setor **que atende**. Não existe setor **de quem pediu**.
- O solicitante é `at_pessoas` (ligado por e-mail/telefone em `at_pessoa_contatos`). Pessoa **não tem setor**.
- Ticket nasce por 5 caminhos diferentes: agente/intranet (`ch_ticket_criar`), clonar, e-mail, WhatsApp, App do solicitante.
- `usuariosxsetores.XLS`: **256 e-mails distintos em 36 grupos** ("Nome Social"). Só parte dos grupos bate com os setores cadastrados:

| Bate com setor existente | **Sem setor cadastrado** (qtd. pessoas) |
|---|---|
| ADMINISTRATIVO, ARQUITETURA, ASSISTENCIA TECNICA, COBRANÇA, COMERCIAL, COMPLIANCE, CONTABILIDADE / FISCAL, CONTRATOS, Departamento Pessoal→DP, ENGENHARIA, FINANCEIRO, INFRAESTRUTURA, TI | OBRA (77), ORÇAMENTO E PLANEJAMENTO (14), SUPRIMENTOS (14), INCORPORAÇÃO (12), JURIDICO (12), PROJETOS EXECUTIVOS (12), CRC (9), ADMINISTRATIVO DE OBRA (8), INSTALAÇÕES (7), PRESIDENCIA (5), RH (2), ALUMINIO (2), FISCAL (1), ESQUADRIA (1), grupos Arte Wave/Arte Jardim/Arte Design (6), Estagiaria COP (1), sem grupo (10) |

  8 e-mails aparecem em mais de um grupo (precisa regra de desempate).

## 3. Desenho proposto

### Banco (migração só aditiva)

1. `at_setores.recebe_chamados boolean not null default false`.
   Backfill: `true` para setor que **já está em uso como atendimento** (tem ticket, serviço, equipe, atendente, número WhatsApp ou conta de e-mail). Os demais ficam `false`.
2. `at_pessoas.setor_id bigint references at_setores` — o setor **a que a pessoa pertence** (qualquer setor, atende ou não).
3. `ch_tickets.setor_solicitante_id bigint references at_setores` (nulo = "A identificar").
   - **Trigger `before insert`** em `ch_tickets` preenche a partir de `at_pessoas.setor_id` do solicitante → cobre os 5 caminhos de criação sem mexer em cada RPC.
   - Fica **gravado no ticket** (foto do momento da abertura): se a pessoa mudar de setor depois, o histórico não muda.
   - Backfill dos tickets existentes pela pessoa.
4. RPCs:
   - `at_setor_salvar` aceita `recebeChamados`; `at_contexto` devolve o campo.
   - Seletores de **setor que atende** (serviços, equipes, transferir ticket, contas de e-mail, números WhatsApp) passam a listar só `recebe_chamados = true`; o banco recusa ticket em setor que não recebe (`INVALID_INPUT`).
   - Desmarcar a flag de um setor com tickets abertos ou atendentes → **bloqueia com mensagem** ("Setor tem X tickets abertos / Y atendentes").
   - Nova RPC para o agente trocar o **Setor** do solicitante no ticket (com evento no histórico + auditoria).
   - Pessoa: salvar/listar com `setorId`.
5. Importação da planilha: de-para **grupo → setor**, casando por e-mail com `at_pessoa_contatos`; e-mail sem pessoa cria a pessoa (`origem = 'importacao'`).

### Telas

| Tela | Mudança |
|---|---|
| Setores e números (lista) | Nova coluna **Receber chamado** (✓ / —) entre Atendentes e Situação |
| Setores e números (formulário) | Novo switch **Receber chamado** — "Desmarcado: o setor só identifica solicitantes; não tem fila nem recebe tickets" |
| Ticket (painel lateral) | Campo **Setor** (do solicitante), editável pelo agente; vazio mostra **A identificar** |
| Lista de tickets | Coluna opcional **Setor do solicitante** + filtro (inclui "A identificar") |
| Pessoas (cadastro) | Campo **Setor** |

## 4. Fases (checklist binário)

**F1 — Banco**
- [x] Migração `recebe_chamados` + carga (TI, CFTV, Administrativo, Financeiro)
- [x] `at_pessoas.setor_id` + `ch_tickets.setor_solicitante_id` + índices
- [x] Gatilho de preenchimento na criação do ticket (5 canais) + carga dos tickets existentes
- [x] RPCs: `at_setor_salvar`/`at_contexto` com a flag; `ch_cadastros`, `at_equipes_setores`, `cd_admin_painel` filtrando; trava ao desmarcar; `ch_ticket_setor_solicitante_definir`; `at_pessoa_setor_definir`; `ch_setores_opcoes`
- [x] Regra: setor que não recebe não aparece no App do solicitante (`cd_visivel`)
- [x] Aplicado no Supabase e testado como usuário (transação desfeita)

**F2 — Setores e números**
- [x] Coluna "Receber chamado" na tabela
- [x] Chave no formulário + mensagens de bloqueio

**F3 — Ticket**
- [x] Campo "Setor" no ticket com "A identificar" (troca atualiza a pessoa)
- [x] Coluna "Setor do solicitante" na Lista (filtro da coluna inclui "A identificar")
- [x] Campo "Setor" no cadastro de Pessoas
- [x] Contas de e-mail e Serviços só oferecem setor que recebe

**F4 — Carga da planilha**
- [x] Setores internos criados (sem receber): Obra, Obra - Arte Wave, Obra - Arte Jardim, Obra - Arte Design, Orçamento e Planejamento, Suprimentos, Incorporação, Jurídico, Projetos Executivos, CRC, Instalações, Presidência, RH, Alumínio, Esquadria, COP
- [x] Nomes corrigidos: Compliance, RI - Relacionamento Com Investidor
- [x] Importação: 250 e-mails → 244 pessoas novas, 233 com setor; 23 de 44 tickets já identificados

**F5 — Validação**
- [x] `npm run build` sem erro
- [ ] Abrir um chamado real por canal (e-mail, WhatsApp, App do solicitante) e conferir o Setor — **validar em produção**

## 5. Decisões do Wagner (16/10/2026)

1. Grupos da planilha sem setor → criar como setores internos, sem receber chamado.
2. FISCAL → "Contabilidade / Fiscal". Administrativo de obra → fica no setor de cada obra (setores "Obra - <nome>").
3. Conflitos da planilha → listados para decisão (abaixo).
4. Recebem chamado: TI, CFTV, Administrativo e Financeiro.
5. Trocar o setor no ticket atualiza também o cadastro da pessoa.
6. Corrigir "Complience" e "Relecionamento".

## 6. Pendências da planilha (ficaram "A identificar")

| Caso | Pessoas |
|---|---|
| Administrativo de obra (falta o setor da obra) | Cesar Ferreira, Marcus Tasca, Diego Liberato Gonçalves, Marcos Genésio (Murano), Gilberto Leite, Domicio Melo (Nexus), Pablo Barenco, João Silva |
| E-mail em dois grupos | arte.wave@ (Instalações / Obra) |
| Sem grupo na planilha | Victor Motta, Ricardo Ranauro, Carlyton Silva, Isabelle Passeri, Roberto Quintanilha, Joao Coelho, Lucas Pinho (Arte Design?), Natalia Taiane |
| Não importados (e-mail inválido) | Roberto P. Medeiros (sem domínio), Kailane Mello (sem e-mail), Gabriel Leitão, Matheus Almeida, Roney Souza, Pedro Souza (e-mails de teste) |
| Não importados (caixa compartilhada) | suporte.ti@ listada em Contratos (Carla Oliveira, Blenda Medeiros) |
| E-mail corrigido na carga | lucas.branco@ (tinha espaço), joao.santos@ (tinha "..") |
