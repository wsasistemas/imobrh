// Cliente da Zenvia (WhatsApp oficial) da Gestão de Atendimento. TypeScript puro: o fetch entra por
// parâmetro (Deno na Edge Function, falso nos testes). Copiado do Vs_PipedriveMKT (05/10/2026), que veio do
// Vs_Portal_Pesagem _shared/whatsapp.ts. Uma conta (um token) para os números de todos os setores: o
// remetente (`from`) é o número do setor da conversa.
//
// Armadilha conhecida: a Zenvia responde 200 com id mesmo quando o remetente é de OUTRA conta e descarta
// a mensagem depois; o motivo só chega pelo webhook MESSAGE_STATUS. Por isso conferirContaZenvia e a
// assinatura de status são obrigatórias.

/** Opção de menu numerada (reservada para o robô, que pode vir depois). */
export interface Opcao {
  id: string;
  rotulo: string;
}

export const ZENVIA_API = "https://api.zenvia.com/v2";
const TIMEOUT_MS = 20_000;

export type Fetch = typeof fetch;

export interface ResultadoEnvio {
  ok: boolean;
  status: number;
  zenviaId: string | null;
  erro: string | null;
}

/** Só dígitos, com 55 para números do Brasil sem DDI. */
export function telefoneZenvia(bruto: string): string {
  const d = bruto.replace(/\D/g, "");
  return d.length === 10 || d.length === 11 ? `55${d}` : d;
}

const NUMEROS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];

/**
 * Texto com as opções numeradas no fim. É o formato que funciona em qualquer conta. O motor entende a
 * resposta "2", o texto da opção ou palavras-chave; botões interativos ficam atrás de uma chave de configuração.
 */
export function textoComOpcoes(texto: string, opcoes?: Opcao[]): string {
  if (!opcoes || opcoes.length === 0) return texto;
  const linhas = opcoes.map((o, i) => `${NUMEROS[i] ?? `${i + 1}.`} ${o.rotulo}`);
  return `${texto}\n\n${linhas.join("\n")}\n\nResponda com o número da opção.`;
}

async function postar(fetchImpl: Fetch, token: string, corpo: Record<string, unknown>): Promise<ResultadoEnvio> {
  let resp: Response;
  try {
    resp = await fetchImpl(`${ZENVIA_API}/channels/whatsapp/messages`, {
      method: "POST",
      headers: { "X-API-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, status: 0, zenviaId: null, erro: err instanceof Error ? `Rede: ${err.message}` : "Erro de rede ao chamar a Zenvia." };
  }
  const texto = await resp.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(texto) as Record<string, unknown>;
  } catch {
    /* resposta não-JSON */
  }
  const erroApi = json?.["error"] as { description?: string } | undefined;
  const ok = resp.ok && !erroApi;
  return {
    ok,
    status: resp.status,
    zenviaId: (json?.["id"] as string | undefined) ?? null,
    erro: ok ? null : (erroApi?.description ?? (json?.["message"] as string | undefined) ?? `HTTP ${resp.status}: ${texto.slice(0, 300)}`),
  };
}

export function enviarTexto(fetchImpl: Fetch, token: string, from: string, para: string, texto: string): Promise<ResultadoEnvio> {
  return postar(fetchImpl, token, { from, to: telefoneZenvia(para), contents: [{ type: "text", text: texto }] });
}

export function enviarArquivo(
  fetchImpl: Fetch,
  token: string,
  from: string,
  para: string,
  arquivo: { url: string; mime: string; nome: string; legenda?: string },
): Promise<ResultadoEnvio> {
  const content: Record<string, unknown> = { type: "file", fileUrl: arquivo.url, fileMimeType: arquivo.mime, fileName: arquivo.nome };
  if (arquivo.legenda) content.fileCaption = arquivo.legenda;
  return postar(fetchImpl, token, { from, to: telefoneZenvia(para), contents: [content] });
}

export function enviarModelo(fetchImpl: Fetch, token: string, from: string, para: string, templateId: string, campos: Record<string, string>): Promise<ResultadoEnvio> {
  return postar(fetchImpl, token, { from, to: telefoneZenvia(para), contents: [{ type: "template", templateId, fields: campos }] });
}

// ---------------------------------------------------------------- webhook

export type EventoZenvia =
  | {
      tipo: "mensagem";
      zenviaId: string;
      de: string;
      para: string;
      nome: string | null;
      textos: string[];
      arquivos: { url: string; mime: string; nome: string | null; legenda: string | null }[];
    }
  | { tipo: "status"; zenviaId: string; status: "enviada" | "entregue" | "lida" | "falhou"; erro: string | null }
  | { tipo: "ignorado"; motivo: string };

const STATUS: Record<string, "enviada" | "entregue" | "lida" | "falhou"> = {
  SENT: "enviada",
  DELIVERED: "entregue",
  READ: "lida",
  REJECTED: "falhou",
  NOT_DELIVERED: "falhou",
  NOT_SENT: "falhou",
};

/** Lê o corpo do webhook da Zenvia (assinaturas MESSAGE e MESSAGE_STATUS). Só mensagens de ENTRADA. */
export function lerEvento(payload: unknown): EventoZenvia {
  if (!payload || typeof payload !== "object") return { tipo: "ignorado", motivo: "corpo vazio" };
  const p = payload as Record<string, unknown>;
  if (p.type === "MESSAGE_STATUS") {
    const ms = (p.messageStatus ?? {}) as { code?: string; description?: string; causes?: { reason?: string; details?: string }[] };
    const status = STATUS[String(ms.code ?? "").toUpperCase()];
    const id = String(p.messageId ?? "");
    if (!status || !id) return { tipo: "ignorado", motivo: `status ${ms.code ?? "?"}` };
    const causa = ms.causes?.map((c) => [c.reason, c.details].filter(Boolean).join(": ")).join("; ");
    return { tipo: "status", zenviaId: id, status, erro: status === "falhou" ? causa || ms.description || "Recusada pela Zenvia" : null };
  }
  if (p.type === "MESSAGE") {
    const m = (p.message ?? {}) as Record<string, unknown>;
    if (String(m.direction ?? p.direction ?? "IN").toUpperCase() !== "IN") return { tipo: "ignorado", motivo: "mensagem de saída" };
    const conteudos = Array.isArray(m.contents) ? (m.contents as Record<string, unknown>[]) : [];
    const textos: string[] = [];
    const arquivos: { url: string; mime: string; nome: string | null; legenda: string | null }[] = [];
    for (const c of conteudos) {
      if (c.type === "text" && typeof c.text === "string") textos.push(c.text);
      else if (c.type === "file" && typeof c.fileUrl === "string") {
        arquivos.push({ url: c.fileUrl, mime: String(c.fileMimeType ?? "application/octet-stream"), nome: (c.fileName as string) ?? null, legenda: (c.fileCaption as string) ?? null });
        if (typeof c.fileCaption === "string" && c.fileCaption.trim()) textos.push(c.fileCaption);
      } else if (typeof c.payload === "string") textos.push(c.payload); // resposta de botão
      else if (typeof c.text === "string") textos.push(c.text);
    }
    const visitante = (m.visitor ?? {}) as { name?: string; firstName?: string };
    return {
      tipo: "mensagem",
      zenviaId: String(m.id ?? p.id ?? ""),
      de: telefoneZenvia(String(m.from ?? "")),
      para: String(m.to ?? ""),
      nome: visitante.name ?? visitante.firstName ?? null,
      textos,
      arquivos,
    };
  }
  return { tipo: "ignorado", motivo: `tipo ${String(p.type ?? "?")}` };
}

// ---------------------------------------------------------------- conta

export interface ZenviaTemplate {
  id: string;
  name: string | null;
  senderId: string | null;
  status: string | null;
}

export async function listarTemplates(fetchImpl: Fetch, token: string): Promise<{ ok: boolean; templates: ZenviaTemplate[]; erro: string | null }> {
  let resp: Response;
  try {
    resp = await fetchImpl(`${ZENVIA_API}/templates`, { headers: { "X-API-Token": token }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    return { ok: false, templates: [], erro: err instanceof Error ? err.message : "Erro de rede." };
  }
  const texto = await resp.text();
  if (!resp.ok) return { ok: false, templates: [], erro: `HTTP ${resp.status}: ${texto.slice(0, 300)}` };
  let bruto: unknown = null;
  try {
    bruto = JSON.parse(texto);
  } catch {
    /* não-JSON */
  }
  const lista = (Array.isArray(bruto) ? bruto : Array.isArray((bruto as { data?: unknown[] })?.data) ? (bruto as { data: unknown[] }).data : []) as Record<string, unknown>[];
  return {
    ok: true,
    erro: null,
    templates: lista.map((t) => ({
      id: String(t.id ?? ""),
      name: (t.name as string) ?? null,
      senderId: (t.senderId as string) ?? null,
      status: (t.status as string) ?? null,
    })),
  };
}

/** O remetente precisa aparecer nos templates da conta do token (a Zenvia não expõe /senders). */
export function conferirContaZenvia(templates: ZenviaTemplate[], from: string): string | null {
  const remetente = from.trim().toLowerCase();
  if (!remetente) return "Informe o remetente (número ou sender id da Zenvia).";
  if (templates.length === 0) return null; // conta nova sem templates: não dá para conferir, não bloqueia
  return templates.some((t) => (t.senderId ?? "").toLowerCase() === remetente)
    ? null
    : `O remetente ${from} não aparece nos templates da conta deste token. Confira se o token é da mesma conta do número.`;
}
