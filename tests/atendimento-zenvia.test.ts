// Cliente da Zenvia (supabase/functions/_shared/atendimento/zenvia.ts). Copiado do Vs_PipedriveMKT e
// adaptado: sem código de campanha; o número de destino ("para") define o setor da conversa.
import { describe, expect, it, vi } from "vitest";
import { conferirContaZenvia, enviarTexto, lerEvento, telefoneZenvia, textoComOpcoes } from "../supabase/functions/_shared/atendimento/zenvia.ts";

function jsonResponse(body: string | object, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** fetch falso que devolve as respostas na ordem. */
function sequenceFetch(responses: (() => Response)[]) {
  const fn = vi.fn<typeof fetch>(async () => {
    const next = responses.shift();
    if (!next) throw new Error("fetch chamado mais vezes do que o esperado");
    return next();
  });
  return { fetch: fn };
}

describe("webhook da Zenvia", () => {
  it("mensagem de entrada com texto e nome do visitante", () => {
    const ev = lerEvento({
      type: "MESSAGE",
      message: { id: "m1", from: "5521973573360", to: "imobdesk", direction: "IN", contents: [{ type: "text", text: "Olá! Quero saber do Arte Wave #AW7K2" }], visitor: { name: "Paulo" } },
    });
    expect(ev).toEqual({ tipo: "mensagem", zenviaId: "m1", de: "5521973573360", para: "imobdesk", nome: "Paulo", textos: ["Olá! Quero saber do Arte Wave #AW7K2"], arquivos: [] });
  });

  it("áudio e imagem viram arquivos (legenda conta como texto)", () => {
    const ev = lerEvento({
      type: "MESSAGE",
      message: { id: "m2", from: "21973573360", direction: "IN", contents: [{ type: "file", fileUrl: "https://z/a.ogg", fileMimeType: "audio/ogg" }, { type: "file", fileUrl: "https://z/f.jpg", fileMimeType: "image/jpeg", fileCaption: "essa planta" }] },
    });
    expect(ev).toMatchObject({ tipo: "mensagem", de: "5521973573360", textos: ["essa planta"] });
    expect(ev.tipo === "mensagem" && ev.arquivos.map((a) => a.mime)).toEqual(["audio/ogg", "image/jpeg"]);
  });

  it("status: entregue, lida e recusada com o motivo", () => {
    expect(lerEvento({ type: "MESSAGE_STATUS", messageId: "s1", messageStatus: { code: "DELIVERED" } })).toEqual({ tipo: "status", zenviaId: "s1", status: "entregue", erro: null });
    expect(lerEvento({ type: "MESSAGE_STATUS", messageId: "s2", messageStatus: { code: "READ" } })).toMatchObject({ status: "lida" });
    expect(lerEvento({ type: "MESSAGE_STATUS", messageId: "s3", messageStatus: { code: "REJECTED", causes: [{ reason: "NOT_ON_WHATSAPP", details: "número sem WhatsApp" }] } })).toEqual({
      tipo: "status",
      zenviaId: "s3",
      status: "falhou",
      erro: "NOT_ON_WHATSAPP: número sem WhatsApp",
    });
  });

  it("mensagem de saída e tipos desconhecidos são ignorados", () => {
    expect(lerEvento({ type: "MESSAGE", message: { id: "x", direction: "OUT", contents: [] } }).tipo).toBe("ignorado");
    expect(lerEvento({ type: "OUTRO" }).tipo).toBe("ignorado");
    expect(lerEvento(null).tipo).toBe("ignorado");
  });
});

describe("setor pelo número de destino", () => {
  it("o 'para' da mensagem é o número do setor (um webhook para todos os números)", () => {
    const fin = lerEvento({ type: "MESSAGE", message: { id: "a", from: "21911110001", to: "5521999990002", direction: "IN", contents: [{ type: "text", text: "boleto" }] } });
    const rel = lerEvento({ type: "MESSAGE", message: { id: "b", from: "21911110001", to: "5521999990003", direction: "IN", contents: [{ type: "text", text: "visita" }] } });
    expect(fin.tipo === "mensagem" && fin.para).toBe("5521999990002");
    expect(rel.tipo === "mensagem" && rel.para).toBe("5521999990003");
    expect(fin.tipo === "mensagem" && rel.tipo === "mensagem" && fin.de === rel.de).toBe(true);
  });
});

describe("envio", () => {
  it("opções numeradas no fim do texto", () => {
    const t = textoComOpcoes("Podemos continuar?", [{ id: "a", rotulo: "Sim" }, { id: "b", rotulo: "Não" }]);
    expect(t).toBe("Podemos continuar?\n\n1️⃣ Sim\n2️⃣ Não\n\nResponda com o número da opção.");
    expect(textoComOpcoes("Só texto")).toBe("Só texto");
  });

  it("POST no formato da API v2 e erro da Zenvia vira ok=false", async () => {
    const seq = sequenceFetch([() => jsonResponse({ id: "z1" }), () => jsonResponse({ code: "VALIDATION_ERROR", message: "from inválido" }, 400)]);
    expect(await enviarTexto(seq.fetch, "tk", "imobdesk", "21973573360", "oi")).toEqual({ ok: true, status: 200, zenviaId: "z1", erro: null });
    expect(JSON.parse(String(seq.fetch.mock.calls[0]![1]!.body))).toEqual({ from: "imobdesk", to: "5521973573360", contents: [{ type: "text", text: "oi" }] });
    expect(await enviarTexto(seq.fetch, "tk", "imobdesk", "21973573360", "oi")).toMatchObject({ ok: false, erro: "from inválido" });
  });

  it("telefone com DDI 55 quando falta", () => {
    expect(telefoneZenvia("(21) 97357-3360")).toBe("5521973573360");
    expect(telefoneZenvia("5521973573360")).toBe("5521973573360");
  });

  it("conta: remetente precisa aparecer nos modelos do token", () => {
    expect(conferirContaZenvia([{ id: "1", name: "x", senderId: "imobdesk", status: "APPROVED" }], "imobdesk")).toBeNull();
    expect(conferirContaZenvia([{ id: "1", name: "x", senderId: "outra", status: "APPROVED" }], "imobdesk")).toMatch(/não aparece/);
  });
});
