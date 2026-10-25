# PRD ImobRH — Solicitações de RH no app imobdesk

Oct 24, 2026 · @Wagner Antunes

## Resumo e viabilidade

É possível, e é a arquitetura certa: o ImobRH vira um módulo dentro do app imobdesk, e não um segundo aplicativo. O colaborador instala um app só, faz um login só e vê em "Meus pedidos" tanto o chamado de TI quanto o pedido de férias.

O que torna isso viável é que 80% do que o RH precisa já existe no imobdesk: abertura de ticket, filas, SLA, notificações, anexos e os canais app, chat e WhatsApp. O ImobRH acrescenta três peças novas: o catálogo de serviços de RH com formulários próprios, um motor de aprovação por alçada e o conector com o TOTVS RM.

Três condições precisam ser cumpridas para funcionar:

- Vínculo de identidade. Todo usuário colaborador do imobdesk precisa estar ligado a um funcionário do RM (coligada + chapa), pelo CPF. Sem isso não há saldo de férias nem hierarquia.

- Separação por papel. Clientes externos do imobdesk nunca enxergam o menu RH. O módulo aparece só para usuários com papel de colaborador interno.

- Dados sensíveis isolados. Atestados, dados de desligamento e casos sensíveis ficam em tabelas com RLS própria, fora do alcance das filas de TI e de atendimento.

Escopo deste PRD: oito serviços — Férias, Atestado, Dúvidas de folha, Documentos, Requisição de pessoal, Desligamento, Admissão e Casos sensíveis.

## Objetivos, não-objetivos e métricas

O objetivo é tirar do e-mail, do papel e do corredor todo pedido de RH, com rastreio, prazo e aprovação registrada.

Objetivos

- Um único ponto de entrada para o colaborador: app, chat web e WhatsApp.

- Aprovações com alçada e trilha de auditoria, sem planilha paralela.

- Saldo de férias, holerite e situação lidos do RM em tempo real.

- Admissão e desligamento disparando automaticamente os chamados de TI.

Não-objetivos (fora desta versão)

- Substituir a folha, o cálculo de férias ou o ponto do RM. O RM continua sendo o sistema de registro.

- Recrutamento e seleção (triagem de candidatos, banco de currículos).

- Ponto eletrônico e ajuste de marcação.

- Benefícios e treinamentos.

Métricas de sucesso

| Métrica | Como medir | Meta |
|---|---|---|
| Pedidos de RH entrando pelo ImobRH | Pedidos no sistema ÷ total recebido pelo RH | A definir com o RH após 30 dias de linha de base |
| Dúvidas de folha resolvidas sem atendente | Tickets fechados pela IA ÷ total da categoria | A definir após a fase 1 |
| Tempo médio de aprovação de férias | Abertura até a última aprovação | A definir com o RH |
| Acessos revogados no dia do desligamento | Chamados de TI concluídos até a data de saída | 100% |
| SLA cumprido por serviço | Tickets dentro do prazo ÷ total | A definir por serviço |

As metas numéricas ficam abertas porque ainda não há linha de base do volume atual do RH.

## Personas e papéis

Sete papéis cobrem os oito serviços. Um mesmo usuário acumula papéis: o gestor também é colaborador e pede as próprias férias.

| Papel | Quem é | O que faz no ImobRH | Origem do papel |
|---|---|---|---|
| Colaborador | Todo funcionário ativo no RM | Pede férias, envia atestado, tira dúvida de folha, pede documento, pede demissão, abre caso sensível | Vínculo CPF ↔ chapa no RM |
| Gestor | Chefe da seção no RM | Aprova férias da equipe, abre requisição de pessoal e desligamento, indica substituto | Hierarquia lida do RM |
| Diretoria / Aprovador de alçada | Diretor da área ou centro de custo | Aprova requisição de pessoal e desligamento conforme alçada | Cadastro de alçadas no ImobRH |
| Analista de RH / DP | Equipe de Departamento Pessoal | Atende as filas, valida atestado, emite documento, executa no RM | Papel atribuído no ImobRH |
| Recrutamento | Analista de R&S | Recebe a requisição aprovada e conduz a vaga até a admissão | Papel atribuído no ImobRH |
| TI | Equipe de Sistemas e Infraestrutura | Recebe os chamados automáticos de acesso e equipamento | Fila já existente no imobdesk |
| Comitê de compliance | 2 ou 3 pessoas nomeadas pela diretoria | Únicos que veem casos sensíveis | Papel atribuído no ImobRH, com registro de quem concedeu |

O cliente externo do imobdesk não tem nenhum desses papéis e não vê o módulo.

## Arquitetura do app único

O ImobRH entra como módulo de código e de banco dentro do imobdesk: mesmo front-end, mesmo login e mesmo motor de tickets, com schema próprio app_imobrh.

arquitetura do app único · canais, app, dados e RM

Os três canais alimentam o mesmo app. O módulo ImobRH usa o núcleo de tickets e a IA, e só ele fala com o RM, sempre pelo conector.

Como encaixar no código

- Projeto próprio, app único. O ImobRH pode nascer como projeto separado (pasta modules/imobrh ou pacote em monorepo) e ser montado no shell do imobdesk pelas rotas /rh/.... Para o colaborador é um app só.

- Home unificada. "Meus pedidos" mostra TI e RH juntos; "Novo pedido" abre o catálogo filtrado pelos papéis do usuário.

- Ticket como base. Toda solicitação de RH cria um ticket do imobdesk com tipo RH e uma linha na tabela de extensão do serviço.

- Liga e desliga por empresa. O módulo fica atrás de uma feature flag por tenant, o que permite vendê-lo como add-on caso o imobdesk seja produto WSA.

- Integração RH → TI. Admissão e desligamento aprovados abrem chamados na fila de TI que já existe no núcleo.

## Catálogo de serviços

Cada serviço é um tipo de ticket com formulário, regras e fluxo próprios. A tabela dá a visão geral; os detalhes de cada um vêm em seguida.

| Serviço | Abre | Aprovação | Executa | Fila | Dado sensível |
|---|---|---|---|---|---|
| Férias | Colaborador | Gestor → RH | DP no RM | DP | Não |
| Atestado | Colaborador | Só RH | DP no RM | DP restrita | Sim |
| Dúvidas de folha | Colaborador | Nenhuma | IA, depois DP | DP | Não |
| Documentos | Colaborador | Nenhuma | DP | DP | Não |
| Requisição de pessoal | Gestor | Gestor → Diretoria → RH | Recrutamento | R&S | Salário |
| Desligamento | Gestor ou colaborador | Diretoria → RH | DP + TI | DP restrita | Sim |
| Admissão | RH | Nenhuma | DP + TI | DP | Sim |
| Casos sensíveis | Qualquer pessoa, até anônima | Nenhuma | Comitê | Confidencial | Sim |

### 1. Férias

Campos: período aquisitivo (lista lida do RM, só os com saldo), data de início, quantidade de dias, até três períodos, abono pecuniário (sim/não, quantos dias), adiantamento do 13º (sim/não), observação.

Regras validadas no formulário (CLT):

- Fracionamento em até 3 períodos; um com pelo menos 14 dias e os demais com pelo menos 5 dias corridos (art. 134, §1º).

- Início não pode cair nos 2 dias antes de feriado ou do repouso semanal (art. 134, §3º).

- Abono pecuniário de no máximo 1/3 dos dias, pedido até 15 dias antes do fim do período aquisitivo (art. 143).

- Pedido com antecedência mínima configurável por empresa (sugestão: 45 dias, para o aviso de 30 dias sair a tempo).

- Alerta de conflito quando outra pessoa da mesma seção já tem férias aprovadas no período.

Fluxo: colaborador pede → gestor aprova ou devolve com motivo → RH confere → DP lança no RM → aviso de férias enviado para assinatura → status "Programada". Cancelamento ou alteração geram um novo pedido vinculado ao original.

Visão do gestor: calendário da equipe com férias aprovadas, pendentes e períodos vencendo (férias em dobro).

### 2. Atestado

Campos: tipo (médico, odontológico, acompanhamento de familiar, comparecimento), data de início, dias ou horas, foto ou PDF do atestado (obrigatório), CRM/CRO do emissor.

Regras: prazo de envio configurável (sugestão: até 48 horas após o retorno). Atestado acima de 15 dias consecutivos gera alerta de afastamento pelo INSS para o DP. O CID nunca é campo obrigatório nem aparece em listas.

Fluxo: colaborador envia → fila restrita do DP valida (legibilidade, emissor, datas) → aceita ou recusa com motivo → DP lança o afastamento no RM. O gestor recebe só a informação "ausência justificada de X a Y", nunca o documento.

### 3. Dúvidas de folha

Campos: competência, assunto (desconto, adicional, hora extra, informe de rendimentos, 2ª via de holerite, outro), descrição livre.

Fluxo: a IA responde primeiro, lendo o holerite da competência no RM e a base de conhecimento do RH. Se o colaborador marcar "não resolveu" ou a IA não tiver confiança, o ticket vai para o DP com o histórico. 2ª via de holerite e informe de rendimentos são autoatendimento puro, sem ticket.

### 4. Documentos

Catálogo inicial: declaração de vínculo empregatício, declaração com salário, carta de referência, cópia do contrato, cópia da ficha de registro.

Fluxo: documentos com modelo fixo (declaração de vínculo) são gerados automaticamente com dados do RM e assinados digitalmente pelo RH. Os demais vão para a fila do DP com SLA. A declaração com salário exige confirmação do colaborador antes de ser emitida.

### 5. Requisição de pessoal

Tipos: aumento de quadro e substituição.

Campos comuns: cargo/função (lista do RM), seção, centro de custo, local de trabalho ou obra, quantidade de vagas, faixa salarial, tipo de contrato (CLT, temporário, estágio, aprendiz), data prevista de admissão, justificativa.

Só na substituição: colaborador substituído (lista dos liderados do gestor, inclusive desligados recentes) e motivo da saída.

Regras: aumento de quadro sempre sobe para a diretoria. Substituição com salário igual ou menor que o do substituído pode parar no gestor + RH, se a empresa configurar assim. O RH pode ajustar a faixa salarial antes da última aprovação, com registro da alteração.

Fluxo: gestor abre → aprovações por alçada → RH aprova → vira vaga em andamento na fila de Recrutamento → quando o candidato é escolhido, Recrutamento abre a Admissão já vinculada à requisição.

### 6. Desligamento

Dois caminhos: iniciativa da empresa (aberto pelo gestor) e pedido de demissão (aberto pelo colaborador).

Campos: colaborador, tipo (sem justa causa, justa causa, término de contrato, pedido de demissão, acordo do art. 484-A), aviso prévio (trabalhado, indenizado, dispensado), data prevista do último dia, justificativa, equipamentos em posse do colaborador.

Regras: o pedido aberto pelo gestor fica invisível para o colaborador desligado até o RH concluir. Justa causa exige anexo e aprovação do jurídico.

Fluxo: abertura → diretoria aprova → RH confere e agenda → na data, o sistema abre automaticamente na fila de TI o chamado de revogação de acessos e devolução de equipamentos, com prazo até o último dia → DP processa a rescisão no RM.

### 7. Admissão

Origem: requisição de pessoal aprovada ou abertura direta pelo RH.

Fluxo: RH cadastra o candidato aprovado → candidato recebe um link de pré-admissão para enviar documentos e dados pessoais → DP confere e lança no RM → o sistema abre na fila de TI os chamados de e-mail, usuário de sistemas, equipamento e crachá, com prazo até a data de início → no primeiro dia o colaborador recebe o convite do app imobdesk, já vinculado à chapa.

### 8. Casos sensíveis

Categorias: assédio moral, assédio sexual, discriminação, conflito com liderança, fraude ou desvio, outros.

Campos: categoria, relato, data e local, envolvidos (opcional), anexos, opção de identificar-se ou não.

Regras: relato anônimo gera um código de acompanhamento para o denunciante voltar e conversar com o comitê sem se identificar. Nenhum gestor, nem o diretor da área, vê esses tickets. Toda leitura do ticket fica registrada em log de auditoria.

Fluxo: relato → comitê de compliance recebe → triagem → apuração → conclusão registrada → retorno ao denunciante pelo código.

## Motor de aprovação

Um único motor atende todos os serviços: cada serviço declara seus níveis, e o motor resolve quem aprova a partir da hierarquia do RM e da tabela de alçadas.

fluxo de aprovação · 4 níveis no máximo

Devolver não é reprovar: o pedido devolvido volta ao solicitante para correção e mantém o protocolo; o reprovado é encerrado.

| Serviço | Nível 1 | Nível 2 | Nível 3 | Aprova pelo WhatsApp |
|---|---|---|---|---|
| Férias | Gestor | RH | — | Sim |
| Atestado | RH | — | — | Não |
| Requisição — aumento de quadro | Gestor | Diretoria | RH | Não |
| Requisição — substituição | Gestor | Diretoria, se o salário for maior que o do substituído | RH | Não |
| Desligamento | Diretoria | RH (+ jurídico na justa causa) | — | Não |
| Dúvidas, Documentos, Admissão, Casos sensíveis | Sem aprovação | — | — | — |

Regras do motor

- Alçada configurável. Condições por serviço (tipo, faixa salarial, centro de custo) definem quantos níveis o pedido percorre.

- Sem autoaprovação. Quem pede nunca aprova o próprio pedido; quando o gestor é o solicitante, sobe para o chefe dele.

- Substituto. O aprovador cadastra um substituto por período; durante as férias dele, as pendências vão automaticamente para o substituto.

- SLA por etapa. Etapa vencida gera lembrete; vencida duas vezes, escala para o nível acima e avisa o RH.

- Trilha completa. Cada decisão grava aprovador, data, motivo e o que foi alterado (por exemplo, a faixa salarial ajustada pelo RH).

## Console do RH: cada pedido vira um caso

Quando um pedido termina as aprovações, ele vira um caso: uma instância de um processo com etapas, responsáveis, prazos legais e uma timeline única. O RH trabalha o caso no Console do RH (web); o colaborador acompanha a parte visível dele no app.

estados de um caso · iguais para todos os serviços

Os estados são os mesmos para todos os serviços; o que muda de um serviço para outro são as etapas dentro de "Em andamento".

### Motor de processos (backend)

O processo é dado, não código: cada serviço tem um modelo versionado de etapas, e o RH ajusta etapas e prazos sem deploy.

| Tabela | O que guarda | Campos principais |
|---|---|---|
| processo_modelo | Modelo de processo por serviço, versionado | servico_id, versao, ativo |
| etapa_modelo | Etapas do modelo | ordem, nome, fila ou papel responsável, tipo, âncora e prazo relativo, depende_de, bloqueante, visível ao colaborador, rotina RM de referência |
| caso | Instância do processo | solicitacao_id, modelo e versão, estado, responsável, datas-âncora (início das férias, data de saída, data de admissão) |
| caso_etapa | Cada etapa do caso | estado, responsável, vence_em, concluída_em, evidência (arquivo, protocolo RM, recibo eSocial) |
| caso_evento | Timeline, só INSERT | tipo, ator (pessoa, sistema, RM, IA), texto, payload, visibilidade (interno ou colaborador) |
| caso_vinculo | Chamados de TI e outros casos ligados | caso_id, ticket_id ou caso_id relacionado |

Tipos de etapa: manual (o analista marca como feita), checklist (só conclui com todos os itens), integração RM (grava via DataServer ou confere por Consulta SQL), documento (gera e coleta assinatura), espera (aguarda uma data, como o retorno das férias) e chamado (abre e acompanha um ticket de outra fila).

Prazos por âncora. O prazo de cada etapa é relativo a uma data do caso, não à data de abertura. Exemplo: "aviso de férias" vence 30 dias antes do início das férias. Se o colaborador muda a data, todos os prazos se recalculam e a mudança entra na timeline.

Regras do motor

- Uma etapa só abre quando as etapas de que depende estão concluídas; etapas sem dependência correm em paralelo.

- Uma etapa de integração com erro do RM volta para o analista com a mensagem do RM e não conta como concluída.

- Um job a cada 15 minutos recalcula prazos, dispara lembretes e escala etapas vencidas para o coordenador do DP.

- Toda ação gera um caso_evento; a timeline do app mostra só os eventos marcados como visíveis ao colaborador.

- O caso só vai para Concluído quando todas as etapas bloqueantes estão concluídas.

### Processo de cada serviço

As etapas abaixo seguem as rotinas da Folha de Pagamento do RM — cadastro, lançamento, cálculo e finalização de férias, rescisão, afastamentos (TDN — Folha de Pagamento RM) — e os prazos da CLT e do eSocial. Os nomes de menu precisam ser conferidos na versão do RM da Calper.

Férias (âncora: início das férias)

| # | Etapa | Responsável | Rotina RM | Prazo |
|---|---|---|---|---|
| 1 | Conferir saldo e programação | DP | Cadastro de Férias | Na triagem |
| 2 | Lançar férias no RM | DP | Lançamento de Férias (DataServer na fase 3) | Início − 35 dias |
| 3 | Emitir aviso e coletar assinatura | DP + colaborador | Aviso de férias | Início − 30 dias (CLT, art. 135) |
| 4 | Calcular férias | DP | Cálculo de Férias | Início − 5 dias |
| 5 | Pagar e coletar recibo assinado | Financeiro + colaborador | Recibo de férias | Início − 2 dias (CLT, art. 145) |
| 6 | Aguardar retorno | Sistema | — | Data de retorno |
| 7 | Finalizar | DP | Finaliza Férias | Retorno + 5 dias |

Atestado (âncora: data de recebimento)

| # | Etapa | Responsável | Rotina RM | Prazo |
|---|---|---|---|---|
| 1 | Validar documento (legível, emissor, datas) | DP restrita | — | 1 dia útil |
| 2 | Lançar abono ou afastamento | DP restrita | Afastamentos / abono no ponto | Antes do fechamento do ponto |
| 3 | Se passar de 15 dias: encaminhar ao INSS e enviar S-2230 | DP restrita | Afastamento + eSocial | Conforme manual do eSocial |
| 4 | Avisar gestor (sem CID nem documento) | Sistema | — | Ao concluir a etapa 2 |

Dúvidas de folha (âncora: abertura)

| # | Etapa | Responsável | Rotina RM | Prazo |
|---|---|---|---|---|
| 1 | Resposta da IA com o holerite | IA | Envelope de pagamento | Imediato |
| 2 | Analisar ficha financeira | DP | Ficha financeira | 2 dias úteis |
| 3 | Se houver erro: lançar acerto na próxima folha | DP | Lançamento de eventos | Antes do cálculo da folha |
| 4 | Responder ao colaborador | DP | — | Junto com a etapa 2 ou 3 |

Documentos (âncora: abertura)

| # | Etapa | Responsável | Rotina RM | Prazo |
|---|---|---|---|---|
| 1 | Gerar documento com dados do RM | Sistema ou DP | Consulta de funcionário | Imediato (modelo fixo) ou 2 dias úteis |
| 2 | Assinar | RH | Assinatura eletrônica | 1 dia útil |
| 3 | Entregar no app ou WhatsApp | Sistema | — | Ao assinar |

Requisição de pessoal (âncora: admissão prevista)

| # | Etapa | Responsável | Rotina RM | Prazo |
|---|---|---|---|---|
| 1 | Conferir quadro e orçamento | RH | Quadro de vagas / seções | 2 dias úteis |
| 2 | Abrir vaga e divulgar | Recrutamento | — | 3 dias úteis |
| 3 | Triagem e entrevistas | Recrutamento + gestor | — | Admissão − 15 dias |
| 4 | Candidato escolhido: abre o caso de Admissão vinculado | Recrutamento | — | Admissão − 10 dias |

Admissão (âncora: data de início)

| # | Etapa | Responsável | Rotina RM | Prazo |
|---|---|---|---|---|
| 1 | Pré-admissão: documentos do candidato pelo link | Candidato + DP | — | Início − 7 dias |
| 2 | Exame admissional (ASO) | Segurança do trabalho | Medicina do trabalho | Início − 3 dias |
| 3 | Cadastrar funcionário | DP | Cadastro de funcionário (DataServer na fase 3) | Início − 2 dias |
| 4 | Enviar admissão ao eSocial (S-2200) | DP | eSocial | Até a véspera do início |
| 5 | Contrato e termos assinados | DP + colaborador | Assinatura eletrônica | No primeiro dia |
| 6 | Chamados de TI: e-mail, sistemas, equipamento, crachá | TI | — | Início − 2 dias |
| 7 | Convite do app e integração | Sistema + RH | — | No primeiro dia |
| 8 | Marcos da experiência | Gestor + RH | — | 45 e 90 dias |

Desligamento (âncora: último dia de trabalho)

| # | Etapa | Responsável | Rotina RM | Prazo |
|---|---|---|---|---|
| 1 | Cadastrar aviso prévio | DP | Aviso prévio | Na triagem |
| 2 | Exame demissional (ASO) | Segurança do trabalho | Medicina do trabalho | Até o último dia |
| 3 | Revogar acessos (chamado TI) | TI | — | No último dia |
| 4 | Recolher equipamentos e EPIs | TI + gestor | — | No último dia |
| 5 | Calcular rescisão | DP | Cálculo de rescisão | Último dia + 3 dias |
| 6 | Enviar desligamento ao eSocial (S-2299) | DP | eSocial | Último dia + 10 dias corridos (referência) |
| 7 | Pagar verbas rescisórias | Financeiro | — | Último dia + 10 dias (CLT, art. 477, §6º) |
| 8 | TRCT e guias assinados e entregues | DP + colaborador | Assinatura eletrônica | Junto com o pagamento |

Casos sensíveis (âncora: recebimento)

| # | Etapa | Responsável | Rotina RM | Prazo |
|---|---|---|---|---|
| 1 | Triagem de risco e medidas cautelares | Comitê | — | 2 dias úteis |
| 2 | Apuração: entrevistas e evidências | Comitê | — | A definir pelo comitê |
| 3 | Parecer e medida | Comitê + jurídico | — | A definir pelo comitê |
| 4 | Retorno ao denunciante pelo código | Comitê | — | Ao concluir |

Os prazos internos (os que não citam lei) são sugestão inicial e ficam editáveis em etapa_modelo.

### O que o Console do RH mostra

- Caixa do RH: todos os casos das filas do analista, ordenados pelo próximo prazo, com a etapa atual e o prazo legal em destaque.

- Tela do caso: à esquerda as etapas do processo; no centro a etapa em trabalho com seu checklist e ações no RM; abaixo a timeline; à direita os dados do colaborador lidos do RM e os prazos legais.

- Casos com várias áreas: admissão e desligamento mostram as etapas agrupadas por área (DP, TI, Segurança do trabalho, Financeiro), com os chamados de TI vinculados e seus status.

## Integração TOTVS RM

O RM continua sendo o sistema de registro: o ImobRH lê do RM desde o primeiro dia e só passa a gravar nele na fase 3, sempre pelos DataServers e nunca com INSERT direto nas tabelas.

Autenticação. Token obtido com POST em /api/connect/token com usuário de integração do RM (não um usuário pessoal), guardado no Vault e renovado pela Edge Function. Fonte: TDN — autenticação das APIs do RM.

Leitura (fase 1), pelo padrão já usado nos outros projetos: Consulta SQL do RM exposta via API, com cache em Redis.

| Consulta | Uso no ImobRH | Tabelas de referência | Cache |
|---|---|---|---|
| API.RH.FUNCIONARIO | Vínculo CPF ↔ coligada + chapa, situação, seção, função, admissão | PFUNC, PPESSOA, PSECAO, PFUNCAO | 1 hora |
| API.RH.HIERARQUIA | Chefe de cada seção, para rotear aprovações | PSECAO + cadastro de chefia da sua base | 1 hora |
| API.RH.FERIAS_SALDO | Períodos aquisitivos, saldo, vencimento | PFUFERIASPER | 15 min |
| API.RH.FERIAS_PROGRAMADAS | Calendário da equipe | Tabelas de férias da sua base | 15 min |
| API.RH.HOLERITE | Resposta da IA em dúvidas de folha, 2ª via | Envelope de pagamento | Por competência |
| API.RH.FERIADOS | Validação de início de férias | Calendário da coligada | 1 dia |

Os nomes das tabelas são referência e precisam ser confirmados na base da Calper, principalmente os de chefia e de férias programadas.

Escrita (fase 3), pelo endpoint REST de DataServer (/rest/{dataServerName}), documentado no TDN — serviços REST dos DataServers:

- Lançamento de férias programadas.

- Lançamento de afastamento por atestado.

- Pré-cadastro de admissão.

Rescisão e cálculo continuam manuais no RM, por envolverem cálculo e eSocial.

Sincronização. Um job a cada hora atualiza funcionários e hierarquia. Desligado no RM = acesso ao módulo RH suspenso no imobdesk no mesmo ciclo. Quando a escrita falha, o ticket volta para a fila do DP com o erro do RM, e o pedido não é dado como concluído.

## Modelo de dados

O ImobRH não cria uma segunda tabela de tickets: cada solicitação é um ticket do imobdesk com uma tabela de extensão por serviço no schema app_imobrh. Assim filas, SLA, comentários, anexos e canais vêm prontos.

| Tabela | Conteúdo | Chave e vínculos |
|---|---|---|
| colaborador_vinculo | Usuário do imobdesk ↔ coligada + chapa do RM, CPF, situação, seção, gestor | user_id único; tenant_id |
| servico_catalogo | Os 8 serviços: nome, formulário (JSON Schema), fila, SLA, se é sensível | codigo único por tenant |
| solicitacao | Cabeçalho comum: serviço, solicitante, beneficiário, status, protocolo | ticket_id → ticket do imobdesk |
| sol_ferias | Períodos, abono, adiantamento do 13º, período aquisitivo | solicitacao_id |
| sol_atestado | Tipo, datas, emissor, arquivo (bucket privado) | solicitacao_id; RLS só DP |
| sol_documento | Tipo de documento, PDF gerado, hash da assinatura | solicitacao_id |
| sol_requisicao_pessoal | Tipo, cargo, seção, faixa salarial, vagas, substituído | solicitacao_id |
| sol_desligamento | Tipo, aviso, data de saída, equipamentos | solicitacao_id; RLS DP + aprovadores |
| sol_admissao | Candidato, documentos, data de início, requisição de origem | solicitacao_id; requisicao_id |
| caso_sensivel | Categoria, relato, anônimo, código de acompanhamento | Sem ticket_id comum; RLS só comitê |
| aprovacao_regra | Serviço, condição (ex.: tipo = aumento de quadro), sequência de níveis | servico_id |
| aprovacao_etapa | Cada aprovação: nível, aprovador, decisão, motivo, data | solicitacao_id |
| substituicao | Aprovador ausente, substituto, período | user_id |
| acao_automatica | Chamados de TI gerados por admissão ou desligamento | solicitacao_id → ticket_id de TI |
| auditoria | Quem leu ou alterou o quê, quando | Imutável, só INSERT |

O caso sensível não usa a tabela de tickets comum de propósito: assim nenhuma visão, relatório ou busca geral do imobdesk consegue alcançá-lo por engano.

Migrations aditivas e versionadas no Git, seguindo o padrão dos outros projetos.

## Canais e IA

O mesmo pedido pode começar em qualquer canal e terminar em outro; o protocolo é único.

| Serviço | App | Chat web | WhatsApp |
|---|---|---|---|
| Férias | Formulário completo + calendário | Formulário completo | Conversa guiada; aprovação do gestor por botão |
| Atestado | Foto pela câmera | Upload | Foto enviada na conversa |
| Dúvidas de folha | IA + ticket | IA + ticket | IA + ticket |
| Documentos | Pedido e download | Pedido e download | Pedido; PDF entregue na conversa |
| Requisição de pessoal | Formulário completo | Formulário completo | Só aprovação por botão |
| Desligamento | Formulário completo | Formulário completo | Só aprovação por botão |
| Admissão | Uso do RH | Uso do RH | Link de pré-admissão para o candidato |
| Casos sensíveis | Sim, com opção anônima | Sim, com opção anônima | Não |

Casos sensíveis ficam fora do WhatsApp porque a conversa fica no aparelho, o número identifica a pessoa e o histórico pode ser visto por terceiros.

Papel da IA

- Triagem: entende "preciso de uma declaração pro banco" e abre o serviço Documentos já preenchido.

- Resposta de folha: lê o holerite da competência e explica cada verba em linguagem simples, citando a linha do holerite.

- Pré-validação: confere legibilidade e datas do atestado antes de cair na fila do DP.

- Limites: a IA nunca aprova, nunca recusa e nunca recebe dados de casos sensíveis. Ela também não responde sobre salário de terceiros: cada consulta é filtrada pela chapa do próprio solicitante.

Notificações seguem o motor já existente do imobdesk: push no app, e-mail e template de WhatsApp aprovado na Meta para cada evento (pedido aberto, aprovado, devolvido, concluído).

## Segurança, LGPD e confidencialidade

Três serviços tratam dado pessoal sensível (art. 5º, II, da LGPD) ou de alto risco, e por isso ganham regras próprias acima do RLS padrão do imobdesk.

| Serviço | Quem vê | Arquivos | Retenção |
|---|---|---|---|
| Atestado | Solicitante e fila do DP | Bucket privado; URL assinada de 5 min | Definir com o jurídico |
| Desligamento | DP, aprovadores do fluxo e, depois de concluído, o próprio colaborador | Bucket privado | Definir com o jurídico |
| Casos sensíveis | Só o comitê de compliance | Bucket privado e separado | Definir com o jurídico |

Regras gerais

- RLS por tenant, por papel e por vínculo: o gestor só vê pedidos de quem está abaixo dele na hierarquia do RM.

- Admin de TI não tem acesso de leitura aos dados de RH no app. O acesso de banco direto fica restrito e registrado.

- Toda leitura de atestado, desligamento e caso sensível grava em auditoria.

- Relato anônimo não grava IP, user_id nem dados do aparelho.

- Credenciais do RM ficam no Vault, nunca no front-end.

- Base legal e aviso de privacidade do módulo revisados pelo jurídico antes da entrada em produção.

## Roadmap e critérios de aceite

Quatro fases, cada uma liberada só quando todos os critérios da anterior estiverem marcados. As datas ficam para depois da validação com o RH.

### Fase 0 — Fundação

- ☐ Usuário de integração do RM criado e token funcionando via Edge Function

- ☐ Consultas API.RH.FUNCIONARIO e API.RH.HIERARQUIA publicadas e com cache

- ☐ 100% dos colaboradores ativos vinculados por CPF, com relatório dos que falharam

- ☐ Menu RH aparecendo só para colaboradores; cliente externo testado sem acesso

- ☐ Schema app_imobrh com RLS e tabela de auditoria

### Fase 1 — Autoatendimento e filas (só leitura do RM)

- ☐ Dúvidas de folha com IA lendo o holerite e escalando para o DP

- ☐ 2ª via de holerite e informe de rendimentos sem ticket

- ☐ Documentos: declaração de vínculo gerada e assinada automaticamente

- ☐ Atestado com fila restrita e lançamento manual no RM

- ☐ Casos sensíveis com relato anônimo e código de acompanhamento

### Fase 2 — Aprovações

- ☐ Motor de aprovação com alçada, devolução, substituto e SLA por etapa

- ☐ Férias com validação CLT, calendário da equipe e aprovação por botão no WhatsApp

- ☐ Requisição de pessoal (aumento de quadro e substituição) até a vaga aberta

- ☐ Desligamento com chamado automático de revogação de acessos na fila de TI

- ☐ Admissão com link de pré-admissão e chamados automáticos de TI

### Fase 3 — Escrita no RM

- ☐ Férias aprovadas gravadas no RM via DataServer, com reprocessamento em caso de erro

- ☐ Afastamento por atestado gravado no RM

- ☐ Pré-cadastro de admissão gravado no RM

- ☐ Conciliação diária: pedidos concluídos no ImobRH × registros no RM

## Riscos e decisões em aberto

| Risco | Impacto | Mitigação |
|---|---|---|
| Hierarquia de chefia desatualizada no RM | Aprovação cai na pessoa errada | Relatório de seções sem chefe na fase 0; RH corrige no RM antes de ligar as aprovações |
| Colaborador sem CPF ou com cadastro duplicado no RM | Não consegue usar o módulo | Fila de vínculos pendentes para o DP resolver |
| Gravação no RM via DataServer recusada por regra de negócio | Pedido aprovado sem registro no RM | Fase 3 só depois da conciliação; erro devolve o ticket ao DP |
| Gestor aprova pelo WhatsApp sem ler | Aprovação sem análise | Botão no WhatsApp só para férias; requisição e desligamento exigem abrir o app |
| Vazamento de atestado ou caso sensível | Incidente LGPD | RLS própria, bucket separado, auditoria de leitura, revisão do jurídico |
| Duas ferramentas para o mesmo pedido (Meu RH e ImobRH) | Colaborador confuso, dado divergente | Decidir quais funções do Meu RH serão desligadas |

Decisões em aberto

- ☐ A Calper usa hoje o Meu RH ou o RM Portal para férias? Se sim, o que será desligado lá?

- ☐ O imobdesk é produto da WSA (multi-tenant, vendido a outras empresas) ou sistema interno da Calper? Isso define o banco, o repositório e se o conector RM é configurável por cliente.

- ☐ Quem compõe o comitê de compliance para casos sensíveis?

- ☐ Tabela de alçadas: quem aprova aumento de quadro e desligamento em cada área?

- ☐ Prazos de retenção de atestados, desligamentos e casos sensíveis (jurídico).

- ☐ SLA de cada serviço, por etapa.

- ☐ Quais documentos entram no catálogo inicial além da declaração de vínculo.
