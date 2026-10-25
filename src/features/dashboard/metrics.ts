import type { KpiVariant, QueueTableRow } from "../../components/ds";
import { isClosed } from "./queue";
import type { DashboardMetric, DashboardPayload, DashboardScope, DashboardTicket } from "./types";

/** Os 6 KPIs, na ordem da referência. Usados no Dashboard e no resumo da Página Inicial. */
export const METRICS: { key: Exclude<DashboardMetric, "all">; label: string; hint: string; variant: KpiVariant }[] = [
  { key: "unassigned", label: "Sem responsável", hint: "Aguardando atribuição", variant: "default" },
  { key: "late", label: "SLA vencido", hint: "Prioridade de atendimento", variant: "danger" },
  { key: "today", label: "Vencem hoje", hint: "Antecipe o próximo prazo", variant: "warning" },
  { key: "active", label: "Em atendimento", hint: "Com agente responsável", variant: "default" },
  { key: "waiting", label: "Aguardando terceiros", hint: "Solicitante ou fornecedor", variant: "default" },
  { key: "opened", label: "Abertos hoje", hint: "Entradas do dia", variant: "info" },
];

/** Nome de cada recorte da fila (rodapé da paginação e aviso de recorte vindo da Página Inicial). */
export const METRIC_LABELS: Record<DashboardMetric, string> = {
  all: "Todos",
  ...(Object.fromEntries(METRICS.map((m) => [m.key, m.label])) as Record<(typeof METRICS)[number]["key"], string>),
  open: "Abertos",
  pending: "Pendentes",
  closed: "Fechados nos últimos 7 dias",
};

const SCOPES: readonly DashboardScope[] = ["mine", "team", "all"];
const METRIC_KEYS = Object.keys(METRIC_LABELS) as DashboardMetric[];

export function parseScope(value: string | null): DashboardScope | null {
  return SCOPES.includes(value as DashboardScope) ? (value as DashboardScope) : null;
}

export function parseMetric(value: string | null): DashboardMetric | null {
  return METRIC_KEYS.includes(value as DashboardMetric) ? (value as DashboardMetric) : null;
}

/** Link para a Gestão de Chamados já filtrada (lido pelo Dashboard na abertura). */
export function dashboardLink(path: string, params: { scope?: DashboardScope; metric?: DashboardMetric; ticket?: number }): string {
  const search = new URLSearchParams();
  if (params.scope) search.set("escopo", params.scope);
  if (params.metric && params.metric !== "all") search.set("metrica", params.metric);
  if (params.ticket) search.set("ticket", String(params.ticket));
  const qs = search.toString();
  return qs ? `${path}?${qs}` : path;
}

const CLOSED_FORMAT = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });

/** Ticket da RPC → linha da QueueTable ("Você" quando o responsável é o usuário atual). */
export function toQueueRow(t: DashboardTicket, data: Pick<DashboardPayload, "services" | "current_user">): QueueTableRow {
  return {
    id: t.id,
    requester: t.requester,
    subject: t.subject,
    team: t.team,
    service: data.services.find((s) => s.id === t.service_id)?.name ?? "",
    origin: t.origin,
    owner: t.owner ? { name: t.owner.id === data.current_user.id ? "Você" : t.owner.name, initials: t.owner.initials } : null,
    dueMinutes: t.sla_due_minutes,
    closedLabel: isClosed(t) && t.closed_at ? `${t.status} em ${CLOSED_FORMAT.format(new Date(t.closed_at))}` : undefined,
  };
}
