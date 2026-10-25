# Solicitações Financeiras — CONTEXTO permanente

Leia este arquivo antes de qualquer alteração no módulo. Quando uma regra, estado, tabela ou componente mudar, atualize-o no mesmo commit.
Fontes: `docs/Solicitacoes-financeiras/PRD.md` (detalhe de regras, tabelas e telas) e o mockup aprovado `docs/mockups/solicitacoes-financeiras.html`.

As seções 1 a 8 abaixo são o texto integral do prompt de implantação. A seção 9 registra onde o repositório e as decisões do Wagner
**prevalecem** sobre esse texto: em caso de conflito, vale a seção 9.

```text
========================================
1. PERFIS
========================================
- Colaborador: cria, salva rascunho, anexa, envia, corrige quando devolvida, cancela antes da 1ª aprovação, comprova adiantamento. Vê só as próprias solicitações.
- Aprovador: listado em equipe_aprovador. Aprova, devolve para ajuste, reprova, define substituto por período. Vê as solicitações em que é ou foi etapa.
- Conferente financeiro: membro de equipe com is_financeiro = true. Confere item a item, aceita, glosa, pede ajuste, devolve, gera lançamento no SIENGE, programa pagamento, confere comprovação. Vê status em_conferencia em diante.
- Administrador: cadastra equipes, aprovadores, alçadas, regras, categorias de motivo e o valor do fundo fixo por colaborador.
Se o solicitante também for aprovador da própria equipe, a etapa dele é pulada.

========================================
2. PROCESSO E MÁQUINA DE ESTADOS
========================================
Geral: rascunho -> em_aprovacao -> em_conferencia -> lancamento_gerado -> pagamento_programado -> paga.
Desvios: em_aprovacao -> devolvida -> (reenvio) em_aprovacao, recomeçando do nível 1 em novo ciclo; em_aprovacao -> reprovada (fim); em_conferencia -> pendencia_solicitante -> em_conferencia; cancelada só a partir de rascunho ou antes da 1ª aprovação.
Adiantamento continua após paga: comprovacao_pendente -> comprovacao_em_conferencia -> encerrada; se comprovado < adiantado: devolucao_pendente -> encerrada; se o prazo vencer: comprovação marcada vencida, aviso ao gestor e bloqueio de novos adiantamentos do solicitante.
Toda mudança de status passa por RPC security definer (sf_enviar, sf_decidir_aprovacao, sf_decidir_item, sf_concluir_conferencia, sf_enviar_comprovacao, sf_decidir_comprovacao). O frontend nunca faz update direto em status. Toda ação grava em sf_evento.
Prazos: reembolso e fundo fixo, pagar_ate = data da última aprovação + 15 dias. Adiantamento: paga no vencimento informado; prazo de comprovação = vencimento + prazo_comprovacao_dias da equipe (padrão 30).

========================================
3. FORMULÁRIOS
========================================
Cabeçalho comum, somente leitura e vindo do perfil: funcionário, CPF mascarado, departamento, equipe.
REEMBOLSO: mês de referência, período de/até, centro de custo/obra (lista do SIENGE); linhas com data, valor, descrição/fornecedor, motivo e comprovante obrigatório; total; aceite eletrônico.
FUNDO FIXO: valor do fundo (cadastro do colaborador), saldo inicial = saldo final anterior + reposição recebida; linhas com data, valor, favorecido, motivo/descrição e comprovante; despesas totais; saldo final = saldo inicial - despesas; reposição solicitada = despesas totais; aceite.
ADIANTAMENTO (modelo Adiantamento de Numerário da empresa): documento de origem (pedido de compras, proposta ou e-mail); obra (empresa pagadora); data do preenchimento automática; conta caixa; conta de pagamento; centro de custo; centro de apuração; rateio por tarefa com porcentagem (soma 100%); valor; valor por extenso gerado; favorecido; CPF/CNPJ; finalidade; forma de pagamento (depósito, boleto, cheque, dinheiro) com banco, agência, conta e tipo (corrente/poupança); vencimento; prazo máximo de comprovação; aceite com termo de responsabilidade pela comprovação.
COMPROVAÇÃO DO ADIANTAMENTO: anexar NF, recibo ou foto; acerto: comprovado >= adiantado encerra e gera lançamento do saldo do pedido contra a nota; menor gera devolução da diferença. Lembretes D-7 e D-1.
Rascunho é salvo automaticamente. O aceite eletrônico registra usuário, data/hora, IP e user-agent e substitui as assinaturas.

========================================
4. APROVAÇÃO
========================================
Cadastro por equipe em equipe_aprovador: tipo_solicitacao (reembolso_fundo_fixo | adiantamento), ordem/nível, papel, aprovador, substituto, condição (sempre | obra | valor_acima) e alcada_minima. Na equipe ficam: modo_aprovacao (sequencial | paralelo | qualquer_um), prazo_horas (48), acao_prazo_vencido (lembrar | escalar), is_financeiro, prazo_comprovacao_dias, acao_comprovacao_vencida, limite_adiantamentos_abertos.
Reembolso/fundo fixo: aprovador entra se total >= alcada_minima.
Adiantamento: sequencial, Planejamento (só se a despesa é de obra) -> Gerente (sempre) -> Diretor (valor acima da alçada) -> Presidente (valor acima da alçada). Níveis não exigidos aparecem na timeline como "não exigido para este valor".
No envio, a cadeia é CONGELADA em sf_aprovacao: mudanças posteriores no cadastro não afetam solicitações em andamento.
Devolver e reprovar exigem comentário. Job pg_cron a cada 30 min: lembrete com 25% do prazo restante e escalonamento ao substituto quando vencer.

========================================
5. OCR E REGRAS DE ACEITAÇÃO
========================================
OCR = Edge Function sf-ocr chamando a API da Anthropic (modelo com visão). Chave só no Vault.
PRINCÍPIO: a IA NÃO sugere data, valor nem favorecido. Ela TRANSCREVE literalmente o que está impresso, campo a campo, sem estimar, corrigir ou completar. Um campo só é copiado quando a legibilidade dele é >= 0,80; abaixo disso, volta null, fica vazio para preenchimento manual e o anexo é marcado ilegivel. A ÚNICA sugestão é o motivo/descrição: até 3 opções, escolhidas só entre as categorias ativas de sf_categoria_motivo enviadas no prompt.
Modos: comprovante (fundo fixo/reembolso), pedido_compra (adiantamento: nº do pedido, data, fornecedor, CNPJ, valor total, condição de pagamento; o sistema CALCULA valor = total x percentual) e comprovacao (NF/recibo do adiantamento).
Contrato de saída (validar com zod antes de gravar em sf_anexo.ocr_json): tipo_documento, data, valor_total, favorecido, cnpj_cpf_emissor, chave_acesso, itens[], motivo_sugestoes[{categoria_id, texto, confianca}], legibilidade{data, valor, favorecido}, alertas[]. Retentativa exponencial 3x; meta de 10 s por arquivo.
Na UI, campo copiado aparece em azul com "copiado · legibilidade NN%". A linha registra a origem: manual | ocr_confirmado | ocr_editado.
Regras (parâmetros em sf_regra; resultado em sf_regra_resultado: ok | alerta | bloqueio):
R01 comprovante anexado (bloqueio); R02 legibilidade >= 80% em data, valor e favorecido (alerta); R03 data dentro do período (alerta); R04 valor do comprovante = declarado, tolerância configurável (alerta); R05 documento fiscal com CNPJ/CPF (alerta); R06 duplicidade por SHA-256 e por CNPJ+data+valor (bloqueio); R07 itens proibidos (alerta); R08 teto por categoria (alerta); R09 prazo de envio (alerta); R10 despesas <= saldo do fundo (bloqueio).
A01 documento de origem (bloqueio); A02 valor <= pedido x percentual (alerta); A03 CNPJ do favorecido = fornecedor do pedido (alerta); A04 titularidade bancária (alerta); A05 rateio = 100% (bloqueio); A06 sem adiantamento em aberto no pedido, abaixo do limite por pessoa e sem comprovação vencida (bloqueio); A07 comprovação: emitente = favorecido, emissão após o pagamento e no prazo, valor >= adiantado, nota não usada (alerta; valor menor gera devolução).
Conferente pode aceitar item com alerta, mas com observação obrigatória. Glosa retira o valor do pagamento: valor_a_pagar = total - glosas.

========================================
6. DADOS E INTEGRAÇÕES
========================================
Schema porta_atendimento, prefixo sf_. Só migrations ADITIVAS e versionadas (supabase/migrations/AAAAMMDDHHMM_sf_<descricao>.sql). Dinheiro numeric(14,2); datas date/timestamptz. RLS ligada em todas as tabelas sf_.
Tabelas: sf_solicitacao (inclui tipo reembolso|fundo_fixo|adiantamento, numero SF-AAAA-NNNN, competência, período, totais, valor_glosado, valor_a_pagar, status, etapa_atual, aceite, pagar_ate, sienge_lancamento_id e os campos do adiantamento), sf_item, sf_anexo, sf_regra_resultado, sf_aprovacao (ciclo, nível, papel, status, comentário, prazo), sf_evento, sf_rateio, sf_comprovacao, equipe_aprovador, sf_fundo_fixo, sf_categoria_motivo, sf_regra; colunas novas em equipe.
RLS: colaborador vê solicitante_id = auth.uid(); aprovador vê onde é aprovador_id ou substituto_id em sf_aprovacao; financeiro vê em_conferencia em diante; admin vê tudo. Storage: bucket privado sf-comprovantes, políticas espelhadas, URLs assinadas de 5 min. CPF completo só no PDF e no SIENGE.
Edge Functions: sf-ocr; sf-pdf (HTML -> PDF no layout padrão 2026 da empresa, o mesmo template para preview e anexo); sf-sienge-lancamento (API REST do SIENGE: título a pagar ou de adiantamento com credor, centro de custo, rateio, vencimento e anexos; idempotente pelo numero; na comprovação, vincula a NF e compensa; credor inexistente = erro claro, sem cadastro automático). Credenciais no Vault. Antes de codar o SIENGE, mostre-me os endpoints que vai usar.
Notificações: reusar o serviço do portal (e-mail + aviso no portal) em envio, cada aprovação, devolução, reprovação, chegada no Financeiro, pendência, lançamento, pagamento, lembretes e vencimentos.

========================================
7. DESIGN SYSTEM (igual ao Imobdesk atual)
========================================
Cores: brand #C41E2A (primário, item ativo, links), brand-hover #9B1620, brand-soft #FDECEE; sidebar #1E1F24, sidebar-hover #2B2D33, texto da sidebar #E4E6EA / subitem #C9CCD3 / rótulo #A3A7B0; bg #F4F5F7; surface #FFFFFF; border #E3E5EA; border-input #D5D8DE; text #1B1D22; text-secondary #4F5562; text-label #3A3F4A; readonly #F1F2F4; ocr (borda #6C8FD8, fundo #F3F7FF, texto #173B86); success #1D6B34; danger #B0181F.
Chips (fundo/texto): rascunho #EEF0F3/#3A3F4A; aguardando, em conferência, comprovação pendente, vence em #FFF1E5/#8A3F00; devolvida, pendência #F1EAFC/#5B2AA0; aguardando pagamento, lançamento gerado #E8EFFC/#1F4FB3; aprovada, paga, encerrado #E6F4EA/#1D6B34; reprovada, vencido, divergente #FDECEE/#A3141C. Sempre texto no chip, nunca só cor.
Tipografia: Inter (fallback system-ui). Título de página 28-32/700; título de card 17/700; corpo 14-15; rótulo 13/600; chip e legenda 12; eyebrow 12/700 em caixa alta, espaçamento 0,14em, cor brand.
Forma: grade de 4 px; padding de card 20-22; gap 16-20; raio card 12, input/botão 8-10, chip 999; cards sem sombra, só borda; controles com no mínimo 44 px (botões finais 48, app 52).
Componentes a criar em src/components/financeiro (ou no padrão do repo): AppShell (reusar o existente), PageHeader, KpiCard, DataTable, StatusChip, FormSection, Field, OcrField, ExpenseTable, AttachmentChip, Dropzone, ApprovalTimeline (verde concluído, borda laranja atual, tracejado não exigido, cinza futuro), ApproverChainPreview, DecisionBar (Reprovar contorno danger, Devolver contorno roxo, Aprovar preenchido success), ReceiptViewer (fundo #2A2C31, zoom, girar, tela cheia, PDF), RuleChecklist, FormPreview (A4 com toolbar escura).
Acessibilidade: contraste 4,5:1, botões e links reais, aria-label em botão só de ícone, responsivo (sidebar empilha no celular, tabelas com rolagem horizontal dentro do card).

========================================
8. TELAS E ROTAS
========================================
1 Minhas solicitações /financeiro/solicitacoes — cards de início (Reembolso, Fundo fixo, Adiantamento), KPIs por status, histórico com busca.
2 Reembolso /financeiro/solicitacoes/nova/reembolso — seções numeradas + painel lateral com a cadeia de aprovação.
3 e 11 Fundo fixo /financeiro/solicitacoes/nova/fundo-fixo — resumo do caixa + adicionar por comprovante (dropzone múltipla, fila de leitura: fila/lendo/lido/ilegível, painel com o comprovante ao lado, campos copiados em azul, chips de motivo).
13 Adiantamento /financeiro/solicitacoes/nova/adiantamento — documento de origem com OCR, apropriação e rateio, valor e favorecido, pagamento e prazos, painel de alçadas.
15 Comprovação /financeiro/solicitacoes/:id/comprovacao — documento com OCR, regras A07, acerto do adiantamento.
5 Aprovações /financeiro/aprovacoes — abas Aguardando mim, Aprovadas por mim, Todas da equipe; etapa N de M; chip de prazo; definir substituto.
6 e 14 Detalhe /financeiro/solicitacoes/:id — dados, anexos com prévia, checagens, comentários, DecisionBar e ApprovalTimeline.
8 Fila do Financeiro /financeiro/conferencia — KPIs por etapa (a conferir, pendência, lançamento gerado, pagamento programado, adiantamentos a comprovar, pagas no mês), lista com pagar até.
9 Conferência /financeiro/conferencia/:id — lista de itens, ReceiptViewer, Declarado x Comprovante, RuleChecklist, decisão por item, "Concluir e Gerar Lançamento SIENGE" só com todos os itens resolvidos.
10 Preview do formulário — modal com FormPreview, imprimir, baixar PDF, lista de comprovantes.
7 Equipes e aprovadores /admin/equipes — dados da equipe, fluxo de reembolso/fundo fixo, fluxo do adiantamento (4 níveis), prazos, flag financeira, prévia de quem aprovaria.
4 e 12 App — mesmas rotas em layout mobile, câmera para comprovante, rascunho offline.
```

## 9. Adaptações ao repositório e decisões (prevalecem sobre as seções 1 a 8)

### 9.1 Nomes reais do repositório
| Texto das seções 1–8 | No repositório |
|---|---|
| schema `porta_atendimento` | `imobdesk` |
| `docs/solicitacoes-financeiras/` | `docs/Solicitacoes-financeiras/` |
| migration `AAAAMMDDHHMM_sf_<descricao>.sql` | `AAAAMMDDHHMMSS_imobdesk_sf_<descricao>.sql` (padrão das 14 cifras) |
| tabela `equipe` | não existe; ver 9.2 (a unidade é o **setor**, `at_setores`) |
| perfis "Aprovador", "Financeiro", "Administrador" | permissões do `menuRegistry` + `imobdesk.tem_permissao()`; super admin vê tudo |
| AppShell, Sidebar | `ProtectedLayout`, `Sidebar`, `Topbar` existentes; menu novo só por entrada no `src/config/menuRegistry.ts` |
| ícones | coloridos (`fluent-color`, `flat-color-icons`) embutidos por `scripts/gerar-icones-setor.mjs` (`npm run icones:setor`); botões de ação seguem com Lucide em linha |
| App (telas 4 e 12) | aba "Financeiro" dentro do App do solicitante existente (`/app/*`) |
| notificações | aviso no portal = sino dos gatilhos (`src/features/chamados/gatilhos`); e-mail = Edge Function `imobdesk-email` |

### 9.2 Aprovadores ficam no cadastro de Setores (decisão do Wagner, 17/10/2026)
- Toda a configuração que as seções 1–8 colocam em `equipe` / `equipe_aprovador` fica em **Gestão de Atendimento › Setores e números**, numa aba nova **"Aprovação financeira"** do setor, mais a coluna **Aprovação** na lista. A aba "Atendimento" atual não muda.
- Os setores já incluem as obras ("Obra - Arte Wave", "Obra - Arte Jardim"…) e o Financeiro.
- Banco: colunas novas em `at_setores` (`sf_setor_obra`, `sf_financeiro`, `sf_modo_aprovacao`, `sf_prazo_horas`, `sf_acao_prazo_vencido`, `sf_centro_custo_padrao`, `sf_prazo_comprovacao_dias`, `sf_acao_comprovacao_vencida`, `sf_limite_adiantamentos_abertos`) e tabela `sf_setor_aprovador` (no lugar de `equipe_aprovador`, mesmas colunas, com `setor_id`).
- "Setor de obra" decide se o nível Planejamento entra no adiantamento. "Setor financeiro" substitui `is_financeiro`.
- Aprovação financeira **independe** de "Receber chamado".
- O gestor do setor ("Gestão do setor") é **sugerido** como aprovador Gestor/Gerente; o admin pode trocar (aprovado em 17/10/2026).

### 9.3 Quem é o solicitante
- Usuário (`usuarios`, id = `auth.uid()`) → pessoa (`at_pessoas`) pelo e-mail em `at_pessoa_contatos` → setor (`at_pessoas.setor_id`) e CPF (`at_pessoas.documento`).
- O Wagner vai colocar **todas** as pessoas num setor (17/10/2026). Mesmo assim, `sf_enviar` recusa com mensagem clara quem estiver sem setor (proteção).
- Cabeçalho do formulário: Funcionário, CPF mascarado, Departamento = **Setor**.

### 9.4 Acesso aos dados
- Padrão do repositório: tabelas com RLS ligada e `revoke all` de `anon`/`authenticated`; leitura e escrita **só por RPC security definer** que checa a permissão. As tabelas `sf_` seguem esse padrão; as regras de visibilidade das seções 6 (colaborador, aprovador, financeiro, admin) ficam dentro das RPCs de leitura.

### 9.5 Design system
Valem os tokens de `src/index.css`. Cores soltas nos componentes, não.

| Token do PRD | Token do repositório |
|---|---|
| brand #C41E2A | `--brand` #d6293b |
| brand-hover #9B1620 | `--brand-hover` #a91d2c |
| brand-soft #FDECEE | `--brand-soft` #fdecee |
| sidebar #1E1F24 / sidebar-hover #2B2D33 | `--sidebar` #17181c / `--sidebar-hover` #232429 |
| texto da sidebar #E4E6EA / #C9CCD3 / rótulo #A3A7B0 | `--sidebar-text` #9a9ba3 (ativo: #fff) |
| bg #F4F5F7 | `--page` #f5f6f8 |
| surface #FFFFFF | `--surface` |
| border #E3E5EA | `--line` #e9eaee |
| border-input #D5D8DE | `--input-border` #8d939e (3:1 com o branco, WCAG 1.4.11) |
| text #1B1D22 | `--ink` #17181c |
| text-secondary #4F5562 | `--muted` #6b7280 |
| text-label #3A3F4A | `--neutral-fg` #52525b |
| readonly #F1F2F4 | `--neutral-bg` #f1f1f3 |
| ocr (borda #6C8FD8, fundo #F3F7FF, texto #173B86) | `--info-fg` #1d4ed8, `--info-bg` #e8effd, `--info-border` #c7d7fb |
| success #1D6B34 | `--success-fg` #166534 |
| danger #B0181F | `--danger-fg` #b91c1c |
| chip rascunho | `--neutral-bg` / `--neutral-fg` |
| chip aguardando, em conferência, vence em | `--warning-bg` / `--warning-strong` |
| chip devolvida, pendência #F1EAFC/#5B2AA0 | **criar** `--violet-bg` #f3e8ff / `--violet-fg` #7e22ce |
| chip aguardando pagamento, lançamento gerado | `--info-bg` / `--info-fg` |
| chip aprovada, paga, encerrado | `--success-bg` / `--success-fg` |
| chip reprovada, vencido, divergente | `--danger-bg` / `--danger-fg` |
| ReceiptViewer #2A2C31 | **criar** `--viewer` #2a2b31 (= `--sidebar-sub-active`) |
| tipografia Inter, eyebrow, títulos | `--ds-font`, `.ds-eyebrow`, `.ds-h1` existentes |
| KpiCard, PageHeader, Pill, Panel, Toast | `src/components/ds/` existentes (`KpiCard`, `PageHeading`, `Pill`, `Panel`, `AlertBanner`, `ThLabel`, `IconeColorido`) |

### 9.6 Em aberto (perguntar antes de codar a parte afetada)
- Lançamento: **SIENGE** em tudo (decisão do Wagner, 17/10/2026). A menção ao RM nos formulários xlsx é antiga.
- Valores `[ALÇADA]` (Diretor e Presidente), `[LIMITE]` de adiantamentos em aberto, `[PRAZO]` da R09, tolerância da R04, lista de itens proibidos (R07) e tetos por categoria (R08): parâmetros configuráveis, sem constantes no código.
- Demais itens da seção "Decisões em aberto" do PRD.md.

## 10. Estado da implementação

### Fase 1 — Banco e cadastros (17/10/2026)
- Migrations: `20261017100000_imobdesk_sf_base.sql` (tabelas, colunas `sf_*` em `at_setores`, número SF-AAAA-NNNN, `sf_evento` imutável, bucket `sf-comprovantes`), `…100100_sf_seeds.sql` (R01–R10, A01–A07, 10 categorias, Financeiro e setores "Obra…" marcados na 1ª carga), `…100200_sf_rpc_cadastros.sql`.
- Regras de acesso: `sf_pessoa_do_usuario`, `sf_setor_do_usuario`, `sf_eh_financeiro` (setor da pessoa ou setor que gere), `sf_status_financeiro`, `sf_pode_ver` (regra única de visibilidade; equivale às policies da seção 6).
- RPCs: `sf_meu_contexto`, `sf_setores_resumo`, `sf_setor_config_obter`, `sf_setor_config_salvar` (Admin), `sf_usuarios_opcoes`, `sf_cadastros_lista`, `sf_fundo_fixo_salvar`, `sf_categoria_salvar`, `sf_regra_salvar` (Admin), `sf_solicitacoes_listar(escopo)`.
- Regra de alçada: reembolso/fundo fixo entra quem tem `alcada_minima <= total`; adiantamento: planejamento só em setor de obra, gerente sempre, diretor e presidente quando `valor > alçada`. Mesma regra em `src/features/financeiro/cadeia.ts` (prévia) e, na Fase 2, em `sf_enviar`.
- Telas: aba **Aprovação financeira** e coluna **Aprovação** em Setores e números; menu **Solicitações Financeiras › Cadastros financeiros** (Admin e Super admin; o grupo fica só para admin até a Fase 2 liberar as telas do colaborador).
- Componentes: `StatusChip`, `ApprovalTimeline`, `FormSection`, `Field`, `OcrField`, `CadeiaPrevia` em `src/features/financeiro/components/`; tokens `--violet-bg`, `--violet-fg`, `--viewer`.
- Testes: `tests/db/financeiro.db.test.ts` (4 usuários) e `tests/financeiro-cadeia.test.ts`.

### Fase 2 — Formulários e envio (17/10/2026)
- Migration `20261017110000_imobdesk_sf_formularios.sql`: `sf_rascunho_criar` (número já na criação; fundo fixo exige valor cadastrado e calcula saldo inicial = saldo final anterior + reposição recebida quando a anterior foi paga), `sf_rascunho_salvar` (linhas por id; a que some é apagada com os anexos), `sf_anexo_registrar`/`sf_anexo_remover`, `sf_checagens` (R01, R03, R06 por arquivo, R08, R09, R10 — as que não dependem da leitura), `sf_enviar(id, aceite)`, `sf_cancelar`, `sf_detalhe`, `sf_minhas`.
- `sf_montar_cadeia(setor, tipo, valor, solicitante)` é a regra única da cadeia (pula a etapa do próprio solicitante). O envio a congela em `sf_aprovacao`; devolvida → reenvio abre ciclo novo recomeçando do nível 1. Sequencial: só o 1º nível exigido fica "aguardando" (prazo = setor.sf_prazo_horas); paralelo/qualquer um: todos.
- Aceite: data/hora, IP (`x-forwarded-for`) e navegador (`user-agent`) dos cabeçalhos da requisição; registrado também em `sf_evento`.
- Storage `sf-comprovantes`: caminho `<usuário>/<solicitação>/<arquivo>`; gravar/apagar só o dono com a solicitação editável; ler = `sf_pode_ver`. Arquivo até 10 MB (JPG, PNG, HEIC, WEBP, PDF); SHA-256 calculado no navegador.
- Telas: Minhas solicitações (`/financeiro/solicitacoes`), Nova solicitação (`/financeiro/nova` e `/financeiro/solicitacoes/nova/reembolso|fundo-fixo`), formulário e visão (`/financeiro/solicitacoes/:id`). Rascunho salvo 1,2 s após a última mudança. Grupo do menu visível para todos; Cadastros continua só Admin.
- Adiantamento: cartão liberado na Fase 5B.

### Fase 3 — Aprovação (17/10/2026)
- Migration `20261017120000_imobdesk_sf_aprovacao.sql`. Decisão: `sf_decidir_aprovacao(id, aprovar|devolver|reprovar, comentario)` (comentário obrigatório para devolver e reprovar). Modo **congelado no envio** em `sf_solicitacao.modo_aprovacao` (gatilho): sequencial libera o próximo nível; paralelo conclui quando todos aprovam; qualquer um conclui no 1º e marca os outros como "pulado". Devolver/reprovar fecham o ciclo (demais etapas "nao_exigido"). Última aprovação → `em_conferencia`, `pagar_ate` = hoje + 15 (reembolso e fundo fixo).
- Quem decide: aprovador da etapa, substituto da etapa ou **substituto por período** (`sf_substituicao`, definido pelo próprio aprovador na tela 5). `sf_pode_ver` redefinida: acrescenta substitutos e os aprovadores cadastrados no setor (aba "Todas do setor", fora rascunho).
- Prazos: `sf_aprovacao.iniciado_em` (gatilho); job `imobdesk-sf-prazos` (pg_cron, 30 min) → lembrete quando falta 25% do prazo; vencido: "escalar" avisa o substituto, "lembrar" avisa de novo o aprovador; uma vez por etapa.
- Notificações: `sf_notificar` grava aviso no sino (`ch_notificacoes.link`, coluna nova; o sino abre o link) e e-mail na fila `sf_email_fila`. Gatilhos: etapa "aguardando" → aprovador; mudança de status → solicitante (enviada, devolvida, reprovada, aprovada/conferência, pendência, lançamento, pagamento, paga); chegada na conferência → todos do Financeiro; cada aprovação intermediária → solicitante.
- E-mail: Edge Function `imobdesk-sf-email` (pg_cron 5 min, chave `x-atendimento-chave` do Vault). Remetente = conta Gmail (OAuth) do setor marcado como financeiro, em Central Email. Sem conta, os e-mails ficam pendentes. Variável opcional `PORTAL_URL` completa os links do texto. 3 tentativas → "falha".
- Telas: Aprovações (`/financeiro/aprovacoes`, abas, prazo, substituto) e, no detalhe, checagens gravadas, comentários e DecisionBar.

### Fase 4 — Leitura dos comprovantes (17/10/2026)
- Edge Function `imobdesk-sf-ocr` (JWT do usuário): `sf_ocr_pedido` confere a posse e marca "lendo"; baixa o arquivo do bucket; chama a API da Anthropic pelo SDK oficial (`npm:@anthropic-ai/sdk@0.135.0`, modelo `claude-opus-5-5`, effort `medium`, saída em JSON com esquema, **fallback do servidor em caso de recusa** `fallbacks: "default"`); até 3 tentativas com espera crescente; grava com `sf_ocr_registrar` (só service_role). Secret: `ANTHROPIC_API_KEY`.
- Módulo puro `supabase/functions/_shared/sf/ocr.ts` (testado em `tests/financeiro-ocr.test.ts`): esquema, instruções (transcrição literal), `validarLeitura` e `normalizarLeitura` (campo abaixo do limiar da R02 → nulo; status `ilegivel`; sugestões só das categorias ativas, até 3). **A validação é feita por esse módulo, no padrão da IA do portal, em vez do zod** citado na seção 5.
- Formatos: JPG, PNG, WEBP e PDF são lidos; HEIC fica anexado sem leitura (a API não aceita); imagem acima de 5 MB não é lida (limite da API).
- Fluxo "Adicionar por comprovante": o anexo entra sem linha (`sf_fila_leitura`), é lido e, ao confirmar, `sf_linha_do_comprovante` cria a linha com origem `ocr_confirmado` (sem mudança) ou `ocr_editado`.
- `sf_rascunho_salvar` redefinida: aceita `conhecidos` (ids que a tela já tinha) e só apaga por omissão esses — evita apagar a linha criada pela leitura no meio de um salvamento.
- `sf_checagens` redefinida com as regras da leitura: R02, R04 (tolerância), R05, R06 por CNPJ + data + valor, R07 (itens proibidos da lista do admin).
- Visualizador (`ReceiptViewer`): imagem com zoom, girar e tela cheia; PDF abre em nova aba (CSP do portal: `frame-src 'none'`, `object-src 'none'`).
- Pendente do critério de aceite: teste com 20 comprovantes reais da empresa (meta ≥ 90% em data e valor) — depende dos arquivos do Wagner.

### Fase 5, parte 1 — Conferência e preview (17/10/2026)
- Migration `20261017140000_imobdesk_sf_conferencia.sql`: `sf_conferencia_fila` (KPIs por etapa e lista pela aprovação mais antiga), `sf_conferencia_itens` (itens com anexos, leitura e regras por item), `sf_decidir_item` (aceitar; com alerta exige observação; ajuste e glosa exigem observação; glosa entre 0 e o valor do item; `valor_a_pagar = total − glosas`), `sf_pedir_ajuste` → `pendencia_solicitante`, `sf_pendencia_anexar` (só itens em ajuste) e `sf_pendencia_responder` → volta para `em_conferencia` sem nova aprovação, `sf_programar_pagamento` (só depois de `lancamento_gerado`), `sf_marcar_paga` (adiantamento segue para `comprovacao_pendente`).
- Permissão nova `sf_conferencia` (tela Conferência financeira): marcar em Perfis e permissões para o perfil do Financeiro; Admin já tem. A regra de dados continua: só quem é do setor financeiro (ou admin) confere.
- Telas: Fila do Financeiro (`/financeiro/conferencia`), Conferência item a item (`/financeiro/conferencia/:id`), Preview do formulário (modal A4 no layout 2026; Imprimir e Baixar PDF pela impressão do navegador) e o quadro de Pendência para o solicitante no detalhe.
- **Pendente (parte 2): integração SIENGE** — endpoints levantados e aguardando aprovação do Wagner (seção 6: "Antes de codar o SIENGE, mostre-me os endpoints"). O botão "Concluir e gerar lançamento SIENGE" fica desabilitado até lá. O PDF do servidor (anexo do lançamento) sai junto com essa parte.

### Fase 5, parte 2 — Integração SIENGE e PDF (17/10/2026)
- Pedido do Wagner: a conexão fica em **Configurações › Integrações › SIENGE** (Admin e Super admin; permissão de menu `integracao_sienge`, adminOnly) e o lançamento é feito pelo botão **"Lançamento no SIENGE"** da conferência.
- Migration `20261017150000_imobdesk_sf_sienge.sql`: `sf_sienge_config` (registro único; senha da API no Vault; ambiente homologação/produção; empresa pagadora `debtorId`, tipo de documento, indexador, plano financeiro por tipo, centro de custo padrão), `sf_sienge_config_ler/salvar`, `sf_sienge_senha_salvar`, `sf_sienge_credenciais` (só service_role), `sf_lancamento_pedido` (Financeiro; todos os itens aceitos/glosados; CPF obrigatório; trava "lancando" por 3 min contra clique duplo), `sf_lancamento_registrar` (sucesso → `lancamento_gerado` + `sienge_lancamento_id`; erro → `sienge_erro`), `sf_sienge_situacao`, `sf_pdf_dados` (CPF completo só no PDF).
- Edge Function `imobdesk-sf-sienge` (JWT): `testar`, `listas` (centros de custo, planos, tipos de documento para os selects), `lancar` e `pdf`. Lançar = `GET /creditors?cpf=` (sem credor → erro claro, sem cadastro automático) → `GET /bills?…&documentNumber=SF-…` (idempotência) → `POST /bills` (1 parcela, valor a pagar já sem glosas, rateio 100% no centro de custo, plano do tipo) → id pelo corpo/`Location` ou nova busca → `POST /bills/{id}/attachments` com o PDF do formulário e os comprovantes aceitos/glosados (falha de anexo vira aviso, não desfaz o título).
- Módulo puro `_shared/sf/sienge.ts` (testado em `tests/financeiro-sienge.test.ts`). PDF do formulário (`pdf-lib`, layout 2026) em `imobdesk-sf-sienge/pdf.ts`; o "Baixar PDF" do preview usa o mesmo PDF.
- Adiantamento: a API não tem adiantamento/compensação; na Fase 5B ele entra como título comum com tipo de documento e plano marcados como adiantamento, e a compensação segue no SIENGE.

### Fase 5B — Adiantamento de numerário (17/10/2026)
- Migration `20261017160000_imobdesk_sf_adiantamento.sql` (aditiva). Colunas novas: `sf_solicitacao.pedido_data`, `pedido_fornecedor`, `pedido_fornecedor_doc`, `pedido_condicao`, `pago_em`, `comprovacao_aviso7_em`, `comprovacao_aviso1_em`, `comprovacao_vencida_em`, `sienge_saldo_id`, `sienge_saldo_erro`; `sf_comprovacao.emitente_nome`, `numero_documento`, `referencia`, `chave_acesso`, `status` (enviada, aceita, devolucao, ajuste), `obs`.
- **Valor como linha única:** o valor do adiantamento vira uma única `sf_item` (data do preenchimento, valor, favorecido, finalidade). Assim a conferência item a item, a glosa, o `valor_a_pagar` e o lançamento da Fase 5 servem sem mudança. Os documentos de origem (`sf_anexo.finalidade = documento_origem`) ficam ligados a essa linha e vão anexados ao título.
- RPCs: `sf_rascunho_criar` aceita `adiantamento` e recusa quem tem comprovação vencida (A06, quando o setor está em "avisar e bloquear"); `sf_adiantamento_salvar` (rascunho automático; rateio refeito a cada gravação; prazo de comprovação = vencimento + `sf_prazo_comprovacao_dias` do setor); `sf_adiantamento_validar` (completude no envio); `sf_checagens_adiantamento` (A01, A02, A03, A05 e A06, todas listadas, com "ok" quando passam); `sf_enviar` redefinido (sem período e sempre sequencial; o gatilho `sf_solicitacao_modo` também força sequencial); `sf_detalhe` traz o bloco `adiantamento` (`sf_adiantamento_dados`).
- Cadeia: `sf_montar_cadeia` (Fase 2) já aplica Planejamento só em setor de obra, Gerente sempre, Diretor e Presidente acima da alçada. Testado com 3 valores.
- Comprovação: `sf_comprovacao_anexar` / `sf_comprovacao_anexo_remover`, `sf_comprovacao_checar` (A07, prévia ao vivo: emitente = favorecido, emissão ≥ pagamento, dentro do prazo, valor ≥ adiantado, nota não usada por chave de acesso, arquivo ou CNPJ + número), `sf_enviar_comprovacao` (grava `sf_comprovacao` com o acerto e as checagens A07 → `comprovacao_em_conferencia`), `sf_decidir_comprovacao` (Financeiro: aceitar → `encerrada` se nota ≥ adiantado, senão `devolucao_pendente`; ajuste volta para `comprovacao_pendente`; aceitar com alerta exige observação), `sf_confirmar_devolucao` → `encerrada`.
- Prazo: `sf_comprovacao_job` (pg_cron `imobdesk-sf-comprovacao`, diário às 08:00 de Brasília): lembrete D-7 e D-1; vencido → `status_comprovacao = vencida`, aviso ao solicitante e aos gestores do setor (`at_setor_gestores`); o bloqueio vale para novos adiantamentos (A06 e na criação).
- Leitura: o esquema da IA ganhou `numero_documento`, `condicao_pagamento` e `referencia_pedido` (nulos quando não existem). No modo `pedido_compra`, o fornecedor vai em `favorecido` / `cnpj_cpf_emissor`, e o sistema calcula valor = total × percentual (o percentual é tirado da condição, ex.: "50% sinal"). `sf_ocr_pedido` também lê a NF da comprovação (fora do rascunho).
- SIENGE: no adiantamento, o credor é o **favorecido** (`GET /creditors?cnpj=` ou `?cpf=`). Se o conferente informar o código da obra e da unidade construtiva no diálogo, o rateio por tarefa vai em `buildingsCost` (tarefa = item de orçamento `costEstimationSheetId`); sem eles, vai só o centro de custo. Saldo do pedido (nota > adiantado): ação `lancar_saldo` cria o título `SF-…-S` contra a nota, anexando a nota (`sf_lancamento_saldo_pedido` / `sf_lancamento_saldo_registrar`). A compensação do adiantamento continua manual no SIENGE (a API não tem esse recurso).
- Telas: 13 (`/financeiro/solicitacoes/nova/adiantamento` → formulário), 14 (detalhe com dados no layout do formulário, prévias, checagens e linha do tempo até Encerrado) e 15 (`/financeiro/solicitacoes/:id/comprovacao`). Na conferência, um quadro A04 (titularidade bancária) e, depois do pagamento, o painel da comprovação. Preview A4 e PDF do servidor com o layout do adiantamento (valor por extenso, rateio, termo e as aprovações de cada nível).
- Adaptação ao mockup: obra, conta de pagamento, centro de custo e centro de apuração são campos de texto (a obra sugere os setores de obra), porque não há lista dessas contas no portal; o colaborador não consulta o SIENGE.
- Módulo puro `_shared/sf/adiantamento.ts` (valor por extenso, percentual da condição, rateio, acerto, prazo), usado pela tela e pelo PDF; testado em `tests/financeiro-adiantamento.test.ts`. Banco: `tests/db/financeiro-adiantamento.db.test.ts`.


### Fase 6 — App no celular e README (17/10/2026)
- App do solicitante ganhou o quadro **Financeiro** (`/app/financeiro`), telas 4 e 12 do mockup: início com aviso de sem rede, Reembolso e Fundo fixo, lista das solicitações (inclusive adiantamentos, só para acompanhar), rascunho com os comprovantes, "Novo comprovante" com a câmera traseira, leitura (campos em azul e motivo sugerido) e envio com aceite. Mesmas RPCs do portal; nenhuma migration nova.
- Rascunho offline: IndexedDB `solicitante-sf` (fotos como Blob). Ao voltar a rede, sobe sozinho; a sincronização é retomável (servidorId, linhaId, fotoEnviada), sem duplicar rascunho nem foto. O envio para aprovação é feito depois, com rede. Lógica pura em `src/features/solicitante/financeiro/offline.ts` (testada em `tests/solicitante-financeiro-offline.test.ts`).
- O app abre sem rede: service worker `public/sw-app.js` (escopo `/app`, só no build; página com rede primeiro, `/assets/` com a cópia guardada primeiro). A última entrada do App do solicitante fica no `localStorage` (`solicitante-entrada`) e é usada quando não há rede.
- Armadilha: o React Query pausa as consultas quando o aparelho está sem rede (`networkMode: "online"`, o padrão), inclusive as que só leem o IndexedDB. Essas consultas usam `networkMode: "always"`.
- O adiantamento continua sendo preenchido no portal (documento de origem, rateio). No app, ele só aparece para acompanhar.
- Foto acima de 1,5 MB é reduzida no aparelho para JPEG de até 2000 px, abaixo do limite de 5 MB da leitura.
- Na simulação da Administração (`?simular=`), o Financeiro fica indisponível: as solicitações são sempre da própria pessoa.
- README do módulo: `docs/Solicitacoes-financeiras/README.md` (rotas, estados, tabelas, RPCs, Edge Functions, variáveis, app e o roteiro do piloto).
- **Pendente do Wagner (não é código):** piloto com 1 equipe de obra por 1 competência mensal e aposentadoria das planilhas dessa equipe.

### Modo demonstração (17/10/2026)
- Pedido do Wagner: apresentar à gerência com dados fictícios antes da fase de cadastros. `npm run demo` (arquivo `.env.demo`: `VITE_DATA_SOURCE=mock`, sem Supabase) e `npm run demo:build` (pasta `dist-demo/`, para hospedagem estática).
- `src/features/financeiro/demo.ts` popula o modo simulado ao iniciar (`src/main.tsx`): 14 solicitações em todas as etapas, com os nomes do mockup aprovado. Também traz cupons, pedidos e NF desenhados em SVG, com a leitura pronta, setores de obra com aprovadores, fundo fixo e o SIENGE ligado em homologação simulada. Roteiro em `DEMONSTRACAO.md`.
- O modo simulado ganhou mapas exportados para a demonstração (`ocrMock`, `regrasItemMock`, `regrasEnvioMock`, `contadorMock`, `decisoes`, `cfg`/`titulos` do SIENGE, `configs`/`mockCadastros`). "Minhas solicitações" filtra pelo usuário do "Ver como". O App do solicitante também tem modo simulado (`entrar`, `podeAcessar`, `meusChamados`, `avisos`, `empreendimentos`).
- Nada do modo demonstração toca o Supabase; com o Supabase configurado (sem `--mode demo`), o portal funciona como antes.

### Página Inicial — resumo financeiro (17/10/2026)
- Pedido do Wagner: o perfil Financeiro via "Nenhum módulo liberado" na Página Inicial. Agora a Home mostra `HomeFinanceiro` (`src/features/financeiro/HomeFinanceiro.tsx`), no visual do resumo de chamados (`.ts-card`). Cada bloco aparece conforme a tela que o perfil abre:
  - **Conferência financeira** (`sf_conferencia`): a conferir (com valor e quantas vencem em até 3 dias), pendência do solicitante, lançamento gerado, pagamento programado, adiantamentos a comprovar (vencidos), pagas no mês, e o painel "Próximos pagamentos" pelo "pagar até";
  - **Aprovações financeiras**: só para quem é aprovador (aguardando você, prazo vencido, com alerta, adiantamentos);
  - **Minhas solicitações financeiras**: todo colaborador; para o Financeiro, só se ele tiver solicitação própria.
- Para o perfil Financeiro, o bloco vem antes de tudo; para os demais, depois dos chamados e dos módulos. O "Nenhum módulo liberado" não aparece mais para quem tem as Solicitações Financeiras.
- Os cards abrem as telas já filtradas: a fila do Financeiro aceita `?etapa=` (em_conferencia, pendencia_solicitante, lancamento_gerado, pagamento_programado, comprovar, paga, todas) e Minhas solicitações aceita `?status=`.
- Migration `20261017170000_imobdesk_sf_perfil_financeiro.sql` (aditiva, aplicada): o perfil `financeiro` abre a tela `sf_conferencia`. A regra de dados não muda: só quem é do setor marcado como financeiro (ou admin) confere.

### PDF dentro do sistema (17/10/2026)
- Pedido do Wagner: o PDF não deve abrir em outra janela. O `ReceiptViewer` agora desenha o PDF na própria tela com o **pdf.js** (`pdfjs-dist` 4.10.38, componente `PdfPaginas`), em `<canvas>`, com zoom, girar e tela cheia, até 20 páginas. A CSP continua com `frame-src 'none'` e `object-src 'none'`, porque não há iframe. O worker sai do próprio portal (`script-src 'self'`) e o `isEvalSupported` fica desligado (sem `unsafe-eval`). A biblioteca só é baixada quando aparece um PDF (chunk separado, cerca de 330 kB + worker).
- Os anexos clicados (linhas, detalhe, preview do formulário, documento de origem, comprovação) abrem no `VisualizadorAnexo`, uma janela dentro do sistema montada nas telas das Solicitações Financeiras. Fora delas (ex.: app), cai na nova aba.
- CSP (`vercel.json`): `connect-src` ganhou `blob:`, para o PDF da demonstração (o arquivo fica em memória). Em produção, o PDF vem da URL assinada do Storage (`*.supabase.co`, já permitido).
- Armadilha: um contêiner com `place-items: center` encolhe o filho mesmo em `display: block`, nos Chrome recentes (justify-self em layout de bloco). O palco do PDF usa `place-items: normal`.

### Demonstração com os setores da produção (17/10/2026)
- Correção pedida pelo Wagner: a demonstração tinha setores inventados. Agora `src/features/atendimento/services/setoresProducao.ts` é a fonte única dos setores simulados, igual à produção (32 setores, mesmos ids e nomes, "recebe chamado" em TI -  Suporte, CFTV, Administrativo e Financeiro; Obra, Obra - Arte Design, Obra - Arte Wave e Obra - Arte Jardim como setores de obra; Financeiro como setor financeiro). Ela é usada por Setores e números, Central Email, Equipes, Gestão de Chamados (cadastros, setor do solicitante, empreendimentos) e Solicitações Financeiras.
- Pessoas fictícias ligadas aos setores (cadastro de Pessoas, classificação Colaborador):
  - TI: Wagner Antunes, Marcos Prado, Paula Nunes (gestora), Diego Ramos;
  - CFTV: Renato Lopes (gestor), Helena Costa, João Silva;
  - Administrativo: Carla Mendes (gestora), Gustavo Reis, Carla Nunes;
  - Financeiro: Fernanda Dias (gestora), Ana Lima, Bruno Rocha.
- Diretor das alçadas: Roberto Alves.
- As solicitações da demonstração saem desses setores e são aprovadas pelo gestor do setor. Como nenhum dos 4 é de obra, o Planejamento aparece como "não exigido". Rascunho novo pega o setor e o gestor de quem está logado (`SETOR_DO_USUARIO`, `GESTOR_DO_SETOR`).

### App Financeiro por perfil, Fase 1 — Banco (23/10/2026)
- Plano: `docs/PLANO-app-financeiro-perfis.md`; mockup aprovado `docs/mockups/app-financeiro-perfis.html` (decisões D1–D5 e P1).
- Migration `20261023150000_imobdesk_sf_acesso_perfil.sql` (aditiva):
  - `sf_eh_gestor(uuid)`: a pessoa está em Gestão do setor (`at_setor_gestores`) de um setor ativo;
  - `sf_eh_aprovador(uuid)`: aprovador ou substituto ativo em `sf_setor_aprovador`, ou substituto por período vigente.
- **Regra única de quem vê o quê:** o bloco `acesso` de `sf_meu_contexto`. O app e o portal leem esse bloco; as RPCs de cada tela continuam conferindo o papel.
  - `reembolso`: tem setor;
  - `fundoFixo`: tem setor e é gestor (`temValorFundo` diz se há valor cadastrado);
  - `adiantamento`: tem setor e não tem comprovação vencida (`adiantamentoBloqueio` traz o motivo);
  - `aprovacoes`: Admin, ou aprovador/substituto **e** permissão `sf_aprovacoes`;
  - `conferencia`: Admin, ou setor financeiro **e** permissão `sf_conferencia`;
  - `cadastros`: Admin.
  - `sf_meu_contexto` também devolve `ehGestor`.
- **Fundo fixo só para gestor (D1, P1).** `sf_rascunho_criar('fundo_fixo')` recusa quem não é gestor. A prestação já criada segue até o fim. `sf_minhas.temFundoFixo` = gestor e valor cadastrado. `sf_cadastros_lista` traz `ehGestor` nos fundos e nos usuários.
- **D3:** a migration marca `sf_aprovacoes` no perfil de cada aprovador ou substituto ativo. Linha que já existe, mesmo desligada, não muda.
- Testes: `tests/db/financeiro-acesso.db.test.ts`.
