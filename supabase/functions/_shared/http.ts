// Respostas HTTP das Edge Functions do ImobRH, sempre no formato { data, error: { code, message, fields } }.
import { type CodigoErro, type ErroApi, STATUS_DO_ERRO } from "./contrato.ts";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-empresa-id",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

/** Erro de regra: vira { data: null, error } com o status do código. */
export class ErroRh extends Error {
  constructor(
    readonly code: CodigoErro,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

export function ok<T>(data: T, status = 200): Response {
  return json({ data, error: null }, status);
}

export function falha(error: unknown): Response {
  if (error instanceof ErroRh) {
    const corpo: ErroApi = { code: error.code, message: error.message, ...(error.fields ? { fields: error.fields } : {}) };
    return json({ data: null, error: corpo }, STATUS_DO_ERRO[error.code]);
  }
  console.error(JSON.stringify({ evento: "erro_inesperado", erro: String(error).slice(0, 500) }));
  return json({ data: null, error: { code: "INTERNO", message: "Erro inesperado. Tente novamente." } }, 500);
}

/** Erro de RPC do app_imobrh (detail = código, hint = campo; ver app_imobrh.erro). */
export function deRpc(error: { message: string; details?: string | null; hint?: string | null; code?: string }): ErroRh {
  const codigo = error.details as CodigoErro | undefined;
  if (error.code === "P0001" && codigo && codigo in STATUS_DO_ERRO) {
    return new ErroRh(codigo, error.message, error.hint ? { [error.hint]: error.message } : undefined);
  }
  console.error(JSON.stringify({ evento: "rpc_falhou", codigo: error.code, mensagem: error.message.slice(0, 300) }));
  return new ErroRh("INTERNO", "Erro inesperado no banco. Tente novamente.");
}

/** Corpo JSON (POST) ou parâmetros da URL (GET), num objeto só. */
export async function lerEntrada(req: Request): Promise<Record<string, unknown>> {
  const daUrl = Object.fromEntries(new URL(req.url).searchParams);
  if (req.method !== "POST") return daUrl;
  const texto = await req.text();
  if (!texto.trim()) return daUrl;
  try {
    const corpo = JSON.parse(texto);
    if (typeof corpo !== "object" || corpo === null || Array.isArray(corpo)) throw new Error();
    return { ...daUrl, ...corpo };
  } catch {
    throw new ErroRh("VALIDACAO", "Requisição inválida: o corpo precisa ser um objeto JSON.");
  }
}

/** Monta o handler com CORS, método e tratamento de erro. */
export function servir(metodos: ("GET" | "POST")[], handler: (req: Request) => Promise<Response>) {
  Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (!metodos.includes(req.method as "GET" | "POST")) {
      return falha(new ErroRh("VALIDACAO", `Método não suportado. Use ${metodos.join(" ou ")}.`));
    }
    try {
      return await handler(req);
    } catch (error) {
      return falha(error);
    }
  });
}
