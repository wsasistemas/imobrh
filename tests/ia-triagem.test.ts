// Triagem por IA: preparo do texto (citação, assinatura, máscara LGPD), pedido e validação da resposta; provedor com
// fetch falso (nova tentativa e modelo reserva).
import { describe, expect, it } from "vitest";
import { classificarComGemini } from "../supabase/functions/_shared/ia/gemini.ts";
import { limparTexto, mascarar, montarPedido, prepararTicket, validarClassificacao } from "../supabase/functions/_shared/ia/triagem.ts";

const equipes = [
  { id: 16, nome: "Infraestrutura", descricao: "rede, VPN, impressora" },
  { id: 17, nome: "Sistemas", descricao: "ERP, portais, acessos" },
];
const servicos = [
  { id: 101, caminho: "T.I. - Infraestrutura › Incidente › Impressora", equipeId: 16 },
  { id: 202, caminho: "T.I. - Sistemas › TOTVS › Acesso ao Sistema", equipeId: 17 },
];

describe("preparo do texto", () => {
  it("corta citação e assinatura", () => {
    const t = "A impressora parou.\r\n\r\nAtenciosamente,\r\n\r\n*Wagner* – TI\r\nwagner@exemplo.com.br";
    expect(limparTexto(t)).toBe("A impressora parou.");
    expect(limparTexto("Sem acesso ao TOTVS\n\nEm qua., 8 de out. de 2026 Fulano escreveu:\n> antigo")).toBe("Sem acesso ao TOTVS");
    expect(limparTexto("Boleto com erro\r\n-----Mensagem original-----\r\nDe: x@y.com")).toBe("Boleto com erro");
  });

  it("mascara e-mail, CPF, CNPJ e telefone", () => {
    expect(mascarar("fale com joao@exemplo.com.br, CPF 123.456.789-09, CNPJ 12.345.678/0001-90, tel (21) 96974-0876")).toBe(
      "fale com [e-mail], CPF [cpf], CNPJ [cnpj], tel [telefone]",
    );
  });

  it("monta o pedido com o chamado delimitado", () => {
    const pedido = montarPedido(prepararTicket("Impressora", "Não imprime"), equipes, servicos);
    expect(pedido).toContain("- id 16: Infraestrutura — rede, VPN, impressora");
    expect(pedido).toContain("- id 101: T.I. - Infraestrutura › Incidente › Impressora (equipe 16)");
    expect(pedido).toMatch(/<chamado>\nAssunto: Impressora\n\nMensagem:\nNão imprime\n<\/chamado>$/);
  });
});

describe("validação da resposta", () => {
  it("aceita equipe e serviço coerentes", () => {
    expect(validarClassificacao({ equipe_id: 16, servico_id: 101, confianca: 93.4, motivo: "Impressora" }, equipes, servicos)).toEqual({
      equipeId: 16,
      servicoId: 101,
      confianca: 93,
      motivo: "Impressora",
    });
  });
  it("descarta serviço de outra equipe ou inventado, e limita a confiança", () => {
    expect(validarClassificacao({ equipe_id: 16, servico_id: 202, confianca: 150, motivo: "" }, equipes, servicos)).toMatchObject({ servicoId: null, confianca: 100 });
    expect(validarClassificacao({ equipe_id: 16, servico_id: 999, confianca: 50, motivo: "" }, equipes, servicos)?.servicoId).toBeNull();
  });
  it("equipe fora da lista (ex.: CFTV num e-mail da TI) é inválida", () => {
    expect(validarClassificacao({ equipe_id: 18, servico_id: null, confianca: 99, motivo: "" }, equipes, servicos)).toBeNull();
    expect(validarClassificacao("texto", equipes, servicos)).toBeNull();
  });
});

describe("provedor", () => {
  const ok = (modelo: string) =>
    new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: '{"equipe_id":17,"servico_id":null,"confianca":80,"motivo":"x"}' }] } }],
        modelVersion: modelo,
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      }),
      { status: 200 },
    );
  const base = { chave: "k", modelo: "principal", reserva: "reserva", sistema: "s", pedido: "p", esquema: {}, espera: async () => {} };

  it("tenta de novo em 503 e depois usa o reserva", async () => {
    const chamados: string[] = [];
    const f = (async (url: string) => {
      chamados.push(url);
      return url.includes("reserva") ? ok("reserva-001") : new Response("ocupado", { status: 503 });
    }) as unknown as typeof fetch;
    const r = await classificarComGemini(f, base);
    expect(chamados.map((u) => u.split("/models/")[1].split(":")[0])).toEqual(["principal", "principal", "reserva"]);
    expect(r).toMatchObject({ modelo: "reserva-001", tokensEntrada: 10, json: { equipe_id: 17 } });
  });

  it("em 404 vai direto para o reserva; erro 400 não tenta de novo", async () => {
    const f404 = (async (url: string) => (url.includes("reserva") ? ok("reserva") : new Response("", { status: 404 }))) as unknown as typeof fetch;
    expect((await classificarComGemini(f404, base)).modelo).toBe("reserva");
    let n = 0;
    const f400 = (async () => {
      n++;
      return new Response("chave", { status: 400 });
    }) as unknown as typeof fetch;
    await expect(classificarComGemini(f400, base)).rejects.toThrow(/400/);
    expect(n).toBe(1);
  });
});
