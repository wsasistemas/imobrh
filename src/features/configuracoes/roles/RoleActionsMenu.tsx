import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import type { RoleSummary } from "../services/types";

interface RoleActionsMenuProps {
  role: RoleSummary;
  onEdit: () => void;
  onDelete: () => void;
}

export function RoleActionsMenu({ role, onEdit, onDelete }: RoleActionsMenuProps) {
  const inUse = role.userCount > 0;

  return (
    // modal={false}: permite abrir o Sheet/diálogo a partir do menu sem travar o foco da página.
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="icon-btn" aria-label={`Ações do perfil ${role.label}`}>
          <MoreHorizontal size={18} aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={4} className="menu">
          <DropdownMenu.Item className="menu__item" onSelect={onEdit}>
            <Pencil size={16} aria-hidden="true" />
            Editar perfil
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="menu__separator" />
          <DropdownMenu.Item className="menu__item menu__item--danger" disabled={inUse} onSelect={onDelete}>
            <Trash2 size={16} aria-hidden="true" />
            <span>
              Excluir perfil
              {inUse && <span className="menu__hint">Mude o perfil dos usuários antes de excluir</span>}
            </span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
