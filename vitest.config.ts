import { configDefaults, defineConfig } from "vitest/config";

// `npm test`: testes rápidos (contrato da API e regras puras). Os de banco (tests/db) sobem um Postgres local e
// rodam com `npm run test:db`.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "apps/console/src/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "tests/db/**"],
  },
});
