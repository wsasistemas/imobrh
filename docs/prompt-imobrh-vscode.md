# ImobRH — prompts para construir no VS Code (Claude Code)

## Antes de colar o primeiro prompt

1. Crie a pasta do projeto `imobrh` e abra no VS Code.
2. Exporte os dois PRDs como Markdown e salve em `imobrh/docs/`:
   - `docs/PRD-imobRH-v2.md` (arquitetura, API, dados, fases)
   - `docs/PRD-imobRH-v1.md` (regras de cada serviço e tabelas de etapas dos processos)
3. Tenha o repositório do **imobdisparos** clonado na mesma máquina e anote o caminho (ex.: `C:\dev\imobdisparos`).
4. Troque os valores entre `<< >>` no Prompt 1 antes de colar.

Rode uma fase por vez. Só cole o prompt da fase seguinte depois de conferir os critérios de aceite da anterior.

---

## Prompt 1 — Fundação (Fase 0)

```text
Você vai construir o ImobRH, um sistema de RH separado do imobdesk. Leia primeiro, por inteiro:
- docs/PRD-imobRH-v2.md (fonte principal: arquitetura, API, modelo de dados, fases)
- docs/PRD-imobRH-v1.md (regras de cada serviço e etapas dos processos)

CONTEXTO
- O ImobRH tem backend próprio (Supabase: schema app_imobrh + Edge Functions) e um front web próprio, o Console do RH, usado pelos analistas.
- Colaboradores e gestores NÃO usam o front do ImobRH: eles usam o app do imobdesk, que chama a API do ImobRH (rotas /rh/*). Portanto toda regra de negócio fica no backend, nunca só no front.
- Login: Supabase Auth compartilhado com o imobdesk. Projeto Supabase: <<ID_DO_PROJETO_SUPABASE>>.
- ERP: TOTVS RM. Leitura por Consulta SQL exposta via API (padrão API.{modulo}.{id}), escrita por DataServer só na fase 4.

DESIGN SYSTEM — OBRIGATÓRIO
O Console do RH deve usar exatamente o mesmo design system do projeto imobdisparos, que está em: <<CAMINHO_DO_REPO_IMOBDISPAROS>>
1. Antes de criar qualquer tela, leia no imobdisparos: package.json, tailwind.config.*, o CSS global (variáveis de tema claro e escuro), components.json do shadcn/ui, a pasta src/components/ui e os componentes de layout (menu lateral, cabeçalho, cartões, tabelas, badges, diálogos, toasts).
2. Use a mesma stack e as mesmas versões de dependências de UI que o imobdisparos usa.
3. Copie tokens e componentes para o ImobRH. Não invente cores, fontes, raios ou espaçamentos: use só os tokens copiados.
4. Componentes que o imobdisparos não tem (stepper de etapas, timeline, painel de prazos legais, badge de estado do caso) devem ser criados no mesmo estilo e documentados em docs/design-system.md.
5. Antes de seguir, me mostre a lista do que copiou e de onde.

TAREFA DESTA FASE (Fase 0 — Fundação)
1. Crie o CLAUDE.md na raiz com as regras da seção "REGRAS DO PROJETO" abaixo.
2. Monte a estrutura:
   - apps/console (front do Console do RH)
   - supabase/migrations (SQL numerado e aditivo)
   - supabase/functions (Edge Functions, uma pasta por função)
   - packages/shared (tipos TypeScript e JSON Schemas compartilhados)
   - docs/
3. Migration 0001: schema app_imobrh com as tabelas colaborador_vinculo, papel_usuario, substituicao e auditoria, todas com tenant_id, RLS ativo e policies. Papéis: colaborador, gestor, diretoria, rh_dp, rh_dp_restrita, recrutamento, compliance, admin.
4. Edge Function rm-token: obtém o token do RM por POST /api/connect/token com o usuário de integração guardado no Vault; nunca expõe credencial ao front.
5. Edge Functions rm-funcionario e rm-hierarquia: chamam as Consultas SQL API.RH.FUNCIONARIO e API.RH.HIERARQUIA com cache de 1 hora. Os SQLs ainda não existem: crie um mock com o mesmo formato de resposta, atrás de uma variável RM_MODO=mock|real, e deixe em docs/consultas-rm.md os campos esperados de cada consulta.
6. Edge Function rh-me (GET /rh/me): devolve o vínculo do usuário com o RM, os papéis e quais itens do menu RH ele vê.
7. Console: login com o Supabase Auth, layout com menu lateral (Caixa do RH, Meus casos, Prazos legais, Modelos de processo, Alçadas, Vínculos pendentes) e guarda de rota por papel. Implemente agora só a tela Vínculos pendentes (usuários sem chapa no RM); as outras ficam como página vazia com o título.
8. Testes: teste de RLS em SQL provando que um colaborador não lê dados de outro e que ninguém fora de compliance lê tabelas de caso sensível (crie a tabela vazia só para o teste, se precisar).

CRITÉRIOS DE ACEITE DA FASE 0
- npm run dev abre o Console com o visual do imobdisparos.
- Login funciona com um usuário do imobdesk.
- GET /rh/me responde com vínculo e papéis (modo mock).
- Testes de RLS passando.
- docs/design-system.md e docs/consultas-rm.md criados.

Ao terminar, me mostre: arquivos criados, como rodar, o resultado dos testes e o que ficou pendente. Não comece a Fase 1.

REGRAS DO PROJETO (copie para o CLAUDE.md)
- Fonte da verdade: docs/PRD-imobRH-v2.md; regras de serviço e etapas: docs/PRD-imobRH-v1.md.
- Migrations só aditivas e numeradas; nunca editar uma migration já aplicada.
- Toda tabela tem tenant_id, RLS ativo e policy; nenhuma tabela sem policy.
- Segredos só no Vault ou em variáveis das Edge Functions; o front nunca recebe service role nem credencial do RM.
- Toda regra de negócio no backend (Edge Functions ou SQL); o front só exibe e chama a API.
- Respostas da API no formato { data, error: { code, message, fields } }, códigos VALIDACAO, SEM_PERMISSAO, RM_INDISPONIVEL, ESTADO_INVALIDO.
- Nunca INSERT direto em tabela do RM; escrita só por DataServer.
- Atestado, desligamento e caso sensível: buckets privados separados, URL assinada de 5 minutos, leitura registrada em auditoria.
- caso_evento e auditoria são só INSERT.
- UI só com os tokens e componentes do design system copiado do imobdisparos.
- Textos da interface em português do Brasil.
- Uma fase por vez; ao fim de cada fase, listar critérios de aceite e status.
```

---

## Prompt 2 — Pedidos e aprovações (Fase 1)

```text
Fase 0 aceita. Agora a Fase 1 do docs/PRD-imobRH-v2.md (Pedidos e aprovações).

1. Migrations: servico, formulario_versao, pedido, pedido_dados, aprovacao_regra, aprovacao_etapa, anexo, caso_sensivel, caso_sensivel_mensagem.
2. JSON Schema dos formulários dos 8 serviços em packages/shared, com os campos do docs/PRD-imobRH-v1.md (seção Catálogo de serviços). Carregue como dados iniciais.
3. Edge Functions: GET /rh/servicos, GET /rh/servicos/{codigo}/formulario, POST /rh/pedidos, GET /rh/pedidos, GET /rh/pedidos/{id}, POST /rh/pedidos/{id}/mensagens, POST /rh/pedidos/{id}/cancelar, GET /rh/aprovacoes, POST /rh/aprovacoes/{id}, POST /rh/sensivel, GET /rh/sensivel/{codigo}.
4. Validações de férias no backend (CLT): até 3 períodos, um com 14 dias ou mais e os demais com 5 ou mais (art. 134 §1º); início fora dos 2 dias antes de feriado ou repouso (art. 134 §3º); abono pecuniário de até 1/3, pedido até 15 dias antes do fim do período aquisitivo (art. 143); conflito com férias já programadas na seção vira aviso, não erro. Saldo e feriados vêm das Consultas SQL (mock por enquanto).
5. Motor de aprovação: níveis por serviço e condição (tabela do PRD v1, seção Motor de aprovação), sem autoaprovação, substituto por período, devolver ≠ reprovar, SLA por etapa.
6. Canal confidencial: relato anônimo sem user_id, IP ou dados do aparelho; devolve código de acompanhamento.
7. Testes automatizados para cada regra da CLT e para cada caminho do motor de aprovação.

Critérios de aceite: todos os endpoints com testes passando; um pedido de férias inválido devolve erro por campo; um pedido válido percorre gestor → RH. Mostre o resultado e pare.
```

---

## Prompt 3 — Motor de processos e Console do RH (Fase 2)

```text
Fase 1 aceita. Agora a Fase 2 (Motor de processos e Console do RH).

1. Migrations: processo_modelo, etapa_modelo, caso, caso_etapa, caso_evento, caso_vinculo.
2. Dados iniciais: os modelos de processo dos 8 serviços com as etapas, responsáveis, rotinas RM e prazos da seção "Console do RH: cada pedido vira um caso" do docs/PRD-imobRH-v1.md. Prazos relativos à data-âncora de cada serviço.
3. Ao concluir a última aprovação, criar o caso automaticamente e calcular os prazos. Se a data-âncora mudar, recalcular e registrar na timeline.
4. Regras: etapa só abre com as dependências concluídas; etapas sem dependência correm em paralelo; erro do RM devolve a etapa ao analista com a mensagem; caso só conclui com todas as etapas bloqueantes concluídas; estados Novo, Em triagem, Em andamento, Aguardando, Concluído, Cancelado; SLA pausa em Aguardando.
5. Job (pg_cron) a cada 15 minutos: recalcula prazos, envia lembretes, escala etapas vencidas para a coordenação.
6. Telas do Console, com o design system do imobdisparos:
   - Caixa do RH: indicadores, filtros por serviço, tabela ordenada pelo próximo prazo.
   - Caso: etapas à esquerda; etapa atual com checklist e ações no centro; timeline com abas Tudo / Visível ao colaborador / Interno e caixa de nota interna ou mensagem; dados do RM e prazos legais à direita.
   - Caso de admissão e de desligamento: marcos e prazos legais no topo e etapas agrupadas por área.
   - Prazos legais, Modelos de processo (editar etapas e prazos) e Alçadas.
7. Casos sensíveis só na rota /compliance, só para o papel compliance.

Critérios de aceite: um pedido de férias aprovado vira caso com 7 etapas e prazos corretos para o início informado; a Caixa ordena pelo próximo prazo; a timeline do colaborador mostra só eventos visíveis. Mostre e pare.
```

---

## Prompt 4 — Integração com o app e o imobdesk (Fase 3)

```text
Fase 2 aceita. Agora a Fase 3.

1. Abertura de chamados de TI no imobdesk a partir das etapas de admissão e desligamento (POST {IMOBDESK_URL}/api/tickets) e webhook POST /rh/webhooks/imobdesk para receber o status. Autenticação entre sistemas por segredo no Vault e assinatura HMAC no cabeçalho; registrar tudo em webhook_log. Quando o chamado fecha, a etapa conclui.
2. Gere em docs/integracao-app-imobdesk.md o guia para o app do imobdesk: endpoints, exemplos de requisição e resposta, códigos de erro e como renderizar o formulário a partir do JSON Schema.
3. Aprovação por botão no WhatsApp: o imobdesk chama POST /rh/aprovacoes/{id} em nome do gestor identificado pelo telefone; só para férias.
4. Dúvidas de folha: Edge Function que lê o holerite da competência (API.RH.HOLERITE) do próprio solicitante e responde com a Anthropic API; se o colaborador marcar "não resolveu", o caso vai para o DP com o histórico.

Critérios de aceite: um desligamento aprovado abre dois chamados no imobdesk e a etapa conclui quando eles fecham; o guia de integração está completo. Mostre e pare.
```

---

## Prompt 5 — Gravação no RM (Fase 4)

```text
Fase 3 aceita. Agora a Fase 4.

1. Gravação por DataServer (REST /rest/{dataServer}) para: lançamento de férias, afastamento por atestado e pré-cadastro de admissão. Antes de codificar, liste em docs/dataservers-rm.md quais DataServers e campos vai usar e espere minha confirmação.
2. Cada gravação registra request, resposta e status em rm_escrita_log; erro devolve a etapa ao analista com a mensagem do RM e permite reprocessar.
3. Botão "Gravar no RM" na etapa de integração do Console, mantendo "Já lancei manualmente".
4. Conciliação diária: casos concluídos × registros no RM, com relatório das divergências.

Critérios de aceite: gravação de férias funcionando em ambiente de homologação do RM, com log e reprocessamento. Mostre e pare.
```
