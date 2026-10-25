// Solicitações Financeiras, Fase 4: leitura do comprovante (CONTEXTO.md, seção 5).
// Chamada pela tela logo depois do upload: {anexoId}. O banco confere que o anexo é de uma solicitação editável do
// usuário (sf_ocr_pedido, com o token dele); a função baixa o arquivo do bucket privado, envia à API da Anthropic
// (modelo com visão, secret ANTHROPIC_API_KEY), valida a resposta e grava com sf_ocr_registrar.
// A IA só transcreve; campo abaixo do limiar da R02 volta nulo (normalizarLeitura). Até 3 tentativas com espera crescente.

import Anthropic from "npm:@anthropic-ai/sdk@0.135.0";
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, errorResponse, json, PortalError, portalContext } from "../_shared/portal.ts";
import { blocoDoArquivo, ESQUEMA_LEITURA, INSTRUCOES, montarPedido, normalizarLeitura, validarLeitura, type Categoria, type ModoLeitura } from "../_shared/sf/ocr.ts";

const MODELO = "claude-opus-5-5";
const BUCKET = "imobdesk-sf-comprovantes";
/** Limite da API por imagem em base64; PDF vai até o limite do bucket (10 MB). */
const IMAGEM_MAX = 5 * 1024 * 1024;

interface Pedido {
  anexoId: number;
  path: string;
  mime: string;
  tamanho: number;
  modo: ModoLeitura;
  limiar: number;
  categorias: Categoria[];
}

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Uma chamada à API. Erros que valem nova tentativa: limite (429), sobrecarga/5xx e rede. */
async function ler(client: Anthropic, pedido: Pedido, bloco: NonNullable<ReturnType<typeof blocoDoArquivo>>): Promise<unknown> {
  // Fallback do lado do servidor quando o modelo recusa (recomendado para claude-opus-5-5): a API refaz o pedido no
  // modelo indicado pela categoria da recusa, dentro da mesma chamada.
  const params = {
    model: MODELO,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: INSTRUCOES,
    output_config: { effort: "medium", format: { type: "json_schema", schema: ESQUEMA_LEITURA } },
    messages: [{ role: "user", content: [bloco, { type: "text", text: montarPedido(pedido.modo, pedido.categorias) }] }],
  } as unknown as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
  const r = await client.beta.messages.create(params);
  if (r.stop_reason === "refusal") throw new Error("A leitura foi recusada para este arquivo.");
  if (r.stop_reason === "max_tokens") throw new Error("A resposta da leitura veio incompleta.");
  const texto = r.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  return JSON.parse(texto);
}

function transitorio(e: unknown): boolean {
  return e instanceof Anthropic.RateLimitError || e instanceof Anthropic.InternalServerError || e instanceof Anthropic.APIConnectionError
    || (e instanceof Anthropic.APIError && (e.status ?? 0) >= 500);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ code: "INVALID_INPUT", message: "Método não suportado." }, 405);
  let anexoId = 0;
  let admin: Awaited<ReturnType<typeof portalContext>>["admin"] | null = null;
  try {
    const ctx = await portalContext(req);
    admin = ctx.admin;
    const corpo = (await req.json().catch(() => ({}))) as { anexoId?: number };
    anexoId = Number(corpo.anexoId ?? 0);
    if (!anexoId) throw new PortalError("INVALID_INPUT", "Informe o comprovante.");

    // Confere a posse com o token da pessoa (a RPC usa auth.uid()).
    const comoUsuario = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
      db: { schema: "imobdesk" },
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const ped = await comoUsuario.rpc("sf_ocr_pedido", { p_anexo: anexoId });
    if (ped.error) throw new PortalError("NOT_FOUND", ped.error.message || "Comprovante não encontrado.", 404);
    const pedido = ped.data as Pedido;

    const registrar = async (status: "lido" | "ilegivel" | "erro", dados: unknown, erro?: string) => {
      const r = await ctx.admin.rpc("sf_ocr_registrar", { p_anexo: anexoId, p_status: status, p_json: dados ?? {}, p_erro: erro ?? null });
      if (r.error) console.error(JSON.stringify({ evento: "sf.ocr.registrar_falhou", anexoId, erro: r.error.message }));
    };

    const chave = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
    if (!chave) {
      await registrar("erro", null, "Leitura automática não configurada.");
      throw new PortalError("INTEGRATION_NOT_CONFIGURED", "Falta o secret ANTHROPIC_API_KEY nas Edge Functions.");
    }

    const arquivo = await ctx.admin.storage.from(BUCKET).download(pedido.path);
    if (arquivo.error || !arquivo.data) {
      await registrar("erro", null, "Arquivo não encontrado no armazenamento.");
      throw new PortalError("NOT_FOUND", "Arquivo não encontrado.", 404);
    }
    const bytes = new Uint8Array(await arquivo.data.arrayBuffer());
    const bloco = blocoDoArquivo(pedido.mime, base64(bytes));
    if (!bloco) {
      await registrar("erro", null, "Formato sem leitura automática (envie JPG, PNG ou PDF). O arquivo continua anexado.");
      return json({ status: "erro", mensagem: "Este formato não tem leitura automática. Preencha a linha à mão." });
    }
    if (bloco.type === "image" && bytes.length > IMAGEM_MAX) {
      await registrar("erro", null, "Imagem acima de 5 MB para a leitura automática.");
      return json({ status: "erro", mensagem: "Imagem grande demais para a leitura automática (até 5 MB). Preencha à mão ou envie uma foto menor." });
    }

    const client = new Anthropic({ apiKey: chave, maxRetries: 0, timeout: 60_000 });
    let resposta: unknown = null;
    let ultimoErro: unknown = null;
    const inicio = Date.now();
    for (let tentativa = 0; tentativa < 3; tentativa++) {
      try {
        resposta = await ler(client, pedido, bloco);
        break;
      } catch (e) {
        ultimoErro = e;
        if (!transitorio(e) && !(e instanceof SyntaxError)) break;
        await esperar(1000 * 2 ** tentativa);
      }
    }
    const leitura = resposta == null ? null : validarLeitura(resposta);
    if (!leitura) {
      const motivo = ultimoErro instanceof Error ? ultimoErro.message : "Resposta da leitura fora do formato esperado.";
      await registrar("erro", null, motivo);
      console.log(JSON.stringify({ evento: "sf.ocr.erro", anexoId, ms: Date.now() - inicio, motivo }));
      return json({ status: "erro", mensagem: "Não foi possível ler este comprovante. Preencha a linha à mão." });
    }
    const { status, leitura: final } = normalizarLeitura(leitura, Number(pedido.limiar) || 0.8, pedido.categorias);
    await registrar(status, final);
    console.log(JSON.stringify({ evento: "sf.ocr.lido", anexoId, status, ms: Date.now() - inicio }));
    return json({ status, leitura: final });
  } catch (error) {
    if (admin && anexoId && !(error instanceof PortalError && error.status === 404)) {
      await admin.rpc("sf_ocr_registrar", { p_anexo: anexoId, p_status: "erro", p_json: {}, p_erro: "Falha na leitura." }).then(() => undefined, () => undefined);
    }
    return errorResponse(error);
  }
});
