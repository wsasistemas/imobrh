export type KpiVariant = "default" | "danger" | "warning" | "info";

interface KpiCardProps {
  label: string;
  value: number | string;
  hint: string;
  variant?: KpiVariant;
  /** Selecionado = a fila está filtrada por esta métrica (outline 2px primary). */
  selected?: boolean;
  onClick?: () => void;
}

export function KpiCard({ label, value, hint, variant = "default", selected = false, onClick }: KpiCardProps) {
  return (
    <button
      type="button"
      className={`ds-kpi${variant === "default" ? "" : ` ds-kpi--${variant}`}`}
      aria-pressed={selected}
      onClick={onClick}
    >
      <span className="ds-kpi__label">{label}</span>
      <strong className="ds-kpi__value">{value}</strong>
      <small className="ds-kpi__hint">{hint} ↗</small>
    </button>
  );
}
