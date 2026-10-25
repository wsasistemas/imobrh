import { createClient } from "@supabase/supabase-js";
import { APP_SCHEMA } from "../config/app";
import type { Database } from "./database.types";

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
 * Client único do portal. As tabelas do aplicativo ficam no schema APP_SCHEMA do projeto
 * compartilhado da WSA; o `auth` é o mesmo dos outros sistemas.
 * Os tipos (database.types.ts) descrevem o schema-modelo (mesma estrutura que `npm run novo-app` cria).
 * Num projeto novo, depois de criar o schema, gere de novo com:
 *   npx supabase gen types typescript --project-id <ref> --schema <schema>,public > src/lib/database.types.ts
 * troque "comercial" pelo nome do schema no client e use supabase.schema("public") no `central`.
 */
/**
 * Link de "Esqueci minha senha" aberto fora de /redefinir-senha (ex.: o Auth caiu no Site URL porque a
 * URL não está em Redirect URLs). Lido antes do createClient, que limpa o #access_token da barra.
 */
let openedFromRecoveryLink = typeof window !== "undefined" && /(^|[#&])type=recovery(&|$)/.test(window.location.hash);

/** Vale uma vez só: depois de levar a pessoa para /redefinir-senha, a navegação segue normal. */
export function takeRecoveryLinkFlag(): boolean {
  const opened = openedFromRecoveryLink;
  openedFromRecoveryLink = false;
  return opened;
}

export const supabase = createClient<Database, "imobdesk">(url || "http://modo-simulado.invalid", anonKey || "modo-simulado", {
  db: { schema: APP_SCHEMA as "imobdesk" },
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

/**
 * Funções da Central de acessos (schema public, iguais em todos os aplicativos da WSA):
 * pode_acessar_app, pa_sou_super_admin e os atalhos pa_* da tela Permissões por aplicativo.
 * Têm os mesmos nomes e argumentos das do schema-modelo, por isso o tipo reaproveita o do client.
 */
export const central = supabase.schema("public");
