import { createClient } from "@supabase/supabase-js";
import { APP_SCHEMA } from "../config/app";

/** Tira espaço, quebra de linha e aspas coladas junto com o valor na hospedagem (ex.: Vercel). */
function clean(value: string | undefined): string {
  return (value ?? "").trim().replace(/^["']+|["']+$/g, "").trim();
}

const url = clean(import.meta.env.VITE_SUPABASE_URL).replace(/\/+$/, "");
const anonKey = clean(import.meta.env.VITE_SUPABASE_ANON_KEY);

/** Sem URL e chave o portal roda no modo simulado (dados em memória), sem tocar no Supabase. */
export const SUPABASE_CONFIGURED = Boolean(url && anonKey);

if (Boolean(url) !== Boolean(anonKey)) {
  throw new Error("Configure VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY no .env.local (veja o .env.example).");
}

/** Chave legada (JWT) com papel service_role: dá acesso total, nunca pode ir para o navegador. */
function isServiceRoleJwt(key: string): boolean {
  try {
    const payload = JSON.parse(atob(key.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))) as { role?: string };
    return payload.role === "service_role";
  } catch {
    return false;
  }
}

// Trava: VITE_* vai para o JavaScript público. Chave secreta ali expõe o projeto compartilhado inteiro
// (aconteceu na Vercel em 2026-09-28). Melhor não iniciar do que publicar acesso total.
if (anonKey.startsWith("sb_secret_") || isServiceRoleJwt(anonKey)) {
  throw new Error(
    "VITE_SUPABASE_ANON_KEY está com a chave SECRETA do Supabase. Use a Publishable key (sb_publishable_…) e troque a chave secreta no painel do Supabase.",
  );
}

/** Só o prefixo da chave pública, para conferir no console qual chave o build usa (nunca o valor inteiro). */
/** URL e chave pública do projeto, para chamadas REST que o supabase-js não cobre. */
export const SUPABASE_URL = url;
export const SUPABASE_PUBLIC_KEY = anonKey;

export const SUPABASE_KEY_HINT = `${anonKey.slice(0, 18)}… (${anonKey.length} caracteres)`;

/**
 * Client único do Console. As tabelas e RPCs ficam no schema app_imobrh do projeto compartilhado da WSA (ikvj);
 * o `auth` é o mesmo do imobdesk. Sem tipos gerados: as RPCs devolvem jsonb e cada serviço converte a resposta.
 */
export const supabase = createClient(url || "http://modo-simulado.invalid", anonKey || "modo-simulado", {
  db: { schema: APP_SCHEMA },
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});
