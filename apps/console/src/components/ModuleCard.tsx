import { ArrowRight, type LucideIcon } from "lucide-react";
import { Link } from "react-router";
import { getMenuItem, type MenuItemId } from "../config/menuRegistry";
import { useAccess } from "../features/configuracoes/access/useAccess";
import { IconeDoMenu, IconeIlustrativo } from "./ds/IconeColorido";
import "./ModuleCard.css";

/** Cor do quadro do ícone (tons do design system: marca, info, sucesso, aviso). */
export type ModuleAccent = "brand" | "info" | "success" | "warning";

export interface ModuleCardData {
  title: string;
  description: string;
  icon: LucideIcon;
  accent: ModuleAccent;
  /** Rota do card inteiro. */
  to: string;
  /** Item do menu que libera o card. */
  permission: MenuItemId;
  /** Atalhos para as telas do módulo (itens do menu com `parent`). */
  shortcuts?: MenuItemId[];
  /** Destaque visual (borda da marca). */
  highlighted?: boolean;
}

/**
 * Card de módulo (visão geral de Configurações). O card inteiro é um link (camada por cima), e os atalhos
 * ficam acima dessa camada para abrir cada tela direto. Só aparecem os atalhos liberados ao usuário.
 */
export function ModuleCard({
  title,
  description,
  icon: Icon,
  accent,
  to,
  shortcuts = [],
  highlighted = false,
  index = 0,
}: ModuleCardData & { index?: number }) {
  const { hasPermission } = useAccess();
  const links = shortcuts.filter((id) => hasPermission(id)).map((id) => getMenuItem(id));

  return (
    <article className={`module-card module-card--${accent}${highlighted ? " module-card--highlighted" : ""}`} style={{ animationDelay: `${index * 70}ms` }}>
      <div className="module-card__icon" aria-hidden="true">
        <IconeIlustrativo icon={Icon} size={22} />
      </div>
      <h3>
        <Link to={to} className="module-card__stretched">
          {title}
        </Link>
      </h3>
      <p>{description}</p>

      {links.length > 0 && (
        <ul className="module-card__shortcuts" aria-label={`Atalhos de ${title}`}>
          {links.map((item) => (
            <li key={item.id}>
              <Link to={item.path} className="module-card__shortcut">
                <IconeDoMenu id={item.id} icon={item.icon} tamanho={16} />
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      )}

      <span className="module-card__cta" aria-hidden="true">
        Acessar módulo <ArrowRight size={14} />
      </span>
    </article>
  );
}
