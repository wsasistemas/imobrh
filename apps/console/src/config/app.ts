/** Empresa e nome do sistema: cabeçalho da sidebar, topo, título da aba e login. */
export const COMPANY_NAME = "WSA Sistemas";
export const APP_NAME = "ImobRH";
/** Nome no topo do portal. Login, título da aba e mensagens seguem com APP_NAME. */
export const APP_TOPBAR_NAME = "ImobRH";

/** Schema do ImobRH no Supabase compartilhado da WSA (ikvj). */
export const APP_SCHEMA = "app_imobrh";

/** Edge Functions do ImobRH (uma pasta por função em supabase/functions). */
export type EdgeFunctionName = "rh-me" | "rm-token" | "rm-funcionario" | "rm-hierarquia" | "rm-consultas";

/**
 * Login: o gateway do imobdesk (Security Gateway imobdesk-auth). O login é compartilhado e a sessão precisa ser a
 * registrada por ele: o banco do ImobRH só aceita sessão confiável para o imobdesk (app_imobrh.uid()).
 */
export const AUTH_GATEWAY_FUNCTION = "imobdesk-auth";

/** Prefixo das chaves do navegador (localStorage/sessionStorage) deste aplicativo. */
export const STORAGE_PREFIX = "imobrh-console";

/**
 * Chave de um papel do ImobRH (os 8 do PRD v2, em packages/shared). No Console os papéis fazem o papel dos
 * "perfis" das telas herdadas do imobdesk.
 */
export type RoleKey = string;

/** Administrador: acesso total ao Console, não editável. */
export const SUPER_ADMIN_ROLE: RoleKey = "admin";
/** Mesmo papel: itens `adminOnly` são só do Administrador. */
export const ADMIN_ROLE: RoleKey = "admin";

/** Qualquer e-mail entra: quem pode o quê vem dos papéis no ImobRH, conferidos pelo banco. */
export function isAllowedLoginEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}
