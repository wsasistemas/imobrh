import type { SqlQueryType } from "../../services/types";

export const SQL_QUERY_TYPE_LABELS: Record<SqlQueryType, string> = {
  resumo: "Resumo da Proposta",
  componentes: "Componentes de Pagamento",
  kpis: "Indicadores KPIs",
  grafico: "Gráfico de Análise",
  detalhes: "Detalhes Mensais",
  status: "Status",
};

const CONSULTA_PATH = "/api/framework/v1/consultaSQLServer/RealizaConsulta";

/** "NOME=valor;NOME2=valor" (até 10 pares), a mesma regra da RPC e da Edge Function. */
export const PARAMS_PATTERN = /^\s*([A-Za-z0-9_]{1,40}=[^;]{0,120})(\s*;\s*[A-Za-z0-9_]{1,40}=[^;]{0,120}){0,9}\s*;?\s*$/;

/**
 * Mesma regra de supabase/functions/_shared/totvs.ts (consultaBase/consultaUrl), só para exibir:
 * base = URL da aba TOTVS RM (até /RealizaConsulta; só o host ganha o caminho padrão);
 * código simples ganha /0/X; parâmetros vão como ?parameters=NOME=valor;NOME2=valor.
 */
export function queryUrlPreview(baseUrl: string | undefined, code: string, parameters = ""): string {
  let base = `http://servidor:8051${CONSULTA_PATH}`;
  try {
    if (baseUrl) {
      const parsed = new URL(baseUrl.trim());
      const path = parsed.pathname.replace(/\/+$/, "");
      const at = path.toLowerCase().indexOf("/realizaconsulta");
      base = `${parsed.origin}${at >= 0 ? path.slice(0, at + "/realizaconsulta".length) : CONSULTA_PATH}`;
    }
  } catch {
    // URL ainda não configurada: usa o exemplo
  }
  const segments = code.trim().replace(/\/+$/, "").split("/").filter(Boolean);
  const path = segments.length > 1 ? segments.join("/") : `${segments[0] || "API.00.02.001"}/0/X`;
  const pairs = parameters
    .split(";")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const [key, ...value] = pair.split("=");
      return `${key.trim().toUpperCase()}=${value.join("=").trim()}`;
    });
  return `${base}/${path}${pairs.length > 0 ? `?parameters=${pairs.join(";")}` : ""}`;
}
