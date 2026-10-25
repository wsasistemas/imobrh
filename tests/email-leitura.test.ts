// Leitura de e-mail (Etapa 4): interpretação da mensagem do Gmail e filtros contra laço e devolução.
import { describe, expect, it } from "vitest";
import { htmlParaTexto, idsCitados, lerEndereco, lerLista, lerMensagem, motivoIgnorar, nomeSeguro, ticketDoAssunto, type MensagemGmail } from "../supabase/functions/_shared/email/leitura.ts";

const b64url = (s: string) => Buffer.from(s, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function mensagem(cab: Record<string, string>, parts: MensagemGmail["payload"][]): MensagemGmail {
  return {
    id: "18f0a",
    threadId: "18f00",
    internalDate: String(Date.parse("2026-10-08T15:00:00Z")),
    payload: { mimeType: "multipart/mixed", headers: Object.entries(cab).map(([name, value]) => ({ name, value })), parts: parts as never },
  };
}

const conta = { email: "noreply@exemplo.com.br", oauthEmail: "noreply@exemplo.com.br", ignorarRemetentes: ["mailer-daemon@", "noreply@", "no-reply@"] };

describe("lerMensagem", () => {
  const m = mensagem(
    {
      From: '"Wagner Antunes" <Wagner.Antunes@exemplo.com.br>',
      To: "noreply@exemplo.com.br, \"TI, Suporte\" <ti@exemplo.com.br>",
      Cc: "gestor@exemplo.com.br",
      Subject: "Impressora não imprime",
      "Message-ID": "<abc@mail.gmail.com>",
      "In-Reply-To": "<x1@exemplo.com.br>",
      References: "<raiz@exemplo.com.br> <x1@exemplo.com.br>",
    },
    [
      {
        mimeType: "multipart/alternative",
        parts: [
          { mimeType: "text/plain", headers: [{ name: "Content-Type", value: "text/plain; charset=UTF-8" }], body: { data: b64url("A impressora do 2º andar parou.") } },
          { mimeType: "text/html", body: { data: b64url("<p>A impressora do <b>2º</b> andar parou.</p>") } },
        ],
      },
      { mimeType: "application/pdf", filename: "erro.pdf", body: { size: 1234, attachmentId: "ANX1" } },
    ],
  );
  const e = lerMensagem(m);

  it("lê remetente, destinatários, assunto e ids da conversa", () => {
    expect(e.de).toBe("wagner.antunes@exemplo.com.br");
    expect(e.deNome).toBe("Wagner Antunes");
    expect(e.para).toEqual(["noreply@exemplo.com.br", "ti@exemplo.com.br"]);
    expect(e.cc).toEqual(["gestor@exemplo.com.br"]);
    expect(e.assunto).toBe("Impressora não imprime");
    expect(e.messageId).toBe("<abc@mail.gmail.com>");
    expect(idsCitados(e)).toEqual(["<x1@exemplo.com.br>", "<raiz@exemplo.com.br>"]);
  });

  it("separa texto, html e anexos (com acento)", () => {
    expect(e.texto).toBe("A impressora do 2º andar parou.");
    expect(e.html).toContain("<b>2º</b>");
    expect(e.anexos).toEqual([{ nome: "erro.pdf", mime: "application/pdf", tamanho: 1234, attachmentId: "ANX1", data: undefined }]);
  });

  it("sem text/plain, o texto vem do html; sem Message-ID, usa o id do Gmail", () => {
    const so = lerMensagem(mensagem({ From: "a@b.com", Subject: "x" }, [{ mimeType: "text/html", body: { data: b64url("<div>Linha 1</div><div>Linha&nbsp;2</div>") } }]));
    expect(so.texto).toBe("Linha 1\nLinha 2");
    expect(so.messageId).toBe("<gmail-18f0a@mail.gmail.com>");
  });
});

describe("motivoIgnorar", () => {
  const base = lerMensagem(mensagem({ From: "cliente@empresa.com.br", Subject: "Oi" }, []));
  it("deixa entrar e-mail normal", () => expect(motivoIgnorar(base, conta)).toBeNull());
  it("barra a própria caixa, devoluções e remetentes ignorados", () => {
    expect(motivoIgnorar({ ...base, de: "noreply@exemplo.com.br" }, conta)).toBe("enviado pela própria caixa");
    expect(motivoIgnorar({ ...base, de: "mailer-daemon@googlemail.com" }, conta)).toBe("devolução de e-mail");
    expect(motivoIgnorar({ ...base, de: "no-reply@banco.com" }, conta)).toMatch(/remetente ignorado/);
  });
  it("barra resposta automática (férias, lista)", () => {
    expect(motivoIgnorar({ ...base, cabecalhos: { "auto-submitted": "auto-replied" } }, conta)).toBe("resposta automática");
    expect(motivoIgnorar({ ...base, cabecalhos: { "auto-submitted": "no" } }, conta)).toBeNull();
    expect(motivoIgnorar({ ...base, cabecalhos: { precedence: "bulk" } }, conta)).toBe("resposta automática");
  });
});

describe("auxiliares", () => {
  it("número do ticket no assunto", () => {
    expect(ticketDoAssunto("Re: [#1042] Impressora")).toBe(1042);
    expect(ticketDoAssunto("Impressora")).toBeNull();
  });
  it("endereços", () => {
    expect(lerEndereco("fulano@x.com")).toEqual({ email: "fulano@x.com", nome: null });
    expect(lerLista("a@x.com, inválido, \"B, C\" <b@y.com>")).toEqual(["a@x.com", "b@y.com"]);
  });
  it("html para texto e nome de arquivo seguro", () => {
    expect(htmlParaTexto("<style>p{}</style><p>Olá &amp; até</p>")).toBe("Olá & até");
    expect(nomeSeguro("Relatório final (v2).pdf")).toBe("Relatorio_final_v2_.pdf");
  });
});
