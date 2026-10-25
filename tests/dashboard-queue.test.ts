import { describe, expect, it } from "vitest";
import { dashboardLink, parseMetric, parseScope, toQueueRow } from "../src/features/dashboard/metrics";
import { dashboardMock } from "../src/features/dashboard/mock";
import { baseTickets, clampPage, closedToday, metricPredicates, queueTickets, type BaseFilters } from "../src/features/dashboard/queue";
import type { DashboardMetric } from "../src/features/dashboard/types";

// Os números esperados saem do script da referência (Downloads/02-dashboard.html) rodado sobre a mesma amostra.

const { tickets, current_user, my_teams } = dashboardMock;
const now = new Date(dashboardMock.generated_at);
const P = metricPredicates(now);
const inicial: BaseFilters = { scope: "team", team: "", origin: "", currentUserId: current_user.id, myTeams: my_teams };

function kpis(f: BaseFilters) {
  const base = baseTickets(tickets, f);
  return Object.fromEntries(
    (["all", "late", "today", "unassigned", "active", "waiting", "opened"] as DashboardMetric[]).map((m) => [m, base.filter(P[m]).length]),
  );
}

describe("fila do dashboard", () => {
  it("KPIs do estado inicial batem com a referência", () => {
    expect(kpis(inicial)).toEqual({ all: 76, late: 38, today: 5, unassigned: 17, active: 32, waiting: 27, opened: 29 });
  });

  it("escopo Meus conta só os tickets do usuário atual", () => {
    expect(kpis({ ...inicial, scope: "mine" })).toEqual({ all: 20, late: 7, today: 2, unassigned: 0, active: 11, waiting: 9, opened: 4 });
  });

  it("ticket sem equipe (aberto por e-mail) entra em Minhas equipes", () => {
    const semEquipe = { ...tickets[0], id: 9999, team: "", owner: null };
    expect(baseTickets([semEquipe], inicial).map((t) => t.id)).toEqual([9999]);
    expect(baseTickets([semEquipe], { ...inicial, team: "Infraestrutura" })).toEqual([]);
  });

  it("equipe e origem combinam com o escopo", () => {
    expect(kpis({ ...inicial, team: "Infraestrutura" })).toMatchObject({ all: 34, late: 0, today: 1, waiting: 27 });
    expect(kpis({ ...inicial, origin: "E-mail" })).toMatchObject({ all: 32, late: 13, today: 3, opened: 9 });
    expect(kpis({ ...inicial, team: "Infraestrutura", origin: "E-mail" }).late).toBe(0);
  });

  it("fila vem ordenada por vencimento, vencidos primeiro", () => {
    const fila = queueTickets(baseTickets(tickets, inicial), "all", "", now);
    expect(fila[0].sla_due_minutes).toBe(-3120);
    expect(fila.every((t, i) => i === 0 || fila[i - 1].sla_due_minutes <= t.sla_due_minutes)).toBe(true);
  });

  it("KPI recorta a fila pela métrica", () => {
    const base = baseTickets(tickets, inicial);
    expect(queueTickets(base, "late", "", now)).toHaveLength(38);
    expect(queueTickets(base, "today", "", now).every((t) => t.sla_due_minutes >= 0 && t.sla_due_minutes < 720)).toBe(true);
    expect(queueTickets(base, "unassigned", "", now).every((t) => t.owner === null)).toBe(true);
  });

  it("busca por nº, assunto ou solicitante", () => {
    const base = baseTickets(tickets, inicial);
    expect(queueTickets(base, "all", "48214", now).map((t) => t.id)).toEqual([48214]);
    expect(queueTickets(base, "all", "sienge", now)).toHaveLength(21);
    expect(queueTickets(base, "all", "MARIANA", now).every((t) => t.requester === "Mariana Costa")).toBe(true);
  });

  it("página volta para dentro do intervalo quando a lista encolhe", () => {
    expect(clampPage(5, 13)).toBe(2);
    expect(clampPage(3, 0)).toBe(0);
  });

  it("links da Página Inicial levam escopo, métrica e ticket, e o Dashboard só aceita valores válidos", () => {
    expect(dashboardLink("/gestao-chamados", { scope: "mine", metric: "late" })).toBe("/gestao-chamados?escopo=mine&metrica=late");
    expect(dashboardLink("/gestao-chamados", { scope: "team", metric: "all", ticket: 48213 })).toBe("/gestao-chamados?escopo=team&ticket=48213");
    expect(dashboardLink("/gestao-chamados", {})).toBe("/gestao-chamados");
    expect(parseScope("mine")).toBe("mine");
    expect(parseScope("x")).toBeNull();
    expect(parseMetric("opened")).toBe("opened");
    expect(parseMetric(null)).toBeNull();
  });

  it("linha da fila mostra Você quando o responsável é o usuário atual", () => {
    const meu = tickets.find((t) => t.owner?.id === current_user.id)!;
    expect(toQueueRow(meu, dashboardMock).owner?.name).toBe("Você");
    expect(toQueueRow(tickets[0], dashboardMock)).toMatchObject({ owner: null, service: "ERP Sienge", dueMinutes: -3120 });
  });

  it("resumo Abertos · Pendentes · Fechados (7 dias) por escopo e por usuário", () => {
    const resumo = (f: BaseFilters) => {
      const base = baseTickets(tickets, f);
      return {
        open: base.filter(P.open).length,
        pending: base.filter(P.pending).length,
        closed: base.filter(P.closed).length,
        closedToday: base.filter((t) => closedToday(t, now)).length,
      };
    };
    expect(resumo(inicial)).toEqual({ open: 49, pending: 27, closed: 25, closedToday: 2 });
    expect(resumo({ ...inicial, scope: "mine" })).toEqual({ open: 11, pending: 9, closed: 9, closedToday: 1 });
    expect(resumo({ ...inicial, scope: "mine", currentUserId: "u-ana" })).toMatchObject({ closed: 8, closedToday: 1 });
    expect(resumo({ ...inicial, scope: "mine", currentUserId: "u-ninguem" })).toEqual({ open: 0, pending: 0, closed: 0, closedToday: 0 });
  });

  it("fechados não entram na fila de trabalho e aparecem do mais recente ao mais antigo", () => {
    const base = baseTickets(tickets, inicial);
    expect(queueTickets(base, "all", "", now).some((t) => t.closed_at)).toBe(false);
    const fechados = queueTickets(base, "closed", "", now);
    expect(fechados[0].id).toBe(48183);
    expect(fechados.every((t, i) => i === 0 || Date.parse(fechados[i - 1].closed_at!) >= Date.parse(t.closed_at!))).toBe(true);
    expect(toQueueRow(fechados[0], dashboardMock).closedLabel).toMatch(/^Resolvido em 07\/10/);
  });
});
