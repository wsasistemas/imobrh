// Montagem de e-mail (RFC 5322 + MIME) para o envio por SMTP e pela API do Gmail (raw).
// TypeScript puro: sem Deno nem Node, testado no Vitest.

export interface MensagemEmail {
  de: string;
  deNome?: string | null;
  para: string[];
  cc?: string[];
  assunto: string;
  texto: string;
  html?: string | null;
  responderPara?: string | null;
  inReplyTo?: string | null;
  referencias?: string | null;
  messageId: string;
  data?: Date;
}

const enc = new TextEncoder();

export function base64(texto: string): string {
  const bytes = enc.encode(texto);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function base64url(texto: string): string {
  return base64(texto).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Cabeçalho com acento vira encoded-word UTF-8 (assunto, nome do remetente). */
export function cabecalho(valor: string): string {
  return /^[\x20-\x7e]*$/.test(valor) ? valor : `=?UTF-8?B?${base64(valor)}?=`;
}

function endereco(email: string, nome?: string | null): string {
  return nome ? `${cabecalho(nome.replace(/"/g, ""))} <${email}>` : email;
}

/** Corpo em base64 com quebra a cada 76 caracteres (RFC 2045). */
function corpo64(texto: string): string {
  return (base64(texto).match(/.{1,76}/g) ?? [""]).join("\r\n");
}

export function novoMessageId(dominio: string): string {
  return `<${crypto.randomUUID()}@${dominio}>`;
}

export function montarMensagem(m: MensagemEmail): string {
  const linhas = [
    `From: ${endereco(m.de, m.deNome)}`,
    `To: ${m.para.join(", ")}`,
    ...(m.cc?.length ? [`Cc: ${m.cc.join(", ")}`] : []),
    ...(m.responderPara ? [`Reply-To: ${m.responderPara}`] : []),
    `Subject: ${cabecalho(m.assunto)}`,
    `Date: ${(m.data ?? new Date()).toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: ${m.messageId}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${m.inReplyTo}`] : []),
    ...(m.referencias ? [`References: ${m.referencias}`] : []),
    "MIME-Version: 1.0",
  ];
  if (!m.html) {
    linhas.push("Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", corpo64(m.texto));
    return linhas.join("\r\n");
  }
  const limite = `=_portal_${crypto.randomUUID().replace(/-/g, "")}`;
  linhas.push(
    `Content-Type: multipart/alternative; boundary="${limite}"`,
    "",
    `--${limite}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    corpo64(m.texto),
    `--${limite}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    corpo64(m.html),
    `--${limite}--`,
  );
  return linhas.join("\r\n");
}

/** Linhas que começam com "." ganham outro "." no DATA do SMTP (RFC 5321 §4.5.2). */
export function pontoDuplo(mensagem: string): string {
  return mensagem.replace(/(^|\r\n)\./g, "$1..");
}
