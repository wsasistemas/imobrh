# Plano — Imobdesk (WSA Sistemas): Supabase ikvj, multiempresa e visual Apple HIG

Mockup: [mockups/apple-hig-imobdesk.html](mockups/apple-hig-imobdesk.html) (v2, 23/10/2026).
Status: mockup v2 aprovado, foto B (suporte) escolhida e P1 a P3 respondidos em 23/10/2026. Fases 0 a 2 em andamento.

## Decisões do Wagner (23/10/2026)

| # | Decisão |
|---|---|
| Banco | Supabase **ikvj** (`ikvjaowvpvxojvcfwnct`), o mesmo do imobdocerias e do Imobimoveis, no schema **`imobdesk`**. |
| Dados | Só a estrutura: o schema nasce vazio. O 1º admin entra por script. |
| Marca | **Imobdesk · WSA Sistemas**. O app de quem abre chamado se chama "App do solicitante". Nenhuma menção à empresa de origem do código. |
| Login | Qualquer e-mail liberado: o acesso vem do cadastro na empresa, não do domínio. |
| Multiempresa | Várias empresas contratam o sistema. **P1:** coluna `tenant_id` em todas as tabelas. **P2:** só o Super admin da WSA cria empresa. **P3:** um login pode estar em várias empresas, com seletor no topo. |
| Módulos mantidos | Solicitações Financeiras + SIENGE, TOTVS RM + Consultas SQL e Zenvia WhatsApp. |
| Saem | Movidesk inteiro (menu, telas, integração, Edge Function, agendamento e tabelas) e a leitura do site de empreendimentos. |
| D2/D3 | Lateral clara no estilo do Mac. Tema claro é o padrão; o usuário escolhe Escuro ou Automático no botão ☾ do topo, e a escolha fica salva no usuário. |
| D4 | Paleta WSA (tokens do Imobimoveis): azul `oklch(0.55 0.11 250)`, abóbora `oklch(0.8 0.11 62)`, fundo coral `oklch(0.972 0.016 40)`, escuro marinho `oklch(0.19 0.02 255)`, menu ativo em degradê azul → abóbora. |
| D5 | Login `.mpl-*` com a foto **B (suporte)**, colorida, nos tons do Imobimoveis (véu azul, selo abóbora, botão em degradê). |

## Como ficou a separação por empresa

- `imobdesk.empresas` (com a empresa **Modelo**, que guarda a configuração inicial), `admins_wsa` e `usuario_preferencias` (empresa aberta e tema).
- Toda tabela do app tem `tenant_id not null default imobdesk.empresa_atual()`. Chaves primárias, únicas e estrangeiras incluem `tenant_id`. Por isso a empresa nova recebe a Modelo com os **mesmos ids**, e as configurações em JSON continuam válidas.
- RLS forçada com a policy restritiva `imobdesk_tenant` em todas as tabelas. Tabelas e funções são do papel `imobdesk_dono`, que não ignora a RLS: dentro das ~500 funções `security definer` a empresa também é filtrada.
- `empresa_atual()`, em ordem:
  1. contexto do servidor (`imobdesk.empresa_id`);
  2. cabeçalho `x-empresa-id` (Edge Function com service_role);
  3. empresa escolhida no topo;
  4. primeiro cadastro ativo;
  5. domínio do e-mail (solicitante sem cadastro).
- Ficam com o `postgres` só as funções de empresa, o hook do Auth e `encerrar_sessao` (a única que escreve no `auth`). Ela filtra a empresa de forma explícita.
- Segredos de cada empresa no Vault com o id da empresa no nome (Zenvia, Google, OpenWA, TOTVS e integrações).
- Agendamentos que chamam funções do banco rodam uma vez por empresa (`para_cada_empresa`).
- Migration nova que cria tabela ou função termina com `select imobdesk.aplicar_multiempresa();`.

## Fases (checklist binário: feito / não feito)

### Fase 0 — Preparação
- [x] Branch `feat/imobdesk-wsa`; remoto `wsasistemas/imobdesk` e autor dos commits `WSA Sistemas`.
- [x] `supabase/migrations` passa a ser só o schema `imobdesk`. O histórico de origem fica no repositório original.
- [x] `.env.local` e `supabase/config.toml` apontando para o ikvj; o link antigo do CLI foi apagado.

### Fase 1 — Schema `imobdesk` no ikvj (estrutura)
- [x] 80 migrations convertidas: schema, Edge Functions, agendamentos e buckets com prefixo `imobdesk`; Movidesk fora; sem trava de domínio.
- [x] Cadastro na Central de acessos do ikvj (`acessos.aplicativos`, controle desligado).
- [x] Nada criado no `public`; `anon` sem `USAGE`; schema acrescentado a `pgrst.db_schemas` sem tirar os outros.
- [x] Ensaio num Postgres 17 de verdade (`npm run test:db`): aplica do zero, sem erro.
- [x] Pacote do SQL Editor: `supabase/sql-editor/1_estrutura_parte1..4.sql` (`node scripts/montar-sql-editor.mjs`).
- [x] Aplicado no ikvj pelo SQL Editor (23/10/2026, partes 1 a 4 e 2_primeiro_admin).

### Fase 2 — Multiempresa
- [x] `empresas`, `admins_wsa`, `usuario_preferencias`, `empresa_atual()`, `minhas_empresas()`, `trocar_empresa()`, `criar_empresa()`, `listar_empresas_wsa()`, `salvar_tema()` e `minhas_preferencias()`.
- [x] `tenant_id` nas tabelas do app, com chaves compostas, RLS forçada e funções do `imobdesk_dono`.
- [x] Segredos por empresa no Vault; agendamentos de banco por empresa.
- [x] Ensaio de isolamento (16 testes): empresa A não vê a B por tabela nem por RPC; Vault, cabeçalho da Edge Function, seletor de empresa e solicitante por domínio.
- [x] Script do 1º Super admin e da 1ª empresa: `supabase/sql-editor/2_primeiro_admin.sql`.
- [ ] Numeração de ticket por empresa (hoje a sequência é única: o nº continua único, só não começa em 1 em cada empresa).

### Fase 3 — Edge Functions e agendamentos
- [x] 15 funções renomeadas para `imobdesk-*`; `movidesk` e a do site saem; gateway de login sem domínio fixo (`dominio_permitido`).
- [x] Empresa em toda chamada (`_shared/empresa.ts`):
  - `portalContext` usa a empresa de quem chama;
  - os ciclos do pg_cron (e-mail, IA, WhatsApp e e-mail das Solicitações) percorrem as empresas;
  - Zenvia acha a empresa pelo número ou pela mensagem; OpenWA, pela sessão; retorno do Google, pelo `state`.
  - O cliente da empresa filtra `tenant_id` em todo select, update e delete direto nas tabelas (o `service_role` ignora a RLS).
  - Migration `…000200_imobdesk_empresa_edge` + `supabase/sql-editor/atualizacao_20261024000200.sql`.
- [ ] Rodar `atualizacao_20261024000200.sql` no SQL Editor do ikvj (pendência sua, antes do deploy).
- [ ] Storage com a pasta da empresa no caminho dos arquivos. Hoje as policies conferem só a permissão: quem tem a permissão numa empresa e adivinha o caminho de um arquivo de outra consegue ler.
- [ ] Deploy no ikvj com o token temporário da conta WSA, pelo workflow `supabase-deploy-functions-em-projeto-de-outra-conta-token-temporario-powershell` do Cerebro.
- [ ] Agendamentos `imobdesk-*` criados depois do deploy.

### Fase 4 — Front ligado ao ikvj
- [x] `.env.local` com a URL e a chave publishable do ikvj e `VITE_APP_SCHEMA=imobdesk`.
- [x] Marca Imobdesk / WSA Sistemas, sem domínio fixo, Movidesk fora, "App do solicitante".
- [x] Empresa aberta no topo; vira seletor com mais de uma empresa e recarrega o portal (P3). Código em `src/features/empresas/`.
- [x] Configurações › Empresas (flag `wsaOnly` no `menuRegistry`): lista e cria empresa, só para o Super admin da WSA (P2).
- [ ] Tipos do banco gerados de novo (`--schema imobdesk,public`). Precisa do login da conta WSA no CLI; até lá, as RPCs novas são chamadas sem tipo.

### Fase 5 — Visual Apple HIG
- [x] Tokens WSA em `src/index.css` (os do portal e os `--ds-*`), com o tema escuro em `[data-tema="escuro"]`.
- [x] Aparência claro/escuro/automático no topo, salva no login (`salvar_tema`) e aplicada antes da primeira pintura (`public/tema.js`).
- [x] Lateral clara do Mac (ícones coloridos que já existiam) e item ativo em degradê azul → abóbora.
- [x] Botões em cápsula com retorno ao toque, campos com anel de foco de 4 px, cards com raio de 14 px.
- [x] Topo com empresa, aparência e notificações. A busca geral do mockup não existe no sistema: fica para uma fase própria.
- [x] Página inicial, Tickets e as demais telas herdam os tokens. Conferido no navegador, claro e escuro: Início, Tickets (kanban), Empresas e Permissões por aplicativo.

### Fase 6 — Login
- [x] `Login.tsx`/`AuthShell.tsx` no `.mpl-*` com a foto B (`public/login-helpdesk.jpg`); vale também para Redefinir e Trocar senha.
- [x] Mantidos: lembrar e-mail, Caps Lock, mostrar senha e "Esqueceu a senha?".
- [ ] URL de produção em ikvj › Authentication › Redirect URLs (pendência sua).

### Fase 7 — Verificação e registro
- [ ] `npm run lint`, `npm run build`, `npm test` e `npm run test:db` no fim de cada fase.
- [ ] Navegador: login, troca de tema e de empresa, e um ticket de ponta a ponta.
- [ ] `docs/Solicitacoes-financeiras/CONTEXTO.md` atualizado.
- [ ] Cerebro atualizado.

## O que fica com você

1. No SQL Editor do ikvj, rodar na ordem `supabase/sql-editor/1_estrutura_parte1.sql` … `parte4.sql` e depois `2_primeiro_admin.sql` (troque o e-mail e o nome da empresa no topo).
2. Gerar o token temporário da conta WSA para o deploy das Edge Functions (Fase 3).
