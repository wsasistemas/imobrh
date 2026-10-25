# Plano de ação: tela do ticket (classificar, responder e usar a solução anterior no mesmo lugar)

Pedido do Wagner (07/10/2026), com dois prints da tela de ticket da Movidesk:
- ao abrir o ticket, a **IA já pré-classificou**;
- o atendente **confere e preenche os campos** e, ao mesmo tempo, **responde ao solicitante**;
- o ticket mostra a **última solução dada para uma demanda parecida**, que o atendente usa ou não;
- o ticket ganha funções extras, por exemplo **macros** de resposta rápida, **clonar** e **mesclar**.

Na mesma mensagem o Wagner **aprovou as fases** dos planos pendentes (ticket único, IA e cadastros), com as recomendações.

Mockup para aprovação: [`docs/mockups/tela-ticket.html`](mockups/tela-ticket.html). Tudo é clicável: Aplicar classificação
da IA, Usar esta solução, macros, Nota interna, Opções ⋮ (clonar, mesclar, SLA, excluir) e os filtros da linha do tempo.

---

## 1. Análise: o que vem da Movidesk e como fica aqui

| Na Movidesk (prints) | No portal | Observação |
|---|---|---|
| Barra: solicitante, nº, status (com justificativa), olho, **Opções** | Igual. O olho vira **Seguir** (avisa quem segue o ticket). O status vem do cadastro de Status | — |
| Abas **Público / Interno** na esquerda | **Público** = dados do ticket; **Interno** = campos que o solicitante não vê (campos adicionais marcados internos, previsão de início, tempo apontado) | É a nossa interpretação das abas (T1) |
| Solicitante, "Colocar-me como solicitante" | Busca no cadastro de **Pessoas** (já existe) | — |
| Serviço ("Liberação de acesso a sites — T.I. - Infraestrutura » Solicitação") | Serviço do catálogo novo (Administração › Serviços), com a equipe e o SLA | A IA sugere, e o agente confirma |
| **Setor** (Fiscal, TI) | **Departamento do solicitante**, vindo de Pessoas (relação pessoa → departamento) | Não é o setor de atendimento, que aparece no topo pela conta ou número (T2) |
| Formas de atendimento (E-MAIL) | Campo "Forma de atendimento" (e-mail, WhatsApp, telefone, presencial, acesso remoto) | Vira um campo adicional padrão |
| Data previsão início | Campo adicional interno | — |
| Categoria, Urgência | Cadastros novos | — |
| Ativos | **Fase futura** (não há cadastro de ativos) | — |
| Previsão de solução (data, "Em pausa", lápis) | Prazo do SLA em horas úteis; **pausa** nos status de categoria *pendente*; o lápis altera o prazo com justificativa | T9 |
| Responsável "Equipe » Pessoa", "Atribuir para mim" | Igual | — |
| Tags, Cc | Igual. O Cc recebe cópia das respostas por e-mail | — |
| Editor + "Aplicar macro" + IA + "Manter o status atual" + **Adicionar ação** | **Responder ao solicitante** (sai pelo canal do ticket) ou **Nota interna**; macros; "✨ Melhorar texto"; "Depois de enviar: [status]" | T3 |
| "Análise gerada por IA" + "Fazer pergunta para IA sobre esse ticket" | Painel **Análise da IA** (intenção, resumo, classificação + motivo, **Aplicar**) + **💡 Já existe solução** + pergunta à IA | Plano de IA, Fases IA-2 a IA-4 |
| "Nenhum relacionamento encontrado" | Relacionamentos: clonado de/para, mesclado em, pai/filho | — |
| Visualizar: ações públicas, internas, mensagens internas, histórico | Filtros da linha do tempo, com o histórico vindo de `ch_ticket_eventos` | — |
| Opções: Iniciar chat, Enviar e-mail, Mensagem interna, Aplicar macro, Agendar abertura automática, Eventos, Detalhes, Imprimir, Detalhes do SLA, Apontamentos, **Clonar, Mesclar, Excluir** | Todas no menu; ordem de entrega na seção 4 | Agendar abertura, Apontamentos e Ativos ficam para depois (T11) |

## 2. Pontos de atenção encontrados na análise

1. **WhatsApp tem a janela de 24 h.** No WhatsApp oficial (Zenvia), só se responde texto livre até 24 h depois da última mensagem do cliente. Fora disso, só com um **modelo (template) aprovado** pela Meta. A tela vai mostrar "Janela de 24 h encerrada: use um modelo aprovado" e oferecer os modelos. O e-mail não tem essa trava.
2. **A "solução anterior" depende de os tickets guardarem a solução** ("Solução aplicada", plano de IA D2). No começo a base estará vazia. A carga inicial de artigos (IA-5) evita uma tela sem sugestões nas primeiras semanas.
3. **Mesclar mexe em dois tickets e no e-mail.** As respostas futuras do cliente no ticket mesclado precisam cair no destino. A regra fica no banco, não na tela.
4. **Excluir** contraria a regra "nada se apaga". Será **exclusão lógica**: o ticket some das filas e dos relatórios, mas fica guardado e auditado. Só o Super admin exclui.

## 3. Decisões (recomendação; confirme ou ajuste)

| # | Decisão | Recomendação |
|---|---|---|
| T1 | Abas Público / Interno | Público = dados do ticket; Interno = campos internos, previsão de início e tempo apontado |
| T2 | "Setor" do print | Departamento do solicitante (Pessoas). O setor de atendimento aparece no topo |
| T3 | Resposta ao solicitante | Sai pelo **canal de origem**: e-mail com `[#nº]` e `In-Reply-To` (mesma conversa) e WhatsApp pela Zenvia, respeitando as 24 h. Também dá para escolher "Enviar e-mail" para outro destinatário |
| T4 | Solução anterior | Mostra **a mais parecida** (com o link do ticket ou artigo de origem), mais "ver outras". **Usar** só copia para a resposta: nunca envia sozinha |
| T5 | Macros | Cadastro novo **Administração › Macros**. Cada macro tem texto com variáveis (`{{solicitante.nome}}`, `{{ticket.numero}}`, `{{agente.nome}}`) e **ações** (status, categoria, urgência, responsável, tags). Podem ser **pessoais ou da equipe** |
| T6 | Clonar | Cria um ticket novo com os campos; opção de copiar a conversa. Registra "clonado de / para" |
| T7 | Mesclar | As ações vão para o destino. A origem vira **Cancelado** com "mesclado em #…". O destino passa a receber as respostas da origem. A IA aponta possíveis duplicados |
| T8 | Excluir | Só **Super admin**; exclusão lógica, auditada |
| T9 | Previsão de solução | O SLA pausa nos status *pendente*. Alterar o prazo à mão: só gestor do setor, Admin ou Super admin, com justificativa no histórico |
| T10 | Pergunta à IA | Responde só com base no ticket e nas fontes citadas (tickets e artigos), sempre mostrando as fontes |
| T11 | Para depois | Agendar abertura automática (tickets recorrentes), Apontamentos de horas e Ativos |

## 4. Ordem geral de entrega (os quatro planos aprovados, numa sequência só)

| Etapa | O que entra | Planos |
|---|---|---|
| 1 | Banco: cadastros (serviços, urgências, categorias, campos, regras) + modelo do ticket (`ch_tickets`, eventos, RLS) | Cadastros F1 · Ticket único F1 |
| 2 | Telas dos cadastros + painel e Tickets lendo do banco | Cadastros F2 · Ticket único F2 |
| 3 | **Tela do ticket** (este plano, TT-1 e TT-2) | — |
| 4 | E-mail vira ticket (leitura e envio) + WhatsApp vira ticket | Ticket único F3 e F4 |
| 5 | IA: base, motor, "Testar IA" e conjunto de avaliação; depois o painel da IA na tela (TT-3) | IA-1 a IA-4 |
| 6 | Macros, clonar, mesclar, excluir, SLA e o restante das Opções (TT-4 a TT-6) | — |
| 7 | Captura de conhecimento, medição da IA, verificação de ponta a ponta | IA-5, IA-6 · Ticket único F7 |

## 5. Fases da tela do ticket (checklist binário)

### TT-1: estrutura e campos
- [x] Rota `/gestao-chamados/tickets/:numero` (abre pela fila, pelo Kanban, pela Lista e pela Página Inicial).
- [x] Barra: nº, solicitante, canal, conta/número, **Seguir**, status com justificativa, Opções.
- [x] Coluna esquerda (Público e Interno) com os cadastros, as **regras para exibição** aplicadas na hora, "Atribuir para mim" e "Salvar campos". O banco recusa resolver com campo obrigatório vazio.
- [x] Linha do tempo numerada, com filtros (públicas, internas, histórico de alterações).
- [ ] A assinatura e a citação de e-mail ficam recolhidas (depende do e-mail entrar como ticket, Etapa 4).

### TT-2: responder
- [x] **Responder ao solicitante** (fica "pendente de envio"), Cc, **Nota interna** e "Depois de enviar: status".
- [ ] Envio de fato pelo canal (e-mail/WhatsApp) e anexos (Etapa 4).
- [ ] WhatsApp: aviso e modelos aprovados fora da janela de 24 h.
- [ ] Rascunho guardado se a tela fechar.

### TT-3: IA na tela (depois de IA-2)
- [ ] Análise (intenção, resumo, classificação + motivo) e **Aplicar classificação**, com o histórico "aplicado por".
- [x] **💡 Já existe solução** sem IA: a última do mesmo serviço, "ver outras", **Usar esta solução na resposta** e **Usar como solução aplicada**.
- [ ] A mais parecida pela IA e 👍/👎 (Etapa 5).
- [ ] Pergunta à IA com fontes (T10) e **✨ Melhorar texto** (ortografia e clareza, sem mudar o sentido).

### TT-4: macros
- [ ] **Administração › Macros**: cadastro com texto, variáveis e ações; pessoais e da equipe.
- [x] Aplicar pelo botão e pelo menu Opções (variáveis, status depois de enviar, campos e tags).
- [ ] Aplicar por "/" no editor.

### TT-5: clonar, mesclar, excluir
- [x] Clonar (T6), mesclar (T7), excluir lógico (T8, só super admin) e o bloco de relacionamentos.
- [ ] Sugestão de duplicados da IA ao mesclar (Etapa 5).

### TT-6: SLA e demais opções
- [x] Detalhes do SLA, pausa e alteração com justificativa (T9).
- [x] Imprimir, Eventos e Enviar mensagem interna (abre a nota interna).
- [ ] Mensagem interna para um colega com aviso e Iniciar chat (abre a Central no WhatsApp do solicitante).

### TT-7: verificação
- [ ] E2E por perfil:
  - o agente classifica, aplica a IA, usa a solução e responde por e-mail, e o status muda;
  - nota interna não sai para o cliente;
  - macro preenche e muda o status;
  - clonar e mesclar registram o relacionamento;
  - operador não exclui.
- [x] 1440 / 1100 / 390 px sem rolagem lateral; `npm run build`, `npm test` e `oxlint` sem erros.
