# Solicitações Financeiras — README do módulo

Reembolso de despesas, fundo fixo de caixa (caixinha) e adiantamento de numerário no Imobdesk, da solicitação ao lançamento no SIENGE. Regras de negócio e decisões ficam em [CONTEXTO.md](CONTEXTO.md) (a seção 9 prevalece). Requisitos originais em [PRD.md](PRD.md). Mockup aprovado em [docs/mockups/solicitacoes-financeiras.html](../mockups/solicitacoes-financeiras.html).

## Onde fica cada coisa

| Parte | Caminho |
| --- | --- |
| Telas do portal | `src/features/financeiro/` (rotas em `src/pages/SolicitacoesFinanceiras.tsx`, menu em `src/config/menuRegistry.ts`) |
| Aprovadores e configuração por setor | Gestão de Atendimento › Setores e números › aba **Aprovação financeira** (`src/features/financeiro/AprovacaoFinanceira.tsx`) |
| Integração SIENGE | Configurações › Integrações › **SIENGE** (`src/features/financeiro/IntegracaoSienge.tsx`) |
| App no celular | App do solicitante › **Financeiro** (`/app/financeiro`, `src/features/solicitante/financeiro/`) |
| Banco | `supabase/migrations/20261017100000` a `20261017160000_imobdesk_sf_*.sql` |
| Edge Functions | `supabase/functions/imobdesk-sf-email`, `-sf-ocr`, `-sf-sienge` |
| Regras puras (testadas) | `supabase/functions/_shared/sf/ocr.ts`, `sienge.ts`, `adiantamento.ts`; `src/features/financeiro/cadeia.ts`; `src/features/solicitante/financeiro/offline.ts` |

## Rotas

| Tela | Rota | Quem |
| --- | --- | --- |
| 1 Minhas solicitações | `/financeiro/solicitacoes` | Colaborador |
| 2, 3, 11 Reembolso / Fundo fixo (com leitura de comprovantes) | `/financeiro/solicitacoes/nova/reembolso`, `…/fundo-fixo` → `/financeiro/solicitacoes/:id` | Colaborador |
| 13 Adiantamento | `/financeiro/solicitacoes/nova/adiantamento` | Colaborador |
| 15 Comprovação do adiantamento | `/financeiro/solicitacoes/:id/comprovacao` | Colaborador |
| 5 Aprovações | `/financeiro/aprovacoes` | Aprovador |
| 6 e 14 Detalhe e decisão | `/financeiro/solicitacoes/:id` | Aprovador, colaborador |
| 8 Fila do Financeiro | `/financeiro/conferencia` | Financeiro (permissão `sf_conferencia`) |
| 9 Conferência item a item / comprovação | `/financeiro/conferencia/:id` | Financeiro |
| 10 Preview do formulário | modal (botão "Pré-visualizar" / "Ver formulário") | Todos que veem |
| Cadastros financeiros (fundo fixo, motivos, regras) | `/financeiro/cadastros` | Admin |
| 4 e 12 App | `/app/financeiro` (início), `/app/financeiro/s/:id` (rascunho no portal), `/app/financeiro/l/:id` (rascunho no aparelho), `…/comprovante` (câmera) | Colaborador |

## Estados

`rascunho → em_aprovacao → em_conferencia → lancamento_gerado → pagamento_programado → paga` (reembolso e fundo fixo terminam em `paga`). Desvios: `devolvida` (volta ao colaborador; o reenvio recomeça do nível 1 em novo ciclo), `reprovada`, `cancelada` (até a 1ª aprovação), `pendencia_solicitante` (o Financeiro pediu ajuste de item).

Adiantamento, depois de `paga`: `comprovacao_pendente → comprovacao_em_conferencia → encerrada`; nota menor que o adiantado → `devolucao_pendente → encerrada`. Comprovação vencida marca `status_comprovacao = vencida` e bloqueia novos adiantamentos.

## Tabelas (schema `imobdesk`)

RLS ligada em todas, com `revoke all` de `anon`, `public` e `authenticated`: o acesso é só pelas RPCs `security definer`.

| Tabela | Conteúdo |
| --- | --- |
| `sf_solicitacao` | Cabeçalho (tipo, número SF-AAAA-NNNN, status, ciclo, competência/período, totais, glosa, aceite com IP e navegador, pagar até, SIENGE e todos os campos do adiantamento) |
| `sf_item` | Linhas (data, valor, favorecido, motivo, origem manual/ocr, status da conferência, glosa). No adiantamento, uma linha única com o valor |
| `sf_anexo` | Arquivos no bucket `sf-comprovantes` (`<usuário>/<solicitação>/<arquivo>`), SHA-256, leitura (`ocr_status`, `ocr_json`), finalidade (comprovante, documento_origem, comprovacao) |
| `sf_aprovacao` | Cadeia congelada no envio (ciclo, nível, papel, aprovador, substituto, status, prazo) |
| `sf_regra`, `sf_regra_resultado` | Regras R01–R10 e A01–A07 (parâmetros editáveis) e o resultado gravado no envio |
| `sf_evento` | Histórico imutável (gatilho impede alteração) |
| `sf_setor_aprovador` | Aprovadores por setor e tipo (reembolso/fundo fixo; adiantamento com papel e condição) |
| `sf_fundo_fixo`, `sf_categoria_motivo`, `sf_numerador` | Valor do caixinha por pessoa, motivos, numeração |
| `sf_substituicao` | Substituto por período |
| `sf_email_fila` | Fila de e-mails |
| `sf_rateio`, `sf_comprovacao` | Rateio por tarefa e comprovação do adiantamento |
| `sf_sienge_config` | Registro único da integração (senha no Vault) |

Colunas `sf_*` em `at_setores`: setor de obra, financeiro, modo e prazo de aprovação, ação no prazo vencido, centro de custo padrão, prazo de comprovação, ação na comprovação vencida, limite de adiantamentos em aberto.

## RPCs (todas `security definer`)

- Cadastros: `sf_meu_contexto`, `sf_setores_resumo`, `sf_setor_config_obter/salvar`, `sf_usuarios_opcoes`, `sf_cadastros_lista`, `sf_fundo_fixo_salvar`, `sf_categoria_salvar`, `sf_regra_salvar`, `sf_solicitacoes_listar`.
- Formulário: `sf_rascunho_criar`, `sf_rascunho_salvar`, `sf_adiantamento_salvar`, `sf_anexo_registrar`, `sf_anexo_remover`, `sf_checagens`, `sf_enviar`, `sf_cancelar`, `sf_detalhe`, `sf_minhas`.
- Leitura: `sf_fila_leitura`, `sf_linha_do_comprovante`; para a Edge Function: `sf_ocr_pedido`, `sf_ocr_registrar` (só service_role).
- Aprovação: `sf_aprovacoes_fila`, `sf_detalhe_extra`, `sf_decidir_aprovacao`, `sf_substituto_definir/remover`.
- Conferência: `sf_conferencia_fila`, `sf_conferencia_itens`, `sf_decidir_item`, `sf_pedir_ajuste`, `sf_pendencia_anexar`, `sf_pendencia_responder`, `sf_programar_pagamento`, `sf_marcar_paga`.
- Adiantamento: `sf_comprovacao_anexar`, `sf_comprovacao_anexo_remover`, `sf_comprovacao_checar`, `sf_enviar_comprovacao`, `sf_decidir_comprovacao`, `sf_confirmar_devolucao`.
- SIENGE: `sf_sienge_config_ler/salvar`, `sf_sienge_senha_salvar`, `sf_sienge_pode_usar`, `sf_sienge_situacao`, `sf_lancamento_pedido`, `sf_lancamento_saldo_pedido`, `sf_pdf_dados`; para a Edge Function: `sf_sienge_credenciais`, `sf_sienge_teste_registrar`, `sf_lancamento_registrar`, `sf_lancamento_saldo_registrar` (só service_role).
- Jobs (pg_cron): `sf_prazos_job` (30 min: lembrete com 25% do prazo e escalonamento), `sf_comprovacao_job` (diário 08:00 de Brasília: D-7, D-1 e vencida), e-mail a cada 5 min (`sf_email_para_enviar` / `sf_email_resultado`).

Toda função nova precisa de `revoke execute … from public, anon` (o `tests/db/security.db.test.ts` confere que `anon` não executa nenhuma).

## Edge Functions

| Função | JWT | Faz |
| --- | --- | --- |
| `imobdesk-sf-email` | não (chave do cron no Vault, `x-atendimento-chave`) | Envia a fila de e-mails pela conta Gmail do setor financeiro (Central Email) |
| `imobdesk-sf-ocr` | sim | Lê comprovante, documento de origem ou NF da comprovação (API da Anthropic, modelo `claude-opus-5-5`, JSON com esquema). Só transcreve; campo abaixo de 80% de legibilidade fica vazio |
| `imobdesk-sf-sienge` | sim | `testar`, `listas`, `lancar`, `lancar_saldo`, `pdf` (API REST do SIENGE, Basic; PDF com `pdf-lib`) |

Publicar: `npx supabase functions deploy <nome> --project-ref ikvjaowvpvxojvcfwnct --use-api` (a de e-mail com `--no-verify-jwt`).

## Variáveis e segredos

| Nome | Onde | Uso |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Secrets das Edge Functions | Leitura dos comprovantes |
| `PORTAL_URL` (opcional) | Secrets das Edge Functions | Completa os links dos e-mails |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | automáticas | Clientes das funções |
| Senha da API do SIENGE | Vault (pela tela de Integrações) | Nunca volta para a tela |
| Chave do cron de e-mail | Vault (`at_email_cron_chave`) | Chamada do pg_cron |

Nenhum segredo fica no repositório nem no frontend.

## App no celular (App do solicitante › Financeiro)

- Mesmas RPCs do portal. Reembolso e fundo fixo pelo celular; o adiantamento é preenchido no portal (documento de origem e rateio), e o app mostra a situação dele.
- **Câmera:** "Novo comprovante" abre a câmera traseira (`capture="environment"`). Foto acima de 1,5 MB é reduzida para JPEG de até 2000 px antes de subir.
- **Com rede:** a foto sobe na fila de leitura, a leitura copia data, valor e favorecido (campos em azul com a legibilidade) e sugere o motivo. "Incluir no formulário" cria a linha.
- **Sem rede:** o rascunho, com as fotos, fica no IndexedDB do aparelho (`solicitante-sf`). Quando a rede volta, o app envia sozinho: cria o rascunho, grava as linhas e anexa as fotos. Se cair no meio, a próxima tentativa continua de onde parou. O envio para aprovação, com o aceite, é feito depois, com rede.
- **Abrir sem rede:** o service worker `public/sw-app.js` (escopo `/app`, registrado só no build) guarda a página e os arquivos do app. A última entrada do App do solicitante fica no aparelho para o app abrir sem rede. O portal não é afetado.

## Testes

- `npm test`: regras puras (cadeia, leitura, SIENGE, adiantamento, rascunho offline).
- `npm run test:db`: Postgres embarcado com todas as migrations (`tests/db/financeiro*.db.test.ts`, portas 54420–54426).
- Verificação visual: `VITE_DATA_SOURCE=mock` (o portal tem modo simulado; o App do solicitante não, então o app foi verificado interceptando a entrada no navegador).

## Piloto (Fase 6) — roteiro

1. **Escolher a equipe piloto:** 1 setor de obra com gestor ativo, por uma competência mensal inteira.
2. **Cadastros antes de começar:**
   - todas as pessoas do setor com setor e CPF em Pessoas;
   - aprovadores na aba Aprovação financeira (reembolso/fundo fixo e os 4 níveis do adiantamento);
   - valor do fundo fixo de quem tem caixinha;
   - permissão `sf_conferencia` no perfil do Financeiro;
   - conta Gmail do Financeiro na Central Email;
   - SIENGE em homologação (credenciais, empresa, tipo de documento, indexador, planos e centro de custo), com "Testar conexão" ok.
3. **Durante o mês:** o colaborador lança pelo app no momento da despesa, inclusive sem rede. O Financeiro confere e lança no SIENGE de homologação. Acompanhar a fila de e-mails e os avisos de prazo.
4. **Medir:**
   - acerto da leitura em data e valor (meta ≥ 90% em 20 comprovantes reais);
   - tempo entre o envio e o pagamento;
   - quantidade de devoluções e pendências;
   - títulos criados sem duplicar.
5. **Aposentar as planilhas** da equipe piloto ao fim da competência, se as metas forem cumpridas. Depois disso, trocar o SIENGE para produção e ampliar para os demais setores.
