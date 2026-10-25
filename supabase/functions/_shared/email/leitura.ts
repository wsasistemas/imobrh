// Leitura de e-mails pela API do Gmail (F4): interpreta a mensagem (format=full) e decide o que não vira ticket.
// TypeScript puro: sem Deno nem Node, testado no Vitest (tests/email-leitura.test.ts).

export interface ParteGmail {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: ParteGmail[];
}

export interface MensagemGmail {
  id: string;
  threadId?: string;
  internalDate?: string;
  payload?: ParteGmail;
}

export interface AnexoLido {
  nome: string;
  mime: string;
  tamanho: number;
  attachmentId?: string;
  data?: string; // base64url, quando o Gmail já manda o conteúdo junto
}

export interface EmailLido {
  provedorId: string;
  threadId: string | null;
  messageId: string;
  de: string;
  deNome: string | null;
  para: string[];
  cc: string[];
  assunto: string;
  texto: string;
  html: string | null;
  inReplyTo: string | null;
  referencias: string | null;
  recebidoEm: Date;
  anexos: AnexoLido[];
  cabecalhos: Record<string, string>;
}

const dec = (charset: string) => {
  try {
    return new TextDecoder(charset);
  } catch {
    return new TextDecoder("utf-8");
  }
};

/** base64url do Gmail → texto, no charset da parte. */
export function decodificar(data: string, charset = "utf-8"): string {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return dec(charset).decode(bytes);
}

function cabecalhosDe(parte?: ParteGmail): Record<string, string> {
  const h: Record<string, string> = {};
  for (const { name, value } of parte?.headers ?? []) h[name.toLowerCase()] = value;
  return h;
}

/** "Fulano de Tal" <fulano@x.com> → { email, nome }. */
export function lerEndereco(valor: string): { email: string; nome: string | null } {
  const m = valor.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { email: m[2].trim().toLowerCase(), nome: m[1].trim() || null };
  return { email: valor.trim().replace(/^<|>$/g, "").toLowerCase(), nome: null };
}

/** Lista de endereços de To/Cc (vírgula fora de aspas). */
export function lerLista(valor: string | undefined): string[] {
  if (!valor) return [];
  const partes = valor.match(/(?:"[^"]*"|[^,])+/g) ?? [];
  return partes.map((p) => lerEndereco(p).email).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
}

function charsetDe(parte: ParteGmail): string {
  const ct = cabecalhosDe(parte)["content-type"] ?? "";
  return ct.match(/charset="?([^";\s]+)"?/i)?.[1] ?? "utf-8";
}

/** HTML → texto legível (sem estilos e scripts; quebras nos blocos). */
export function htmlParaTexto(html: string): string {
  return html
    .replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Corpo e anexos: primeira parte text/plain e text/html fora de anexo; partes com nome de arquivo são anexos. */
function percorrer(parte: ParteGmail, acc: { texto?: string; html?: string; anexos: AnexoLido[] }) {
  const mime = (parte.mimeType ?? "").toLowerCase();
  const disp = cabecalhosDe(parte)["content-disposition"] ?? "";
  if (parte.filename || /^attachment/i.test(disp)) {
    acc.anexos.push({
      nome: parte.filename || "anexo",
      mime: mime || "application/octet-stream",
      tamanho: parte.body?.size ?? 0,
      attachmentId: parte.body?.attachmentId,
      data: parte.body?.data,
    });
    return;
  }
  if (mime === "text/plain" && acc.texto === undefined && parte.body?.data) acc.texto = decodificar(parte.body.data, charsetDe(parte));
  else if (mime === "text/html" && acc.html === undefined && parte.body?.data) acc.html = decodificar(parte.body.data, charsetDe(parte));
  for (const p of parte.parts ?? []) percorrer(p, acc);
}

export function lerMensagem(m: MensagemGmail): EmailLido {
  const h = cabecalhosDe(m.payload);
  const acc: { texto?: string; html?: string; anexos: AnexoLido[] } = { anexos: [] };
  if (m.payload) percorrer(m.payload, acc);
  const de = lerEndereco(h["from"] ?? "");
  const html = acc.html ?? null;
  return {
    provedorId: m.id,
    threadId: m.threadId ?? null,
    // Sem Message-ID (raro): um id estável a partir do Gmail, para não importar duas vezes.
    messageId: (h["message-id"] ?? "").trim() || `<gmail-${m.id}@mail.gmail.com>`,
    de: de.email,
    deNome: de.nome,
    para: lerLista(h["to"]),
    cc: lerLista(h["cc"]),
    assunto: (h["subject"] ?? "").trim(),
    texto: (acc.texto ?? (html ? htmlParaTexto(html) : "")).trim(),
    html,
    inReplyTo: h["in-reply-to"]?.trim() || null,
    referencias: h["references"]?.trim() || null,
    recebidoEm: new Date(Number(m.internalDate ?? Date.now())),
    anexos: acc.anexos,
    cabecalhos: h,
  };
}

/**
 * Por que este e-mail não deve entrar (null = entra): a própria caixa, remetentes ignorados da conta,
 * devoluções e respostas automáticas (evita laço com os avisos dos gatilhos).
 */
export function motivoIgnorar(e: EmailLido, conta: { email: string; oauthEmail?: string | null; ignorarRemetentes: string[] }): string | null {
  if (!e.de) return "sem remetente";
  if (e.de === conta.email || (conta.oauthEmail && e.de === conta.oauthEmail)) return "enviado pela própria caixa";
  if (/^(mailer-daemon|postmaster)@/i.test(e.de)) return "devolução de e-mail";
  const ignorado = conta.ignorarRemetentes.find((r) => r && e.de.includes(r.toLowerCase()));
  if (ignorado) return `remetente ignorado (${ignorado})`;
  const auto = (e.cabecalhos["auto-submitted"] ?? "").toLowerCase();
  if (auto && auto !== "no") return "resposta automática";
  if (/^(bulk|junk|list|auto_reply)$/i.test((e.cabecalhos["precedence"] ?? "").trim())) return "resposta automática";
  if (e.cabecalhos["x-autoreply"] || e.cabecalhos["x-autorespond"]) return "resposta automática";
  return null;
}

/** Número do ticket no assunto: "[#1234]". */
export function ticketDoAssunto(assunto: string): number | null {
  const m = assunto.match(/\[#(\d{1,12})\]/);
  return m ? Number(m[1]) : null;
}

/** Message-IDs citados (In-Reply-To + References), sem repetição. */
export function idsCitados(e: { inReplyTo: string | null; referencias: string | null }): string[] {
  const todos = `${e.inReplyTo ?? ""} ${e.referencias ?? ""}`.match(/<[^<>\s]+>/g) ?? [];
  return [...new Set(todos)];
}

/** Nome de arquivo seguro para o Storage. */
export function nomeSeguro(nome: string): string {
  const limpo = nome.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "");
  return (limpo || "anexo").slice(-120);
}
