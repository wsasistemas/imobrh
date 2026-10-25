// Provedor da IA (D1: Gemini, isolado aqui). Saída em JSON com esquema, temperatura 0, timeout curto,
// 1 nova tentativa em 429/5xx/timeout e modelo reserva (lições do Cerebro: gemini-404-modelo-aposentado).

type Fetch = typeof fetch;

export interface RespostaIa {
  json: unknown;
  modelo: string;
  tokensEntrada: number | null;
  tokensSaida: number | null;
}

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const TIMEOUT_MS = 25_000;

class ErroIa extends Error {
  constructor(
    message: string,
    readonly transitorio: boolean,
  ) {
    super(message);
  }
}

async function chamar(f: Fetch, chave: string, modelo: string, sistema: string, pedido: string, esquema: unknown): Promise<RespostaIa> {
  let r: Response;
  try {
    r = await f(`${BASE}/${encodeURIComponent(modelo)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": chave },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: sistema }] },
        contents: [{ role: "user", parts: [{ text: pedido }] }],
        // Nos 3.x o raciocínio sai do mesmo limite: com 400 o JSON vinha cortado.
        generationConfig: { temperature: 0, maxOutputTokens: 4096, responseMimeType: "application/json", responseSchema: esquema },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new ErroIa(`Gemini sem resposta (${e instanceof Error ? e.name : "erro"})`, true);
  }
  const texto = await r.text();
  if (!r.ok) {
    if (r.status === 404) throw new ErroIa(`Modelo ${modelo} indisponível para a chave (404).`, true);
    throw new ErroIa(`Gemini respondeu ${r.status}: ${texto.slice(0, 200)}`, r.status === 429 || r.status >= 500);
  }
  const corpo = JSON.parse(texto) as {
    candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    modelVersion?: string;
  };
  const saida = corpo.candidates?.[0]?.content?.parts?.filter((p) => !p.thought).map((p) => p.text ?? "").join("") ?? "";
  let json: unknown;
  try {
    json = JSON.parse(saida);
  } catch {
    const fim = corpo.candidates?.[0]?.finishReason ?? "?";
    throw new ErroIa(`O Gemini não devolveu JSON válido (finishReason ${fim}): ${saida.slice(0, 120)}`, fim === "MAX_TOKENS");
  }
  return {
    json,
    modelo: corpo.modelVersion ?? modelo,
    tokensEntrada: corpo.usageMetadata?.promptTokenCount ?? null,
    tokensSaida: corpo.usageMetadata?.candidatesTokenCount ?? null,
  };
}

/** Modelo principal; em falha passageira, mais 1 tentativa e depois o reserva. */
export async function classificarComGemini(
  f: Fetch,
  p: { chave: string; modelo: string; reserva: string; sistema: string; pedido: string; esquema: unknown; espera?: (ms: number) => Promise<void> },
): Promise<RespostaIa> {
  const espera = p.espera ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  try {
    return await chamar(f, p.chave, p.modelo, p.sistema, p.pedido, p.esquema);
  } catch (e) {
    if (!(e instanceof ErroIa) || !e.transitorio) throw e;
    if (!/404/.test(e.message)) {
      await espera(1500);
      try {
        return await chamar(f, p.chave, p.modelo, p.sistema, p.pedido, p.esquema);
      } catch (e2) {
        if (!(e2 instanceof ErroIa) || !e2.transitorio) throw e2;
      }
    }
    if (p.reserva && p.reserva !== p.modelo) return chamar(f, p.chave, p.reserva, p.sistema, p.pedido, p.esquema);
    throw e;
  }
}
