import type { ComponentPropsWithoutRef, ReactNode } from "react";

interface PanelProps extends ComponentPropsWithoutRef<"section"> {
  /** Padding interno de 20px (painéis do rail); sem ele, cada bloco define o seu. */
  padded?: boolean;
}

export function Panel({ padded = false, className, children, ...rest }: PanelProps) {
  return (
    <section className={["ds-panel", padded && "ds-panel--padded", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </section>
  );
}

interface PanelHeaderProps {
  title: string;
  subtitle?: ReactNode;
  /** Conteúdo à direita do título (pill, legenda, ícone). */
  aside?: ReactNode;
  titleId?: string;
  /** false nos painéis que já têm padding (rail). */
  inset?: boolean;
}

export function PanelHeader({ title, subtitle, aside, titleId, inset = true }: PanelHeaderProps) {
  return (
    <div className={`ds-row${inset ? " ds-panel__head" : ""}`}>
      <div>
        <h2 className="ds-h2" id={titleId}>
          {title}
        </h2>
        {subtitle && <p className="ds-subtitle">{subtitle}</p>}
      </div>
      {aside}
    </div>
  );
}
