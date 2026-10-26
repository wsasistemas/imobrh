# ImobRH — Console do RH (WSA Sistemas)

Sistema de RH separado do imobdesk. O backend é o Supabase ikvj (schema `app_imobrh`) com Edge Functions. O front é o
Console do RH. Colaboradores e gestores usam o app do imobdesk, que chama a API `/rh/*`.

- Regras do projeto: [CLAUDE.md](CLAUDE.md)
- Fonte da verdade: [docs/PRD-imobRH-v2.md](docs/PRD-imobRH-v2.md) e [docs/PRD-imobRH-v1.md](docs/PRD-imobRH-v1.md)
- Fase atual: [docs/PLANO-fase0.md](docs/PLANO-fase0.md)
- Design system: [docs/design-system.md](docs/design-system.md)
- Consultas do RM: [docs/consultas-rm.md](docs/consultas-rm.md)

## Como rodar

```bash
npm install
npm run dev        # Console em http://localhost:5174 (Supabase do apps/console/.env.local)
npm run demo -w apps/console   # modo simulado em http://localhost:5199 (sem Supabase; qualquer senha)
```

No modo simulado, entre com `wagner.antunes@exemplo.com.br` (Administrador) e use o "Ver como" do topo para trocar de
papel.

## Verificação

```bash
npm run lint
npm run build      # typecheck + build do Console
npm test           # núcleo do RM e contrato da API (Vitest)
npm run test:db    # RLS do app_imobrh num Postgres 17 local (embedded-postgres)
npm run deno:check # Edge Functions
```

## Estrutura

| Pasta | O que tem |
|---|---|
| `apps/console` | Console do RH: React 19 + Vite + TypeScript, design system do imobdesk |
| `packages/shared` | Tipos e JSON Schemas da API (reexporta `supabase/functions/_shared/contrato.ts`) |
| `supabase/migrations` | SQL numerado e aditivo, aplicado pelo SQL Editor do ikvj |
| `supabase/functions` | Edge Functions `rh-me`, `rm-token`, `rm-funcionario`, `rm-hierarquia`, `rm-consultas` |
| `tests` | Vitest (`*.test.ts`) e testes de banco (`tests/db/*.db.test.ts`) |
