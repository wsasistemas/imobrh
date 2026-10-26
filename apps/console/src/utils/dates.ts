import { differenceInMinutes, format, formatDistanceToNowStrict } from "date-fns";
import { ptBR } from "date-fns/locale";

/** "25/09/2026 14:10". */
export function formatDateTime(iso: string): string {
  return format(new Date(iso), "dd/MM/yyyy HH:mm", { locale: ptBR });
}

/** "25/09/2026". */
export function formatDate(iso: string): string {
  return format(new Date(iso), "dd/MM/yyyy", { locale: ptBR });
}

/** Atividade nos últimos 2 minutos conta como "agora". */
export function isNow(iso: string): boolean {
  return differenceInMinutes(new Date(), new Date(iso)) < 2;
}

/** "agora", "há 15 minutos", "há 2 dias". */
export function formatRelative(iso: string): string {
  if (isNow(iso)) return "agora";
  return formatDistanceToNowStrict(new Date(iso), { locale: ptBR, addSuffix: true });
}
