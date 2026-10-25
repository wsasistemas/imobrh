// Colunas da Lista de Tickets (docs/PLANO-visoes-colunas.md): rótulos, campos adicionais e quando buscar os extras.
import { describe, expect, it } from "vitest";
import { ehCampoAdicional, formatarCampo, precisaExtras, rotuloColuna } from "../src/features/chamados/visoes/campos";
import type { CampoColuna } from "../src/features/chamados/visoes/types";

const campos: CampoColuna[] = [
  { chave: "patrimonio", rotulo: "Patrimônio do equipamento", tipo: "texto", interno: false },
  { chave: "centro_custo", rotulo: "Centro de custo", tipo: "lista", interno: true },
];

describe("rótulo das colunas", () => {
  it("padrão, campo adicional e campo sem cadastro", () => {
    expect(rotuloColuna("prazo_solucao")).toBe("Prazo de solução");
    expect(rotuloColuna("setor")).toBe("Departamento");
    expect(rotuloColuna("campo:patrimonio", campos)).toBe("Patrimônio do equipamento");
    expect(rotuloColuna("campo:apagado", campos)).toBe("apagado");
  });

  it("reconhece campo adicional", () => {
    expect(ehCampoAdicional("campo:obra")).toBe(true);
    expect(ehCampoAdicional("status")).toBe(false);
  });
});

describe("quando a Lista busca os extras", () => {
  it("só com coluna nova ou campo adicional", () => {
    expect(precisaExtras(["solicitante", "status", "sla", "tags", "recebido_em"])).toBe(false);
    expect(precisaExtras(["status", "categoria"])).toBe(true);
    expect(precisaExtras(["status", "campo:obra"])).toBe(true);
  });
});

describe("formatação dos campos adicionais", () => {
  it.each<[CampoColuna["tipo"] | undefined, unknown, string]>([
    ["texto", "IMP-0231", "IMP-0231"],
    ["texto", "", ""],
    ["texto", null, ""],
    [undefined, undefined, ""],
    ["sim_nao", true, "Sim"],
    ["sim_nao", "false", "Não"],
    ["data", "2026-10-10", "10/10/2026"],
    ["data_hora", "2026-10-10T17:30:00Z", "10/10/2026, 14:30"],
    ["numero", 1234.5, "1.234,5"],
    ["multipla", ["Sede", "Obra Barra"], "Sede, Obra Barra"],
    ["usuario", "Wagner Antunes", "Wagner Antunes"],
  ])("%s %j → %j", (tipo, valor, esperado) => {
    expect(formatarCampo(tipo, valor)).toBe(esperado);
  });
});
