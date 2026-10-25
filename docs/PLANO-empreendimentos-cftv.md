# Plano — Cadastro de Empreendimentos e identificação pela IA (CFTV)

Pedido do Wagner (12/10/2026): em Administração, um cadastro de empreendimentos (nomes copiados do campo da
Movidesk). Nos chamados do CFTV, a IA identifica qual empreendimento a equipe técnica vai atender.
Mockup: `docs/mockups/empreendimentos-cftv.html` (aguardando aprovação).

## 1. Viabilidade
Sim. A triagem por IA já existe (`supabase/functions/imobdesk-ia`, Gemini, `_shared/ia/triagem.ts`,
`ch_ia_config` por setor). Só que ela escolhe **equipe** em tickets **sem equipe** — e o CFTV tem uma equipe só,
então a fila atual (`ch_ia_pendentes`) nunca pegaria esses tickets. Por isso a identificação do empreendimento
é uma **segunda tarefa da mesma Edge**, com fila própria.

## 2. Desenho
- Tabela `ch_empreendimentos`: nome, apelidos (text[]), cidade, endereço, observação para o técnico,
  setores (bigint[], vazio = todos), ativo, ordem.
- `ch_tickets.empreendimento_id` (nullable, FK) + `empreendimento_origem` (`ia` | `manual`).
- `ch_ia_config`: novas colunas `empreendimento_ligado`, `empreendimento_limiar` (padrão 80), `empreendimento_desde`.
- Fila `ch_ia_empreendimentos_pendentes()`: tickets do setor ligado, sem empreendimento, ainda não avaliados
  (até 3 tentativas com erro). Manda assunto + 1ª mensagem + lista de empreendimentos do setor (nome e apelidos).
- Resposta da IA: `{ empreendimento_id | null, confianca, motivo, alternativas[] }`. Validada no TS (id da lista).
- `ch_ia_empreendimento_registrar()`: ≥ limiar e ticket ainda vazio → aplica e registra evento `ia` no histórico;
  abaixo → grava sugestões (selo "Revisar empreendimento", 3 sugestões em um clique). Escolha manual nunca é sobrescrita.
- Telas: Administração › Empreendimentos (adminOnly, padrão de `chamados/cadastros`); campo no ticket;
  coluna na Lista e filtro na barra de Tickets (vale para Lista e Kanban); uso por setor na própria tela.
  Fora desta entrega: "Empreendimento" como condição dentro de Configurar visões.

## 3. Decisões do Wagner (12/10/2026)
- **D1** "Empreendimentos" em Administração, só Admin e Super admin.
- **D2** Só no CFTV (configurável por setor na própria tela, "Uso por setor").
- **D3** IA aplica sozinha a partir de 80%; abaixo, "Revisar empreendimento" com até 3 sugestões.
- **D4** No App do solicitante, para o CFTV, o solicitante **escolhe** o empreendimento logo depois do setor (obrigatório).
  A IA cobre os chamados que chegam sem ele (e-mail, WhatsApp, agente).
- **D5** Nomes exatamente como na Movidesk: 81 nomes (3 prints + o 1º), na ordem de lá.
- Ajuste na implementação: o cadastro não tem "setores que atendem" por empreendimento (o mockup tinha). Quem
  decide o uso é o setor; todos os 81 são do CFTV. Fácil de acrescentar se outro setor precisar de outra lista.

## 4. Fases (checklist binário)
### Fase E-1: banco (migration `20261012100000_imobdesk_empreendimentos.sql`, aditiva)
- [x] `ch_empreendimentos`, `ch_empreendimento_config`, `ch_ticket_ia_empreendimento` + RLS fechada
- [x] `ch_tickets.empreendimento_id` / `empreendimento_origem` (`ia` | `manual` | `solicitante`)
- [x] RPCs: `ch_empreendimentos_lista`, `ch_empreendimento_salvar`, `ch_empreendimento_config_salvar`,
      `ch_ticket_empreendimento`, `ch_ticket_empreendimento_definir`, `ch_ia_empreendimentos_pendentes`,
      `ch_ia_empreendimento_registrar`, `cd_setor_empreendimentos`; `cd_ticket_criar` e `ch_lista_extras` redefinidas
- [x] Seed dos 81 nomes; CFTV com app e IA ligados (limiar 80)
- [x] Testes de banco: `tests/db/empreendimentos.db.test.ts` (9)
### Fase E-2: Administração › Empreendimentos
- [x] `gestao_atendimento_empreendimentos` no `menuRegistry` (adminOnly) + rota
- [x] Uso por setor (app, IA, limiar); lista com busca; novo/editar; apelidos; ativar/inativar
### Fase E-3: IA
- [x] `_shared/ia/empreendimento.ts` (regras, pedido, esquema, validação) + `tests/ia-empreendimento.test.ts`
- [x] Edge `imobdesk-ia` processa a segunda fila no mesmo cron de 1 min
### Fase E-4: ticket, listas e App do solicitante
- [x] Campo Empreendimento na tela do ticket (selo IA/Agente/Solicitante, troca, sugestões; salva na hora)
- [x] Coluna "Empreendimento" na Lista e filtro na barra de Tickets
- [x] App do solicitante: passo "1 · Empreendimento" com busca quando o setor pede
### Produção
- [ ] Aplicar a migration `20261012100000`
- [ ] Deploy da Edge `imobdesk-ia`
- [ ] Deploy do front (Vercel)
