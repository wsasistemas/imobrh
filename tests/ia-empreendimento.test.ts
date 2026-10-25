// IA de empreendimento: pedido com nomes e apelidos, e validação da resposta contra o cadastro.
import { describe, expect, it } from "vitest";
import { montarPedidoEmpreendimento, validarIdentificacao } from "../supabase/functions/_shared/ia/empreendimento.ts";

const lista = [
  { id: 1, nome: "CONDOMINIO ARTE WAVE", apelidos: [], cidade: null },
  { id: 2, nome: "ARTE WAVE SURF RESIDENCES", apelidos: ["Wave Surf"], cidade: "Rio de Janeiro" },
  { id: 3, nome: "FEEL NATURE", apelidos: [], cidade: null },
];

describe("pedido", () => {
  it("lista ids, nomes, apelidos e cidade, com o chamado delimitado", () => {
    const p = montarPedidoEmpreendimento("Assunto: Câmera\n\nMensagem:\nCâmera do Surf", lista);
    expect(p).toContain("- id 2: ARTE WAVE SURF RESIDENCES (apelidos: Wave Surf) — Rio de Janeiro");
    expect(p).toContain("- id 1: CONDOMINIO ARTE WAVE\n");
    expect(p).toMatch(/<chamado>\nAssunto: Câmera[\s\S]*<\/chamado>$/);
  });
});

describe("validação", () => {
  it("aceita id da lista e põe o escolhido na frente das sugestões", () => {
    expect(validarIdentificacao({ empreendimento_id: 2, confianca: 94.6, motivo: " Wave Surf ", sugestoes: [1, 2] }, lista)).toEqual({
      empreendimentoId: 2,
      confianca: 95,
      motivo: "Wave Surf",
      sugestoes: [2, 1],
    });
  });

  it("id inventado vira null com confiança 0; sugestões fora da lista somem; no máximo 3", () => {
    expect(validarIdentificacao({ empreendimento_id: 99, confianca: 90, motivo: "x", sugestoes: [99, 3, 1, 2, 3] }, lista)).toEqual({
      empreendimentoId: null,
      confianca: 0,
      motivo: "x",
      sugestoes: [3, 1, 2],
    });
  });

  it("nada citado: null; resposta inválida: null (conta como erro)", () => {
    expect(validarIdentificacao({ empreendimento_id: null, confianca: 0, motivo: "", sugestoes: [] }, lista)?.empreendimentoId).toBeNull();
    expect(validarIdentificacao("texto", lista)).toBeNull();
    expect(validarIdentificacao({ empreendimento_id: "2", confianca: "120" }, lista)).toMatchObject({ empreendimentoId: 2, confianca: 100, sugestoes: [2] });
  });
});
