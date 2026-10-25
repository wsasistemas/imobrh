// OpenWA (opção A do atendimento: privado + grupo interno) e o resumo da IA no encerramento.
// supabase/functions/_shared/atendimento/openwa.ts e _shared/ia/resumo.ts são TypeScript puro.
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { assinaturaValida, bytesDeBase64, caminhoMidia, chatIdDe, comAutor, enviarImagemOpenwa, enviarTextoOpenwa, lerEventoOpenwa, telefoneDoJid } from "../supabase/functions/_shared/atendimento/openwa.ts";
import { montarConversa, validarResumo } from "../supabase/functions/_shared/ia/resumo.ts";

const envelope = (data: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  event: "message.received",
  timestamp: 1760000000,
  sessionId: "a1b2c3d4-0000-4000-8000-000000000001",
  idempotencyKey: "idem-1",
  deliveryId: "dlv-1",
  data,
  ...extra,
});

describe("telefoneDoJid", () => {
  it("lê o telefone de @c.us e @s.whatsapp.net (com sufixo de aparelho)", () => {
    expect(telefoneDoJid("5521996453552@c.us")).toBe("5521996453552");
    expect(telefoneDoJid("5521996453552:12@s.whatsapp.net")).toBe("5521996453552");
  });
  it("@lid só com o telefone resolvido (RESOLVE_LID_TO_PHONE)", () => {
    expect(telefoneDoJid("123456789012345@lid")).toBeNull();
    expect(telefoneDoJid("123456789012345@lid", "5521996453552")).toBe("5521996453552");
  });
  it("grupo e lixo não são telefone", () => {
    expect(telefoneDoJid("120363000@g.us")).toBeNull();
    expect(telefoneDoJid(undefined)).toBeNull();
  });
});

describe("lerEventoOpenwa", () => {
  it("mensagem privada de texto", () => {
    const e = lerEventoOpenwa(
      envelope({ id: "false_5521996453552@c.us_3EB0A", from: "5521996453552@c.us", chatId: "5521996453552@c.us", body: " Bom dia ", type: "chat", fromMe: false, isGroup: false, contact: { pushname: "Vini" } }),
    );
    expect(e).toEqual({
      tipo: "privada",
      chave: "idem-1",
      sessao: "a1b2c3d4-0000-4000-8000-000000000001",
      externoId: "false_5521996453552@c.us_3EB0A",
      de: "5521996453552",
      nome: "Vini",
      texto: "Bom dia",
      midia: null,
    });
  });

  it("imagem sem legenda vira mídia", () => {
    const e = lerEventoOpenwa(envelope({ id: "x1", from: "5521996453552@c.us", chatId: "5521996453552@c.us", body: "", type: "image", fromMe: false, isGroup: false, media: { mimetype: "image/jpeg", omitted: true } }));
    expect(e.tipo === "privada" && e.midia).toEqual({ tipo: "imagem", nome: null, mime: "image/jpeg", data: null, chatId: "5521996453552@c.us" });
    const comDados = lerEventoOpenwa(envelope({ id: "x2", from: "5521996453552@c.us", chatId: "5521996453552@c.us", body: "", type: "image", fromMe: false, isGroup: false, media: { mimetype: "image/png", data: "iVBORw0KGgo=" } }));
    expect(comDados.tipo === "privada" && comDados.midia?.data).toBe("iVBORw0KGgo=");
  });

  it("mensagem no grupo interno: autor e a mensagem citada", () => {
    const e = lerEventoOpenwa(
      envelope({
        id: "false_120363000@g.us_3EBRESP_5521977770000@c.us",
        from: "120363000@g.us",
        chatId: "120363000@g.us",
        author: "5521977770000@c.us",
        body: "Limpei a fila",
        type: "chat",
        fromMe: false,
        isGroup: true,
        quotedMessage: { id: "true_120363000@g.us_3EBNOVO_5521900000001@c.us", body: "🆕 #1043" },
      }),
    );
    expect(e).toMatchObject({ tipo: "grupo", grupo: "120363000@g.us", autor: "5521977770000", texto: "Limpei a fila", citadoId: "true_120363000@g.us_3EBNOVO_5521900000001@c.us" });
  });

  it("message.sent no privado = resposta digitada no celular do número (para quem foi)", () => {
    const e = lerEventoOpenwa(
      envelope({ id: "true_5521967337314@c.us_3EBME", from: "5521969740876@c.us", to: "5521967337314@c.us", chatId: "5521967337314@c.us", body: "RESOLVIDO", fromMe: true, isGroup: false }, { event: "message.sent" }),
    );
    expect(e).toMatchObject({ tipo: "propria", para: "5521967337314", texto: "RESOLVIDO", externoId: "true_5521967337314@c.us_3EBME" });
    const grupo = lerEventoOpenwa(envelope({ id: "b", chatId: "120363000@g.us", body: "oi", fromMe: true, isGroup: true }, { event: "message.sent" }));
    expect(grupo.tipo).toBe("ignorado");
  });

  it("ignora status, outros eventos e remetente @lid sem telefone", () => {
    expect(lerEventoOpenwa(envelope({ id: "a", from: "status@broadcast", body: "x" })).tipo).toBe("ignorado");
    expect(lerEventoOpenwa(envelope({ id: "a" }, { event: "session.status" })).tipo).toBe("ignorado");
    const lid = lerEventoOpenwa(envelope({ id: "a", from: "1234567890123@lid", chatId: "1234567890123@lid", body: "oi", isGroup: false, isLidSender: true }));
    expect(lid).toMatchObject({ tipo: "ignorado", motivo: expect.stringContaining("RESOLVE_LID_TO_PHONE") });
  });
});

describe("assinatura do webhook", () => {
  const segredo = "segredo-de-teste-com-mais-de-16";
  const corpo = JSON.stringify(envelope({ id: "a", body: "oi" }));
  const certa = "sha256=" + createHmac("sha256", segredo).update(corpo).digest("hex");

  it("aceita o HMAC-SHA256 do corpo bruto", async () => {
    expect(await assinaturaValida(segredo, corpo, certa)).toBe(true);
    expect(await assinaturaValida(segredo, corpo, certa.toUpperCase())).toBe(true);
  });
  it("recusa corpo alterado, segredo errado ou sem cabeçalho", async () => {
    expect(await assinaturaValida(segredo, corpo + " ", certa)).toBe(false);
    expect(await assinaturaValida("outro-segredo-qualquer-123", corpo, certa)).toBe(false);
    expect(await assinaturaValida(segredo, corpo, null)).toBe(false);
    expect(await assinaturaValida("", corpo, certa)).toBe(false);
  });
});

describe("envio", () => {
  it("send-text com X-API-Key, chatId do telefone e citação", async () => {
    const f = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ messageId: "true_5521996453552@c.us_3EB0OK", timestamp: 1 }), { status: 201 }));
    const r = await enviarTextoOpenwa(f, "https://x.trycloudflare.com/", "owa_k1_chave", "sess-1", "5521996453552", "Olá", "3EBNOVO");
    expect(r).toMatchObject({ ok: true, id: "true_5521996453552@c.us_3EB0OK" });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("https://x.trycloudflare.com/api/sessions/sess-1/messages/send-text");
    expect((init!.headers as Record<string, string>)["X-API-Key"]).toBe("owa_k1_chave");
    expect(JSON.parse(String(init!.body))).toEqual({ chatId: "5521996453552@c.us", text: "Olá", quotedMessageId: "3EBNOVO" });
  });
  it("erro do OpenWA volta com a mensagem", async () => {
    const f = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ statusCode: 409, message: "Engine not ready" }), { status: 409 }));
    const r = await enviarTextoOpenwa(f, "https://x", "k", "s", "120363000@g.us", "oi");
    expect(r).toMatchObject({ ok: false, status: 409, erro: "OpenWA 409: Engine not ready" });
  });
  it("destino e autor", () => {
    expect(chatIdDe("120363000@g.us")).toBe("120363000@g.us");
    expect(chatIdDe("(21) 99645-3552")).toBe("21996453552@c.us");
    expect(comAutor("Tenta de novo?", "Wagner Antunes", "TI")).toBe("*Wagner (TI):* Tenta de novo?");
    expect(comAutor("Oi", null, "TI")).toBe("Oi");
  });
});

describe("resumo da IA (encerramento)", () => {
  it("monta só as ações públicas, mascara dados e identifica quem falou", () => {
    const t = montarConversa("Impressora", [
      { direcao: "entrada", tipo: "publica", autorNome: "Vinicius", texto: "A impressora não imprime. Meu e-mail é vini@exemplo.com.br" },
      { direcao: "saida", tipo: "interna", autorNome: "Wagner Antunes", texto: "nota interna não vai" },
      { direcao: "saida", tipo: "publica", autorNome: "Wagner Antunes", texto: "Limpei a fila" },
    ]);
    expect(t).toContain("Colaborador: A impressora não imprime. Meu e-mail é [e-mail]");
    expect(t).toContain("Atendente (Wagner): Limpei a fila");
    expect(t).not.toContain("nota interna");
  });
  it("valida a resposta", () => {
    expect(validarResumo({ solucao: "  Fila limpa e impressão normalizada. ", resolvido: true })).toEqual({ solucao: "Fila limpa e impressão normalizada.", resolvido: true });
    expect(validarResumo({ solucao: "ok" })).toBeNull();
    expect(validarResumo(null)).toBeNull();
  });
});

describe("print (mídia)", () => {
  it("caminho seguro no bucket por sessão e mês", () => {
    expect(caminhoMidia("b4cab961-03e6", "false_5521@c.us_3EB0/../x", "image/jpeg", new Date("2026-10-09T12:00:00Z"))).toBe("openwa/b4cab961-03e6/2026-10/false_5521_c_us_3EB0____x.jpg");
    expect(caminhoMidia("s", "id", "application/x-desconhecido")).toMatch(/\.bin$/);
  });
  it("base64 com ou sem prefixo data:", () => {
    expect(Array.from(bytesDeBase64("AQID"))).toEqual([1, 2, 3]);
    expect(Array.from(bytesDeBase64("data:image/png;base64,AQID"))).toEqual([1, 2, 3]);
  });
  it("imagem para o grupo com legenda e citação", async () => {
    const f = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ messageId: "true_g_IMG" }), { status: 201 }));
    const r = await enviarImagemOpenwa(f, "https://x", "k", "s", "1203630@g.us", { url: "https://sb/print.jpg?token=1", mime: "image/jpeg" }, "🆕 #1003", "3EBNOVO");
    expect(r.ok).toBe(true);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("https://x/api/sessions/s/messages/send-image");
    expect(JSON.parse(String(init!.body))).toEqual({ chatId: "1203630@g.us", url: "https://sb/print.jpg?token=1", mimetype: "image/jpeg", caption: "🆕 #1003", quotedMessageId: "3EBNOVO" });
  });
});
