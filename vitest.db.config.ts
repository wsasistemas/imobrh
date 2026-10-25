import { defineConfig } from "vitest/config";

// Testes de banco: sobem um Postgres 17 local (embedded-postgres) e aplicam todas as migrations.
// Rodar com `npm run test:db`. Ficam fora do `npm test` porque levam ~30 s e baixam binários.
export default defineConfig({
  test: {
    include: ["tests/db/**/*.db.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
