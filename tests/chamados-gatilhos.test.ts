import { describe, expect, it } from "vitest";
import { CADASTROS_INICIAIS } from "../src/features/chamados/cadastros/seed";
import { condicaoAtende, gatilhoAtende, gatilhosDoEvento, validarGatilho, type ContextoGatilho } from "../src/features/chamados/gatilhos/motor";
import { gatilhosMock } from "../src/features/chamados/gatilhos/store";
import type { CondicaoGatilho, Gatilho } from "../src/features/chamados/gatilhos/types";

const { servicos } = CADASTROS_INICIAIS;
const base: ContextoGatilho = {
  statusId: 3,
  justificativaId: 1,
  urgenciaId: 3,
  categoriaId: 2,
  servicoId: 3,
  equipeId: 6,
  responsavelId: null,
  setorId: 1,
  origem: "email",
  tags: ["vip"],
  textos: ["Sienge não gera boleto", "Testei de novo e continua"],
  campos: { protocolo: "123" },
  dentroExpediente: true,
};
const se = (campo: CondicaoGatilho["campo"], operador: CondicaoGatilho["operador"], valores: string[] = []): CondicaoGatilho => ({ campo, operador, valores });
const vale = (c: CondicaoGatilho, ctx: Partial<ContextoGatilho> = {}, autor: "solicitante" | "agente" | "sistema" = "agente") => condicaoAtende(c, { ...base, ...ctx }, autor, servicos);

describe("condições dos gatilhos (mesma lógica de ch_gatilho_condicao)", () => {
  it("status casa pelo status ou pelo status com a justificativa", () => {
    expect(vale(se("status", "um_de", ["3"]))).toBe(true);
    expect(vale(se("status", "um_de", ["3:1"]))).toBe(true);
    expect(vale(se("status", "um_de", ["3:2"]))).toBe(false);
    expect(vale(se("status", "nao_um_de", ["2"]))).toBe(true);
  });

  it("serviço vale para o nó e para os de cima (está dentro de)", () => {
    const pai = servicos.find((s) => s.id === 3)!.paiId!;
    expect(vale(se("servico", "um_de", [String(pai)]))).toBe(true);
    expect(vale(se("servico", "vazio"), { servicoId: null })).toBe(true);
  });

  it("responsável vazio/preenchido, tags e texto contém (sem diferenciar maiúsculas)", () => {
    expect(vale(se("responsavel", "vazio"))).toBe(true);
    expect(vale(se("responsavel", "preenchido"), { responsavelId: "u-ana" })).toBe(true);
    expect(vale(se("tags", "um_de", ["vip", "x"]))).toBe(true);
    expect(vale(se("tags", "nao_um_de", ["vip"]))).toBe(false);
    expect(vale(se("texto", "contem", ["BOLETO"]))).toBe(true);
    expect(vale(se("texto", "nao_contem", ["senha"]))).toBe(true);
  });

  it("campo adicional, horário e quem fez a ação", () => {
    expect(vale(se("campo:protocolo", "preenchido"))).toBe(true);
    expect(vale(se("campo:patrimonio", "vazio"))).toBe(true);
    expect(vale(se("horario", "um_de", ["fora"]), { dentroExpediente: false })).toBe(true);
    expect(vale(se("autor", "um_de", ["solicitante"]), {}, "solicitante")).toBe(true);
    expect(vale(se("autor", "um_de", ["solicitante"]), {}, "agente")).toBe(false);
  });

  it("TODAS e QUALQUER (QUALQUER vazia não filtra)", () => {
    const g = { todas: [se("status", "um_de", ["3"])], qualquer: [] as CondicaoGatilho[] };
    expect(gatilhoAtende(g, base, "agente", servicos)).toBe(true);
    expect(gatilhoAtende({ ...g, qualquer: [se("origem", "um_de", ["whatsapp"])] }, base, "agente", servicos)).toBe(false);
    expect(gatilhoAtende({ ...g, qualquer: [se("origem", "um_de", ["whatsapp"]), se("urgencia", "um_de", ["3"])] }, base, "agente", servicos)).toBe(true);
  });
});

describe("gatilhos do evento e validação", () => {
  const lista: Gatilho[] = gatilhosMock().map((g) => ({ ...g, ativo: true }));

  it("só os ativos com o disparo, na ordem da lista", () => {
    expect(gatilhosDoEvento(lista, ["acao_solicitante"]).map((g) => g.id)).toEqual([1]);
    expect(gatilhosDoEvento(lista, ["criado", "status"]).map((g) => g.id)).toEqual([3]);
    expect(gatilhosDoEvento(gatilhosMock(), ["criado"])).toEqual([]); // exemplos começam inativos (G7)
  });

  it("exige disparo, horas válidas, valores e ação completa", () => {
    const ok = { nome: "Teste", disparos: [{ tipo: "criado" as const }], todas: [], qualquer: [], acoes: [{ tipo: "nota_interna", texto: "oi" }] };
    expect(validarGatilho(ok)).toBeNull();
    expect(validarGatilho({ ...ok, disparos: [] })).toMatch(/disparo/);
    expect(validarGatilho({ ...ok, disparos: [{ tipo: "tempo_status", horas: 0 }] })).toMatch(/horas/);
    expect(validarGatilho({ ...ok, todas: [se("status", "um_de")] })).toMatch(/condições/);
    expect(validarGatilho({ ...ok, acoes: [{ tipo: "nota_interna", texto: " " }] })).toMatch(/ações/);
    expect(validarGatilho({ ...ok, acoes: [] })).toMatch(/pelo menos uma ação/);
  });
});
