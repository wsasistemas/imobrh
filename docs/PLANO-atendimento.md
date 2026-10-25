# Plano de ação — Gestão de Atendimento no Imobdesk

Origem: Gestão de Atendimento do `Vs_PipedriveMKT` (commits `e7a5b94` → `ec06117`, 05/10/2026).
Mockup para aprovação: [`docs/mockups/atendimento-portal.html`](mockups/atendimento-portal.html).

Fluxo: **aprovar o mockup → este plano vira o prompt → implementar fase a fase**. Cada fase termina
com checklist binário (feito / não feito), conferido antes de seguir. Migrations **só aditivas**,
ensaiadas em `begin … rollback` e aplicadas à mão com
`npx supabase db query --linked --project-ref ikvjaowvpvxojvcfwnct -f "<arquivo>"`.

---

## 1. Pedido (como entendi)

Trazer do Vs_PipedriveMKT o menu **Gestão de Atendimento** (Central de atendimento) e as
configurações do atendimento por WhatsApp para este projeto, com estas diferenças:

| Tema | No Vs_PipedriveMKT | Aqui |
|---|---|---|
| CRM | Escrita restrita no Pipedrive (pessoa, negócio, etapa, dono, perdido, nota) | **Sem Pipedrive.** O contato e a conversa vivem só no banco do portal |
| Entrada | Landing page com código de campanha + orgânico | **Só orgânico**: o cliente escreve direto no número |
| Canal | Zenvia (número novo) | **Zenvia**, outro número |
| Robô / IA | Motor do fluxo do PDF Cidade Arte + Gemini + inatividade | **Não entra agora** |
| Base de conhecimento | Empreendimentos, minibooks, campanhas, mensagens fixas | **Não entra agora** |
| Painel e Simulador do robô | Sim | **Não entram** (dependem do robô) |
| Chat (receber/enviar de verdade) | Sim | **Fase posterior**. Agora: estrutura, telas e configurações |

## 2. Decisões (Wagner, 06/10/2026)

- Canal: **Zenvia**.
- Escopo agora: **estrutura + configurações**. O chat real fica para depois.
- Base de conhecimento: **não trazer agora**.
- Sistema: **Portal_Atendimento**. O schema fica `imobdesk`, em minúsculas, porque o
  `novo-app` recusa maiúscula (`^[a-z][a-z0-9_]{1,40}$`). Com maiúscula, cada SQL, policy, RPC e
  header do PostgREST precisaria de aspas. O nome de exibição é "Imobdesk".

### Propostas que entraram no mockup (confirmar na aprovação)

- [ ] Sem robô, a única resposta automática são 3 mensagens editáveis: **boas-vindas**, **fora do horário** e **encerramento**.
- [ ] Toda conversa nova entra na **fila**, com rodízio entre os atendentes aptos e online.
- [ ] Atendente sem responder por **30 min**: a conversa volta para a fila.
- [ ] Cliente sem responder por **23 h**: a conversa é encerrada sozinha (janela de 24 h da Meta).
- [ ] O Kanban da Central é **por situação** (Na fila / Comigo / Com outros / Encerradas), no lugar de "por empreendimento".
- [ ] O painel lateral da Central é o **Contato** (nome, telefone, canal, cliente desde, nº de conversas, nota interna), no lugar dos dados do Pipedrive.
- [ ] O papel "SDR" vira **Atendente**: modo `sdr` → `atendente` no banco, e o rótulo também muda.

### Monitor do gestor (pedido de 06/10/2026, a partir do print de outra ferramenta de chat)

Terceira visão da Central (**Lista | Kanban | Monitor**), só para quem tem a permissão
`gestao_atendimento_supervisao`. Atualiza por Realtime, e os tempos contam ao vivo.

| Bloco do modelo | Como fica aqui |
|---|---|
| Principais indicadores do chat (com % sobre o período anterior) | 6 indicadores com filtro Hoje / Esta semana / Este mês: atendidas, resolvidas no 1º atendimento, não resolvidas no 1º, recebidas fora do horário, tempo médio de espera, tempo médio de atendimento. A cor da variação leva em conta se subir é bom ou ruim |
| Acompanhamento de agentes (duas bolinhas + número) | Atendente, **Online** (Central aberta, `at_ping` a cada 60 s), **Disponível** (Apto ligado e abaixo do limite; amarelo = pausa), em atendimento agora, atendidas hoje, tempo médio |
| Conversas aguardando atendimento | Posição, ticket, cliente, telefone, última mensagem, entrou na fila, **tempo de espera ao vivo** (vermelho acima de 15 min), origem e as ações **Visualizar \| Atender** |
| Conversas em atendimento | Ticket, cliente, telefone, atendente, início, duração, **cliente esperando há** (vermelho acima de 5 min), origem e as ações **Visualizar \| Transferir** |
| Visualizar | Gaveta lateral **só leitura** com o histórico. Na fila, há o botão Atender; nas demais, Transferir |
| Atender | O gestor assume e cai no chat da conversa (Lista) |

Cargo, Organização, Classificação e Serviço ficaram fora porque não existem no atendimento orgânico.

Confirmar na aprovação:
- [ ] "Resolvida no 1º atendimento" = encerrada sem transferência, sem voltar à fila e sem o cliente escrever de novo em 24 h.
- [ ] Alertas: espera na fila acima de **15 min** e cliente sem resposta do atendente acima de **5 min**.
- [ ] Limite de conversas simultâneas por atendente (define "Disponível"). Proposta: **5**, editável em Fila e horários.
- [ ] Status **Pausa** do atendente (botão na Central). Pausado continua online, mas não recebe da fila.
- [ ] **Ticket** = número sequencial por atendimento. Cada vez que a conversa reabre, ela ganha um ticket novo, e é por ele que os indicadores contam.

### Adendo: vários números, tudo separado por setor (Wagner, 06/10/2026)

Pedido: "a central de atendimento por WhatsApp deve permitir adicionar mais números vinculados ao canal,
para cada setor ter sua própria central de atendimento".

**Viável.** Cada evento da Zenvia traz o número de destino (`message.to`, lido em `lerEvento` como `para`),
e o envio já recebe o remetente (`from`). Um único webhook recebe todos os números e roteia pelo destino.

Decisões:
- **Uma conta Zenvia** (um token no Vault) e **vários números**. Cada número pertence a **um setor só**.
- **Tudo separado por setor:**
  - cada atendente pertence a **uma** equipe (setor);
  - cada setor tem a sua gestão (gestor ou gestores do setor);
  - a supervisão geral (super admin / permissão `gestao_atendimento_supervisao`) vê todos.
- Horário, mensagens automáticas e regras da fila (limite, 30 min, 23 h, alertas) são **por setor**. Um setor novo nasce com os padrões.
- **Sem transferência entre setores.** Transferir só vale dentro do setor. A resposta sai sempre pelo número em que o cliente escreveu.
- O mesmo cliente escrevendo em números de setores diferentes = **conversas separadas**, uma por setor.

Quem vê o quê (mockup com "Ver como"):

| Perfil | Central | Monitor | Fila e horários | Setores e números | Zenvia |
|---|---|---|---|---|---|
| Atendente | fila do seu setor + as próprias | — | — | — | — |
| Gestor do setor | tudo do seu setor; transfere dentro dele | do seu setor | do seu setor | — | — |
| Supervisão geral | todos, com filtro de setor | todos, agrupado por setor | escolhe o setor | sim | só super admin |

Modelo de dados (entra na F2):
- `at_setores`: `id`, `nome`, `ativo`, horário e mensagens. As regras ficam em colunas próprias, que substituem os campos globais de `at_config`.
- `at_numeros`: `numero` único (E.164), `setor_id`, `verificacao`.
- `at_setor_gestores`: `setor_id` + `usuario_id`.
- `at_atendentes.setor_id`: **not null**, um setor por atendente.
- `at_horarios`: chave `(setor_id, dia)`.
- `at_conversas`: `setor_id` + `numero_id` (por onde responder). A chave única passa a ser `(numero_id, telefone)`.
- `at_atendimentos.setor_id`, para os indicadores por setor.
- RLS: `at_pode_ver_setor(setor_id)`, que vale para supervisão geral, gestor do setor ou atendente do setor (o atendente vê só a fila e as próprias conversas).
- Permissões novas no `menuRegistry`:
  - seção `gestao_atendimento_setores` (Setores e números, supervisão geral);
  - a seção Fila e horários e o Monitor passam a valer também para o **gestor do setor**, decidido pelo banco, não só pelo perfil.

---

## 3. Mapa de cópia (origem → destino)

Origem = `C:\Projetos VSCODE\Vs_PipedriveMKT`. Prefixo `app_pipedrive` → `imobdesk`.

### Front

| Origem | Destino | Ação |
|---|---|---|
| `src/pages/GestaoAtendimento.tsx` | `src/pages/GestaoAtendimento.tsx` | **Adaptar**: só as seções `central` e `fila` |
| `src/config/menuRegistry.ts` (itens `gestao_atendimento*`, `atendimento_zenvia`, ações) | `src/config/menuRegistry.ts` | **Adaptar**: tirar base/painel/simulador/exportar; descrição sem Pipedrive; sai o "Módulo exemplo" |
| `src/App.tsx` (rota `gestao_atendimento`) | `src/App.tsx` | **Copiar** a linha do lazy + a rota |
| `src/features/atendimento/pages/Central.tsx` | idem | **Adaptar**: sai `useNegocioDetalhe`, `Negocios.css`, etapas, motivos, trocar empreendimento e corretor; Kanban por situação; painel Contato |
| `src/features/atendimento/pages/FilaHorarios.tsx` | idem | **Adaptar**: sai `pdUserId`; as mensagens fixas viram as 3 automáticas; entram as regras de 30 min / 23 h |
| `src/features/atendimento/pages/IntegracaoZenvia.tsx` | idem | **Adaptar**: sai o passo "Escrita no Pipedrive" e o bloco da IA; "Robô ligado" → "Atendimento ligado" |
| `src/features/atendimento/pages/Atendimento.css` | idem | **Copiar** e podar as classes da Base, do Painel e do Simulador |
| `src/features/atendimento/services/central.ts` | idem | **Adaptar**: sem `dealId/empreendimento/campanha/etapa`; ações `assumir/devolver/enviar/encerrar/transferir`; mock novo (dados do mockup) |
| `src/features/atendimento/services/fila.ts` | idem | **Adaptar**: sem `pd_user_id`; regras de tempo novas |
| `src/features/atendimento/services/zenvia.ts` | idem | **Copiar** (troca só o nome da Edge Function) |
| `src/features/atendimento/hooks/useCentral.ts`, `useFila.ts`, `useZenvia.ts` | idem | **Copiar** |
| `src/features/configuracoes/pages/Integracoes.tsx` (aba Zenvia) | idem | **Copiar** a aba e a rota `zenvia` |
| `src/features/configuracoes/services/types.ts` / `labels.ts` (`AuditModule` "atendimento") | idem | **Copiar** |
| `src/config/app.ts` → `edgeFunction()` | idem | **Adaptar**: aceitar `"zenvia"`, `"zenvia-webhook"` e `"atendimento"` |
| `pages/BaseConhecimento.tsx`, `PainelRobo.tsx`, `Simulador.tsx`, `hooks/useBase.ts`, `services/base.ts`, `services/painel.ts` | — | **Não trazer** |

### Banco (`supabase/migrations`)

| Origem | Destino | Ação |
|---|---|---|
| `…160000_atendimento_base.sql` | `<ts>_imobdesk_atendimento_base.sql` | **Adaptar**: só `pode_ler_atendimento()`, `at_config` e `at_mensagens_fixas` (3 chaves). Saem `at_empreendimentos`, `at_campanhas` e o bucket de minibooks |
| `…200000_atendimento_conversas.sql` | `<ts>_imobdesk_atendimento_conversas.sql` | **Adaptar**: `at_conversas` sem `empreendimento_id/campanha_id/origem/midia/campanha/deal_id/person_id/estado/inat_*`; `modo in ('fila','atendente','encerrada')` + `'robo'` reservado; `at_mensagens` com `autor in ('cliente','atendente','auto','sistema')`; `at_eventos_zenvia`; Realtime; token no Vault; `at_config_salvar` |
| `…230000_atendimento_fila.sql` + `…233000_candidatos.sql` | `<ts>_imobdesk_atendimento_fila.sql` | **Adaptar**: `at_atendentes` sem `pd_user_id`; `at_horarios`; `at_ping`; `at_marcar_lida`; `at_candidatos_atendente`; prazos `atendente_sem_resposta_min` e `encerrar_apos_horas` |
| `…180000_escrita.sql`, `…220000_inatividade.sql`, `…000000_ia.sql`, `…010000_painel.sql`, `…020000_organico.sql` | — | **Não trazer** (Pipedrive, robô, IA, painel). Na fase do chat entra um cron próprio, mais simples |

### Edge Functions (`supabase/functions`)

| Origem | Destino | Ação | Fase |
|---|---|---|---|
| `_shared/atendimento/zenvia.ts` | idem | **Copiar**; o tipo `Opcao` (vinha de `fluxo.ts`) passa a ser declarado no próprio arquivo | F3 |
| `app_pipedrive-atendimento` (ações `testar`, `assinar`, `enviar_teste`) | `imobdesk-zenvia` | **Adaptar**: só as 3 ações de configuração | F3 |
| `app_pipedrive-zenvia-webhook` | `imobdesk-zenvia-webhook` | **Adaptar**: grava a conversa, a mensagem e o evento e põe na fila. Sem `executor`/`fluxo` | Chat |
| `app_pipedrive-atendimento` (ações da SDR) | `imobdesk-atendimento` | **Adaptar**: assumir, devolver, enviar, encerrar, transferir | Chat |
| `_shared/atendimento/sdr.ts` | `_shared/atendimento/fila.ts` | **Adaptar**: roleta e fora do horário. Sai tudo que mexe no Pipedrive | Chat |
| `_shared/atendimento/portas-supabase.ts` | idem | **Adaptar**: só as portas de fila, conversa e mensagem | Chat |
| `fluxo.ts`, `executor.ts`, `ia.ts`, `escrita.ts`, `catalogo.ts` | — | **Não trazer** (robô e Pipedrive) | — |

### Testes

`collector/test/atendimento-zenvia.test.ts` → `tests/atendimento-zenvia.test.ts` (F3) e
`atendimento-sdr.test.ts` → `tests/atendimento-fila.test.ts` (Chat). Entra `vitest` como devDependency.

---

## 4. Fases

### F0 — Fundação do projeto ✅ (06/10/2026)

Feito:
- 17 migrations do `novo-app` ensaiadas e aplicadas;
- `segue_contrato = true`, dono Super admin, `anon` sem USAGE;
- tipos gerados e `supabase.ts` apontando para `imobdesk`;
- `.env.local` só com a chave publishable;
- Edge Functions `usuarios`, `totvs` e `integracao-teste` publicadas;
- build e lint ok.

Pendente com o Wagner: entrar no portal com o login real.

- `npm run novo-app -- imobdesk "Imobdesk" --dono wagner.antunes@exemplo.com.br`.
- Aplicar as migrations geradas (ensaio com rollback antes).
- `.env.local` só com a chave **publishable** e `VITE_APP_SCHEMA=imobdesk`.
- Gerar `database.types.ts` com `--schema imobdesk,public`.
- Conferir o `.gitignore` (`.env*`, `supabase/.temp/`, `.claude/settings.local.json`) antes do 1º commit.

Checklist:
- [x] migrations da base ensaiadas (rollback) e aplicadas
- [x] `segue_contrato = true` e o dono como Super admin (conferido no banco, não na tela)
- [ ] login real funcionando; selo "Modo simulado" **ausente** (teste do Wagner)
- [x] typecheck, lint e build ok

### F1 — Menu, permissões e telas ✅ (06/10/2026)

Feito:
- `menuRegistry`: `gestao_atendimento` com 3 seções:
  - `_central`;
  - `_fila`;
  - `_setores`.
- Duas ações com `parent: gestao_atendimento_central`:
  - `gestao_atendimento_monitor`, que vale só nos setores em que a pessoa é gestora;
  - `gestao_atendimento_supervisao`, para todos os setores.
- `atendimento_zenvia` em Integrações (super admin). O "Módulo exemplo" saiu.
- Telas em `src/features/atendimento/pages`:
  - Central: lista, Kanban por situação, Monitor, chat e painel Contato;
  - Monitor: indicadores, atendentes, aguardando, em atendimento, gaveta Visualizar e Atender;
  - FilaHorarios, por setor;
  - Setores;
  - IntegracaoZenvia.
- Serviços com Supabase e mock:
  - `services/atendimento.ts` e `services/mock.ts`;
  - no mock entram a equipe e os setores do mockup;
  - o "Ver como" do modo simulado troca entre supervisão (admin), gestor (TI) e atendente (operador).

Checklist:
- [x] menu agrupador e as 3 seções aparecem conforme a permissão (gestor não vê Setores e números)
- [x] Monitor só aparece para gestor/supervisão; Visualizar abre só leitura; Atender assume e abre o chat ("Comigo")
- [x] Integrações › Zenvia só para o super admin
- [x] telas conferidas com Playwright (Edge) nos 3 perfis, em desktop e 390 px, sem erro de console e sem rolagem lateral
- [x] nenhuma referência a Pipedrive, empreendimento, campanha ou minibook na feature
- [x] typecheck, lint e build ok

### F2 — Banco do atendimento ✅ (06/10/2026)

Feito (migrations `20261006170000` a `…170200`, só aditivas):
- `…_setores`: `at_config`, `at_setores` (regras e mensagens por setor), `at_numeros` (número único, um setor), `at_setor_gestores`, `at_atendentes` (um setor por atendente, `apto`, `pausa`, `online_em`) e `at_horarios` (por setor, padrão seg–sex 8–18);
- funções `at_supervisor`, `at_gestor_de(setor)` e `at_membro_de(setor)`;
- RPCs:
  - `at_contexto` (tudo o que o usuário vê, com o papel por setor);
  - `at_candidatos`;
  - `at_setor_salvar`;
  - `at_setor_config_salvar`;
  - `at_atendente_salvar` e `at_atendente_remover`;
  - `at_ping` e `at_minha_pausa`;
  - `at_config_salvar`.
- `…_conversas`: `at_conversas` (única por número + telefone), `at_atendimentos` (ticket a partir de 10000), `at_mensagens`, `at_eventos_zenvia`, `at_ve_conversa`, `at_conversas_lista`, `at_marcar_lida` e `at_conversa_editar`. Realtime em conversas, mensagens e atendentes.
- `…_monitor`:
  - `at_monitor_indicadores(periodo, setor)`: atual × mesmo trecho do período anterior, fuso de Brasília;
  - `at_monitor_atendentes`;
  - `at_monitor_conversas`.
- Front: `DUPLICATE` em `SERVICE_ERROR_CODES` e módulo `atendimento` na Auditoria.

Checklist:
- [x] migrations ensaiadas (rollback, com erro proposital no fim) e aplicadas; sem resíduo
- [x] RLS testada com 4 usuários simulados: supervisão (vê 3 de 3), gestor do setor A (2 de 2 do setor A), atendente do setor A (só a fila e as próprias: 1), com a Central e sem setor (0)
- [x] gestor não altera outro setor; número duplicado e limite fora da faixa são recusados; gravação direta na tabela é negada
- [x] `at_monitor_indicadores` bate com o cálculo à mão (2 atendidas, 1 resolvida, espera de 9 min, atendimento de 26 min)
- [x] atendente recebe erro nas RPCs do Monitor; `anon` sem acesso ao schema (401 42501)
- [ ] salvar pela tela no banco real e ver na Auditoria (falta o Wagner entrar com o login real)

### F3 — Integração Zenvia (configuração) ✅ no que não depende da Zenvia (06/10/2026)

Feito:
- Migration `…170300_zenvia`:
  - token no Vault (`at_zenvia_salvar_token`, só super admin);
  - chave do webhook gerada no Vault;
  - `at_ler_credencial_zenvia` só para o service role.
- `_shared/atendimento/zenvia.ts`, copiado da origem sem a dependência do robô.
- Edge Function `imobdesk-zenvia`:
  - `testar`: confere o token, se **cada número dos setores** está na conta e as assinaturas;
  - `assinar`: um webhook para todos os números;
  - `enviar_teste`: pelo número escolhido.
- Edge Function `imobdesk-zenvia-webhook` (sem JWT, com a chave no cabeçalho):
  - grava o evento cru, idempotente;
  - guarda o número de destino;
  - atualiza o status das mensagens.
- `tests/atendimento-zenvia.test.ts` (9 testes, `npm test`).

Checklist:
- [x] Edge Functions publicadas; sem login → 401; webhook sem chave ou com chave errada → 401
- [x] webhook com chave certa: evento sintético gravado uma vez (o reenvio foi reconhecido como duplicado), com o número de destino; dados de teste removidos
- [x] 9 de 9 testes Vitest passando
- [ ] token salvo no Vault pela tela (depende da Zenvia: token da conta)
- [ ] "Testar conexão e números" ok com a conta certa (depende do token e dos números)
- [ ] teste de envio confirmado como "entregue" pelo status (depende da Zenvia)

## 5. Depois (fora deste plano, a definir com o Wagner)

**Fase Chat:**
- webhook de entrada idempotente (pelo id da Zenvia);
- fila com roleta e aviso fora do horário;
- assumir, devolver, transferir e encerrar;
- envio de texto e arquivo com a janela de 24 h;
- Realtime e presença;
- pg_cron para as regras de 30 min / 23 h;
- cada movimento (entrar na fila, assumir, transferir, devolver, encerrar, reabrir) grava o ticket em `at_atendimentos`, e é isso que liga o Monitor aos dados reais. Até lá, o Monitor mostra zeros.

Reaproveita o webhook, `sdr.ts`, `portas-supabase.ts` e a Central real do Vs_PipedriveMKT.

**Opcional:**
- robô e IA (`fluxo.ts`, `executor.ts`, `ia.ts`);
- Base de conhecimento;
- Painel;
- Simulador.

O banco já nasce com o modo `robo` reservado e com `at_mensagens_fixas`.

## 6. Armadilhas conhecidas (Cerebro)

- Sem `.env.local`, o app sobe em **modo simulado** e "salva" sem erro. Confira sempre a linha no banco.
- A Zenvia aceita envio de outra conta e descarta depois. Por isso, `conferirContaZenvia` vem antes de enviar.
- Depois de 24 h sem mensagem do cliente, a Meta só aceita modelo aprovado.
- `useEffect` com `scrollIntoView` não pode devolver promise: o React quebra com "destroy is not a function".
- Os tipos gerados marcam `p_id` de RPC como obrigatório. Para mandar `null`, use a camada de serviço com `as never`.
