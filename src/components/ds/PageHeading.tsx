import type { ReactNode } from "react";

interface PageHeadingProps {
  eyebrow: string;
  title: string;
  description?: string;
  /** Botão de ação principal (CTA), à direita. */
  action?: ReactNode;
}

export function PageHeading({ eyebrow, title, description, action }: PageHeadingProps) {
  return (
    <div className="ds-heading">
      <div>
        <div className="ds-eyebrow">{eyebrow}</div>
        <h1 className="ds-h1">{title}</h1>
        {description && <p className="ds-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}
