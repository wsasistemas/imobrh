import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { IconeIlustrativo } from "../../../components/ds/IconeColorido";
import "./EmptyState.css";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
}

export function EmptyState({ icon: Icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <div className="empty-state__icon">
        <IconeIlustrativo icon={Icon} size={22} />
      </div>
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
}
