// Empresa de cada chamada nas Edge Functions (Imobdesk multiempresa).
//
// O service_role ignora a RLS. Então:
//  * as RPCs recebem a empresa pelo cabeçalho x-empresa-id (imobdesk.empresa_atual() lê o cabeçalho e a RLS das
//    funções filtra o resto);
//  * o acesso direto às tabelas (.from) ganha o filtro tenant_id = empresa em select, update e delete, e o upsert
//    passa a conferir o conflito dentro da empresa. O insert recebe a empresa pelo default da coluna (o cabeçalho).
// Sem isso, uma leitura direta traria linhas de todas as empresas, e um update por id poderia acertar outra empresa
// (a configuração copiada da empresa Modelo tem os mesmos ids em todas).
import { createClient } from "npm:@supabase/supabase-js@2";
import type { AdminClient } from "./portal.ts";

/** Tabelas sem tenant_id (valem para todas as empresas). */
const GLOBAIS = new Set([
  "empresas", "admins_wsa", "usuario_preferencias", "security_attempts", "security_auth_control", "security_config",
  "security_events", "security_ip_blocks", "security_secret", "security_sessions",
]);

function credenciais() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Função sem configuração do Supabase.");
  return { url, key };
}

/** service_role sem empresa: só para descobrir a empresa (empresa_de, empresa_por_numero…) e para o que é global. */
export function clienteServico(): AdminClient {
  const { url, key } = credenciais();
  return createClient(url, key, { db: { schema: "imobdesk" }, auth: { persistSession: false, autoRefreshToken: false } });
}

/** service_role preso a uma empresa: RPCs pelo cabeçalho e tabelas com o filtro tenant_id. */
export function clienteDaEmpresa(empresaId: string): AdminClient {
  const { url, key } = credenciais();
  const db = createClient(url, key, {
    db: { schema: "imobdesk" },
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { "x-empresa-id": empresaId } },
  }) as AdminClient;
  const from = db.from.bind(db);
  // deno-lint-ignore no-explicit-any
  (db as any).from = (tabela: string) => {
    const consulta = from(tabela);
    if (GLOBAIS.has(tabela)) return consulta;
    return new Proxy(consulta, {
      get(alvo, prop, receptor) {
        const valor = Reflect.get(alvo, prop, receptor);
        if (typeof valor !== "function") return valor;
        if (prop === "select" || prop === "update" || prop === "delete") {
          // deno-lint-ignore no-explicit-any
          return (...args: any[]) => valor.apply(alvo, args).eq("tenant_id", empresaId);
        }
        if (prop === "upsert") {
          // deno-lint-ignore no-explicit-any
          return (linhas: any, opcoes: { onConflict?: string } & Record<string, unknown> = {}) =>
            valor.call(alvo, linhas, opcoes.onConflict && !/\btenant_id\b/.test(opcoes.onConflict)
              ? { ...opcoes, onConflict: `tenant_id,${opcoes.onConflict}` }
              : opcoes);
        }
        return valor.bind(alvo);
      },
    });
  };
  (db as unknown as { empresaId: string }).empresaId = empresaId;
  return db;
}

/** Empresa de um login (a escolhida no topo, o primeiro cadastro ativo ou o domínio do e-mail). */
export async function empresaDoUsuario(usuarioId: string): Promise<string | null> {
  const r = await clienteServico().rpc("empresa_de", { p_usuario: usuarioId });
  if (r.error) throw new Error(r.error.message);
  return (r.data as string | null) ?? null;
}

/** Empresas ativas (sem a Modelo), na ordem de criação. */
export async function empresasAtivas(): Promise<{ id: string; nome: string }[]> {
  const r = await clienteServico().rpc("empresas_ativas");
  if (r.error) throw new Error(r.error.message);
  return (r.data as { id: string; nome: string }[] | null) ?? [];
}

/** Roda o ciclo em cada empresa ativa; a falha de uma não para as outras. */
export async function paraCadaEmpresa<T>(ciclo: (db: AdminClient, empresa: { id: string; nome: string }) => Promise<T>) {
  const resultado: Record<string, T | { erro: string }> = {};
  for (const empresa of await empresasAtivas()) {
    try {
      resultado[empresa.nome] = await ciclo(clienteDaEmpresa(empresa.id), empresa);
    } catch (err) {
      resultado[empresa.nome] = { erro: err instanceof Error ? err.message : String(err) };
      console.error(JSON.stringify({ evento: "empresa.ciclo_falhou", empresa: empresa.id, erro: String(err).slice(0, 500) }));
    }
  }
  return resultado;
}

/** Chama uma RPC que descobre a empresa (empresa_por_numero, empresa_por_sessao_openwa…). */
export async function empresaPor(funcao: string, args: Record<string, unknown>): Promise<string | null> {
  const r = await clienteServico().rpc(funcao, args);
  if (r.error) throw new Error(r.error.message);
  return (r.data as string | null) ?? null;
}
