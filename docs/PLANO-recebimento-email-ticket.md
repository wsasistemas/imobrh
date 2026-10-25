# Plano — Recebimento de e-mail e abertura de ticket (Etapa 4: F4 + F5)

> **Status:** Fases A, B e C implementadas e em produção em 08/10/2026 (testando com `noreply@`; depois troca para `chamados.ti@`). Pendentes: anexos na tela do ticket, botão "Ler agora", equipe padrão do setor TI.

## 1. Diagnóstico da conta `noreply@exemplo.com.br`

O que está **certo** (conferido no banco em 08/10/2026):

| Item | Valor |
|---|---|
| Conta | id 9, "Suporte TI Exemplo", setor **TI**, padrão do setor |
| Autorização Google (OAuth) | autorizada como `noreply@exemplo.com.br` às 18:07 UTC; token guardado no Vault |
| "Testar configurações" | OK nos 3 passos: autorização; leitura da INBOX (16.222 e-mails, 16.183 não lidos); e-mail de teste enviado |
| Recebimento | habilitado; abrir tickets = "qualquer remetente"; importar a partir de 08/10/2026 |

**Por que o e-mail não virou ticket:** o sincronismo **ainda não existe**. A autorização e o teste só validam a caixa. O plano das contas de e-mail ([PLANO-contas-email.md](PLANO-contas-email.md), §4c) já registrava isso: "a leitura automática (F4) e o envio das respostas (F5) ainda não existem". As evidências:

- a conta tem `ultima_leitura_em` e `cursor` vazios, e `at_email_recebidos` tem 0 linhas;
- não há job no `pg_cron` para e-mail (o único job do portal é `imobdesk-gatilhos-5min`);
- a Edge `imobdesk-email` só tem as ações `rede`, `oauth_iniciar` e `testar`; falta a ação `ler`;
- não há rotina que transforme `at_email_recebidos` em ticket (`ch_ticket_criar` só é chamado pela tela).

**Pontos de atenção encontrados:**

1. **`noreply@` é também o remetente do login.** Desde hoje, o SMTP do Supabase Auth (convites e "esqueci a senha" de **todos** os portais) sai por essa conta. Os efeitos:
   - devoluções, respostas automáticas e respostas a esses e-mails caem na mesma caixa e virariam tickets;
   - um endereço chamado "noreply" desestimula o cliente a responder ao ticket.
2. **O campo `usuario` da conta ainda diz `suporte.ti@exemplo.com.br`**, e no dia 07/10 a conta 9 era `chamados.ti@exemplo.com.br`. O e-mail da conta foi trocado e sobrou o valor antigo.
3. **A caixa tem 16 mil e-mails não lidos.** A primeira leitura precisa respeitar "importar a partir de 08/10/2026"; sem isso, entrariam 16 mil tickets.
4. **"Qualquer remetente"** abre ticket para spam e para remetentes de fora da empresa.
5. **Risco de laço:** o gatilho "Ticket criado" responde por e-mail; uma resposta automática ("Estou de férias") voltaria como ação nova, e assim por diante.

## 2. Decisões para o Wagner

| # | Decisão | Recomendação |
|---|---|---|
| D1 | Qual caixa recebe os chamados da TI | **Uma caixa só para chamados** (`chamados.ti@` ou `suporte.ti@`), deixando `noreply@` só para o login. Se ficar `noreply@`, os e-mails do Auth precisam ser filtrados |
| D2 | Quem pode abrir ticket por e-mail | **"Cliente ou domínio"** com `exemplo.com.br`. "Qualquer" abre ticket para spam |
| D3 | Ao importar: marcar como lido no Gmail? | Sim (padrão atual) |
| D4 | Anexos | Salvar no Storage, até 25 MB por e-mail; acima disso, registrar só o nome |
| D5 | Envio das respostas (F5) junto, ou depois | **Junto.** Sem F5, a resposta do agente e o aviso do gatilho ficam como "pendente de envio" |

## 3. Plano de ação (fases com checklist binário)

### Fase A — Leitura da caixa (F4)
- Edge `imobdesk-email`, ação nova `ler`, chamada pelo `pg_cron` a cada 1 min com a chave de serviço:
  - para cada conta habilitada, com recebimento habilitado e token: renova o access token pelo refresh token do Vault;
  - **primeira leitura:** `messages.list` com `q = in:inbox after:<ler_desde>` e grava o `historyId` atual como cursor;
  - **leituras seguintes:** `history.list` desde o cursor (só `messageAdded` na pasta). Se o Google responder 404 (histórico expirado), volta para `messages.list` desde a `ultima_leitura_em`;
  - baixa cada mensagem (`format=raw`), interpreta o MIME (texto, html e anexos) e grava em `at_email_recebidos`. A gravação é idempotente por `(conta_id, message_id)`;
  - ignora o que não deve entrar: remetentes ignorados, a própria caixa, `Auto-Submitted: auto-*`, `Precedence: bulk/junk/list` e devoluções (`mailer-daemon`);
  - marca como lido (`messages.modify`), conforme a conta;
  - atualiza `ultima_leitura_em`, `cursor`, `status` e `ultimo_erro`. Um erro de token vira "Falha na conexão" na lista;
  - limite de 50 mensagens por conta em cada execução (o resto entra no minuto seguinte).
- Botão **"Ler agora"** na conta, que chama a mesma ação só para ela.

Checklist:
- [ ] e-mail enviado para a caixa aparece em `at_email_recebidos` em até 1 min, uma vez só (ler de novo não duplica)
- [ ] e-mails anteriores a "importar a partir de" não entram (a caixa tem 16 mil)
- [ ] remetente ignorado, resposta automática e devolução não entram
- [ ] anexo salvo no Storage e listado no e-mail
- [ ] token revogado vira "Falha na conexão" com a mensagem do Google
- [ ] `ultima_leitura_em` aparece na lista de contas

### Fase B — E-mail vira ticket ou ação
- RPC `ch_email_processar(p_recebido_id)`, chamada no fim da leitura:
  1. **É resposta?** Procura `[#número]` no assunto, ou `In-Reply-To`/`References` que batam com uma ação já enviada. Se achar, grava uma **ação de entrada** no ticket (dispara o gatilho "Ação do solicitante recebida") e reabre o ticket se ele estiver resolvido.
  2. **É novo?** Confere a regra de abertura da conta (D2). Acha ou cria a pessoa pelo e-mail (autocadastro por contato, que já existe) e chama `ch_ticket_criar` com: origem `email`, setor da conta, equipe padrão do setor, assunto, texto, anexos e `email_conta_id`.
  3. Marca o recebido como `virou_chamado` ou `ignorado`, com o motivo.

Checklist:
- [ ] e-mail novo de um remetente permitido abre ticket no setor TI, com assunto, texto e anexos
- [ ] resposta ao ticket (pelo `[#n]` ou pela conversa) vira ação no mesmo ticket, sem abrir outro
- [ ] remetente fora da regra de abertura não abre ticket e fica como "ignorado" com o motivo
- [ ] gatilho "Ticket criado" dispara para o ticket vindo do e-mail

### Fase C — Envio das respostas (F5)
- Ação `enviar` na Edge, também pelo `pg_cron` a cada 1 min:
  - pega as ações públicas `pendente` de tickets com origem e-mail e a fila `at_email_saida`;
  - monta a mensagem com o remetente e a assinatura da conta, o assunto com `[#n]`, e `In-Reply-To`/`References` do último e-mail do cliente;
  - envia pela Gmail API (a resposta fica em "Enviados" e na mesma conversa);
  - até 3 tentativas; o erro fica visível na ação do ticket.

Checklist:
- [ ] resposta do agente chega ao cliente na mesma conversa, com remetente e assinatura da conta
- [ ] o cliente responde e a resposta volta para o mesmo ticket (fecha o ciclo com a Fase B)
- [ ] falha de envio aparece no ticket e é tentada de novo, no máximo 3 vezes
- [ ] aviso de gatilho por e-mail sai e não gera laço com resposta automática

### Fase D — Ajustes da conta
- Corrigir o `usuario` antigo (`suporte.ti@`) e aplicar D1 e D2 na conta 9.
- Migração **aditiva**: colunas de controle em `at_email_recebidos` (`motivo`, `ticket_id`), índice por `message_id` para as respostas e os 2 jobs do `pg_cron`.

Checklist:
- [ ] conta 9 com a caixa e a regra de abertura decididas
- [ ] migração ensaiada com rollback e aplicada
- [ ] Edge republicada; os 2 jobs ativos no `pg_cron`

## 4. Ordem e teste de ponta a ponta

A → B → C → D (a D pode ir junto com a A). Teste final:
1. você envia um e-mail para a caixa;
2. o ticket aparece no portal em até 1 min;
3. o agente responde e o e-mail chega para você;
4. você responde e a resposta entra no mesmo ticket.
