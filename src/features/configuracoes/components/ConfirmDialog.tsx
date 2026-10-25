import * as AlertDialog from "@radix-ui/react-alert-dialog";
import type { ReactNode } from "react";
import { useReturnFocus } from "./useReturnFocus";
import "./ConfirmDialog.css";

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  tone: "warning" | "danger";
  isPending: boolean;
  onConfirm: () => void;
}

/** Confirmação de ação sensível. Fica aberta enquanto a ação roda; quem chama fecha ao concluir. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  tone,
  isPending,
  onConfirm,
}: ConfirmDialogProps) {
  const returnFocus = useReturnFocus();
  return (
    <AlertDialog.Root open={open} onOpenChange={(next) => !isPending && onOpenChange(next)}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="overlay" />
        <AlertDialog.Content className="confirm-dialog" {...returnFocus}>
          <AlertDialog.Title className="confirm-dialog__title">{title}</AlertDialog.Title>
          <AlertDialog.Description className="confirm-dialog__description">{description}</AlertDialog.Description>
          <div className="confirm-dialog__actions">
            <AlertDialog.Cancel asChild>
              <button type="button" className="btn btn--outline" disabled={isPending}>
                Cancelar
              </button>
            </AlertDialog.Cancel>
            <button type="button" className={`btn btn--${tone}`} disabled={isPending} onClick={onConfirm}>
              {isPending ? "Aguarde…" : confirmLabel}
            </button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
