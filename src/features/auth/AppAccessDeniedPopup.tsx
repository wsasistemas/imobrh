import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { LogOut, ShieldAlert } from "lucide-react";
import "./AppAccessDeniedPopup.css";

/** Mesmo texto em todos os aplicativos da WSA (Permissões por aplicativo). */
export const APP_ACCESS_DENIED_MESSAGE = "Sem permissão nessa aplicação, contacte o Administrador.";

interface AppAccessDeniedPopupProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  email: string | null;
  signingOut: boolean;
  onSignOut: () => void;
}

/**
 * Pop-up de bloqueio de Permissões por aplicativo: fundo desfocado, entrada com zoom e um leve
 * tremor, escudo com pulso vermelho. Respeita prefers-reduced-motion.
 */
export function AppAccessDeniedPopup({ open, onOpenChange, email, signingOut, onSignOut }: AppAccessDeniedPopupProps) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="access-denied__overlay" />
        <AlertDialog.Content className="access-denied">
          <div className="access-denied__icon" aria-hidden="true">
            <span className="access-denied__pulse" />
            <span className="access-denied__pulse access-denied__pulse--late" />
            <ShieldAlert size={30} />
          </div>
          <AlertDialog.Title className="access-denied__title">Acesso bloqueado</AlertDialog.Title>
          <AlertDialog.Description className="access-denied__message">{APP_ACCESS_DENIED_MESSAGE}</AlertDialog.Description>
          {email && <p className="access-denied__email">{email}</p>}
          <div className="access-denied__actions">
            <AlertDialog.Cancel asChild>
              <button type="button" className="btn btn--outline">
                Entendi
              </button>
            </AlertDialog.Cancel>
            <button type="button" className="btn btn--primary" disabled={signingOut} onClick={onSignOut}>
              <LogOut size={16} aria-hidden="true" />
              {signingOut ? "Saindo…" : "Sair e entrar com outra conta"}
            </button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
