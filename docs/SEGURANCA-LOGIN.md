# Segurança do login — Imobdesk

Relatório da análise, correção e implementação da segurança de autenticação (2026-10-09).
Nenhum valor de segredo aparece neste documento.

## Resumo

| Antes | Depois |
|---|---|
| O navegador chamava `supabase.auth.signInWithPassword` direto. Nenhum limite além do limite nativo do Auth por IP. | O login passa pelo **Security Gateway** (Edge Function `imobdesk-auth`). Limites, bloqueio e risco são decididos no Postgres antes do Supabase Auth. |
| As mensagens diziam "E-mail ou senha incorretos", "Este acesso está bloqueado" e "Confirme o seu e-mail", e mostravam o código técnico do Auth. | Uma única resposta pública (401 + a mesma mensagem e o mesmo tempo de resposta) para qualquer motivo. |
| Uma sessão de senha aberta por fora (curl na API do Auth) acessava o portal normalmente. | A RLS só aceita sessão de senha **emitida pelo gateway**. Sessão aberta por fora não lê nem grava nada. |
| Logout e "encerrar sessão" só valiam quando o access token expirava (até 1 h). | O acesso cai **na hora**: a RLS confere se a sessão ainda existe no Auth. |

## Arquitetura

```text
Navegador ──POST {login}──► Edge Function imobdesk-auth (Security Gateway)
                               1 request id · 2 origem · 3 método/tipo/tamanho (≤2 KB)
                               4 JSON e campos (e-mail ≤254, senha ≤256, sem campo extra)
                               5 IP do cabeçalho configurado · 6 e-mail normalizado
                               7 security_auth_begin()  ── Postgres, atômico ──┐
                                  limite IP · conta · IP+conta · bloqueio ·    │
                                  espera progressiva · spraying · distribuído · │
                                  risco · reserva da conta (1 tentativa por vez)│
                               8 só então: Supabase Auth signInWithPassword ◄──┘
                               9 classifica o erro (nunca repassa)
                              10 security_auth_finish() — contadores, eventos, registra a sessão
                              11 resposta pública uniforme (tempo mínimo de 900 ms)
Navegador ◄── tokens oficiais do Supabase ── supabase.auth.setSession()
     │
     ▼
PostgREST / RPC ──► RLS: perfil_usuario_atual() / perfil_de() exigem sessao_confiavel()
Edge Functions  ──► portalContext() exige security_sessao_valida()
```

```text
Frontend:          React/Vite na Vercel. Só UX: o servidor decide tudo.
Backend:           Supabase Edge Functions (Deno) + RPCs no Postgres.
Supabase Auth:     única autoridade de identidade, senha, hash, sessão, tokens, logout e recuperação.
Security Gateway:  supabase/functions/imobdesk-auth + _shared/security/gateway.ts.
Redis/KV:          não usado. O estado temporário fica no Postgres (veja "Decisões").
Supabase Database: tabelas security_* (estado, tentativas, bloqueios, eventos, sessões).
Vercel:            só arquivos estáticos + cabeçalhos de segurança (vercel.json).
GitHub:            nenhum segredo no histórico (varredura de todas as refs e do stash).
```

### Decisões

- **Postgres em vez de Redis.** O projeto não tem Redis. As funções `security_auth_begin/finish` serializam por IP e por conta com `pg_advisory_xact_lock` (sempre na ordem IP → conta, sem deadlock), além de `FOR UPDATE` na linha da conta. O estado é compartilhado entre todas as instâncias. Nada fica em memória da função. O custo é de 2 a 4 consultas indexadas por tentativa de login.
- **Gateway no Supabase, não na Vercel.** O front é estático. A Edge Function fica ao lado do Auth e do banco, e o projeto já usava Edge Functions.
- **Chave de conta = HMAC do e-mail normalizado**, com um pepper que nunca sai do banco. O controle vale também para e-mail inexistente, então bloqueio e limite não revelam se a conta existe. Nenhuma tabela própria guarda senha, hash de senha ou token.
- **Sessão confiável.** Um login por senha só vale no portal se a sessão foi registrada pelo gateway (`security_sessions`). Sessões de link de e-mail (recuperação, convite) valem sem registro, porque não passam por senha. Em todos os casos a sessão precisa ainda existir em `auth.sessions`.
- **Nada no schema `auth` é alterado.** Só há leitura de `auth.users` (o e-mail, para o hook) e de `auth.sessions` (a sessão ainda existe?).

## Autenticação

```text
Supabase Auth como autoridade: SIM
Autenticação paralela:         NÃO (o gateway decide se a tentativa pode ir ao Auth; quem valida a senha é o Auth)
```

## Proteções

| Proteção | Regra (padrões em `security_config`, ajustáveis sem deploy) |
|---|---|
| Limite por conta | 5 falhas consecutivas → bloqueio. Também 20 tentativas por conta em 15 min, somando todos os IPs. |
| Bloqueio | Escalonado: 15, 30, 60 e depois 60 min. Nunca permanente. O nível volta a zero após 24 h sem falha. Conta bloqueada não chega ao Auth nem com a senha certa. Independe do IP. |
| Espera progressiva | Após cada falha, a próxima tentativa só é aceita depois de 1 s, 2 s, 4 s e 8 s (`next_allowed_at`, sem `sleep` no servidor). |
| Limite por IP | 10/min, 30/15 min, 100/h. Independe da conta. |
| Limite IP + conta | 5 em 15 min. |
| Password spraying | Mais de 10 contas pelo mesmo IP em 5 min → IP bloqueado por 30 min + evento crítico. |
| Ataque distribuído | Mais de 5 IPs na mesma conta em 15 min → conta bloqueada + evento crítico. |
| Risco / bots | Sinais da conta (falhas, vários IPs) e sinais do IP (rajada de 3 em 2 s, várias contas, requisições paralelas, bloqueio recente). 30–59: intervalo mínimo de 5 s. 60–79: IP bloqueado 15 min. 80+: IP bloqueado 60 min + evento crítico. **Só sinais do IP bloqueiam o IP**, para que um usuário errando a senha não derrube o escritório inteiro atrás do mesmo NAT. User-Agent não é usado. |
| Concorrência | Uma tentativa por conta por vez (`inflight_until`). 50 requisições simultâneas → 1 chega ao Auth. |
| Recuperação de senha | 3 pedidos por conta por hora e 5 por IP em 15 min. Resposta sempre neutra. Conta bloqueada pode pedir, porque é assim que o dono legítimo sai do bloqueio. Trocar a senha desbloqueia a conta e derruba as outras sessões. |
| Enumeração | Mesmo status, corpo, cabeçalhos e tempo de resposta para conta inexistente, senha errada, conta bloqueada, IP limitado, Auth fora do ar e camada de segurança fora do ar. |
| Fail closed | Banco ou Auth fora → nega. Senha certa mas sessão não registrada → a sessão é derrubada no Auth e o login é negado. |
| Logs | `security_events`: LOGIN_SUCCESS, LOGIN_FAILED, LOGIN_BLOCKED, RATE_LIMIT_IP, RATE_LIMIT_ACCOUNT, RATE_LIMIT_IP_ACCOUNT, RATE_LIMIT_RECOVER, PASSWORD_SPRAY_DETECTED, DISTRIBUTED_ATTACK, BOT_PATTERN, PASSWORD_RESET, SESSION_REVOKED. Guarda só e-mail mascarado, HMAC e prefixo /24 do IP. Nunca senha, token, cabeçalho Authorization ou cookie. |

Códigos internos (`SEC_AUTH_001` a `SEC_AUTH_020`) ficam só no banco e no log da função. Nunca vão para o cliente.

## Supabase

```text
RLS:            ligada em TODAS as tabelas do schema (verificado por teste em Postgres real com as 36 migrations).
Policies:       tabelas security_* sem policy e sem grant para anon/authenticated → negado.
                Raízes da autorização (perfil_usuario_atual, perfil_de) exigem sessão confiável.
Service Role:   só nas Edge Functions. Nunca no front (há trava em src/lib/supabase.ts e o bundle foi varrido).
Edge Functions: imobdesk-auth (nova, verify_jwt=false: é chamada antes de existir sessão).
                portalContext() das demais confere a sessão (o service_role ignora a RLS).
Auth:           sem alteração de config (projeto compartilhado). Recomendações abaixo.
```

Correções encontradas pelos testes e incluídas nas migrations:

- O schema dá `EXECUTE` a `authenticated` por padrão (`20261006141700_..._base.sql`). Funções internas de segurança precisavam de `revoke` explícito. Sem ele, `security_sessao_valida` virava um oráculo de "essa sessão existe?" para qualquer usuário logado. **Corrigido.**
- Funções de trigger do schema (ex.: `ch_tickets_antes`) tinham `EXECUTE` para `PUBLIC`/`anon`. O risco era baixo (o Postgres não deixa chamá-las direto), mas o acesso foi revogado.

## Segredos

| Tipo | Local | Risco | Ação |
|---|---|---|---|
| Service role (JWT/`sb_secret_`) | Histórico Git (todas as refs + stash) | Nenhum encontrado | — |
| Service role | Bundle de produção (`dist/`) | Valor real do `.env` **não encontrado**. Sem source maps. | — |
| `SUPABASE_SERVICE_ROLE_KEY` | `.env` local da máquina de desenvolvimento (fora do Git, ignorado) | Baixo: só local | Manter fora do `.env` do projeto se não for usada. As Edge Functions já recebem a chave do Supabase. |
| Service role exposta na Vercel em 2026-09-28 (registrado no código) | Variável `VITE_*` na Vercel (incidente anterior) | Encerrado | **Chave secreta rotacionada** (confirmado pelo responsável em 2026-10-09). A chave antiga não vale mais. |
| "BEGIN PRIVATE KEY" | 4 arquivos (validação de formato e fixture de teste) | Nenhum: não há material de chave | — |

## Testes

`npm test`: 92 testes, sendo 40 do gateway. `npm run test:db`: 41 testes num **Postgres 17 real** (embedded-postgres) com as 36 migrations aplicadas e o mínimo do Supabase simulado (papéis, `auth.users/sessions`, `auth.uid()/jwt()`, vault, storage). Os de banco rodaram duas vezes seguidas sem instabilidade.

```text
ACCOUNT RATE LIMIT ........ PASS  5ª falha bloqueia; 20/15 min por conta (security.db.test.ts)
IP RATE LIMIT ............. PASS  10/min; trocar de conta não zera (TESTE 4)
IP+ACCOUNT ................ PASS  5/15 min
ACCOUNT LOCK .............. PASS  senha certa barrada sem chamar o Auth; troca de IP não desbloqueia; 15/30/60/60 min (TESTES 1-3, e2e)
PASSWORD SPRAY ............ PASS  11ª conta pelo IP → bloqueio do IP + evento crítico (TESTE 5)
DISTRIBUTED ATTACK ........ PASS  6º IP na conta → conta bloqueada (TESTE 6)
BOT DETECTION ............. PASS  script sem pausa barrado antes do 10º alvo; humano não bloqueia o NAT (heurístico: não há prova contra todo bot)
ENUMERATION ............... PASS  8 cenários com status, corpo, cabeçalhos e tempo idênticos (TESTE 11)
RACE CONDITION ............ PASS  50 conexões simultâneas: 1 passa; o limite de IP segura 10/50; 50 requisições HTTP → 1 chamada ao Auth (TESTE 7, e2e)
SUPABASE ERROR LEAK ....... PASS  mensagem do Auth não chega à resposta nem ao log (TESTE 12)
SERVICE ROLE EXPOSURE ..... PASS  histórico Git e bundle (TESTE 13)
RLS ....................... PASS  A não lê nem altera B; tabelas security_* negadas a authenticated/anon; todas as tabelas com RLS (TESTES 14, 15)
FRONT/POSTMAN/CURL ........ PASS  sem Origin, sem apikey, com UA de script: mesmas regras (TESTES 8-10)
BYPASS PELA API DO AUTH ... PASS  sessão de senha aberta por fora não acessa o portal
LOGOUT .................... PASS  sessão apagada no Auth corta o acesso na hora
```

**Pendente de validação no ambiente real** (não dá para testar sem o deploy):

1. ~~**IP confiável.**~~ **Validado em 2026-10-09:** uma requisição com `X-Forwarded-For: 203.0.113.7` foi registrada com o IP real (`ip_prefix` do cliente), então o 1º item de `x-forwarded-for` é posto pela plataforma e não é forjável. Padrão `AUTH_IP_HEADER` mantido.
2. **Limite nativo do Auth.** Todas as chamadas do gateway chegam ao Auth vindas da Edge Function. Confira se o limite "sign-ins por 5 min por IP" do Auth não estrangula logins legítimos em horário de pico.
3. **Fluxos reais.** Login validado em produção. Faltam "esqueci a senha" pelo link, troca de senha, sair e "encerrar sessão" de outro usuário.

## Limite que continua existindo

O endpoint público do Auth (`/auth/v1/token`) **continua aceitando senha direto** com a chave pública. O projeto é compartilhado e não dá para desligá-lo. Quem chama por fora:

- **não acessa o portal** (sessão não registrada → RLS nega);
- mas consegue **testar senhas**, limitado só pelo limite nativo do Auth por IP.

Para fechar isso também existe o **Password Verification Hook** (`imobdesk.security_password_verification_hook`, já criado e desligado). Com ele ligado, o próprio Auth consulta o mesmo bloqueio em **toda** verificação de senha, inclusive as diretas, e passa a contar as falhas. Os testes cobrem o hook. Ligar é decisão do dono do projeto compartilhado, porque vale para todos os sistemas da WSA (e depende do plano do Supabase):

1. Dashboard → Authentication → Hooks → Password Verification Attempt → Postgres → `imobdesk.security_password_verification_hook`
2. `update imobdesk.security_config set value = 1 where key = 'hook_counts_failures';` (evita contar a falha duas vezes)

Outras recomendações para o Auth compartilhado (fora do escopo deste repositório):

- **MFA (TOTP) obrigatório para super admin/admin.** O gateway já devolve a sessão oficial. Falta ligar TOTP no Auth e exigir `aal2` em `eh_super_admin()`.
- Proteção contra senhas vazadas (HIBP) e tamanho mínimo de senha no Auth.
- `supabase/templates/` (gerador `npm run novo-app`) não foi alterado. Aplicativos novos nascem sem o gateway até o template ser atualizado.

## Implantação (ordem)

**Concluída em 2026-10-09:** etapa 1, secret (portalimobdesk.imobsystems.com.br, URL de deploy da Vercel e localhost), as 8 Edge Functions (auth + as 7 que usam portalContext) e etapa 2 aplicadas. Antes do commit da etapa 2, uma trava na mesma transação confirmou que a sessão real emitida pelo gateway mantinha o acesso e que uma sessão de senha não vinculada era negada. Login real testado com sucesso em produção.

1. **Migration etapa 1:** `20261009120000_imobdesk_seguranca_login.sql`. Não muda o acesso de ninguém.
2. **Secret da função:** `AUTH_ALLOWED_ORIGINS=https://<domínio de produção>,https://<domínio de preview>,http://localhost:5173`. Opcionais: `AUTH_IP_HEADER` e `AUTH_MIN_RESPONSE_MS`.
3. **Edge Functions:** `imobdesk-auth` (nova) e as que usam `portalContext` (usuarios, totvs, integracao-teste, zenvia, email):
   `npx supabase functions deploy <nome> --project-ref <ref> --use-api`
4. **Front na Vercel:** primeiro em **Preview**, para conferir a CSP nova (login, OAuth do Gmail, fotos de pessoas), depois Produção. Quem estiver logado com uma sessão antiga é desconectado e entra de novo pelo gateway.
5. **Migration etapa 2:** `20261009120100_imobdesk_seguranca_sessao_obrigatoria.sql`. A partir daqui a RLS exige sessão do gateway.
6. Validar os 3 itens pendentes acima.

**Desfazer:** a etapa 2 se desfaz recriando `perfil_usuario_atual`/`perfil_de` sem a linha `sessao_confiavel()`. O front volta com o deploy anterior na Vercel.

## Arquivos

- `supabase/migrations/20261009120000_..._seguranca_login.sql`: tabelas, gateway, sessão confiável, hook, higiene de grants.
- `supabase/migrations/20261009120100_..._seguranca_sessao_obrigatoria.sql`: liga a regra na RLS.
- `supabase/functions/_shared/security/gateway.ts`: núcleo do gateway (sem dependência de Deno, testável).
- `supabase/functions/imobdesk-auth/index.ts`: liga o gateway ao Postgres e ao Auth.
- `supabase/functions/_shared/portal.ts`: `portalContext` confere a sessão.
- `src/lib/authGateway.ts`, `src/features/auth/*`, `services/supabase/{auth,users}.ts`: o front só fala com o gateway.
- `vercel.json` + `public/boot-guard.js`: CSP sem script inline, HSTS, nosniff, frame-ancestors, Referrer/Permissions-Policy.
- `tests/security-gateway.test.ts`, `tests/db/*`: evidências.
