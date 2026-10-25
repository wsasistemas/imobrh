# Plano de ação — Contas de e-mail (Gestão de Atendimento)

Pedido (06/10/2026): criar, no menu Gestão de Atendimento, a seção **Contas de e-mail** com a estrutura das
Configurações › Contas de e-mail da Movidesk. O sistema vai cadastrar várias contas ligadas aos
provedores, para **receber os chamados** e **enviar as respostas**. Depois disso, o Wagner monta o processo
de atendimento por ticket.

Mockup para aprovação: [`docs/mockups/contas-email.html`](mockups/contas-email.html).
Fluxo: aprovar o mockup → este plano vira o prompt → fases com checklist binário. Migrations só aditivas,
ensaiadas em `begin … rollback`.

---

## 1. O que foi copiado da Movidesk (e o que mudou)

| Movidesk | Imobdesk |
|---|---|
| Lista: Nome, Endereço, Status de conexão, E-mails na fila, Habilitado; busca com 3 letras; Opções | Igual, mais **Setor**, **Provedor** e **Última leitura**; filtro por status; Opções = testar todas, habilitar/desabilitar em lote, exportar |
| Formulário com abas Principal / Configurações de recebimento / Configurações de envio | Igual |
| "Marca" | **Setor**: a conta entra na fila, na equipe e no horário de um setor, seguindo a regra "tudo separado por setor" |
| Exibir no envio de e-mails do ticket | Igual |
| Exibir no mural de avisos | Trocado por **Conta padrão de envio do setor** (o portal não tem mural) |
| Logomarca da conta | Igual |
| Provedor (Gmail, Yahoo, Outlook, Uol, Aol, Bol, Exchange, Ig, IBest, Terra, manual) | Igual (sem Aol). O provedor preenche servidor e porta |
| Excluir · Cancelar · Testar configurações · Salvar e criar um novo · Salvar | Igual. O teste mostra passo a passo: conexão, leitura da pasta, envio de teste |

## 2. Análise técnica (o que decide o desenho)

**O e-mail da empresa está no Google Workspace.** O registro MX de `exemplo.com.br` aponta para
`aspmx.l.google.com` e o SPF inclui `_spf.google.com`. As contas da lista da Movidesk (cftv@, cobranca@, dp@…) também estão lá.

Para ler e enviar, há três caminhos:

| Caminho | Como funciona | Prós | Contras |
|---|---|---|---|
| **A. Conexão Google por API** (recomendado) | A TI cria uma conta de serviço no Google Cloud e autoriza (delegação no domínio) os escopos de leitura e envio do Gmail no Admin do Workspace. O portal lê e envia de qualquer caixa @exemplo.com.br pela API do Gmail (HTTPS). | Sem senha por conta; funciona em Edge Function (só HTTPS); a resposta fica em "Enviados" e na mesma conversa do Gmail; o Google não bloqueia | A TI do Workspace precisa fazer a autorização uma vez; a chave da conta de serviço fica no Vault |
| **B. IMAP/SMTP com senha de app** (como a Movidesk) | Cada conta tem verificação em 2 etapas e uma senha de app; o portal conecta em `imap.gmail.com:993` e `smtp.gmail.com:465` | Igual à Movidesk; serve para qualquer provedor ("Definir manualmente") | Uma senha por conta; o administrador do Workspace pode bloquear senha de app; IMAP exige uma conexão TCP longa dentro da Edge Function (precisa de prova técnica) |
| C. Encaminhamento para um serviço de entrada (SendGrid Inbound, que já está no SPF) | O Gmail encaminha cópias para um endereço do serviço, que chama um webhook | Recebe em tempo real | Depende de regra de encaminhamento em cada caixa; a resposta sai por outro remetente; mais uma conta paga |

**Recomendação:** A para as contas @exemplo.com.br e B como alternativa ("Definir manualmente") para provedores fora do Google.
O mockup mostra os dois: no provedor Google, a aba de recebimento oferece "Conexão Google (recomendado)" ou "IMAP/SMTP com senha de app".

**Limites do Supabase (Edge Functions):**
- as portas de saída 25 e 587 são bloqueadas, então o SMTP só funciona na **465 (SSL)**;
- não há processo rodando o tempo todo, então a leitura é por **polling** (pg_cron a cada 1 min chama a Edge Function, que lê o que chegou desde a última vez), e não por IMAP IDLE.

## 3. Modelo de dados (F2)

- `at_email_contas`:
  - `id`, `nome`, `email` (único), `setor_id` → `at_setores`, `nome_remetente`;
  - `exibir_no_envio`, `padrao_do_setor`, `logo_path`, `habilitada`;
  - `provedor` (google | outlook | exchange | yahoo | uol | bol | terra | ig | ibest | manual) e `modo` (api_google | imap_smtp);
  - `imap_host`, `imap_porta`, `imap_seguranca`, `smtp_host`, `smtp_porta`, `usuario`;
  - `senha_segredo_id` (Vault) e `senha_mascara`;
  - `pasta`, `intervalo_min`, `ler_desde`, `marcar_lido`, `mover_para`, `juntar_respostas`, `ignorar_remetentes text[]`;
  - `responder_para`, `copia_oculta`, `assinatura`;
  - `status` (conectado | falha | aguardando_autorizacao | inativo), `ultimo_erro`, `ultima_leitura_em`, `cursor` (`historyId` do Gmail ou UID do IMAP), `verificacao jsonb`.
- `at_email_recebidos`: e-mail cru importado, idempotente por `(conta_id, message_id)`. Guarda de, para, cc, assunto, texto, html e anexos (no Storage), com o estado `pendente | virou_chamado | ignorado`. É a "fila" da coluna "E-mails na fila" e a entrada do processo de ticket.
- `at_email_saida`: fila de envio (`pendente | enviado | falhou`, tentativas, erro).
- Credencial da conta de serviço Google no Vault: `imobdesk_google_sa`, lida só pelo service role.
- RLS:
  - supervisão geral cadastra e vê tudo;
  - gestor do setor vê as contas do seu setor (sem a senha);
  - escrita só por RPC (`at_email_conta_salvar`, `at_email_conta_senha`, `at_email_conta_habilitar`), com auditoria (módulo `atendimento`).

## 4. Fases

> **Decisões fechadas (06/10/2026, mockup aprovado):**
> - (1) Google pela API com conta de serviço, e IMAP/SMTP com senha como alternativa;
> - (2) toda conta tem setor;
> - (3) só a supervisão geral cadastra (o gestor vê as do seu setor, só leitura);
> - (4) sem POP3.

### F1 — Menu e telas ✅ (06/10/2026)
- Seção `gestao_atendimento_emails` ("Contas de e-mail", rota `/gestao-atendimento/emails`) no `menuRegistry`.
- Lista e formulário de 3 abas como no mockup, com mock. Os presets dos provedores preenchem servidor e porta.

Feito:
- seção `gestao_atendimento_emails` em `ContasEmail.tsx`;
- aba **Configurações › Integrações › Google Workspace** (`atendimento_google`, super admin) em `IntegracaoGoogle.tsx`, com o upload da chave JSON, o Client ID e o passo a passo para a TI;
- serviço `services/email.ts` com Supabase e mock.

Checklist:
- [x] seção aparece conforme a permissão; gestor vê só as contas do seu setor, em só leitura e sem "Nova conta"
- [x] lista: busca (3 letras), filtro de status, Opções (testar todas, habilitar/desabilitar marcadas, exportar CSV), linha inativa em cinza, rodapé com totais
- [x] formulário: 3 abas, provedor troca servidor e porta (aviso no Microsoft 365), Testar mostra os passos, Salvar e criar um novo, Excluir com confirmação
- [x] Playwright (Edge) em desktop e 390 px sem erro de console e sem rolagem lateral; typecheck, lint e build ok

### F2 — Banco ✅ (06/10/2026)
- Migration `…_atendimento_email.sql` com as 3 tabelas, as RPCs, a senha no Vault, a RLS por setor e a auditoria.

Migration `20261006180000_imobdesk_atendimento_email.sql`, aplicada.

Checklist:
- [x] ensaio com rollback e aplicação:
  - supervisão vê 2 contas;
  - gestor do setor A vê 1;
  - atendente vê 0;
  - leitura direta da tabela é negada.
- [x] senha só no Vault: a lista traz a máscara `••••xy`, não o valor; ao excluir a conta, o segredo some
- [x] recusados: e-mail duplicado (`DUPLICATE`), porta 587, modo API fora do Google, JSON que não é de conta de serviço, gestor salvando conta, exclusão de conta com histórico
- [ ] gravação pela tela no banco real (falta o login real do Wagner)

### F3 — Prova técnica e "Testar configurações" ✅ no que não depende de credencial (06/10/2026)
- **Spike** antes de escolher a biblioteca:
  - (A) API do Gmail com conta de serviço: token JWT assinado em Deno, `users.messages.list` e `send`;
  - (B) IMAP em Deno dentro da Edge Function (`imap.gmail.com:993`) e SMTP pela 465.
- Edge Function `imobdesk-email`, ação `testar`: conecta, lê a pasta (quantidade de não lidos) e envia um e-mail de teste. Grava `status` e `verificacao`.

Feito:
- Clientes próprios, sem npm, em `_shared/email/`:
  - `gmail.ts`: JWT RS256 com WebCrypto e a API do Gmail;
  - `imap.ts` e `smtp.ts`: comando e resposta sobre TLS;
  - `mime.ts`.
- Edge Function `imobdesk-email` com as ações `testar`, `google_testar` e `rede`, publicada.
- 8 testes Vitest com servidores IMAP e SMTP falsos e o JWT conferido pela chave pública.

Checklist:
- [x] **prova de rede no Supabase:** `imap.gmail.com:993` respondeu "Gimap ready" (419 ms) e `smtp.gmail.com:465` respondeu "220 ESMTP" (1,3 s). A função de diagnóstico temporária foi apagada.
- [x] Testar mostra cada passo com ok/erro e a mensagem do provedor (conferido no modo simulado e nos testes)
- [x] Edge publicada; sem login → 401
- [ ] spike A com a chave real da conta de serviço (depende da TI: Gmail API + delegação no domínio)
- [ ] spike B com uma senha de app real

### F4 — Recebimento
- pg_cron (1 min) → Edge `imobdesk-email`, ação `ler`: para cada conta habilitada, lê os e-mails novos pelo cursor e grava em `at_email_recebidos`. Respeita os remetentes ignorados e marca como lido ou move, conforme a conta.

Checklist:
- [ ] e-mail real enviado para a conta aparece em até 1 min, uma vez só (reenvio não duplica)
- [ ] remetente ignorado não entra; anexo salvo no Storage
- [ ] falha de login vira "Falha na conexão" na lista, com o erro

### F5 — Envio
- Ação `enviar` + fila `at_email_saida`, com 3 tentativas. O assunto leva `[#ticket]`, e os cabeçalhos `In-Reply-To` e `References` mantêm a resposta na mesma conversa do cliente.

Checklist:
- [ ] resposta chega ao cliente na mesma conversa, com a assinatura e o remetente da conta
- [ ] falha de envio fica visível e é tentada de novo

### Depois — processo de atendimento por ticket (Wagner)
`at_email_recebidos` → ticket no setor da conta (aproveita `at_atendimentos` e a fila do setor), juntando as
respostas pelo `[#ticket]` e pelo `In-Reply-To`.

## 4b. Ajuste de 06/10/2026: escopos iguais aos da empresa

O Wagner mostrou a tela **Admin › Segurança › Controles de API › Delegação em todo o domínio › Clientes da API**. A empresa já tem ali um cliente com `https://mail.google.com/` (+ `email.migration` e mais 2).

O Google só emite o token se os escopos pedidos forem **exatamente** os cadastrados para o Client ID. Por isso:
- os escopos ficam configuráveis (`at_config.google_escopos`), com padrão `https://mail.google.com/` e a opção mínima `gmail.modify` + `gmail.send`;
- o Client ID da chave fica guardado (`google_sa_client_id`);
- a aba Google Workspace mostra o passo a passo nos termos dessa tela ("Adicionar novo" › ID do cliente + Escopos OAuth) com os valores para copiar;
- migration `20261006200000_imobdesk_google_escopos.sql` aplicada; Edge `imobdesk-email` republicada.

O cliente que já existe na lista só serve se for uma conta de serviço do projeto da empresa e se a TI tiver o JSON dela. Caso contrário, cria-se um cliente novo para o portal.

## 4c. "Autorizar com Gmail" por conta (OAuth2, como a Movidesk), 06/10/2026

Pedido do Wagner: conectar as contas do Google como a Movidesk, com o botão "Reautorizar com Gmail".

- **Modo novo da conta: `oauth_google` (padrão para o Google).** Quem tem a senha da caixa entra no Google e autoriza; o refresh token da caixa fica no Vault. Os modos delegação (`api_google`) e IMAP/SMTP continuam como alternativa.
- **Fluxo:**
  1. botão na aba de recebimento;
  2. ação `oauth_iniciar` (Edge `imobdesk-email`) cria um `state` de uso único (10 min) e devolve a URL do Google (`access_type=offline`, `prompt=consent`, `login_hint` = caixa);
  3. o Google volta em `imobdesk-google-oauth` (sem JWT), que troca o código, confere se a conta autorizada é a da caixa, grava o token, testa a caixa e redireciona para a rota `/oauth/google` do portal;
  4. a janela avisa a tela (`postMessage`) e se fecha.
- **Integrações › Google Workspace:**
  - aplicativo OAuth (ID do cliente + chave secreta no Vault) com o passo a passo para a TI: Gmail API, tela de consentimento **Interna** e ID do cliente "Aplicativo da Web" com a URI de redirecionamento para copiar;
  - a delegação no domínio ficou recolhida como alternativa.
- **Campos da tela da Movidesk:**
  - habilitar recebimento;
  - caixa para recebimento;
  - importar a partir de;
  - apagar processadas depois de N dias;
  - marcar como lido;
  - importar como Ticket;
  - regra de abertura de novos tickets (qualquer remetente, só cliente em Pessoas, cliente ou domínio, não habilitar);
  - inclusão de ações em tickets existentes.
- Migration `20261006210000_imobdesk_email_oauth.sql`, aplicada depois do ensaio.

Checklist:
- [x] mockup `docs/mockups/email-oauth-google.html` aprovado pelo Wagner (06/10/2026); status da lista alinhados ("Aguardando autorização", "Reautorizar")
- [x] **Correção do Wagner (06/10/2026):** a referência é a tela da Movidesk, não o mockup. A aba de recebimento ficou igual à Movidesk:
  - Habilitar recebimento;
  - botão azul "Autorizar/Reautorizar com Gmail" e a nota OAuth2;
  - Caixa para recebimento de e-mails;
  - Mecanismo de autenticação (Auto) e Importar a partir de;
  - Apagar depois de N dias;
  - Marcar como lido, com a nota;
  - Importar e-mails como Ticket;
  - as 4 opções de abertura, com a nota;
  - rodapé com Excluir, Cancelar, Testar, Salvar e criar um novo e Salvar.
- [x] Para o Google, a conta usa sempre `oauth_google`. A mesma autorização libera recebimento e envio (escopo `https://mail.google.com/`), e a aba de envio mostra isso.
- [x] Saíram da tela (continuam no banco com o valor padrão):
  - escolha de modo;
  - Ler a cada;
  - Mover para pasta;
  - ignorar remetentes;
  - inclusão de ações;
  - campo "enviar teste para" (o teste vai para o e-mail de quem está logado);
  - delegação em Integrações.
- A seção 2 (recebimento) de `email-oauth-google.html` foi **substituída** pela tela da Movidesk.
- [x] ensaio:
  - `state` de uso único;
  - retorno fora de https recusado;
  - token só no Vault e apagado ao trocar o endereço;
  - modo OAuth recusado fora do Google;
  - regra e dias fora da faixa recusados.
- [x] Edge publicada:
  - retorno sem `state` → 400;
  - `state` desconhecido → 400;
  - `state` válido com "acesso negado" → 302 para `/oauth/google` com a mensagem;
  - reuso → 400 (dados de teste apagados).
- [x] 23 testes Vitest (URL de autorização, troca de código, id_token, token revogado)
- [x] Playwright no modo simulado: botão, janela, retorno, aviso único, status "Autorizado como…", Testar ok; 390 px sem rolagem lateral
- [ ] TI criar o ID do cliente OAuth e o portal receber; autorizar uma caixa real (ex.: cftv@) e testar

## 4d. Central Email sem a integração Google Workspace (06/10/2026)

Pedido do Wagner: tirar a integração Google Workspace do projeto, para não deixar sujeira, e renomear a seção para **Central Email**.

- **Saiu da tela e do código:**
  - a aba Configurações › Integrações › Google Workspace;
  - o item `atendimento_google` do menuRegistry;
  - a delegação no domínio (conta de serviço, escopos, `google_testar`);
  - os serviços e hooks do Google Workspace.
- **No banco não se mexeu** (migração só aditiva): ficam colunas e funções sem uso (`at_google_sa_*`, `at_google_escopos_salvar`, `at_google_oauth_salvar/ler`). Uma limpeza delas precisa da sua autorização explícita.
- **Aplicativo do Google (ID do cliente + chave secreta):** cadastrado **dentro do sistema** pelo super admin, uma vez só, em Central Email › Opções › **Aplicativo do Google (chaves)**. Enquanto não houver, aparece o aviso "Configurar" no topo da lista.
  - A chave secreta fica oculta (campo de senha) e é guardada no cofre do banco (Vault); o ID fica em `at_config`.
  - Só as Edge Functions leem a chave (`at_google_oauth_ler`). Os secrets `GOOGLE_OAUTH_CLIENT_*` valem só como reserva; não é preciso rodar nenhum comando.
- **Conta sem setor** (migração `20261006220000`, aditiva):
  - a conta de e-mail existe só com a autorização do Google;
  - o setor é opcional ("Sem setor (vincular depois)");
  - o vínculo com equipe vem depois;
  - quem cadastra continua sendo quem tem a permissão de supervisão da Gestão de Atendimento (o super admin tem).
- **Passo a passo da TI, uma vez, no Google Cloud Console** (projeto da empresa):
  1. APIs e serviços › ative a **Gmail API**.
  2. Tela de consentimento OAuth › Tipo de usuário **Interno**. Nome: "Imobdesk".
  3. Credenciais › Criar credenciais › **ID do cliente OAuth** › **Aplicativo da Web**. Em URIs de redirecionamento autorizados, cole `https://ikvjaowvpvxojvcfwnct.supabase.co/functions/v1/imobdesk-google-oauth`.
  4. Cole o ID do cliente e a chave secreta em Central Email › Opções › Aplicativo do Google (chaves).
- **Cada conta é autorizada individualmente:**
  1. cadastre a conta (que já existe no Google);
  2. em Configurações de recebimento, clique em **Autorizar com Gmail**;
  3. entre no Google com a própria caixa e clique em Permitir.

  Enquanto não for autorizada, a lista mostra "Aguardando autorização". A autorização (refresh token da caixa, no Vault) vale para receber e para enviar.
- **Sincronização:** a leitura automática (F4, pg_cron) e o envio das respostas (F5) **ainda não existem**. Hoje a autorização só valida a caixa: lê a pasta e manda o e-mail de teste. A F4 vai ler somente contas habilitadas, com recebimento habilitado e autorizadas.

Checklist:
- [x] Integração Google Workspace removida (tela, menu, serviços, delegação na Edge)
- [x] Aplicativo do Google cadastrado na própria Central Email (chave oculta, no Vault); Edge Functions leem do banco e foram publicadas
- [x] Conta de e-mail sem setor: migração 20261006220000 ensaiada e aplicada; "Nova conta" não depende mais de setor
- [x] Seção renomeada para "Central Email" (menu, título, mockup)
- [ ] TI criar o ID do cliente OAuth e o super admin colar em Central Email › Opções › Aplicativo do Google
- [ ] Autorizar a primeira caixa real e testar
- [ ] F4 leitura automática e F5 envio

## 5. Decisões para o Wagner (na aprovação do mockup)

1. **Como acessar as caixas Google:** (A) conexão por API com conta de serviço, recomendado, que exige a TI do Workspace autorizar uma vez; ou (B) senha de app por conta, como na Movidesk.
2. **Toda conta pertence a um setor?** Recomendado: sim, porque o chamado entra na fila desse setor.
3. **Quem cadastra contas:** só a supervisão geral (recomendado), ou também o gestor no seu setor?
4. **POP3** fica fora (a Movidesk também usa IMAP). Ok?
