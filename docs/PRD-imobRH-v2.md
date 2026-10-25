# PRD ImobRH v2 — sistema de RH separado, app compartilhado com o imobdesk

Oct 25, 2026 · @Wagner Antunes

## Resumo e decisões

O ImobRH é um sistema próprio — backend, banco e Console do RH — e o colaborador usa o app do imobdesk, onde as telas de RH chamam a API do ImobRH. Um login, um app, dois sistemas por trás.

| Decisão | Escolha |
|---|---|
| Sistema | ImobRH separado do imobdesk, em repositório próprio |
| Front do colaborador e do gestor | O app do imobdesk, com o menu RH consumindo a API do ImobRH |
| Front do RH | Console do RH, web, dentro do ImobRH |
| Banco | Mesmo projeto Supabase do imobdesk, schema app_imobrh (proposta; ver Decisões em aberto) |
| Login | Supabase Auth compartilhado com o imobdesk |
| Design system | O mesmo do imobdisparos (projeto Disparo em Massa) |
| Desenvolvimento | VS Code com Claude Code, CLAUDE.md na raiz, migrations versionadas no Git |
| ERP | TOTVS RM: leitura por Consulta SQL via API desde o início; escrita por DataServer só na fase 4 |

O detalhamento das regras de cada serviço (campos, regras da CLT, etapas e prazos de cada processo) está no PRD ImobRH v1 e continua valendo. Este v2 muda a arquitetura e define o que o Claude Code precisa para construir.

## Arquitetura

O ImobRH é dono de tudo o que é RH; o imobdesk é dono do app, dos tickets de TI e do WhatsApp. Os dois só se tocam em três pontos: o login, a API do ImobRH e os chamados de TI.

arquitetura · ImobRH separado, app e login compartilhados

O app chama o imobdesk para TI e o ImobRH para RH. Só o ImobRH fala com o RM, e o Console do RH só fala com o ImobRH.

## Escopo

Oito serviços, cada um com um formulário no app e um processo com etapas no Console do RH.

| Serviço | Abre no app | Aprova no app | Trata no Console | Fila |
|---|---|---|---|---|
| Férias | Colaborador | Gestor | DP | DP |
| Atestado | Colaborador | — | DP restrita | DP restrita |
| Dúvidas de folha | Colaborador | — | DP (depois da IA) | DP |
| Documentos | Colaborador | — | DP | DP |
| Requisição de pessoal | Gestor | Gestor e diretoria | Recrutamento | Recrutamento |
| Desligamento | Gestor ou colaborador | Diretoria | DP, TI, Segurança do trabalho, Financeiro | DP restrita |
| Admissão | — (abre no Console) | — | DP, TI, Segurança do trabalho | DP |
| Casos sensíveis | Qualquer pessoa, até anônima | — | Comitê de compliance | Confidencial |

Fora do escopo: folha, cálculo e ponto (continuam no RM), recrutamento completo com banco de currículos, benefícios e treinamentos.

## Contrato de API

O app do imobdesk nunca lê o banco do ImobRH: tudo passa por Edge Functions do ImobRH, autenticadas pelo JWT do Supabase Auth. O RLS continua valendo por baixo, como segunda barreira.

Para o app do imobdesk (colaborador e gestor)

| Método e rota | O que faz | Quem chama |
|---|---|---|
| GET /rh/me | Vínculo com o RM, papéis e menu RH a exibir | App, ao abrir |
| GET /rh/servicos | Catálogo filtrado pelos papéis do usuário | App |
| GET /rh/servicos/{codigo}/formulario | JSON Schema do formulário e valores lidos do RM (ex.: saldo de férias) | App |
| POST /rh/pedidos | Abre um pedido; valida regras (CLT, prazos) e devolve erros por campo | App |
| GET /rh/pedidos?minhas=true | Pedidos do usuário com estado e protocolo | App, em "Meus pedidos" |
| GET /rh/pedidos/{id} | Detalhe e timeline visível ao colaborador | App |
| POST /rh/pedidos/{id}/mensagens | Mensagem do colaborador para o RH | App |
| POST /rh/pedidos/{id}/cancelar | Cancela, se o estado permitir | App |
| GET /rh/aprovacoes | Pendências do gestor (inclui as que ele cobre como substituto) | App |
| POST /rh/aprovacoes/{id} | Aprovar, devolver ou reprovar, com motivo | App e WhatsApp |
| POST /rh/sensivel | Relato confidencial; devolve só o código de acompanhamento | App, sem exigir login no modo anônimo |
| GET /rh/sensivel/{codigo} | Andamento do relato pelo código | App |

Para o imobdesk (sistema a sistema)

| Método e rota | Direção | O que faz |
|---|---|---|
| POST {imobdesk}/api/tickets | ImobRH → imobdesk | Abre chamado de TI (acessos, equipamento) a partir de uma etapa de admissão ou desligamento |
| POST /rh/webhooks/imobdesk | imobdesk → ImobRH | Avisa mudança de status de um chamado vinculado; conclui a etapa quando o chamado fecha |

As chamadas entre sistemas usam um segredo compartilhado no Vault e assinatura HMAC no cabeçalho, nunca o JWT de um usuário.

Padrão de resposta: { data, error: { code, message, fields } }, com códigos estáveis (VALIDACAO, SEM_PERMISSAO, RM_INDISPONIVEL, ESTADO_INVALIDO) para o app traduzir em mensagens.

## Modelo de dados

Tudo no schema app_imobrh. Diferente do v1, o ImobRH tem o próprio cadastro de pedidos e casos e não usa a tabela de tickets do imobdesk.

| Grupo | Tabelas | Observação |
|---|---|---|
| Identidade | colaborador_vinculo, papel_usuario, substituicao | Vínculo auth.users ↔ coligada + chapa pelo CPF; papéis: colaborador, gestor, diretoria, rh_dp, rh_dp_restrita, recrutamento, compliance, admin |
| Catálogo | servico, formulario_versao | Formulário em JSON Schema, versionado |
| Pedido | pedido, pedido_dados | Cabeçalho comum + dados do formulário em JSONB validado pelo schema da versão |
| Aprovação | aprovacao_regra, aprovacao_etapa | Níveis por serviço e condição; decisão, motivo e data por etapa |
| Processo | processo_modelo, etapa_modelo, caso, caso_etapa | Modelo versionado; prazos relativos a uma data-âncora do caso |
| Timeline | caso_evento | Só INSERT; campo visivel_colaborador |
| Vínculos | caso_vinculo | Chamados do imobdesk e casos relacionados (requisição → admissão) |
| Arquivos | anexo | Storage privado por bucket: rh-geral, rh-restrito, rh-compliance |
| Sensível | caso_sensivel, caso_sensivel_mensagem | Fora das tabelas comuns; RLS só compliance; anônimo sem user_id |
| Integração | rm_cache, rm_escrita_log, webhook_log | Cache das consultas ao RM e trilha de cada gravação |
| Auditoria | auditoria | Só INSERT; quem leu ou alterou o quê |

Todas as tabelas carregam tenant_id e o RLS filtra por tenant, papel e hierarquia do RM. Migrations aditivas, numeradas e aplicadas no push.

Os dados iniciais de processo_modelo e etapa_modelo são as tabelas de etapas do PRD v1, seção Console do RH.

## Telas

As referências visuais estão no canvas de mockups: a página "App do colaborador" vale para o imobdesk e a página "Console do RH" vale para o ImobRH. No código, as telas seguem o design system do imobdisparos, não as cores do mockup.

Console do RH (ImobRH, web)

| Rota | Tela | Conteúdo principal |
|---|---|---|
| / | Caixa do RH | Indicadores (abertos, vencendo hoje, atrasados, aguardando), filtros por serviço, tabela ordenada pelo próximo prazo |
| /casos/:id | Caso | Etapas à esquerda; etapa atual com checklist e ações no centro; timeline com nota interna ou mensagem ao colaborador; dados do RM e prazos legais à direita |
| /casos/:id (admissão e desligamento) | Caso com várias áreas | Marcos e prazos legais no topo; etapas agrupadas por área; chamados do imobdesk vinculados |
| /casos/novo | Abrir caso | Admissão a partir de requisição aprovada ou direto |
| /prazos | Prazos legais | Todas as etapas com prazo legal nos próximos 30 dias |
| /compliance | Casos sensíveis | Só para o papel compliance |
| /config/processos | Modelos de processo | Editar etapas, responsáveis e prazos sem deploy |
| /config/aprovacoes | Alçadas | Regras de aprovação por serviço |
| /config/vinculos | Vínculos pendentes | Usuários sem chapa no RM |

App do imobdesk (telas novas no menu RH)

| Tela | Endpoint principal |
|---|---|
| Catálogo RH (aba RH em "Novo pedido") | GET /rh/servicos |
| Formulário do serviço | GET /rh/servicos/{codigo}/formulario, POST /rh/pedidos |
| Meus pedidos (lista unificada TI + RH) | GET /rh/pedidos?minhas=true + endpoint de tickets do imobdesk |
| Detalhe do pedido com timeline | GET /rh/pedidos/{id} |
| Aprovações do gestor | GET e POST /rh/aprovacoes |
| Canal confidencial | POST /rh/sensivel, GET /rh/sensivel/{codigo} |

O formulário do app é renderizado a partir do JSON Schema: um serviço novo ou um campo novo não exige nova versão do app.

## Integrações

TOTVS RM. O ImobRH lê e grava no RM só por Edge Functions, com credenciais no Vault.

| Uso | Como | Cache |
|---|---|---|
| Token | POST /api/connect/token com usuário de integração | Até expirar |
| Funcionário, seção, função, situação | Consulta SQL API.RH.FUNCIONARIO | 1 hora |
| Hierarquia de chefia | Consulta SQL API.RH.HIERARQUIA | 1 hora |
| Saldo e períodos de férias | Consulta SQL API.RH.FERIAS_SALDO | 15 min |
| Férias já programadas na seção | Consulta SQL API.RH.FERIAS_PROGRAMADAS | 15 min |
| Holerite da competência | Consulta SQL API.RH.HOLERITE | Por competência |
| Feriados | Consulta SQL API.RH.FERIADOS | 1 dia |
| Gravação de férias, afastamento e pré-admissão (fase 4) | DataServer REST /rest/{dataServer} | — |

As Consultas SQL seguem o padrão API.{módulo}.{id} já usado nos outros projetos; os SQLs são escritos e validados na base da Calper antes da fase 2. Quando o RM está fora, o app mostra o último valor em cache com a data da leitura, e a abertura de pedido continua funcionando.

imobdesk. Três pontos de contato: o login (Supabase Auth compartilhado), a abertura de chamados de TI pelo ImobRH e o webhook de status desses chamados. O imobdesk não lê nem grava dados de RH.

WhatsApp. O imobdesk continua dono do canal. Para aprovar férias por botão, ele chama POST /rh/aprovacoes/{id} em nome do gestor identificado pelo telefone.

## Design system

O Console do RH usa o mesmo design system do imobdisparos: tokens, componentes e layout são copiados de lá, não reinventados.

O que copiar do repositório do imobdisparos

- Tokens: cores (claro e escuro), tipografia, espaçamentos, raios e sombras — de tailwind.config.* e do CSS global (variáveis do shadcn/ui).

- Componentes de src/components/ui (shadcn/ui) e os componentes de layout próprios: menu lateral, cabeçalho, cartões de indicador, tabela com filtros, badges de status, diálogos e toasts.

- Padrões de tela: como o imobdisparos monta lista com filtros, tela de detalhe e tela de configurações.

Regras

- Nada de cor ou tamanho fixo no código: só tokens.

- Componente que o imobdisparos não tem (stepper de etapas, timeline, painel de prazos legais) é criado no mesmo estilo e documentado em docs/design-system.md do ImobRH.

- Estados de caso e de etapa têm um mapa único de cor e rótulo, usado em todas as telas.

App do imobdesk. As telas de RH no app seguem o design system do imobdesk, para o colaborador não perceber que são dois sistemas. Se o imobdesk também adotar o design system do imobdisparos, as duas pontas ficam iguais.

## Segurança e LGPD

Atestado, desligamento e casos sensíveis têm regras acima do RLS padrão, porque tratam dado sensível ou de alto risco.

- RLS em todas as tabelas, por tenant, papel e hierarquia do RM; nenhuma tabela sem policy.

- Edge Functions validam o JWT e o papel antes de qualquer consulta; o front nunca recebe a service role.

- Buckets privados separados (rh-geral, rh-restrito, rh-compliance), acesso só por URL assinada de 5 minutos.

- O gestor recebe "ausência justificada de X a Y", nunca o atestado nem o CID.

- O desligamento aberto pelo gestor fica invisível ao colaborador até a comunicação.

- Relato anônimo não grava user_id, IP nem dados do aparelho.

- Toda leitura de atestado, desligamento e caso sensível grava em auditoria.

- Credenciais do RM e o segredo da integração com o imobdesk ficam no Vault.

- Antes da produção: revisão do jurídico, aviso de privacidade do módulo e prazos de retenção definidos.

## Fases de construção

Cada fase só começa com todos os critérios da anterior marcados. O prompt do Claude Code segue esta mesma ordem.

### Fase 0 — Fundação

- ☐ Repositório imobrh com CLAUDE.md, estrutura de pastas e design system do imobdisparos copiado

- ☐ Schema app_imobrh com tabelas de identidade, papéis e auditoria, RLS ativo

- ☐ Login pelo Supabase Auth compartilhado; Console abre com menu lateral e controle de papéis

- ☐ Edge Function de token do RM e Consultas SQL de funcionário e hierarquia funcionando com cache

- ☐ Tela de vínculos pendentes listando usuários sem chapa

### Fase 1 — Pedidos e aprovações

- ☐ Catálogo e formulários em JSON Schema para os 8 serviços

- ☐ API /rh/servicos, /rh/pedidos e /rh/aprovacoes com testes

- ☐ Validações de férias da CLT no backend, com erro por campo

- ☐ Motor de aprovação com alçada, devolução, substituto e SLA

- ☐ Canal confidencial com código de acompanhamento

### Fase 2 — Motor de processos e Console do RH

- ☐ Modelos de processo dos 8 serviços carregados como dados iniciais

- ☐ Caso criado ao fim das aprovações; prazos calculados pela data-âncora

- ☐ Caixa do RH, tela do caso, timeline e prazos legais

- ☐ Job de recálculo de prazos, lembretes e escalonamento a cada 15 minutos

- ☐ Tela de configuração de modelos de processo e alçadas

### Fase 3 — Integração com o app e com o imobdesk

- ☐ Telas de RH no app do imobdesk consumindo a API

- ☐ "Meus pedidos" unificado TI + RH

- ☐ Abertura de chamados de TI e webhook de status com HMAC

- ☐ Aprovação de férias por botão no WhatsApp

- ☐ IA de dúvidas de folha lendo o holerite

### Fase 4 — Gravação no RM

- ☐ Férias, afastamento e pré-admissão gravados por DataServer, com log e reprocessamento

- ☐ Conciliação diária entre casos concluídos e registros no RM

## Decisões em aberto

- ☐ Banco: mesmo projeto Supabase do imobdesk com schema app_imobrh (proposta deste PRD) ou projeto próprio, que exige validar o JWT do imobdesk.

- ☐ Confirmar que "imobdisparos" é o projeto Disparo em Massa (imobenviomassa) e o caminho do repositório para o Claude Code ler o design system.

- ☐ Stack do app do imobdesk (web/PWA ou nativo), que define como as telas de RH entram nele.

- ☐ Nomes das tabelas do RM na base da Calper (chefia, férias programadas, holerite) para escrever as Consultas SQL.

- ☐ Composição do comitê de compliance, tabela de alçadas e SLAs por etapa.

- ☐ Prazos de retenção de atestados, desligamentos e casos sensíveis (jurídico).
