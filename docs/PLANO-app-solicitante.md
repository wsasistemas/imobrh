# Plano — App do solicitante (app do solicitante)

Mockup aprovado em 10/10/2026: [docs/mockups/app-solicitante.html](mockups/app-solicitante.html).
Visual copiado do app "Seu Imóvel" do Superapp, refeito em CSS puro.

## Decisões do Wagner

- Nome do app e do submenu: **App do solicitante**. O submenu fica em Administração.
- Acesso: qualquer **@exemplo.com.br** entra com e-mail e senha. Recebe automaticamente o perfil **Solicitante**, que só vê o app.
- Ao entrar, a pessoa escolhe o departamento: **TI**, **Administração** ou **CFTV**. Os departamentos são os Setores cadastrados.
- Nome, e-mail e telefone corporativo vêm do login e do cadastro de Pessoas. A pessoa não digita esses dados.
- Botão grande **ABRIR CHAMADO**. A tela tem tipo de serviço (árvore de Serviços do setor), descrição e anexo (tirar foto ou arquivo).
- Quadrados: Meus chamados, Avisos, Soluções, Falar no WhatsApp, Meu perfil, Trocar departamento.

## Como funciona por dentro

- **Rota `/app`**, fora do layout do portal e pensada para celular. Sem sessão, mostra o login do próprio app. O login é o mesmo gateway seguro do portal.
- **Primeiro acesso:** "Primeiro acesso / Esqueci a senha" cria a conta no Auth, se ela ainda não existir, e manda o link para criar a senha. A conta é criada só para @exemplo.com.br, e o envio passa pelo bloqueio por tentativas.
- **Primeira entrada no app:** `cd_entrar()` cria a linha em `usuarios` com o perfil `solicitante` e liga a pessoa em `at_pessoas` pelo e-mail.
  - Quem já tem outro perfil (operador, admin…) continua com ele e também usa o app.
- **Quem só tem o perfil Solicitante**, ou ainda não tem acesso ao portal, é levado ao `/app` quando tenta abrir o portal.
- **Ticket aberto pelo app:**
  - Entra com `origem = intranet`, `recebido_em = App do solicitante`, no setor escolhido.
  - Aparece para a equipe como qualquer outro ticket. A resposta pública da equipe aparece no app.
- **Anexos:** bucket privado `solicitante`, na pasta `<id do usuário>/`. A pessoa só grava e lê na própria pasta, e a equipe de chamados lê tudo.
- **Segurança:** todas as funções `cd_*` são `security definer`. Elas exigem sessão confiável e e-mail @exemplo.com.br, e a pessoa só vê os próprios tickets (pelo cadastro em Pessoas ou por ter criado o ticket).

## Fases

### Fase 1 — Banco (migração `20261010100000_imobdesk_solicitante.sql`, só aditiva)
- [x] Perfil `solicitante` (sistema, não pode ser excluído)
- [x] Colunas de app em `at_setores`: `cd_visivel`, `cd_icone`, `cd_descricao`, `cd_ordem`
- [x] Tabelas `cd_config` (quadros, WhatsApp, boas-vindas), `cd_avisos`, `cd_solucoes`, `cd_vistos`
- [x] Bucket `solicitante` (10 MB, privado) e políticas por pasta do usuário
- [x] Funções do app:
  - `cd_entrar`, `cd_perfil_salvar`, `cd_servicos`, `cd_inicio`;
  - `cd_ticket_criar`, `cd_meus_chamados`, `cd_chamado`, `cd_chamado_responder`, `cd_chamado_confirmar`;
  - `cd_solucoes_listar`, `cd_avisos_listar`.
- [x] Funções da Administração: `cd_admin_painel`, `cd_admin_setor_salvar`, `cd_admin_config_salvar`, `cd_aviso_salvar`, `cd_aviso_excluir`, `cd_solucao_salvar`, `cd_solucao_excluir`
- [x] Simular solicitante: as funções de leitura aceitam `p_como`, só para Admin ou para quem tem a permissão App do solicitante
- [x] Permissão `gestao_atendimento_solicitante`
- [x] Ensaio no Supabase local:
  - solicitante novo;
  - abrir chamado com anexo;
  - ver só os próprios tickets;
  - responder;
  - confirmar ou reabrir;
  - simular sem permissão é recusado.

### Fase 2 — Login e primeiro acesso
- [x] Gateway: no "recover", criar a conta do Auth quando ela não existir (só @exemplo.com.br)
- [x] Teste do gateway cobrindo a criação da conta
- [x] O portal manda para `/app` quem tem só o perfil Solicitante ou ainda não tem acesso ao portal

### Fase 3 — App `/app`
- [x] Casca com o visual do mockup (CSS próprio `solicitante.css`) e login do app
- [x] Escolher departamento, com cartão de identificação
- [x] Início do departamento:
  - botão ABRIR CHAMADO e carrossel de avisos;
  - quadrados e bloco "Em andamento".
- [x] Abrir chamado:
  - tipo de serviço em níveis e descrição;
  - dica de solução;
  - tirar foto ou anexar arquivo;
  - urgente.
- [x] Confirmação com número e prazo
- [x] Meus chamados (abertos, resolvidos, todos) e detalhe:
  - histórico, responder com anexo;
  - "Ficou bom? Sim / Não".
- [x] Avisos, Soluções e Meu perfil (telefone corporativo)
- [x] Barra amarela "Modo simulação", só leitura

### Fase 4 — Administração › App do solicitante
- [x] Submenu no `menuRegistry`, com a página e a permissão
- [x] Bloco "O app": endereço, copiar, abrir, QR e simular solicitante
- [x] Departamentos no app: liga/desliga, ícone e texto
- [x] Quadros liga/desliga e número do WhatsApp
- [x] Avisos (carrossel), com período
- [x] Soluções publicadas
- [x] Linha do tempo do ticket mostra os anexos de qualquer canal (antes só os do WhatsApp)

### Fase 5 — Conferência
- [x] `npm run build` e testes passando
- [x] Telas conferidas no navegador, em largura de celular
- [x] Comandos de produção para o Wagner: migração, deploy do `imobdesk-auth`, commit (entregues na conversa de 10/10/2026)

## Conferência (10/10/2026)

- Ensaio SQL no Supabase local (`set local role authenticated`):
  - 1º acesso vira Solicitante e ganha pessoa;
  - anexo de outro usuário é recusado;
  - outra pessoa não vê o chamado;
  - simular sem permissão é recusado;
  - `ch_ticket_criar` continua fechado para o Solicitante;
  - "Não, continua" reabre (status Reaberto) e "Sim" fecha;
  - storage: cada um lê só a própria pasta.
- Ensaio no navegador (playwright-core + Chrome, banco local), 390 px e 1366 px:
  - login e primeiro acesso;
  - departamentos e início;
  - abrir chamado com foto e confirmação (ticket `intranet / App do solicitante`, 1 anexo);
  - detalhe resolvido, reabrir e responder;
  - meus chamados, perfil, soluções e avisos;
  - Administração › App do solicitante e simulação;
  - o solicitante que abre /home vai para /app.
- `npm run build`, `oxlint` e `vitest` (140 testes) passando.

## Pendências fora do código (Wagner)

- Cadastrar os setores **Administração** e **CFTV**, se ainda não existirem, com os serviços marcados para o canal **Portal**. A migração já liga TI, Administração e CFTV no app quando os nomes batem.
- Confirmar na Central (Permissões por aplicativo) que o cadastro de Solicitante conta como "cadastro próprio no app". Se não contar, os solicitantes veem o pop-up "Acesso bloqueado".
