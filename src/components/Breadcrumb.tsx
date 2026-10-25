import { Home } from "lucide-react";
import { Link } from "react-router";
import "./Breadcrumb.css";

export interface BreadcrumbItem {
  label: string;
  /** Rota do item; o último item (página atual) nunca é link. */
  to?: string;
}

interface BreadcrumbProps {
  items: BreadcrumbItem[];
}

export function Breadcrumb({ items }: BreadcrumbProps) {
  return (
    <nav className="breadcrumb" aria-label="Trilha de navegação">
      <Home size={14} aria-hidden="true" />
      {items.map((item, index) => {
        // Apenas o último item (página atual) recebe destaque visual.
        const isLast = index === items.length - 1;
        return (
          <span key={item.label} className={isLast ? "breadcrumb__current" : undefined}>
            {index > 0 && <span className="breadcrumb__separator">/</span>}
            {isLast ? (
              <span aria-current="page">{item.label}</span>
            ) : item.to ? (
              <Link to={item.to} className="breadcrumb__link">
                {item.label}
              </Link>
            ) : (
              item.label
            )}
          </span>
        );
      })}
    </nav>
  );
}
