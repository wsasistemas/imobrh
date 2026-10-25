// CPF/CNPJ: a regra do front (documento.ts) é a mesma de imobdesk.at_documento_valido, conferida no ensaio do banco.
import { describe, expect, it } from "vitest";
import { documentoValido } from "../src/features/cadastros/services/documento";

describe("documentoValido", () => {
  it("CPF", () => {
    expect(documentoValido("529.982.247-25")).toBe(true);
    expect(documentoValido("529.982.247-24")).toBe(false);
    expect(documentoValido("111.111.111-11")).toBe(false);
  });
  it("CNPJ", () => {
    expect(documentoValido("11.222.333/0001-81")).toBe(true);
    expect(documentoValido("22.417.565/0001-01")).toBe(true);
    expect(documentoValido("11.222.333/0001-80")).toBe(false);
    expect(documentoValido("00000000000000")).toBe(false);
  });
  it("tamanho errado", () => {
    expect(documentoValido("123")).toBe(false);
  });
});
