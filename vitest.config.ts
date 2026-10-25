import { configDefaults, defineConfig } from "vitest/config";

// `npm test`: testes rápidos. Os de banco (tests/db) sobem um Postgres local e rodam com `npm run test:db`.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "tests/db/**"],
  },
});
