import { format, isToday, isYesterday } from "date-fns";
import { ptBR } from "date-fns/locale";
import { SUPER_ADMIN_ROLE, type RoleKey } from "../../../config/app";
import { StatusBadge } from "../components/StatusBadge";
import type { LinkStatus, UserStatus } from "../services/types";

const STATUS_BADGES: Record<UserStatus, { label: string; variant: "success" | "neutral" | "warning" }> = {
  active: { label: "Ativo", variant: "success" },
  inactive: { label: "Inativo", variant: "neutral" },
  pending: { label: "Primeiro acesso pendente", variant: "warning" },
};

export function UserStatusBadge({ status }: { status: UserStatus }) {
  const badge = STATUS_BADGES[status];
  return <StatusBadge variant={badge.variant}>{badge.label}</StatusBadge>;
}

export function RoleBadge({ role, label }: { role: RoleKey | null; label: string | null }) {
  return <StatusBadge variant={role === SUPER_ADMIN_ROLE ? "danger" : "neutral"}>{label ?? "Sem papel"}</StatusBadge>;
}

const LINK_BADGES: Record<LinkStatus, { label: string; variant: "success" | "neutral" | "warning" | "danger" }> = {
  vinculado: { label: "Vinculado", variant: "success" },
  pendente: { label: "Pendente", variant: "warning" },
  divergente: { label: "Divergente", variant: "danger" },
  sem_registro: { label: "Sem vínculo", variant: "neutral" },
};

/** Situação do vínculo com o TOTVS RM (chapa quando vinculado). */
export function LinkStatusBadge({ status, chapa }: { status: LinkStatus; chapa: string | null }) {
  const badge = LINK_BADGES[status];
  return <StatusBadge variant={badge.variant}>{status === "vinculado" && chapa ? `Chapa ${chapa}` : badge.label}</StatusBadge>;
}

/** "hoje 08:42", "ontem 17:03", "12/09/2026" ou "nunca". */
export function formatLastAccess(iso: string | null): string {
  if (!iso) return "nunca";
  const date = new Date(iso);
  if (isToday(date)) return `hoje ${format(date, "HH:mm")}`;
  if (isYesterday(date)) return `ontem ${format(date, "HH:mm")}`;
  return format(date, "dd/MM/yyyy", { locale: ptBR });
}
