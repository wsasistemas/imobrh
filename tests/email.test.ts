// Contas de e-mail: montagem MIME, clientes mínimos de IMAP/SMTP (com servidor falso) e o JWT da conta de
// serviço do Google (assinatura conferida com a chave pública).
import { describe, expect, it } from "vitest";
import type { Socket } from "../supabase/functions/_shared/email/conexao.ts";
import { appGoogle, emailDoIdToken, erroGoogle, tokenPorRefresh, trocarCodigo, urlAutorizacao } from "../supabase/functions/_shared/email/gmail.ts";
import { aspas, lerStatus, testarImap, type Rede } from "../supabase/functions/_shared/email/imap.ts";
import { cabecalho, montarMensagem, pontoDuplo } from "../supabase/functions/_shared/email/mime.ts";
import { testarSmtp } from "../supabase/functions/_shared/email/smtp.ts";

/** Servidor falso: responde a cada linha recebida com o que `responder` devolver. */
function servidorFalso(saudacao: string, responder: (linha: string) => string) {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const recebido: string[] = [];
  let fila: Uint8Array[] = [enc.encode(saudacao)];
  let acordar: (() => void) | null = null;
  let buffer = "";
  const socket: Socket = {
    async read(buf) {
      while (fila.length === 0) await new Promise<void>((r) => (acordar = r));
      const pedaco = fila.shift()!;
      buf.set(pedaco);
      return pedaco.length;
    },
    async write(dados) {
      buffer += dec.decode(dados);
      let i: number;
      while ((i = buffer.indexOf("\r\n")) >= 0) {
        const linha = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        recebido.push(linha);
        const r = responder(linha);
        if (r) {
          fila.push(enc.encode(r));
          acordar?.();
        }
      }
      return dados.length;
    },
    close() {
      fila = [];
    },
  };
  const rede: Rede = { abrir: async () => socket, iniciarTls: async (s) => s };
  return { rede, recebido };
}

describe("MIME", () => {
  it("assunto com acento vira encoded-word e o corpo vai em base64", () => {
    expect(cabecalho("Teste")).toBe("Teste");
    expect(cabecalho("Ação")).toBe("=?UTF-8?B?QcOnw6Nv?=");
    const m = montarMensagem({ de: "cftv@exemplo.com.br", deNome: "Construtora Exemplo · CFTV", para: ["a@b.com"], assunto: "[#10241] Boleto", texto: "olá", messageId: "<x@exemplo.com.br>", inReplyTo: "<y@b.com>", referencias: "<y@b.com>" });
    expect(m).toContain("From: =?UTF-8?B?");
    expect(m).toContain("Subject: [#10241] Boleto");
    expect(m).toContain("In-Reply-To: <y@b.com>");
    expect(m).toContain("Content-Transfer-Encoding: base64\r\n\r\nb2zDoQ==");
  });

  it("linha começando com ponto é duplicada no DATA", () => {
    expect(pontoDuplo("a\r\n.b\r\n..c")).toBe("a\r\n..b\r\n...c");
  });
});

describe("IMAP", () => {
  it("aspas e STATUS", () => {
    expect(aspas('se"nh\\a')).toBe('"se\\"nh\\\\a"');
    expect(lerStatus("* STATUS INBOX (MESSAGES 12 UNSEEN 3)")).toEqual({ mensagens: 12, naoLidas: 3 });
    expect(lerStatus("* OK")).toBeNull();
  });

  it("conexão, login e contagem da pasta", async () => {
    const { rede, recebido } = servidorFalso("* OK Gimap ready\r\n", (l) => {
      const tag = l.split(" ")[0];
      if (l.includes("LOGIN")) return `${tag} OK logged in\r\n`;
      if (l.includes("STATUS")) return `* STATUS "INBOX" (MESSAGES 7 UNSEEN 2)\r\n${tag} OK done\r\n`;
      if (l.includes("LOGOUT")) return `* BYE\r\n${tag} OK bye\r\n`;
      return `${tag} BAD ?\r\n`;
    });
    const passos = await testarImap({ host: "imap.gmail.com", porta: 993, seguranca: "ssl", usuario: "cftv@exemplo.com.br", senha: "abcd efgh", pasta: "INBOX" }, rede);
    expect(passos.map((p) => p.ok)).toEqual([true, true, true]);
    expect(passos[2]!.detalhe).toBe("7 e-mails, 2 não lidos");
    expect(recebido[0]).toBe('a1 LOGIN "cftv@exemplo.com.br" "abcd efgh"');
  });

  it("senha recusada vira passo com a mensagem do servidor", async () => {
    const { rede } = servidorFalso("* OK ready\r\n", (l) => `${l.split(" ")[0]} NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)\r\n`);
    const passos = await testarImap({ host: "imap.gmail.com", porta: 993, seguranca: "ssl", usuario: "x@y.com", senha: "errada", pasta: "INBOX" }, rede);
    expect(passos[1]).toMatchObject({ ok: false, detalhe: "Invalid credentials (Failure)" });
    expect(passos).toHaveLength(2);
  });
});

describe("SMTP", () => {
  it("EHLO multilinha, AUTH PLAIN e envio com DATA", async () => {
    const { rede, recebido } = servidorFalso("220 smtp.gmail.com ESMTP\r\n", (l) => {
      if (l.startsWith("EHLO")) return "250-smtp.gmail.com\r\n250-AUTH LOGIN PLAIN\r\n250 SMTPUTF8\r\n";
      if (l.startsWith("AUTH")) return "235 2.7.0 Accepted\r\n";
      if (l.startsWith("MAIL") || l.startsWith("RCPT")) return "250 OK\r\n";
      if (l === "DATA") return "354 Go ahead\r\n";
      if (l === ".") return "250 2.0.0 OK queued\r\n";
      if (l === "QUIT") return "221 bye\r\n";
      return "";
    });
    const passos = await testarSmtp({ host: "smtp.gmail.com", porta: 465, usuario: "cftv@exemplo.com.br", senha: "s" }, rede, { de: "cftv@exemplo.com.br", para: "w@exemplo.com.br", mensagem: "Subject: t\r\n\r\n.oi" });
    expect(passos.map((p) => p.ok)).toEqual([true, true, true]);
    expect(recebido).toContain(`AUTH PLAIN ${btoa("\u0000cftv@exemplo.com.br\u0000s")}`);
    expect(recebido).toContain("..oi");
  });
});

describe("Google: aplicativo do portal e erros", () => {
  it("aplicativo OAuth vem dos secrets; sem os dois valores, não está configurado", () => {
    const env = (m: Record<string, string>) => (k: string) => m[k];
    expect(appGoogle(env({ GOOGLE_OAUTH_CLIENT_ID: " id.apps.googleusercontent.com ", GOOGLE_OAUTH_CLIENT_SECRET: "x" }))).toEqual({ clientId: "id.apps.googleusercontent.com", clientSecret: "x" });
    expect(appGoogle(env({ GOOGLE_OAUTH_CLIENT_ID: "id" }))).toBeNull();
    expect(appGoogle(env({}))).toBeNull();
  });

  it("erros comuns do Google viram mensagem com a causa", () => {
    expect(erroGoogle(401, '{"error":"invalid_client","error_description":"The OAuth client was not found."}')).toMatch(/ID do cliente/);
    expect(erroGoogle(400, '{"error":"invalid_grant","error_description":"Bad Request"}')).toMatch(/Reautorizar com Gmail/);
  });
});

describe("Autorizar com Gmail (OAuth2 por conta)", () => {
  it("URL pede acesso contínuo, consentimento e a caixa certa", () => {
    const u = new URL(urlAutorizacao({ clientId: "1-a.apps.googleusercontent.com", redirectUri: "https://x.supabase.co/functions/v1/cb", state: "s1", caixa: "cftv@exemplo.com.br" }));
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("scope")).toBe("https://mail.google.com/ openid email");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
    expect(u.searchParams.get("login_hint")).toBe("cftv@exemplo.com.br");
    expect(u.searchParams.get("state")).toBe("s1");
  });

  it("troca o código e lê o e-mail do id_token", async () => {
    const corpo = btoa(JSON.stringify({ email: "CFTV@exemplo.com.br" })).replace(/=+$/, "");
    const f = (async () => new Response(JSON.stringify({ access_token: "at", refresh_token: "rt", id_token: `h.${corpo}.s` }))) as typeof fetch;
    expect(await trocarCodigo(f, { clientId: "c", clientSecret: "s", code: "x", redirectUri: "r" })).toEqual({ refreshToken: "rt", accessToken: "at", email: "cftv@exemplo.com.br" });
    expect(emailDoIdToken("lixo")).toBeNull();
  });

  it("token revogado pede para reautorizar", async () => {
    const f = (async () => new Response('{"error":"invalid_grant","error_description":"Token has been expired or revoked."}', { status: 400 })) as typeof fetch;
    await expect(tokenPorRefresh(f, { clientId: "c", clientSecret: "s", refreshToken: "r" })).rejects.toThrow(/Reautorizar com Gmail/);
  });
});
