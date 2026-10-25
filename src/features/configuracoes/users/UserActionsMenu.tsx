import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { KeyRound, LockKeyhole, MoreHorizontal, Pencil, RotateCcwKey, Trash2, UserCheck, UserX } from "lucide-react";
import type { User } from "../services/types";

interface UserActionsMenuProps {
  user: User;
  onEdit: () => void;
  onSendReset: () => void;
  /** Abre "Alterar senha": exigir troca no próximo login ou definir senha temporária. */
  onChangePassword: () => void;
  onRemovePasswordChange: () => void;
  onDeactivate: () => void;
  onReactivate: () => void;
  onDelete: () => void;
}

export function UserActionsMenu({
  user,
  onEdit,
  onSendReset,
  onChangePassword,
  onRemovePasswordChange,
  onDeactivate,
  onReactivate,
  onDelete,
}: UserActionsMenuProps) {
  return (
    // modal={false}: permite abrir o Sheet/diálogo a partir do menu sem travar o foco da página.
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="icon-btn" aria-label={`Ações para ${user.name}`}>
          <MoreHorizontal size={18} aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={4} className="menu">
          <DropdownMenu.Item className="menu__item" onSelect={onEdit}>
            <Pencil size={16} aria-hidden="true" />
            Editar usuário
          </DropdownMenu.Item>
          <DropdownMenu.Item className="menu__item" onSelect={onSendReset}>
            <KeyRound size={16} aria-hidden="true" />
            Enviar link de redefinição de senha
          </DropdownMenu.Item>
          <DropdownMenu.Item className="menu__item" onSelect={onChangePassword}>
            <LockKeyhole size={16} aria-hidden="true" />
            Alterar senha
          </DropdownMenu.Item>
          {user.mustChangePassword && (
            <DropdownMenu.Item className="menu__item" onSelect={onRemovePasswordChange}>
              <RotateCcwKey size={16} aria-hidden="true" />
              Remover exigência de troca de senha
            </DropdownMenu.Item>
          )}
          <DropdownMenu.Separator className="menu__separator" />
          {user.status === "inactive" ? (
            <DropdownMenu.Item className="menu__item" onSelect={onReactivate}>
              <UserCheck size={16} aria-hidden="true" />
              Reativar usuário
            </DropdownMenu.Item>
          ) : (
            <DropdownMenu.Item className="menu__item menu__item--warning" onSelect={onDeactivate}>
              <UserX size={16} aria-hidden="true" />
              Inativar e encerrar sessões
            </DropdownMenu.Item>
          )}
          <DropdownMenu.Item className="menu__item menu__item--danger" onSelect={onDelete}>
            <Trash2 size={16} aria-hidden="true" />
            Excluir usuário
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
