import type { ReactNode } from "react";
import "./StatusBadge.css";

export type StatusBadgeVariant = "success" | "neutral" | "warning" | "danger" | "info";

interface StatusBadgeProps {
  variant: StatusBadgeVariant;
  children: ReactNode;
  icon?: ReactNode;
}

/** Badge em pílula. success: Ativo · neutral: Inativo · warning: pendências · danger: super admin · info: Você. */
export function StatusBadge({ variant, children, icon }: StatusBadgeProps) {
  return (
    <span className={`status-badge status-badge--${variant}`}>
      {icon}
      {children}
    </span>
  );
}
