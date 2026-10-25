import { describe, expect, it } from "vitest";
import { camposPendentes, estadoCampos, type ContextoRegras } from "../src/features/chamados/cadastros/regras";
import { CADASTROS_INICIAIS } from "../src/features/chamados/cadastros/seed";
import { cadeiaServico, caminhoServico, chaveDoRotulo } from "../src/features/chamados/cadastros/types";

const { campos, regras, servicos } = CADASTROS_INICIAIS;
const base: ContextoRegras = { servicoId: null, categoriaId: null, urgenciaId: 3, setorId: 1, origem: "email", campos: {} };
const estado = (ctx: Partial<ContextoRegras>) => estadoCampos(campos, regras, { ...base, ...ctx }, servicos);

describe("regras para exibição (mesma lógica do banco)", () => {
  it("campo 'por regra' começa oculto; 'não' começa visível e opcional", () => {
    const e = estado({});
    expect(e.protocolo).toEqual({ visivel: false, obrigatorio: false });
    expect(e.forma_atendimento).toEqual({ visivel: true, obrigatorio: false });
  });

  it("Portais internos + Solicitação obriga o PROTOCOLO; com outra categoria, não", () => {
    expect(estado({ servicoId: 4, categoriaId: 3 }).protocolo).toEqual({ visivel: true, obrigatorio: true });
    expect(estado({ servicoId: 4, categoriaId: 2 }).protocolo.visivel).toBe(false);
  });

  it("condição de serviço vale para os filhos (regra sobre o pai)", () => {
    const regraPai = [{ id: 9, nome: "Infra", ordem: 9, ativa: true, condicoes: [{ campo: "servico" as const, operador: "um_de" as const, valores: ["6"] }], acoes: [{ acao: "obrigar" as const, campo: "patrimonio" }] }];
    expect(estadoCampos(campos, regraPai, { ...base, servicoId: 7 }, servicos).patrimonio.obrigatorio).toBe(true);
  });

  it("CFTV: câmera obrigatória e data do ocorrido visível", () => {
    const e = estado({ setorId: 2, servicoId: 12 });
    expect(e.camera).toEqual({ visivel: true, obrigatorio: true });
    expect(e.data_ocorrido.visivel).toBe(true);
  });

  it("a última regra vence; regra inativa não conta", () => {
    const extra = [...regras, { id: 10, nome: "Libera", ordem: 99, ativa: true, condicoes: [{ campo: "setor" as const, operador: "um_de" as const, valores: ["2"] }], acoes: [{ acao: "liberar" as const, campo: "camera" }] }];
    expect(estadoCampos(campos, extra, { ...base, setorId: 2 }, servicos).camera).toEqual({ visivel: true, obrigatorio: false });
    expect(estadoCampos(campos, extra.map((r) => ({ ...r, ativa: r.id !== 10 })), { ...base, setorId: 2 }, servicos).camera.obrigatorio).toBe(true);
  });

  it("pendentes: só obrigatórios visíveis e vazios", () => {
    const e = estado({ servicoId: 4, categoriaId: 3 });
    expect(camposPendentes(campos, e, {})).toEqual(["PROTOCOLO"]);
    expect(camposPendentes(campos, e, { protocolo: "  " })).toEqual(["PROTOCOLO"]);
    expect(camposPendentes(campos, e, { protocolo: "PGE-1" })).toEqual([]);
  });
});

describe("utilitários do catálogo", () => {
  it("caminho e cadeia do serviço", () => {
    expect(caminhoServico(7, servicos)).toBe("TI › Infraestrutura › Rede / VPN");
    expect(cadeiaServico(7, servicos)).toEqual([7, 6, 1]);
  });

  it("chave do campo a partir do rótulo", () => {
    expect(chaveDoRotulo("Obra / unidade")).toBe("obra_unidade");
    expect(chaveDoRotulo("Nº Patrimônio")).toBe("n_patrimonio");
    expect(chaveDoRotulo("1ª via")).toBe("c_1_via");
  });
});
