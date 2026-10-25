import { describe, expect, it } from "vitest";
import { JUSTIFICATIVA_ID, STATUS_ID } from "../src/features/chamados/status/seed";
import { atende, atendeCondicoes, colunaDoTicket, ordenarTickets, type ContextoAvaliacao } from "../src/features/chamados/visoes/avaliar";
import { permissoesVisoes } from "../src/features/chamados/visoes/permissoes";
import { KANBAN_PADRAO, VISOES_INICIAIS } from "../src/features/chamados/visoes/seed";
import { validarVisao } from "../src/features/chamados/visoes/service";
import type { Condicao, VisaoSalvar } from "../src/features/chamados/visoes/types";
import { dashboardMock } from "../src/features/dashboard/mock";

const { tickets, services } = dashboardMock;
const ctx: ContextoAvaliacao = {
  userId: "u-ana",
  now: new Date(dashboardMock.generated_at),
  servicoNome: (id) => services.find((s) => s.id === id)?.name ?? "",
};
const quantos = (c: Condicao) => tickets.filter((t) => atende(t, c, ctx)).length;

describe("avaliador de condições das visões", () => {
  it("igual / diferente aceitam vários valores (OU) e ignoram maiúsculas", () => {
    const sistemas = quantos({ campo: "equipe", operador: "igual", valores: ["sistemas"] });
    const infra = quantos({ campo: "equipe", operador: "igual", valores: ["Infraestrutura"] });
    expect(sistemas + infra).toBe(tickets.length);
    expect(quantos({ campo: "equipe", operador: "igual", valores: ["Sistemas", "Infraestrutura"] })).toBe(tickets.length);
    expect(quantos({ campo: "equipe", operador: "diferente", valores: ["Sistemas"] })).toBe(infra);
  });

  it("responsável: vazio, preenchido e usuário logado", () => {
    const vazio = quantos({ campo: "responsavel", operador: "vazio", valores: [] });
    expect(vazio).toBe(tickets.filter((t) => !t.owner).length);
    expect(quantos({ campo: "responsavel", operador: "preenchido", valores: [] })).toBe(tickets.length - vazio);
    expect(quantos({ campo: "responsavel", operador: "usuario_logado", valores: [] })).toBe(tickets.filter((t) => t.owner?.id === "u-ana").length);
  });

  it("TAG: diferente de Verificado inclui quem não tem tag; vazio = sem nenhuma", () => {
    const verificados = tickets.filter((t) => t.tags.includes("Verificado")).length;
    expect(verificados).toBeGreaterThan(0);
    expect(quantos({ campo: "tag", operador: "diferente", valores: ["Verificado"] })).toBe(tickets.length - verificados);
    expect(quantos({ campo: "tag", operador: "vazio", valores: [] })).toBe(tickets.filter((t) => t.tags.length === 0).length);
  });

  it("status e justificativa pelo id do cadastro", () => {
    expect(quantos({ campo: "status", operador: "igual", valores: [String(STATUS_ID.novo)] })).toBe(17);
    const retorno = quantos({ campo: "justificativa", operador: "igual", valores: [String(JUSTIFICATIVA_ID.retornoCliente)] });
    expect(retorno).toBe(tickets.filter((t) => t.justificativa_id === JUSTIFICATIVA_ID.retornoCliente).length);
  });

  it("SLA e Criado em", () => {
    expect(quantos({ campo: "sla", operador: "vencido", valores: [] })).toBe(38);
    expect(quantos({ campo: "sla", operador: "vence_hoje", valores: [] })).toBe(5);
    expect(quantos({ campo: "criado_em", operador: "ultimos_dias", valores: ["1"] })).toBe(29);
  });

  it("combinadas (E) + independentes (ao menos uma)", () => {
    const todas: Condicao[] = [{ campo: "equipe", operador: "igual", valores: ["Sistemas"] }];
    const qualquer: Condicao[] = [
      { campo: "sla", operador: "vencido", valores: [] },
      { campo: "responsavel", operador: "vazio", valores: [] },
    ];
    const esperado = tickets.filter((t) => t.team === "Sistemas" && ((t.sla_due_minutes < 0 && !t.closed_at) || !t.owner)).length;
    expect(tickets.filter((t) => atendeCondicoes(t, { todas, qualquer }, ctx)).length).toBe(esperado);
    expect(tickets.filter((t) => atendeCondicoes(t, { todas: [], qualquer: [] }, ctx)).length).toBe(tickets.length);
  });
});

describe("Kanban e ordenação", () => {
  it("cada ticket cai numa coluna do Kanban padrão; justificativa exata vence a genérica", () => {
    const semColuna = tickets.filter((t) => colunaDoTicket(t, KANBAN_PADRAO) === null);
    expect(semColuna).toHaveLength(0);
    const preFech = tickets.find((t) => t.justificativa_id === JUSTIFICATIVA_ID.preFechamento)!;
    expect(colunaDoTicket(preFech, KANBAN_PADRAO)).toBe("pre-fechamento");
    const novo = tickets.find((t) => t.status_id === STATUS_ID.novo)!;
    expect(colunaDoTicket(novo, KANBAN_PADRAO)).toBe("a-fazer");
  });

  it("ordenar por SLA põe os vencidos primeiro e os encerrados no fim", () => {
    const o = ordenarTickets(tickets, "sla");
    expect(o[0].sla_due_minutes).toBe(-3120);
    expect(o[o.length - 1].closed_at).not.toBeNull();
  });
});

describe("permissões e validação", () => {
  it("agente usa; admin configura; só super admin exclui e define o padrão", () => {
    expect(permissoesVisoes("operador", false)).toEqual({ veTodas: false, podeConfigurar: false, podeExcluir: false, podeDefinirPadrao: false });
    expect(permissoesVisoes("admin", false)).toEqual({ veTodas: true, podeConfigurar: true, podeExcluir: false, podeDefinirPadrao: false });
    expect(permissoesVisoes("super_admin", true)).toEqual({ veTodas: true, podeConfigurar: true, podeExcluir: true, podeDefinirPadrao: true });
  });

  it("valida nome, valor das condições e colunas do Kanban", () => {
    const v = VISOES_INICIAIS[0] as VisaoSalvar;
    expect(() => validarVisao(v)).not.toThrow();
    expect(() => validarVisao({ ...v, nome: " " })).toThrow(/nome/);
    expect(() => validarVisao({ ...v, condicoes: { todas: [{ campo: "tag", operador: "igual", valores: [""] }], qualquer: [] } })).toThrow(/valor/);
    expect(() => validarVisao({ ...v, condicoes: { todas: [{ campo: "tag", operador: "ultimos_dias", valores: ["1"] }], qualquer: [] } })).toThrow(/inválido/);
    expect(() => validarVisao({ ...v, kanban: { ...v.kanban, colunas: [] } })).toThrow(/coluna/);
  });
});
