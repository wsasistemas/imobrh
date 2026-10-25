// Cadeia de aprovação das Solicitações Financeiras (CONTEXTO.md, seção 4): alçada do reembolso/fundo fixo e os
// 4 níveis do adiantamento (planejamento só em obra, gerente sempre, diretor e presidente acima da alçada).
import { describe, expect, it } from "vitest";
import { cadeiaAdiantamento, cadeiaReembolso } from "../src/features/financeiro/cadeia";
import { validarConfig, type ConfigSetorFinanceiro } from "../src/features/financeiro/service";

const base: ConfigSetorFinanceiro = {
  setorId: 1, obra: true, financeiro: false, modoAprovacao: "sequencial", prazoHoras: 48, acaoPrazoVencido: "escalar", centroCustoPadrao: null,
  prazoComprovacaoDias: 30, acaoComprovacaoVencida: "avisar_bloquear", limiteAdiantamentosAbertos: null,
  reembolso: [
    { papel: "Gestor", aprovadorId: "g", substitutoId: null, alcadaMinima: 0 },
    { papel: "Diretor", aprovadorId: "d", substitutoId: null, alcadaMinima: 5000 },
  ],
  adiantamento: [
    { papel: "planejamento", aprovadorId: "p", substitutoId: null, alcadaMinima: null },
    { papel: "gerente", aprovadorId: "g", substitutoId: null, alcadaMinima: null },
    { papel: "diretor", aprovadorId: "d", substitutoId: null, alcadaMinima: 5000 },
    { papel: "presidente", aprovadorId: "x", substitutoId: null, alcadaMinima: 50000 },
  ],
};
const exigidos = (etapas: { exigido: boolean; aprovadorId: string | null }[]) => etapas.filter((e) => e.exigido).map((e) => e.aprovadorId);

describe("cadeia de aprovação", () => {
  it("reembolso: o diretor entra a partir da alçada (inclusive)", () => {
    expect(exigidos(cadeiaReembolso(base, 300))).toEqual(["g"]);
    expect(exigidos(cadeiaReembolso(base, 5000))).toEqual(["g", "d"]);
  });

  it("adiantamento: planejamento só em obra; diretor e presidente acima da alçada", () => {
    expect(exigidos(cadeiaAdiantamento(base, 658.4))).toEqual(["p", "g"]);
    expect(exigidos(cadeiaAdiantamento({ ...base, obra: false }, 658.4))).toEqual(["g"]);
    expect(exigidos(cadeiaAdiantamento(base, 8000))).toEqual(["p", "g", "d"]);
    expect(exigidos(cadeiaAdiantamento(base, 60000))).toEqual(["p", "g", "d", "x"]);
    expect(cadeiaAdiantamento(base, 658.4)[2].motivo).toBe("não exigido para este valor");
  });

  it("nível sem aprovador fica como não configurado", () => {
    const sem = { ...base, adiantamento: base.adiantamento.map((n) => (n.papel === "gerente" ? { ...n, aprovadorId: null } : n)) };
    expect(cadeiaAdiantamento(sem, 100)[1]).toMatchObject({ exigido: false, motivo: "não configurado" });
  });
});

describe("validação da aba", () => {
  it("aceita a configuração válida", () => {
    expect(validarConfig(base)).toBeNull();
  });

  it("recusa diretor sem alçada, substituto igual ao aprovador e prazo fora da faixa", () => {
    const semAlcada = { ...base, adiantamento: base.adiantamento.map((n) => (n.papel === "diretor" ? { ...n, alcadaMinima: null } : n)) };
    expect(validarConfig(semAlcada)?.message).toMatch(/a partir de que valor/);
    expect(validarConfig({ ...base, reembolso: [{ papel: "Gestor", aprovadorId: "g", substitutoId: "g", alcadaMinima: 0 }] })?.message).toMatch(/substituto/);
    expect(validarConfig({ ...base, prazoHoras: 0 })?.field).toBe("prazoHoras");
  });
});
