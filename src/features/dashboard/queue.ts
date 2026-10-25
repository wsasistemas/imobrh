import { SLA_SOON_MINUTES } from "../../components/ds/sla";
import { CATEGORIAS_ENCERRADAS, CATEGORIAS_FECHADAS } from "../chamados/status/types";
import type { DashboardMetric, DashboardScope, DashboardTicket } from "./types";

// Regras da fila, iguais ao script da referência: o escopo, a equipe e a origem formam a "base"
// (que alimenta KPIs, alerta e distribuição); a métrica e a busca recortam só a fila.
// Os números saem da CATEGORIA do status (cadastro de status): resolvido/fechado/cancelado saem da fila de
// trabalho; resolvido e fechado entram na métrica "closed" (Fechados nos últimos 7 dias).

export const QUEUE_PAGE_SIZE = 6;

/** Janela do card Fechados. */
export const CLOSED_WINDOW_DAYS = 7;

const TIME_ZONE = "America/Sao_Paulo";
const DAY_MS = 86_400_000;

type Predicate = (t: DashboardTicket) => boolean;

/** Saiu da fila de trabalho (resolvido, fechado ou cancelado). */
export function isClosed(t: DashboardTicket): boolean {
  return CATEGORIAS_ENCERRADAS.includes(t.status_categoria);
}

const openOnly =
  (predicate: Predicate): Predicate =>
  (t) =>
    !isClosed(t) && predicate(t);

/** Dia civil em São Paulo (AAAA-MM-DD), para "fechados hoje" não depender do fuso do navegador. */
function localDay(date: Date): string {
  return date.toLocaleDateString("en-CA", { timeZone: TIME_ZONE });
}

/** Predicados de cada métrica. `now` é o `generated_at` do payload (o "agora" do servidor). */
export function metricPredicates(now: Date): Record<DashboardMetric, Predicate> {
  const windowStart = now.getTime() - CLOSED_WINDOW_DAYS * DAY_MS;
  return {
    all: openOnly(() => true),
    late: openOnly((t) => t.sla_due_minutes < 0),
    today: openOnly((t) => t.sla_due_minutes >= 0 && t.sla_due_minutes < SLA_SOON_MINUTES),
    unassigned: openOnly((t) => !t.owner),
    active: openOnly((t) => t.status_categoria === "andamento"),
    waiting: openOnly((t) => t.status_categoria === "pendente"),
    opened: (t) => t.opened_today,
    open: openOnly((t) => t.status_categoria === "novo" || t.status_categoria === "andamento"),
    pending: openOnly((t) => t.status_categoria === "pendente"),
    closed: (t) => CATEGORIAS_FECHADAS.includes(t.status_categoria) && t.closed_at !== null && Date.parse(t.closed_at) >= windowStart,
  };
}

/** Fechados no mesmo dia civil de `now`. */
export function closedToday(t: DashboardTicket, now: Date): boolean {
  return CATEGORIAS_FECHADAS.includes(t.status_categoria) && t.closed_at !== null && localDay(new Date(t.closed_at)) === localDay(now);
}

export interface BaseFilters {
  scope: DashboardScope;
  team: string;
  origin: string;
  currentUserId: string;
  /** Equipes do escopo "Minha equipe". */
  myTeams: readonly string[];
}

export function baseTickets(tickets: readonly DashboardTicket[], f: BaseFilters): DashboardTicket[] {
  return tickets.filter(
    (t) =>
      (f.scope !== "mine" || t.owner?.id === f.currentUserId) &&
      // Sem equipe (ex.: ticket aberto por e-mail num setor sem equipe padrão): o banco já só devolve os do setor
      // de quem vê, então entra em "Minhas equipes" para alguém assumir.
      (f.scope !== "team" || !t.team || f.myTeams.includes(t.team)) &&
      (!f.team || t.team === f.team) &&
      (!f.origin || t.origin === f.origin),
  );
}

/**
 * Fila: métrica + busca (nº, assunto ou solicitante). Vencidos primeiro e depois o próximo prazo;
 * em Fechados, o mais recente primeiro.
 */
export function queueTickets(base: readonly DashboardTicket[], metric: DashboardMetric, search: string, now: Date): DashboardTicket[] {
  const q = search.trim().toLowerCase();
  const byClosedDesc = (a: DashboardTicket, b: DashboardTicket) => Date.parse(b.closed_at ?? "") - Date.parse(a.closed_at ?? "");
  return base
    .filter(metricPredicates(now)[metric])
    .filter((t) => `${t.id} ${t.subject} ${t.requester}`.toLowerCase().includes(q))
    .sort(metric === "closed" ? byClosedDesc : (a, b) => a.sla_due_minutes - b.sla_due_minutes);
}

/** Mantém a página dentro do intervalo depois de um filtro reduzir a lista. */
export function clampPage(page: number, total: number, size = QUEUE_PAGE_SIZE): number {
  return Math.max(0, Math.min(page, Math.ceil(total / size) - 1));
}
