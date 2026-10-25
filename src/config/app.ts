/** Empresa e nome do sistema: cabeçalho da sidebar, topo, título da aba e login. */
export const COMPANY_NAME = "WSA Sistemas";
export const APP_NAME = "Imobdesk";
/** Nome no topo do portal. Login, título da aba e mensagens seguem com APP_NAME. */
export const APP_TOPBAR_NAME = "Imobdesk";

/**
 * Schema do aplicativo no Supabase compartilhado da WSA. É também a chave dele na tela
 * Permissões por aplicativo e o prefixo das Edge Functions (<schema>-usuarios, <schema>-totvs…).
 * Projeto novo: troque aqui (ou em VITE_APP_SCHEMA) e gere o backend com `npm run novo-app -- <schema>`.
 */
export const APP_SCHEMA: string = (import.meta.env.VITE_APP_SCHEMA ?? "").trim() || "imobdesk";

/** Nome publicado de uma Edge Function do aplicativo, ex.: edgeFunction("usuarios") → "imobdesk-usuarios". */
export function edgeFunction(name: "auth" | "usuarios" | "totvs" | "integracao-teste" | "zenvia" | "atendimento" | "email" | "google-oauth" | "whatsapp" | "ia" | "sf-ocr" | "sf-sienge"): string {
  return `${APP_SCHEMA}-${name}`;
}

/** Prefixo das chaves do navegador (localStorage/sessionStorage) deste aplicativo. */
export const STORAGE_PREFIX = `imobdesk-${APP_SCHEMA}`;

/**
 * Chave de um perfil de acesso. Os perfis são cadastrados na tela Perfis e permissões
 * (a hierarquia vem do serviço); só as chaves abaixo têm significado fixo no código.
 */
export type RoleKey = string;

/** Perfil do sistema com acesso total. Não é editável nem pode ser excluído. */
export const SUPER_ADMIN_ROLE: RoleKey = "super_admin";
/** Perfil Admin: único (além do super admin) que acessa itens `adminOnly`. */
export const ADMIN_ROLE: RoleKey = "admin";

/** Perfis que podem criar, editar e excluir outros perfis. */
export const ROLE_MANAGER_ROLES: readonly RoleKey[] = [SUPER_ADMIN_ROLE, "admin"];

/**
 * Qualquer e-mail entra no portal: o acesso vem do cadastro do usuário numa empresa,
 * validado pelo serviço (no Supabase, a Edge Function/RLS). No front só checamos o formato.
 */
export function isAllowedLoginEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}
