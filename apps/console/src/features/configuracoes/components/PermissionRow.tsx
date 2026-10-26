import * as Switch from "@radix-ui/react-switch";
import type { CSSProperties } from "react";
import type { PermissionEntry } from "../../../config/menuRegistry";
import { StatusBadge } from "./StatusBadge";
import "./PermissionRow.css";

interface PermissionRowProps {
  item: PermissionEntry;
  checked: boolean;
  /** Travado: sempre visível, exclusivo de super admin, perfil não editável ou pai negado. */
  locked: boolean;
  changed: boolean;
  /** O perfil não tem regra para o item (negado por padrão). */
  noRule: boolean;
  /** Nível de aninhamento: 0 = item de menu; 1+ = seção ou ação dentro dele. */
  depth?: number;
  /** Nome do item pai quando a ação depende dele e ele está negado. */
  requires?: string;
  onChange: (checked: boolean) => void;
}

export function PermissionRow({ item, checked, locked, changed, noRule, depth = 0, requires, onChange }: PermissionRowProps) {
  const Icon = item.icon;

  return (
    <li
      className={`permission-row${changed ? " permission-row--changed" : ""}${depth > 0 ? " permission-row--nested" : ""}`}
      style={depth > 0 ? ({ "--permission-depth": depth } as CSSProperties) : undefined}
    >
      <Icon size={18} className="permission-row__icon" aria-hidden="true" />
      <div className="permission-row__text">
        <span className="permission-row__label">{item.label}</span>
        <code className="permission-row__id">{item.id}</code>
      </div>
      <div className="permission-row__badges">
        {item.kind === "action" && <StatusBadge variant="info">Ação</StatusBadge>}
        {item.alwaysVisible && <StatusBadge variant="success">Sempre visível</StatusBadge>}
        {item.superAdminOnly && <StatusBadge variant="danger">Somente super admin</StatusBadge>}
        {item.adminOnly && <StatusBadge variant="danger">Somente admin e super admin</StatusBadge>}
        {requires && <StatusBadge variant="neutral">Requer {requires}</StatusBadge>}
        {changed && <StatusBadge variant="warning">Alterado</StatusBadge>}
        {!changed && noRule && !locked && <StatusBadge variant="warning">Negado por padrão</StatusBadge>}
      </div>
      <Switch.Root
        className="switch"
        checked={checked}
        disabled={locked}
        onCheckedChange={onChange}
        aria-label={`Liberar ${item.label}`}
      >
        <Switch.Thumb className="switch__thumb" />
      </Switch.Root>
    </li>
  );
}
