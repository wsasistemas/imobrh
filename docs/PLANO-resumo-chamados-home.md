# Plano de ação: resumo de chamados na Página Inicial (correção visual)

Pedido (07/10/2026): os operadores também vão atender chamados, e o perfil vai passar a se chamar **Agente**.
Todos os perfis que atendem devem ver, ao entrar, o resumo dos **seus** tickets abertos, pendentes e
fechados. Antes de implementar, analisar o visual atual e planejar a correção.

Mockup para aprovação: [`docs/mockups/resumo-chamados-home.html`](mockups/resumo-chamados-home.html).
O seletor no topo do mockup troca o perfil e o escopo.
**Aprovado em 07/10/2026 com as recomendações (D1 = A, D2 a D5 como na tabela). Implementado no mesmo dia.**
Fluxo: aprovar o mockup → este plano vira o prompt → fases com checklist binário. Migrations só aditivas,
ensaiadas em `begin … rollback`.

---

## 1. Análise do que está no ar hoje

Base: capturas da Página Inicial em 1440 px e 390 px, no modo simulado (07/10/2026).

| # | Problema | Evidência | Efeito |
|---|---|---|---|
| 1 | **Dois visuais na mesma página.** O bloco Chamados usa azul, IBM Plex e o raio/sombra do design system novo. O resto da página usa vermelho da marca e Inter. | Link "Abrir Gestão de Chamados" azul, números azuis e pills azuis, ao lado dos cards de módulo vermelhos | Parece outro produto. Isso contraria o padrão visual único do portal |
| 2 | **Os 6 KPIs são da operação, não da pessoa.** "Sem responsável" fica sempre em 0 no escopo Meus, e "Abertos hoje" não diz o que o agente tem para fazer | Captura em "Meus": Sem responsável = 0 | Ruído; falta o que foi pedido: abertos, pendentes e fechados |
| 3 | **O mesmo número aparece duas vezes.** O KPI "SLA vencido" (7) e o alerta "7 tickets com SLA vencido" ficam um embaixo do outro | Captura 1440 | Ocupa altura e não acrescenta nada |
| 4 | **A coluna Responsável é redundante em "Meus":** mostra "WA Você" em todas as linhas | Captura 1440 | Ocupa espaço que o assunto precisaria |
| 5 | **No celular, a coluna SLA fica fora da tela.** A tabela rola de lado e só a 1ª coluna aparece | Captura 390: sem ORIGEM, RESPONSÁVEL e SLA | O dado mais importante (prazo) some |
| 6 | **6 KPIs viram 3 linhas de 2 no celular** (≈ 400 px de altura) antes da lista | Captura 390 | A lista de chamados fica abaixo da dobra |
| 7 | **Fechados não existe no modelo.** `TicketStatus` só tem Novo, Em atendimento e Aguardando terceiros | `src/features/dashboard/types.ts` | Não há como mostrar "fechados" |
| 8 | **O perfil Operador não tem `gestao_chamados`.** No mock só admin e ti têm; no banco, nenhum perfil tem | `mock/db.ts:224`; nenhuma migration cita `gestao_chamados` | Os agentes não veem o resumo |

## 2. O que muda (mockup)

1. **Visual único na Página Inicial:** fonte Inter, cards no padrão dos cards de módulo (branco, borda `--line`, raio 12, padding 22, hover com borda vermelha), links e CTA em vermelho da marca, títulos no `.section-title`. O azul e a IBM Plex saem da Página Inicial.
2. **Cards Abertos · Pendentes · Fechados** (mais **Sem responsável** só em "Minha equipe"):
   - **Abertos:** com etiquetas "N vencidos" (vermelha) e "N vencem hoje" (âmbar), sempre com texto. Sem nada em risco, mostra a etiqueta "Tudo no prazo" (verde). O alerta separado sai.
   - **Pendentes:** aguardando o solicitante ou um fornecedor.
   - **Fechados:** nos últimos 7 dias, com "N hoje" embaixo.
   - Cada card leva à Gestão de Chamados já filtrada (`?escopo=` e `?metrica=`, que já existem).
3. **Lista "Seus próximos prazos":** sem a coluna Responsável em "Meus". Em "Minha equipe", o responsável vira texto na linha do número ("· Não atribuído" em âmbar).
4. **Celular:** a lista vira cartões (nº e solicitante, assunto, categoria, SLA embaixo) e a origem some. Os cards ficam em grade de 2, com Abertos ocupando a linha inteira em "Meus".
5. **Sem chamados:** "Nenhum chamado aberto com você agora" e um link para a fila da equipe.

## 3. Decisões para você confirmar

| # | Decisão | Opções | Recomendação |
|---|---|---|---|
| D1 | **Visual da tela Gestão de Chamados** (hoje azul, idêntica à referência) | **A.** Também passa para o visual do portal: os tokens `--ds-*` apontam para os do portal, a fonte vira Inter e o CTA vira vermelho; o azul fica só nos gráficos. **B.** Só a Página Inicial muda e a Gestão de Chamados continua azul | **A.** Um produto só, como pede o padrão da WSA. Assim o clique num card não leva de um visual vermelho para um azul. Isso revê a decisão da Etapa 1 ("paleta azul isolada em `--ds-*`"), que foi a recomendação padrão e não um pedido seu |
| D2 | **O que conta como Aberto, Pendente e Fechado** | Aberto = Novo + Em atendimento. Pendente = Aguardando terceiros. Fechado = Resolvido + Fechado | Como ao lado. Entram 2 status novos: **Resolvido** (aguarda o solicitante confirmar) e **Fechado** |
| D3 | **Período dos Fechados** | Hoje / 7 dias / mês corrente | **7 dias**, com "N hoje" embaixo |
| D4 | **"Minha equipe" para agentes** | Agente vê Meus + Minha equipe / só Meus | **Meus + Minha equipe.** É em "Minha equipe" que o agente vê o "Sem responsável" e assume chamados. "Todos" fica só na Gestão de Chamados |
| D5 | **Renomear Operador → Agente** | Agora / depois | **Depois, como você disse.** O código nunca usa o texto "Operador", só a chave `operador`. Na hora, basta trocar o `label` em Perfis (uma migration aditiva de `update`) |

## 4. Fases (checklist binário)

### Fase 1: dados e permissão
- [x] `TicketStatus` ganha `Resolvido` e `Fechado`; o payload ganha `closed_at`.
- [x] Novas métricas em `queue.ts`: `open`, `pending`, `closed_7d` e `closed_today`; testes em `tests/dashboard-queue.test.ts`.
- [x] O mock ganha tickets fechados e números por usuário, para "Ver como" mostrar cada agente com os dados dele.
- [x] Mock: `operador` recebe `gestao_chamados: true`.
- [x] Migration aditiva: `insert … on conflict do nothing` em `imobdesk.profile_permissions` (`operador`, `gestao_chamados`) e (`ti`, `gestao_chamados`), ensaiada em `begin … rollback`.

### Fase 2: Página Inicial no visual do portal
- [x] `HomeTicketsSummary` refeito com as classes do portal (sem `.ds`): cards, etiquetas e lista do mockup.
- [x] Título "Meus chamados" / "Chamados da equipe" conforme o escopo; "Sem responsável" só em equipe.
- [x] Coluna Responsável fora de "Meus"; lista em cartões abaixo de 640 px.
- [x] Estado vazio com link para a fila da equipe.
- [x] Sem hex solto: cores dos tokens do portal (`src/index.css`); etiquetas de SLA pelos tokens de estado.

### Fase 3: Gestão de Chamados no visual do portal (só se D1 = A)
- [x] Os tokens `--ds-*` passam a apontar para os do portal (fonte, primary, ring, superfícies). Os nomes dos tokens ficam, só o valor muda.
- [x] Os KPIs "Abertos/Pendentes/Fechados" entram também na Gestão de Chamados, com os mesmos filtros de URL.
- [x] A vitrine `/design-system` mostra a paleta nova.

### Fase 4: verificação
- [x] E2E no Edge: admin, ti e operador ("Ver como") veem o bloco com os números de cada um; financeiro não vê.
- [x] Cada card abre a Gestão de Chamados com o escopo e a métrica certos.
- [x] 1440, 1200 e 390 px: sem rolagem lateral; no celular o SLA aparece em todas as linhas.
- [x] `npm run build`, `npm test` e `oxlint` sem erros.

## 5. Resultado da verificação (07/10/2026)

- Migration aplicada em `ikvjaowvpvxojvcfwnct`, depois do ensaio com rollback. `profile_permissions` ficou com `gestao_chamados` para admin, operador e ti.
- E2E no Edge com "Ver como":
  - Wagner (super admin): Abertos 11 (7 vencidos, 2 vencem hoje) · Pendentes 9 · Fechados 9 (1 hoje).
  - Ana Lima (operador): Abertos 17 · Pendentes 0 · Fechados 8.
  - Marcos Prado (TI, sem chamados): abre em "Minha equipe" (49 · 27 · 25 · 17 sem responsável).
  - Fernanda Dias (financeiro): não vê o bloco.
- Cada card abre a Gestão de Chamados com `?escopo=` e `?metrica=`. Recortes sem KPI na tela (Abertos, Pendentes, Fechados) aparecem como "Recorte: …" ao lado da busca. Fechados mostram "Resolvido/Fechado em dd/mm, hh:mm" no lugar do SLA.
- Larguras de 1440, 1100 e 390 px: sem rolagem lateral, SLA visível em todas as linhas. Console limpo.
- Ajustes feitos durante o teste:
  - o escopo salvo passou a ser por usuário, e o bloco reinicia quando o "Ver como" troca de usuário;
  - com Abertos = 0, a etiqueta mostra "Nenhum aberto" em vez de "Tudo no prazo".
- Diferença em relação ao texto da Fase 3: Abertos, Pendentes e Fechados **não** viraram 3 KPIs a mais na Gestão de Chamados; ela continua com os 6 da referência. Esses recortes chegam pela URL e aparecem como "Recorte: …".

## 6. Fora deste plano
- A RPC `rpc_dashboard` real. Ela já deve nascer com `open`, `pending` e `closed_*` por usuário e por equipe, no formato da Fase 1.
- A renomeação Operador → Agente (D5).
