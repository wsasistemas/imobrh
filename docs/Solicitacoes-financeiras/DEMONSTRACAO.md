# Demonstração — Solicitações Financeiras

Roteiro para apresentar o módulo à gerência com **dados fictícios**. Nada é gravado no Supabase: tudo roda em memória no navegador. Os cadastros reais (pessoas, setores, aprovadores, fundo fixo, SIENGE) entram depois, na fase de cadastros.

## Link publicado

**https://imobdesk-demo.vercel.app**: portal inteiro com dados fictícios, aberto de qualquer computador ou celular. É um projeto separado na Vercel (`imobdesk-demo`), sem Supabase e sem ligação com o portal de produção. Não aparece em buscadores (noindex).

- Entre com `wagner.antunes@exemplo.com.br` e qualquer senha de 8 caracteres ou mais.
- Para a visão do Financeiro, use "Ver como" › Fernanda Dias, ou entre com `fernanda.dias@exemplo.com.br`.
- App no celular: `https://imobdesk-demo.vercel.app/app/financeiro`.
- Cada navegador tem a sua cópia dos dados. Recarregar a página volta tudo ao início, e é preciso entrar de novo.
- Para republicar depois de um ajuste: `npm run demo:publicar` (Vercel CLI logada na conta do projeto).

## Como abrir no computador (sem internet)

```bash
npm run demo
```

1. Abra `http://localhost:5199`.
2. Entre com `wagner.antunes@exemplo.com.br` e qualquer senha (8 caracteres ou mais).
3. Não recarregue a página durante a apresentação: a sessão e os dados ficam na memória do navegador. Se recarregar, entre de novo; os dados de exemplo voltam ao estado inicial.

Para publicar um link de demonstração (sem Supabase), use `npm run demo:build`. A pasta `dist-demo/` pode ir para qualquer hospedagem estática (ex.: um projeto de preview na Vercel).

No topo, "Ver como" troca o usuário. Os perfis úteis são o seu (Super admin) e **Fernanda Dias · Financeiro**.

## Os dados de exemplo

| Nº | Tipo | De quem | Situação | Para mostrar |
| --- | --- | --- | --- | --- |
| SF-2026-0149 | Reembolso | Wagner | Rascunho | Formulário, leitura do comprovante, checagens |
| SF-2026-0150 | Reembolso | Wagner | Em aprovação (Gestor) | Linha do tempo, decisão do aprovador |
| SF-2026-0143 | Reembolso | Wagner | Devolvida | Comentário do aprovador, reenviar |
| SF-2026-0146 | Reembolso | Wagner | Paga | Fim do fluxo |
| SF-2026-0144 | Fundo fixo | Wagner | Lançamento gerado (título 48211) | Glosa de item, programar pagamento |
| SF-2026-0151 | Adiantamento | Wagner | Aguardando o Gerente | Cadeia de 4 níveis, níveis não exigidos |
| SF-2026-0142 | Adiantamento | Wagner | Comprovação pendente (vence em 5 dias) | Tela de comprovação com a NF |
| SF-2026-0152 | Reembolso | Diego Ramos | Em aprovação, prazo vencido | Escalonamento ao substituto |
| SF-2026-0145 | Fundo fixo | Carla Nunes | Em conferência | Comprovante com valor diferente (R04) |
| SF-2026-0147 | Reembolso | João Silva | Em conferência | Conferir e lançar no SIENGE |
| SF-2026-0153 | Adiantamento | João Silva | Em conferência (R$ 6.000, com Diretor) | Rateio em 2 tarefas, A04, lançamento |
| SF-2026-0139 | Reembolso | João Silva | Pagamento programado | Marcar como paga |
| SF-2026-0148 | Adiantamento | João Silva | Comprovação em conferência (nota menor) | Devolução de R$ 350,00 |
| SF-2026-0138 | Reembolso | Diego Ramos | Reprovada | Motivo da reprovação |

## Roteiro sugerido (15 minutos)

1. **Minhas solicitações:** os cartões de início, os contadores por situação e o histórico.
2. **Reembolso novo** (Nova solicitação › Novo reembolso):
   - "Adicionar por comprovante": anexe uma foto; a leitura preenche data, valor e favorecido e sugere o motivo;
   - mostre as checagens antes de enviar e o aceite eletrônico.
3. **Aprovações:**
   - SF-2026-0152: prazo vencido e escalado;
   - SF-2026-0151: aprove como Gerente e mostre a linha do tempo até Encerrado, com Diretor e Presidente "não exigido para este valor".
4. **Conferência financeira** (troque "Ver como" para Fernanda Dias):
   - fila com os contadores;
   - SF-2026-0145: visualizador do cupom, Declarado × comprovante com a diferença de R$ 18,00 (R04), aceite com observação, glosa;
   - SF-2026-0147: aceite os itens e clique em **Lançamento no SIENGE** (homologação simulada);
   - SF-2026-0139: marcar como paga.
5. **Adiantamento:**
   - SF-2026-0153 na conferência: A04 e o rateio por tarefa;
   - SF-2026-0148: comprovação com nota menor e a devolução;
   - SF-2026-0142, voltando a ser o Wagner: tela de comprovação.
6. **Preview do formulário:** o layout padrão 2026 (A4), com os aceites no lugar das assinaturas.
7. **App no celular:** abra `http://localhost:5199/app/financeiro` com a janela estreita (ou pelo modo celular do navegador, F12). Mostre:
   - "Novo comprovante" com a câmera;
   - a leitura;
   - o rascunho offline: desligue a rede no F12 › Network › Offline, inclua um comprovante e religue para ver a sincronização.
8. **Configurações:**
   - Setores e números › Aprovação financeira: aprovadores e alçadas por setor de obra;
   - Configurações › Integrações › SIENGE: conexão testada e padrões do título.

## O que falta para valer de verdade

Os cadastros reais e as credenciais, na fase de cadastros (lista completa em [README.md](README.md), seção Piloto):

- pessoas com setor e CPF;
- aprovadores por setor;
- fundo fixo de cada pessoa;
- permissão do Financeiro;
- conta de e-mail do Financeiro;
- credenciais e códigos do SIENGE.
