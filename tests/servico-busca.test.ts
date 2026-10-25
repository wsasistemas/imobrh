// Busca rápida do serviço na tela do ticket: todas as palavras, sem acento, e o último nível que começa com a busca primeiro.
import { describe, expect, it } from "vitest";
import { filtrarServicos } from "../src/features/chamados/ticket/ServicoBusca";

const opcoes = [
  { id: 1, rotulo: "T.I. - Infraestrutura › Solicitação › Instalação de impressora" },
  { id: 2, rotulo: "T.I. - Infraestrutura › Incidente › Impressora" },
  { id: 3, rotulo: "T.I. - Sistemas › TOTVS › Acesso ao Sistema" },
  { id: 4, rotulo: "T.I. - Infraestrutura › Incidente › Acesso à VPN" },
];

describe("filtrarServicos", () => {
  it("o nível final que começa com a busca vem primeiro", () => {
    expect(filtrarServicos(opcoes, "impr").map((o) => o.id)).toEqual([2, 1]);
  });
  it("ignora acento e combina palavras de níveis diferentes", () => {
    expect(filtrarServicos(opcoes, "acesso vpn").map((o) => o.id)).toEqual([4]);
    expect(filtrarServicos(opcoes, "totvs acesso").map((o) => o.id)).toEqual([3]);
    expect(filtrarServicos(opcoes, "solicitacao").map((o) => o.id)).toEqual([1]);
  });
  it("sem busca devolve a lista; sem resultado, vazio", () => {
    expect(filtrarServicos(opcoes, "  ")).toHaveLength(4);
    expect(filtrarServicos(opcoes, "cftv")).toEqual([]);
  });
});
