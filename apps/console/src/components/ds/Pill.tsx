import type { ReactNode } from "react";

export type PillTone = "neutral" | "red" | "amber" | "green" | "blue";

interface PillProps {
  tone?: PillTone;
  children: ReactNode;
}

/** Etiqueta curta. Estado de SLA sempre vai com texto (ex.: "Vencido há 2d 4h"), nunca só a cor. */
export function Pill({ tone = "neutral", children }: PillProps) {
  return <span className={`ds-pill${tone === "neutral" ? "" : ` ds-pill--${tone}`}`}>{children}</span>;
}
