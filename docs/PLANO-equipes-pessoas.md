# Plano de ação — Equipes (Usuários) e Pessoas (Configurações)

Pedido (06/10/2026):
1. Dentro de **Usuários**, uma aba **Equipes**: cadastrar o nome da equipe e vincular o usuário.
2. No menu **Configurações**, o menu **Pessoas**: cadastro dos solicitantes que abrem chamados. Ele é
   **criado sozinho** quando chega um e-mail, para o sistema reconhecer a pessoa e montar o **histórico** dos próximos chamados.
   Referência: o cadastro de pessoas da Movidesk.

Mockup para aprovação: [`docs/mockups/equipes-pessoas.html`](mockups/equipes-pessoas.html) (o seletor no topo troca a tela).
Fluxo: aprovar o mockup → fases com checklist binário. Migrations só aditivas, ensaiadas em `begin … rollback`.

---

## 1. Análise do pedido

### Equipes
- A tela Usuários já tem abas, mas elas são **filtros de situação** (Todos, Ativos, Inativos, Convites).
  Equipes é outro cadastro, então entra como **seção** da tela: **Usuários | Equipes**, no mesmo
  padrão de Integrações. A rota é `/configuracoes/usuarios/equipes`.
- **Hoje o "setor" já agrupa atendentes** (Fila e horários: cada atendente pertence a um setor). A equipe é um
  nível abaixo: um grupo dentro do setor (ex.: Financeiro › "Cobrança", "2ª via e boletos"), que servirá para
  direcionar o chamado no processo de ticket. Por isso, na proposta:
  - a equipe **pertence a um setor**, ou fica "sem setor" quando é uma equipe interna;
  - um usuário pode estar em **várias equipes**, como na Movidesk;
  - a equipe tem um **líder** (opcional).
- O vínculo aparece nos dois lados: na seção Equipes (membros) e no cadastro do usuário (campo **Equipes**,
  no painel Editar usuário que já existe).

### Pessoas
- **Pessoas são os clientes** (quem abre chamado). Os **agentes** continuam sendo os **Usuários**. Por isso o
  "Perfil Agente/Cliente" da Movidesk vira só "Cliente".
- **O que entra da tela da Movidesk:**
  - Tipo (Pessoa, Empresa, Departamento);
  - Nome fantasia/Nome, Razão social, Ramo de atividade;
  - Habilitado/Desabilitado;
  - CPF/CNPJ, Cód. Ref., Cód. Ref. adicional;
  - Classificação, Imagem;
  - as abas Contatos, Relações, Sinalizadores, Observações e Anexos;
  - os botões Excluir, Cancelar, Mesclar pessoa, Salvar e criar um novo e Salvar.
- **O que fica de fora, por enquanto:**
  - Usuário/Senha e Perfil de acesso: servem a um portal do cliente, que não existe;
  - as abas Projetos, Configurações regionais e Assinatura.
- **Entram coisas novas:**
  - aba **Histórico de chamados**, juntando todos os canais e as pessoas relacionadas;
  - campo **Domínios de e-mail** da empresa;
  - **Origem** (Manual, E-mail, WhatsApp).
- **Autocadastro (o coração do pedido):**
  - **E-mail (F4 das Contas de e-mail):** quando chega um e-mail, o sistema procura o remetente nos contatos. Se não acha, cria a pessoa (nome do cabeçalho `From`, e-mail como contato principal, origem "E-mail"). Se o domínio do remetente for de uma Empresa cadastrada, a pessoa já nasce ligada a ela. Remetentes da lista "ignorar" da conta não viram pessoa.
  - **WhatsApp (fase do chat):** pelo mesmo raciocínio, o telefone do cliente identifica ou cria a pessoa. É proposta; confirmar.
  - O contato (e-mail ou telefone) é **único**: identifica uma pessoa só. Se o cliente escreveu pelos dois canais e virou duas fichas, o **Mesclar pessoa** junta tudo (contatos, relações, anexos e histórico).
- **Histórico:**
  - `at_conversas` (WhatsApp) ganha `pessoa_id`;
  - `at_email_recebidos` ganha `pessoa_id`;
  - o ticket, quando existir, aponta para a pessoa;
  - a aba Histórico lista tudo isso.
- **Cód. Ref.** é o código do cliente no TOTVS RM. A sincronização com o RM pode vir depois, porque o portal já tem a conexão TOTVS.

## 2. Modelo de dados

**Equipes** (schema `imobdesk`):
- `at_equipes`: `id`, `nome` (único por setor), `setor_id` (opcional), `descricao`, `lider_id` → usuarios, `ativa`, auditoria.
- `at_equipe_membros`: `equipe_id` + `usuario_id` (N:N).
- RPCs:
  - `at_equipes_lista()`;
  - `at_equipe_salvar(p)`, com os membros;
  - `at_usuario_equipes_salvar(usuario, equipes[])`, chamada pelo painel do usuário.
- Quem altera: quem tem `manage_users` (a mesma permissão de Usuários).

**Pessoas:**
- `at_pessoas`:
  - `id`, `tipo` (pessoa | empresa | departamento), `nome`, `razao_social`, `ramo`;
  - `documento` (CPF/CNPJ só dígitos, único quando preenchido, com dígito verificador conferido);
  - `cod_ref`, `cod_ref_adicional`, `classificacao`, `dominios text[]`, `sinalizadores text[]`, `observacoes`, `avatar_path`, `habilitada`;
  - `origem` (manual | email | whatsapp | importacao), `origem_detalhe` (ex.: a conta que recebeu);
  - `ultimo_contato_em` e auditoria.
- `at_pessoa_contatos`: `pessoa_id`, `tipo` (email | telefone | whatsapp), `valor` normalizado (e-mail minúsculo, telefone E.164), `principal`, **único por (tipo, valor)**.
- `at_pessoa_relacoes`: `pessoa_id` → `empresa_id` (pessoa ↔ empresa/departamento), `cargo`.
- `at_pessoa_anexos`: metadados. O arquivo vai para o bucket privado `atendimento-pessoas`.
- Colunas novas: `pessoa_id` em `at_conversas` e em `at_email_recebidos`.
- RPCs:
  - `at_pessoas_lista(filtros, página)`;
  - `at_pessoa_detalhe(id)`, com contatos, relações e histórico;
  - `at_pessoa_salvar(p)`;
  - `at_pessoa_mesclar(fica, sai)`;
  - `at_pessoa_excluir(id)`: só sem histórico, senão desabilitar;
  - `at_pessoa_identificar(tipo, valor, nome, contexto)`: **service role**, usada pela leitura de e-mail e pelo webhook do WhatsApp. Acha a pessoa ou cria, e liga à empresa pelo domínio.
- Quem vê e altera: permissão nova `manage_pessoas` (menu Pessoas em Configurações). O atendente vê a pessoa dentro do chamado.

## 3. Fases

> **Decisões fechadas (06/10/2026, mockup aprovado):**
> - equipe dentro de setor (ou sem setor);
> - usuário em N equipes;
> - autocadastro por e-mail e WhatsApp;
> - ligação à empresa pelo domínio (exceto domínios públicos);
> - portal do cliente depois.

### F1 — Telas ✅ (06/10/2026)
- **Usuários | Equipes:** lista, painel Nova/Editar equipe (nome, setor, descrição, membros, líder, ativa) e o campo **Equipes** no painel Editar usuário.
- **Configurações › Pessoas:**
  - lista com busca (nome, e-mail, telefone, CPF/CNPJ, Cód. Ref.) e filtros de tipo e origem;
  - formulário com 7 abas e a imagem;
  - Mesclar pessoa.

Feito:
- `menuRegistry`:
  - seção `manage_users_equipes` (filha de Usuários) e menu `manage_pessoas` em Configurações;
  - a tela Usuários virou `UsuariosSecoes` (Usuários | Equipes), e as abas de situação continuam iguais.
- Telas em `src/features/cadastros/pages`:
  - `Equipes.tsx` (lista + painel);
  - `EquipesDoUsuario.tsx` (campo no Editar usuário, grava na hora);
  - `Pessoas.tsx` (lista paginada + ficha com 7 abas, imagem, anexos e Mesclar).
- Serviços Supabase + mock.

Checklist:
- [x] seção Equipes e menu Pessoas aparecem conforme a permissão (atendente não abre Pessoas)
- [x] Equipes: criar, editar, desativar e excluir; equipe duplicada no setor é recusada; o vínculo aparece no Editar usuário
- [x] Pessoas:
  - o tipo troca os campos;
  - a busca acha por telefone;
  - CPF inválido e contato de outra pessoa são recusados;
  - Mesclar junta as fichas.
- [x] Playwright (Edge) em desktop e 390 px sem erro de console; typecheck, lint, build e 20 testes ok

### F2 — Banco de Equipes e Pessoas ✅ (06/10/2026)
- 2 migrations: `…_equipes` e `…_pessoas`, com tabelas, RPCs, RLS, auditoria e o bucket de anexos.

Migrations `20261006190000_equipes`, `…190100_pessoas` e `…190200_equipes_setores`, aplicadas.

Checklist:
- [x] ensaio com rollback e aplicação, sem resíduo
- [x] recusados: equipe duplicada no setor, contato duplicado, CPF inválido, domínio público como domínio de empresa, excluir com histórico, anexo fora da pasta da pessoa; sem permissão → FORBIDDEN; leitura direta das tabelas negada
- [x] CPF/CNPJ com dígito verificador no banco e no front (o mesmo resultado; o CNPJ do print da Movidesk é válido)
- [x] mesclar move contatos, relações, anexos e histórico e apaga a ficha incorporada (conferido por SQL)
- [ ] gravação pela tela no banco real (falta o login real do Wagner)

### F3 — Autocadastro e histórico ✅ no banco; ligação aos canais pendente
- `at_pessoa_identificar` ligado à leitura de e-mail (F4 das Contas de e-mail) e, quando vier, ao webhook do WhatsApp.
- Aba Histórico lendo conversas, e-mails e, depois, tickets.

Checklist:
- [x] `at_pessoa_identificar` (só service role):
  - e-mail novo cria a pessoa com origem "E-mail";
  - o segundo e-mail dela reconhece a mesma pessoa;
  - o WhatsApp cria com origem "WhatsApp";
  - o número já cadastrado como "telefone" também é reconhecido (ensaio).
- [x] remetente de domínio de empresa cadastrada nasce relacionado a ela; gmail não liga (ensaio)
- [x] histórico junta WhatsApp e e-mail, inclusive das pessoas da empresa (ensaio)
- [ ] chamar `at_pessoa_identificar` na leitura de e-mail (F4 das Contas de e-mail), respeitando a lista "ignorar" da conta
- [ ] chamar `at_pessoa_identificar` no webhook do WhatsApp (fase do chat)

## 4. Decisões para o Wagner (na aprovação do mockup)

1. **Equipe dentro de setor:** a equipe pertence a um setor (recomendado) ou é independente do setor?
2. **Usuário em várias equipes** (recomendado, como na Movidesk) ou numa só?
3. **Autocadastro também pelo WhatsApp** (telefone), além do e-mail? Recomendado.
4. **Ligar à empresa pelo domínio do e-mail** (ex.: tudo de @casanovamoveis.com.br vai para a Casa Nova)? Recomendado, exceto domínios públicos (gmail, hotmail, outlook…), que nunca ligam.
5. **Usuário/Senha do cliente** (portal do cliente para abrir e acompanhar chamados): fica para depois. Ok?
