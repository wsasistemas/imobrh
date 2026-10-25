// Leitura de comprovantes (Fase 4): validação da resposta, limiar de legibilidade (campo abaixo vira nulo e o
// comprovante fica "ilegivel"), formatos (data, CNPJ, chave) e sugestões só das categorias ativas.
import { describe, expect, it } from "vitest";
import { blocoDoArquivo, montarPedido, normalizarLeitura, validarLeitura, type Leitura } from "../supabase/functions/_shared/sf/ocr.ts";

const categorias = [{ id: 4, nome: "Combustível" }, { id: 5, nome: "Transporte" }];
const bruto = (p: Partial<Leitura> = {}): unknown => ({
  tipo_documento: "nfce", data: "2026-10-14", valor_total: 210, favorecido: "AUTO POSTO SHELL BARRA LTDA", cnpj_cpf_emissor: "12.345.678/0001-90",
  chave_acesso: "3326 1012 3456 7800 0190 6500 1000 0123 4510 0012 3456", itens: [{ descricao: "GASOLINA COMUM", valor: 210 }],
  motivo_sugestoes: [{ categoria_id: 5, texto: "Transporte — deslocamento", confianca: 0.42 }, { categoria_id: 4, texto: "Combustível — abastecimento", confianca: 0.91 }, { categoria_id: 99, texto: "Inventada", confianca: 0.99 }],
  legibilidade: { data: 0.99, valor: 0.98, favorecido: 0.95 }, alertas: [], ...p,
});

describe("leitura de comprovantes", () => {
  it("lido: copia os campos, só dígitos no CNPJ e na chave, sugestões das categorias em ordem", () => {
    const { status, leitura } = normalizarLeitura(validarLeitura(bruto())!, 0.8, categorias);
    expect(status).toBe("lido");
    expect(leitura).toMatchObject({ data: "2026-10-14", valor_total: 210, cnpj_cpf_emissor: "12345678000190", chave_acesso: "33261012345678000190650010000123451000123456" });
    expect(leitura.motivo_sugestoes.map((s) => s.categoria_id)).toEqual([4, 5]);
  });

  it("abaixo de 80%: o campo não é copiado e o comprovante fica ilegível", () => {
    const { status, leitura } = normalizarLeitura(validarLeitura(bruto({ legibilidade: { data: 0.61, valor: 0.54, favorecido: 0.88 } }))!, 0.8, categorias);
    expect(status).toBe("ilegivel");
    expect([leitura.data, leitura.valor_total, leitura.favorecido]).toEqual([null, null, "AUTO POSTO SHELL BARRA LTDA"]);
  });

  it("formatos inválidos viram nulos; resposta sem a forma esperada é recusada", () => {
    const { leitura } = normalizarLeitura(validarLeitura(bruto({ data: "14/10/2026", cnpj_cpf_emissor: "123", chave_acesso: "1" }))!, 0.8, categorias);
    expect([leitura.data, leitura.cnpj_cpf_emissor, leitura.chave_acesso]).toEqual([null, null, null]);
    expect(validarLeitura({ tipo_documento: "boleto" })).toBeNull();
    expect(validarLeitura("texto")).toBeNull();
  });

  it("arquivo: imagem e PDF viram blocos; HEIC não é lido", () => {
    expect(blocoDoArquivo("application/pdf", "x")?.type).toBe("document");
    expect(blocoDoArquivo("image/png", "x")?.type).toBe("image");
    expect(blocoDoArquivo("image/heic", "x")).toBeNull();
  });

  it("o pedido lista as categorias ativas com o id", () => {
    expect(montarPedido("comprovante", categorias)).toContain("id 4: Combustível");
  });
});
