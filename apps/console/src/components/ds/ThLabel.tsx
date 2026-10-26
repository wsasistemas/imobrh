import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { IconeIlustrativo } from "./IconeColorido";

/** Título de coluna com ícone (padrão de todas as tabelas do portal). O ícone é decorativo. */
export function ThLabel({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <span className="th-label">
      <IconeIlustrativo icon={Icon} size={14} className="th-label__icon" />
      {children}
    </span>
  );
}
