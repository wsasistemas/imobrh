# Plano de ação: Conversas do WhatsApp na Gestão de Chamados + OpenWA (opção A) + e-mail só domínio

Mockup aprovado pelo Wagner em 09/10/2026: [docs/mockups/conversas-chamados.html](mockups/conversas-chamados.html).
Decisões no Cerebro: `vs-imobdesk-gestao-atendimento-plano` (rodadas de 09/10/2026).

## 1. Pedido (como entendi)

- **Conversas e Monitor dentro da Gestão de Chamados.** O atendente usa um menu só: tickets e WhatsApp ao vivo.
- **Cada atendimento por WhatsApp vira ticket.**
  - O ticket abre quando a conversa entra na fila.
  - A IA classifica o ticket pela triagem existente.
  - Ao encerrar, o sistema pergunta "Foi resolvido?":
    - **Sim:** o ticket vai para Resolvido, com a solução resumida pela IA e revisada pelo atendente.
    - **Não:** o ticket vai para "Em atendimento".
  - Encerramento por inatividade: o ticket vai para "Em atendimento".
- **Identificação do colaborador pelo número,** com confirmação de nome e e-mail só no primeiro contato.
  - Número sem cadastro: pede nome e e-mail @exemplo.com.br.
  - Setor que exige linha corporativa: número fora da lista recebe um aviso e não abre ticket.
- **OpenWA, opção A,** com o mesmo motor da Zenvia, que continua funcionando:
  - o colaborador fala no privado com o número do sistema do setor;
  - cada pedido é repassado a um **grupo interno só de atendentes**;
  - o atendente responde **citando** o pedido, no celular ou no sistema, e a resposta chega ao privado do colaborador.
- **E-mail só domínio:** TI, Administrativo e CFTV abrem ticket só para remetentes @exemplo.com.br.
- **Métrica "Quem mais abre chamados"** na Visão geral.

## 2. Desenho

**Banco (regras e estado, atômico):** uma conversa ativa por `(número, telefone)`, como hoje.

1. `at_whatsapp_receber(p)` é a entrada única, chamada pelo webhook da Zenvia e pelo do OpenWA, com service role:
   - grava a mensagem;
   - roda a identificação no modo `robo`;
   - entra na fila;
   - cria ou continua o ticket;
   - grava a mensagem também como ação do ticket;
   - enfileira o repasse para o grupo interno.
2. As respostas automáticas e as mensagens do atendente ficam em `at_mensagens` com `status = 'pendente'`. Os repasses ao grupo ficam em `at_repasses`, também pendentes.
3. As ações do atendente vêm de `at_conversa_acao(conversa, p)`, uma RPC com o JWT de quem chama, como as RPCs `ch_*`:
   - assumir, devolver, transferir, enviar e encerrar (encerrar recebe `{resolvido, solucao, servicoId, categoriaId}`);
   - ao assumir, o ticket ganha responsável e vai para "Em atendimento".
4. **Ação pública no ticket de WhatsApp,** feita pela tela do ticket: um gatilho cria a mensagem pendente na conversa. O status de envio volta para a ação do ticket.
5. `at_whatsapp_ciclo()` roda pelo pg_cron, a cada 1 min:
   - roleta da fila e aviso fora do horário;
   - atendente sem resposta → volta à fila;
   - cliente sem resposta por N horas → encerra (ticket "Em atendimento");
   - identificação parada há 10 min → fila sem identificação.

**Edge Functions (só entrada e saída):**

- `imobdesk-whatsapp`:
  - `despachar`: envia as pendentes pela Zenvia ou pelo OpenWA, conforme o canal do número;
  - `ciclo`: cron, `at_whatsapp_ciclo` + despachar;
  - administração do OpenWA: testar, QR, grupos e membros.
- `imobdesk-openwa-webhook`, novo:
  - confere o HMAC (`X-OpenWA-Signature`);
  - mensagem privada → `at_whatsapp_receber`;
  - mensagem do grupo interno → `at_grupo_receber` (resposta citando um repasse).
- `imobdesk-zenvia-webhook`: passa a chamar `at_whatsapp_receber` e despachar.
- `imobdesk-ia`: ação nova `resumir`, a solução sugerida para o diálogo de encerramento.

**Front:**
- "Central de atendimento" vira **Conversas** e **Monitor de atendimento** dentro de Gestão de Chamados. O caminho antigo redireciona para o novo.
- Diálogo de encerramento "Foi resolvido?".
- Painel "Conversa ao vivo" no ticket.
- Tela **WhatsApp OpenWA** em Administração.
- Opção "Só domínio" na conta de e-mail.
- Bloco "Quem mais abre chamados" na Visão geral.

## 3. Fases (checklist binário) — implementado em 09/10/2026

Migrations (renomeadas para depois das de segurança do login, que vieram no merge de `6d3ca25`):
`20261009150000_forma_atendimento_canal`, `…150100_email_so_dominio`, `…150200_whatsapp_motor`, `…150300_openwa`,
`…150400_conversas_menu_metricas`.

### Fase 1: e-mail só domínio
- [x] Migration `…150100`: regra `dominio` + `dominios_permitidos` (padrão `{exemplo.com.br}`); `ch_email_processar` recusa remetente de fora com o motivo.
- [x] Central Email: opção "Só domínio" com a lista de domínios.

### Fase 2: motor do chat (Zenvia e OpenWA)
- [x] Migration `…150200`: canal/sessão/grupo do número, WhatsApp do atendente, regras do setor, `at_linhas`, `at_repasses`, ticket do atendimento, estado da identificação.
- [x] `at_whatsapp_receber`: identificação (confirmar 1/2, nome, e-mail @domínio), só corporativo, fila, ticket (novo ou continua), ações do ticket, repasse, "novo".
- [x] `at_conversa_acao`: assumir, devolver, transferir (só gestão), enviar, encerrar (resolvido valida como o botão Resolver do ticket).
- [x] Ação pública no ticket de WhatsApp → mensagem pendente; status do envio volta para a ação.
- [x] `at_whatsapp_ciclo` (roleta, inatividade, identificação parada) + pg_cron `imobdesk-whatsapp-1min`.
- [x] Edge `imobdesk-whatsapp` (despachar, ciclo, administração do OpenWA) + `_shared/atendimento/despacho.ts`.
- [x] Zenvia webhook processando a entrada e respondendo na hora.
- [x] Central: ações pela RPC + envio imediato.

### Fase 3: OpenWA
- [x] Migration `…150300`: URL/API key no Vault (super admin), segredo do webhook, `at_grupo_receber`, linhas corporativas, tela.
- [x] Edge `imobdesk-openwa-webhook` (HMAC, privado → receber, grupo → resposta citando) + `_shared/atendimento/openwa.ts`.
- [x] Tela Administração › WhatsApp OpenWA (conexão, sessões, QR, webhook, número → canal/sessão/grupo, regras do setor, WhatsApp dos atendentes × membros do grupo, linhas corporativas com importação).

### Fase 4: telas na Gestão de Chamados
- [x] Conversas e Monitor de atendimento como seções da Gestão de Chamados; `/gestao-atendimento/central` redireciona.
- [x] Diálogo "Foi resolvido?" com solução sugerida pela IA (`imobdesk-ia` › `resumir`), serviço e categoria.
- [x] Painel "Conversa ao vivo" na tela do ticket de WhatsApp.

### Fase 5: métrica
- [x] `ch_top_solicitantes(dias)` (migration `…150400`) + bloco "Quem mais abre chamados" na Visão geral.

### Fase 6: verificação
- [x] `tsc -b`, `npm run lint` (sem aviso nos arquivos novos), `npm test` (134 testes; 14 novos em `tests/atendimento-openwa.test.ts`) e `npm run build`.
- [x] `deno check` das Edge Functions novas e alteradas.
- [x] Migrations ensaiadas num Supabase local do zero (as 45 do repositório, incluindo as de segurança), com 2 roteiros em transação desfeita:
      identificação, só corporativo, fila, ticket, repasse, resposta pelo grupo (com e sem citação, autor estranho), permissões
      (outro atendente, transferir só gestão), encerrar sem/com resolver (regra do serviço), ticket que continua × novo, "novo",
      ação pelo ticket, ciclo, métrica, tela OpenWA, importação de linhas e e-mail só domínio.
- [x] Migrations aplicadas na produção (09/10/2026, Wagner, uma a uma com `npx supabase db query --linked -f …`; o `db push` não serve no Supabase compartilhado).
- [x] Edge Functions publicadas (09/10/2026, Wagner): whatsapp, openwa-webhook, zenvia-webhook, ia.
- [ ] OpenWA no ar, sessão pareada, webhook cadastrado e teste ponta a ponta com um celular — **Wagner**.

### Ajustes do 1º teste real (09/10/2026, tarde)
- [x] `20261009160000`: lista de Conversas falhava para usuário logado (subselect em `at_pessoas` sem SELECT) e o ticket vinha vazio (RLS de `at_atendimentos`): funções auxiliares `at_nome_pessoa` e `at_ticket_do_atendimento`.
- [x] `20261009170000`: respostas automáticas do OpenWA por setor (`wa_respostas_auto`, ligada por padrão; a Zenvia segue a chave dela); identificação procura também em **Pessoas**; pessoa com e-mail @domínio conta como colaborador; **RESOLVIDO** (portal, grupo interno ou celular do número) resolve o ticket; mensagem final sempre com o número do chamado; resposta digitada no próprio celular entra na conversa e no ticket (`at_whatsapp_propria`, evento `message.sent`).
- [x] Edge: `message.sent` no webhook (o "Cadastrar webhook" atualiza o existente) e conteúdo de evento ignorado não fica guardado.
- [x] Ensaio local (4 roteiros, inclusive como usuário logado), 135 testes, `deno check`.
- [ ] Aplicar `…160000` e `…170000` (`db query`), publicar `imobdesk-whatsapp` e `imobdesk-openwa-webhook`, clicar de novo em **Cadastrar webhook** — **Wagner**.

### Grupo interno pelo portal + descrição e print (09/10/2026, fim da tarde)
- [x] `20261009190000` (renomeada: a frente gerencial já usava `…180000`): pergunta "Descreva em poucas palavras… envie um print" depois de identificar, quando a 1ª mensagem não explica (`at_precisa_descricao`, chave `wa_pedir_descricao` por setor); print sozinho → "Recebi o print 👍 Agora escreva…"; a descrição vira o assunto; print anexado à 1ª ação e repassado ao grupo como imagem (`at_repasses.arquivo`); bucket privado `atendimento-whatsapp`.
- [x] Edge: webhook guarda a mídia no Storage (base64 do webhook ou download pela API do OpenWA, até 15 MB); despachante manda o print ao grupo (`send-image` com link assinado); ação `openwa_criar_grupo` (grupo com o WhatsApp dos atendentes, ligado ao número, mensagem de apresentação).
- [x] Front: botão **Criar grupo interno**, chave **Pedir a descrição e o print**, print no chat (miniatura) e anexos com link na linha do tempo do ticket (WhatsApp e e-mail).
- [x] Ensaio local do zero (5 roteiros), 138 testes, lint, `deno check`.
- [ ] Aplicar `…190000` (`db query`), publicar `imobdesk-whatsapp` e `imobdesk-openwa-webhook`, preencher o WhatsApp dos atendentes e clicar em **Criar grupo interno** — **Wagner**.

### Grupo interno sem citação (09/10/2026, noite)
- [x] `20261009200000`: resposta do atendente no grupo **sem citar** — "#1021 texto" vai para o ticket; sem número, vai para o único atendimento que está com ele ou, sem nenhum, assume o único pedido da fila; ambíguo → lista "#ticket · nome" no grupo e não envia. "RESOLVIDO" segue a mesma escolha. Confirmação "✔ Enviado a … (#ticket)" / "✅ #ticket resolvido por …".
- [x] Ensaio local (8 cenários do grupo + os 5 roteiros anteriores).
- [ ] Aplicar `…200000` (`db query`) — **Wagner**. Sem mudança de Edge nem de front.
- Risco aceito: com um único pedido na fila, conversa casual no grupo vai para o colaborador (a confirmação ✔ mostra).

### Chave geral do OpenWA (09/10/2026, noite)
- [x] `20261009210000`: `at_config.openwa_ligado`; `at_openwa_ligar` (supervisão/super admin; ao desligar cancela os envios pendentes do OpenWA); despachante não reserva nada do OpenWA desligado; webhook descarta sem gravar.
- [x] Tela: chave "WhatsApp OpenWA ligado/desligado" no card de conexão, com confirmação ao desligar.
- [ ] Aplicar `…210000` (`db query`) e publicar `imobdesk-openwa-webhook` — **Wagner**.
- [x] `20261009220000`: só **Administrador ou Super admin** ligam/desligam (antes: supervisão); `at_whatsapp_disponivel()` (OpenWA ligado com número, ou número Zenvia ativo). Sem WhatsApp em uso, o `AccessProvider` nega `gestao_atendimento_central` (Conversas) e `gestao_chamados_monitor` (Monitor): somem do menu, das seções e das rotas, sem mexer em Perfis e permissões. O Administrador abre a tela WhatsApp OpenWA mesmo sem a permissão de supervisão.
- [ ] Aplicar `…220000` (`db query`) — **Wagner**.

## 4. Como ativar (Wagner)

1. **Banco:** `npx supabase link --project-ref ikvjaowvpvxojvcfwnct` e, para cada migration nova, na ordem,
   `npx supabase db query --linked -f supabase/migrations/<arquivo>.sql`. **Não use `db push`** (o histórico do projeto compartilhado tem
   migrations de outros sistemas e ele pede `migration repair`, que não deve ser rodado).
2. **Edge Functions:**
   `npx supabase functions deploy imobdesk-whatsapp imobdesk-openwa-webhook imobdesk-zenvia-webhook imobdesk-ia --project-ref ikvjaowvpvxojvcfwnct --use-api`
3. **OpenWA na sua máquina:** `npm run dev` na pasta do OpenWA, com `RESOLVE_LID_TO_PHONE=true` no `.env` (sem isso, remetentes `@lid` chegam sem número e são ignorados).
4. **Túnel:** `cloudflared tunnel --url http://localhost:2785` → copie a URL `https://….trycloudflare.com`.
5. **Portal › Administração › WhatsApp OpenWA:**
   - salve a URL e a API key (`data\.api-key` do OpenWA) e clique em **Testar conexão**;
   - no número do setor: canal **OpenWA**, escolha a sessão e salve; **Parear (QR)** com o celular do chip do sistema; **Cadastrar webhook**;
   - crie no celular o grupo "Atendimento TI · interno" (chip do sistema + atendentes), escolha-o como **grupo interno** e salve;
   - informe o **WhatsApp pessoal** de cada atendente (a coluna "No grupo interno?" confere);
   - ligue **Identificar no 1º contato** e **Só linhas corporativas** no setor e importe a planilha das linhas.
6. **Respostas automáticas:** em Integrações › Zenvia WhatsApp, ligue as respostas automáticas. Para validar só com o seu celular, mantenha
   a **trava do piloto** com o seu número; depois, desligue a trava.
7. **Teste ponta a ponta:** do seu celular (linha cadastrada), mande "a impressora não imprime" para o chip do sistema → confirme 1 →
   veja o 🆕 no grupo interno → responda citando → a resposta chega no privado → encerre em Conversas com "Sim, resolvida".

## 5. Riscos
- O OpenWA não é a API oficial, então o número pode ser bloqueado. Volume baixo, só conversas de suporte.
- O túnel temporário muda de URL a cada vez que reinicia, e é preciso atualizar a tela. Na Hostinger, a URL fica fixa.
- Na Zenvia, depois de 24 h sem mensagem do cliente, a Meta só aceita modelo aprovado, e o envio falha com o motivo.
