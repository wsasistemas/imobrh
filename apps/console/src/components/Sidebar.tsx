import * as Popover from "@radix-ui/react-popover";
import { ChevronRight, LogOut, PanelLeftClose, PanelLeftOpen, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { Link, NavLink, useLocation } from "react-router";
import { CONFIG_ROOT_PATH, menuGroups, menuItemsByGroup, routeChildrenOf, type MenuItem } from "../config/menuRegistry";
import { useAccess } from "../features/configuracoes/access/useAccess";
import { useSignOut } from "../features/auth/useSignOut";
import { IconeDoMenu as IconeMenu } from "./ds/IconeColorido";
import "./Sidebar.css";

interface SidebarProps {
  collapsed: boolean;
  onCollapse: () => void;
}

export function Sidebar({ collapsed, onCollapse }: SidebarProps) {
  const { canOpen, hasPermission, isLoading } = useAccess();
  const { signingOut, handleSignOut } = useSignOut();

  // Itens vêm do menuRegistry, filtrados pela permissão do usuário logado.
  const mainItems = menuItemsByGroup("principal").filter((item) => canOpen(item.id));
  const configItems = menuItemsByGroup("configuracoes").filter((item) => canOpen(item.id));

  const renderItem = (item: MenuItem) => {
    // Nome na lateral: menuLabel quando houver (ex.: Gestão de Tickets), senão o label.
    const nome = item.menuLabel ?? item.label;
    // Item com seções (ex.: Módulo exemplo) vira grupo; as seções liberadas são os subitens.
    const sections = routeChildrenOf(item.id).filter((section) => hasPermission(section.id));
    if (sections.length > 0) {
      const group: NavGroupData = { id: item.id, label: nome, icon: item.icon, rootPath: item.path, items: sections };
      return collapsed ? <NavFlyout key={item.id} group={group} /> : <NavGroup key={item.id} group={group} />;
    }
    return (
      <li key={item.id}>
        <NavLink
          to={item.path}
          end={item.path === "/"}
          className={({ isActive }) => `sidebar__item${isActive ? " sidebar__item--active" : ""}`}
          title={collapsed ? nome : undefined}
          aria-label={collapsed ? nome : undefined}
        >
          <IconeMenu id={item.id} icon={item.icon} />
          {!collapsed && <span>{nome}</span>}
        </NavLink>
      </li>
    );
  };

  return (
    <aside className={`sidebar${collapsed ? " sidebar--collapsed" : ""}`}>
      {/* A marca (logo + nome do sistema) fica na topbar; só o menu rola, o rodapé fica parado. */}
      <nav className="sidebar__nav" aria-label="Menu lateral">
        {!collapsed && <p className="sidebar__label">{menuGroups.principal.label}</p>}
        {isLoading ? (
          <div className="sidebar__loading" aria-busy="true" aria-label="Carregando menu">
            {Array.from({ length: 4 }, (_, index) => (
              <span key={index} className="sidebar__loading-bar" />
            ))}
          </div>
        ) : (
          <ul>
            {mainItems.map(renderItem)}

            {/* O grupo some quando nenhum subitem sobra para o perfil. */}
            {configItems.length > 0 &&
              (collapsed ? <NavFlyout group={configGroup(configItems)} /> : <NavGroup group={configGroup(configItems)} />)}
          </ul>
        )}
      </nav>

      <div className="sidebar__footer">
        <button
          type="button"
          className="sidebar__footer-item"
          onClick={onCollapse}
          aria-label={collapsed ? "Expandir menu" : undefined}
        >
          {collapsed ? <IconeMenu id="rodape_expandir" icon={PanelLeftOpen} /> : <IconeMenu id="rodape_recolher" icon={PanelLeftClose} />}
          {!collapsed && <span>Recolher menu</span>}
        </button>
        <button
          type="button"
          className="sidebar__footer-item"
          aria-label={collapsed ? "Sair" : undefined}
          disabled={signingOut}
          onClick={() => void handleSignOut()}
        >
          <IconeMenu id="rodape_sair" icon={LogOut} />
          {!collapsed && <span>Sair</span>}
        </button>
      </div>
    </aside>
  );
}

interface NavGroupData {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Tela raiz do grupo (o link do título). */
  rootPath: string;
  items: MenuItem[];
}

function configGroup(items: MenuItem[]): NavGroupData {
  return { id: "configuracoes", label: menuGroups.configuracoes.label, icon: menuGroups.configuracoes.icon, rootPath: CONFIG_ROOT_PATH, items };
}

function useIsInside(rootPath: string): boolean {
  const { pathname } = useLocation();
  return pathname === rootPath || pathname.startsWith(`${rootPath}/`);
}

function SubItems({ items, onNavigate }: { items: MenuItem[]; onNavigate?: () => void }) {
  return (
    <ul className="sidebar__subitems">
      {items.map((item) => (
        <li key={item.id}>
          <NavLink
            to={item.path}
            onClick={onNavigate}
            className={({ isActive }) => `sidebar__subitem${isActive ? " sidebar__subitem--active" : ""}`}
          >
            <IconeMenu id={item.id} icon={item.icon} tamanho={18} />
            <span>{item.label}</span>
          </NavLink>
        </li>
      ))}
    </ul>
  );
}

/** Sidebar expandida: grupo com trilho vertical; abre sozinho ao entrar na área do grupo. */
function NavGroup({ group }: { group: NavGroupData }) {
  const inside = useIsInside(group.rootPath);
  const [open, setOpen] = useState(inside);
  const [wasInside, setWasInside] = useState(inside);
  const listId = `sidebar-${group.id}-items`;

  // Ajuste durante a renderização: ao entrar na área do grupo, ele expande.
  if (inside !== wasInside) {
    setWasInside(inside);
    if (inside) setOpen(true);
  }

  return (
    <li>
      <div className={`sidebar__group${inside ? " sidebar__group--active" : ""}`}>
        <Link to={group.rootPath} className="sidebar__group-link" aria-current={inside ? "true" : undefined}>
          <IconeMenu id={group.id} icon={group.icon} />
          <span>{group.label}</span>
        </Link>
        <button
          type="button"
          className="sidebar__group-toggle"
          aria-expanded={open}
          aria-controls={listId}
          aria-label={open ? `Recolher ${group.label}` : `Expandir ${group.label}`}
          onClick={() => setOpen((value) => !value)}
        >
          <ChevronRight size={16} className={`sidebar__chevron${open ? " sidebar__chevron--open" : ""}`} />
        </button>
      </div>
      {open && (
        <div id={listId}>
          <SubItems items={group.items} />
        </div>
      )}
    </li>
  );
}

/** Sidebar recolhida: os subitens abrem em flyout ao lado do ícone. */
function NavFlyout({ group }: { group: NavGroupData }) {
  const inside = useIsInside(group.rootPath);
  const [open, setOpen] = useState(false);

  return (
    <li>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button type="button" className={`sidebar__item${inside ? " sidebar__item--active" : ""}`} aria-label={group.label}>
            <IconeMenu id={group.id} icon={group.icon} />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content side="right" align="start" sideOffset={14} className="sidebar-flyout">
            <Link to={group.rootPath} className="sidebar-flyout__title" onClick={() => setOpen(false)}>
              {group.label}
            </Link>
            <SubItems items={group.items} onNavigate={() => setOpen(false)} />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </li>
  );
}
