// Integração SIENGE (Fase 5): título a pagar no formato do Swagger (POST /bills), validações, leitura das respostas.
import { describe, expect, it } from "vitest";
import {
  apropriacaoObra, autorizacao, faltandoNaConfig, filtroCredor, idDoTitulo, mensagemSienge, montarTitulo, planoDoTipo, resultados, urlBase, validarEscolhas,
  type ConfigSienge, type PedidoLancamento,
} from "../supabase/functions/_shared/sf/sienge.ts";

const cfg: ConfigSienge = {
  ativo: true, ambiente: "homologacao", subdominio: "exemplo", usuario: "api", senha: "segredo", empresaId: 1, tipoDocumento: "AV", indexadorId: 0,
  planoReembolso: "2010101", planoFundoFixo: "2010102", planoAdiantamento: "2010103", centroCustoPadrao: 114,
};
const pedido: PedidoLancamento = {
  id: 7, numero: "SF-2026-0007", tipo: "reembolso", cpf: "12345678900", solicitante: "João Silva", setor: "Obra - Arte Wave",
  competencia: "2026-10-01", ultimaAprovacaoEm: "2026-10-15T14:22:00Z", pagarAte: "2026-10-30", vencimento: null, total: 617.9, glosado: 7.5, aPagar: 610.4,
};

describe("SIENGE", () => {
  it("monta o título: uma parcela, valor a pagar, rateio 100% e número SF como documento", () => {
    const t = montarTitulo(pedido, cfg, { credorId: 55, centroCustoId: 114, plano: "2010101", vencimento: "2026-10-30" });
    expect(t).toMatchObject({
      debtorId: 1, creditorId: 55, documentIdentificationId: "AV", documentNumber: "SF-2026-0007", issueDate: "2026-10-15", baseDate: "2026-10-15",
      dueDate: "2026-10-30", billDate: "2026-10-01", installmentsNumber: 1, indexId: 0, totalInvoiceAmount: 610.4, discount: 0,
      budgetCategories: [{ costCenterId: 114, paymentCategoriesId: "2010101", percentage: 100 }],
    });
    expect(t.notes).toContain("Reembolso SF-2026-0007 - João Silva");
    expect(t.notes.length).toBeLessThanOrEqual(500);
  });

  it("configuração incompleta e escolhas inválidas são apontadas", () => {
    expect(faltandoNaConfig({ ...cfg, senha: null, ativo: false })).toEqual(["integração ativa", "senha"]);
    expect(validarEscolhas({ centroCustoId: 114, plano: "20.10.101", vencimento: "2026-10-30" })).toMatch(/plano financeiro/);
    expect(validarEscolhas({ centroCustoId: 114, plano: "2010101", vencimento: "2026-10-30" })).toBeNull();
    expect(planoDoTipo(cfg, "fundo_fixo")).toBe("2010102");
  });

  it("endereço, autenticação Basic e leitura das respostas", () => {
    expect(urlBase("exemplo")).toBe("https://api.sienge.com.br/exemplo/public/api/v1");
    expect(autorizacao("api", "segredo")).toBe(`Basic ${btoa("api:segredo")}`);
    expect(resultados<{ id: number }>({ resultSetMetadata: {}, results: [{ id: 3 }] })).toEqual([{ id: 3 }]);
    expect(idDoTitulo(null, "https://api.sienge.com.br/exemplo/public/api/v1/bills/9876")).toBe(9876);
    expect(idDoTitulo({ id: 12 }, null)).toBe(12);
    expect(mensagemSienge(400, JSON.stringify({ clientMessage: "Credor inativo" }))).toBe("SIENGE 400: Credor inativo");
    expect(mensagemSienge(401, "")).toMatch(/usuário ou senha/);
  });
});

describe("SIENGE · adiantamento (Fase 5B)", () => {
  const adt: PedidoLancamento = {
    ...pedido, numero: "SF-2026-0151", tipo: "adiantamento", cpf: "53520864000109", favorecido: "J.A BLINDAGEM LTDA", finalidade: "Sinal do pedido",
    pedidoNumero: "001355", total: 658.4, glosado: 0, aPagar: 658.4, rateio: [{ tarefa: "29.02.20", porcentagem: "60.00" }, { tarefa: "29.02.21", porcentagem: 40 }],
  };

  it("credor pelo CNPJ do favorecido; CPF continua para o colaborador", () => {
    expect(filtroCredor("53520864000109")).toBe("cnpj=53520864000109");
    expect(filtroCredor("12345678900")).toBe("cpf=12345678900");
  });

  it("rateio por tarefa vira apropriação de obra só com obra e unidade", () => {
    const sem = montarTitulo(adt, cfg, { credorId: 9, centroCustoId: 114, plano: "2010103", vencimento: "2026-10-20" });
    expect(sem.buildingsCost).toBeUndefined();
    expect(sem.notes).toContain("Adiantamento SF-2026-0151 - J.A BLINDAGEM LTDA");
    expect(sem.notes).toContain("Pedido 001355");
    const com = montarTitulo(adt, cfg, { credorId: 9, centroCustoId: 114, plano: "2010103", vencimento: "2026-10-20", obraId: 12, unidadeId: 1 });
    expect(com.buildingsCost).toEqual([
      { buildingId: 12, buildingUnitId: 1, costEstimationSheetId: "29.02.20", percentage: 60 },
      { buildingId: 12, buildingUnitId: 1, costEstimationSheetId: "29.02.21", percentage: 40 },
    ]);
    expect(apropriacaoObra({ ...adt, rateio: [] }, { credorId: 9, centroCustoId: 1, plano: "1", vencimento: "2026-10-20", obraId: 12, unidadeId: 1 })).toEqual([]);
  });

  it("saldo do pedido usa o documento SF-…-S", () => {
    const t = montarTitulo({ ...adt, notaNumero: "000874" }, cfg, { credorId: 9, centroCustoId: 114, plano: "2010103", vencimento: "2026-11-01" }, "SF-2026-0151-S");
    expect(t.documentNumber).toBe("SF-2026-0151-S");
    expect(t.notes).toContain("Saldo do pedido (comprovação) SF-2026-0151");
    expect(t.notes).toContain("Nota 000874");
  });

  it("obra sem unidade é recusada", () => {
    expect(validarEscolhas({ centroCustoId: 114, plano: "2010103", vencimento: "2026-10-20", obraId: 12, unidadeId: null })).toMatch(/unidade/);
    expect(validarEscolhas({ centroCustoId: 114, plano: "2010103", vencimento: "2026-10-20", obraId: 12, unidadeId: 3 })).toBeNull();
  });
});
