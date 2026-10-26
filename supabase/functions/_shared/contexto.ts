// Quem está chamando cada Edge Function do ImobRH e em qual empresa.
//
// Segurança (mesma regra do imobdesk, cujo login é compartilhado):
//  * verify_jwt=true só garante um JWT válido do projeto (a chave anon também passa): aqui se confere o USUÁRIO do
//    token (auth.getUser) e se a sessão é confiável (aberta pelo gateway imobdesk-auth: imobdesk.security_sessao_valida);
//  * a empresa vem de imobdesk.empresa_de(usuário), a mesma de imobdesk.empresa_atual();
//  * o cliente service_role vai preso à empresa: RPCs recebem x-empresa-id e todo .from() ganha o filtro tenant_id.
//    A service_role ignora a RLS, então nada de consulta direta sem esse cliente.
import { createClient, type SupabaseClient, type User } from "npm:@supabase/supabase-js@2";
import { deRpc, ErroRh } from "./http.ts";

// deno-lint-ignore no-explicit-any
export type Db = SupabaseClient<any, any, any>;

function credenciais() {
  const url = Deno.env.get("SUPABASE_URL");
  const chave = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !chave) throw new ErroRh("INTERNO", "Função sem configuração do Supabase.");
  return { url, chave };
}

/** service_role no schema imobdesk, só para conferir sessão e descobrir a empresa. */
function clienteImobdesk(): Db {
  const { url, chave } = credenciais();
  return createClient(url, chave, { db: { schema: "imobdesk" }, auth: { persistSession: false, autoRefreshToken: false } });
}

/** service_role no app_imobrh preso a uma empresa. */
export function clienteDaEmpresa(empresaId: string): Db {
  const { url, chave } = credenciais();
  const db = createClient(url, chave, {
    db: { schema: "app_imobrh" },
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { "x-empresa-id": empresaId } },
  });
  const from = db.from.bind(db);
  // deno-lint-ignore no-explicit-any
  (db as any).from = (tabela: string) => {
    const consulta = from(tabela);
    return new Proxy(consulta, {
      get(alvo, prop, receptor) {
        const valor = Reflect.get(alvo, prop, receptor);
        if (typeof valor !== "function") return valor;
        if (prop === "select" || prop === "update" || prop === "delete") {
          // deno-lint-ignore no-explicit-any
          return (...args: any[]) => valor.apply(alvo, args).eq("tenant_id", empresaId);
        }
        return valor.bind(alvo);
      },
    });
  };
  return db;
}

export interface Contexto {
  usuario: User;
  empresaId: string;
  /** service_role no app_imobrh, preso à empresa de quem chama. */
  db: Db;
}

function payload(token: string): Record<string, unknown> {
  try {
    const parte = token.split(".")[1] ?? "";
    const base64 = parte.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(parte.length / 4) * 4, "=");
    return JSON.parse(atob(base64)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function tokenDe(req: Request): string {
  return (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
}

/** Chamada de outra Edge Function ou job do próprio projeto (Authorization = service role). */
export function ehServiceRole(req: Request): boolean {
  const token = tokenDe(req);
  return token.length > 0 && token === Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
}

/** Usuário logado (sessão confiável) e a empresa dele. */
export async function contextoDoUsuario(req: Request): Promise<Contexto> {
  const token = tokenDe(req);
  if (!token) throw new ErroRh("NAO_AUTENTICADO", "Faça login para continuar.");

  const imobdesk = clienteImobdesk();
  const { data, error } = await imobdesk.auth.getUser(token);
  if (error || !data.user) throw new ErroRh("NAO_AUTENTICADO", "Sessão inválida. Faça login novamente.");

  const claims = payload(token);
  const sessao = await imobdesk.rpc("security_sessao_valida", {
    p_user_id: data.user.id,
    p_session_id: typeof claims.session_id === "string" ? claims.session_id : null,
    p_amr: Array.isArray(claims.amr) ? claims.amr : [],
  });
  if (sessao.error || sessao.data !== true) throw new ErroRh("NAO_AUTENTICADO", "Sessão inválida. Faça login novamente.");

  const empresa = await imobdesk.rpc("empresa_de", { p_usuario: data.user.id });
  if (empresa.error) throw deRpc(empresa.error);
  if (!empresa.data) throw new ErroRh("SEM_PERMISSAO", "Seu login não está cadastrado em nenhuma empresa do imobdesk.");

  return { usuario: data.user, empresaId: empresa.data as string, db: clienteDaEmpresa(empresa.data as string) };
}

/** Confere uma permissão do Console (matriz de papéis; admin tem todas). */
export async function exigirPermissao(ctx: Contexto, permissao: string): Promise<void> {
  const { data, error } = await ctx.db.rpc("pode_usuario", { p_usuario: ctx.usuario.id, p_permissao: permissao });
  if (error) throw deRpc(error);
  if (data !== true) throw new ErroRh("SEM_PERMISSAO", "Você não tem permissão para esta ação.");
}
