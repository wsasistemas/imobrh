/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  /** Chave pública (anon/publishable). A service_role nunca vai para o front. */
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /** "mock" usa os dados em memória (demonstração/testes); qualquer outro valor usa o Supabase. */
  readonly VITE_DATA_SOURCE?: string;
}
