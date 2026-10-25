// Adiantamento (Fase 5B): valor por extenso, percentual da condição, valor calculado do pedido, rateio e acerto.
import { describe, expect, it } from "vitest";
import { acerto, percentualDaCondicao, prazoComprovacao, somaRateio, valorDaTarefa, valorDoPedido, valorPorExtenso } from "../supabase/functions/_shared/sf/adiantamento.ts";

describe("valor por extenso", () => {
  it.each([
    [658.4, "SEISCENTOS E CINQUENTA E OITO REAIS E QUARENTA CENTAVOS"],
    [1, "UM REAL"],
    [0.01, "UM CENTAVO"],
    [100, "CEM REAIS"],
    [101.5, "CENTO E UM REAIS E CINQUENTA CENTAVOS"],
    [1000, "MIL REAIS"],
    [1500, "MIL E QUINHENTOS REAIS"],
    [1316.8, "MIL TREZENTOS E DEZESSEIS REAIS E OITENTA CENTAVOS"],
    [2020, "DOIS MIL E VINTE REAIS"],
    [1_000_000, "UM MILHÃO DE REAIS"],
    [2_500_000.99, "DOIS MILHÕES QUINHENTOS MIL REAIS E NOVENTA E NOVE CENTAVOS"],
  ])("%s", (v, esperado) => expect(valorPorExtenso(v)).toBe(esperado));
});

describe("pedido", () => {
  it("percentual da condição", () => {
    expect(percentualDaCondicao("50% sinal - 50% após a entrega")).toBe(50);
    expect(percentualDaCondicao("Sinal de 30,5 % no pedido")).toBe(30.5);
    expect(percentualDaCondicao("à vista")).toBeNull();
    expect(percentualDaCondicao(null)).toBeNull();
  });
  it("valor = total × percentual", () => {
    expect(valorDoPedido(1316.8, 50)).toBe(658.4);
    expect(valorDoPedido(null, 50)).toBeNull();
  });
  it("rateio fecha 100% e valor por tarefa", () => {
    expect(somaRateio([{ porcentagem: 60 }, { porcentagem: 40 }])).toEqual({ soma: 100, fecha: true });
    expect(somaRateio([{ porcentagem: 90 }]).fecha).toBe(false);
    expect(somaRateio([]).fecha).toBe(false);
    expect(valorDaTarefa(658.4, 60)).toBe(395.04);
  });
  it("prazo de comprovação = vencimento + dias", () => {
    expect(prazoComprovacao("2026-10-20", 30)).toBe("2026-11-19");
    expect(prazoComprovacao(null, 30)).toBeNull();
  });
});

describe("acerto", () => {
  it("maior, igual e menor", () => {
    expect(acerto(1200, 2400)).toEqual({ resultado: "comprovado", saldoPagar: 1200, saldoDevolver: 0 });
    expect(acerto(500, 500)).toEqual({ resultado: "comprovado", saldoPagar: 0, saldoDevolver: 0 });
    expect(acerto(1200, 850)).toEqual({ resultado: "devolucao", saldoPagar: 0, saldoDevolver: 350 });
  });
});
