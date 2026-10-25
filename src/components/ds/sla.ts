/** Minutos até o prazo em texto curto: "2d 4h", "3h 10min", "45min". */
export function formatDuration(minutes: number): string {
  const n = Math.abs(Math.round(minutes));
  if (n >= 1440) return `${Math.floor(n / 1440)}d ${Math.floor((n % 1440) / 60)}h`;
  if (n >= 60) return `${Math.floor(n / 60)}h${n % 60 ? ` ${n % 60}min` : ""}`;
  return `${n}min`;
}

/** Abaixo disto (12h) o prazo conta como "vence hoje" (âmbar). */
export const SLA_SOON_MINUTES = 720;

export type SlaTone = "red" | "amber" | "blue";

export function slaTone(dueMinutes: number): SlaTone {
  if (dueMinutes < 0) return "red";
  return dueMinutes < SLA_SOON_MINUTES ? "amber" : "blue";
}

/** Texto do SLA, sempre junto da cor: "Vencido há 2d 4h" / "Vence em 3h". */
export function slaLabel(dueMinutes: number): string {
  return `${dueMinutes < 0 ? "Vencido há" : "Vence em"} ${formatDuration(dueMinutes)}`;
}
