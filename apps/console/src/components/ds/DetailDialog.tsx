import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";

interface DetailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Texto curto acima do título (ex.: "ABERTURA DE SOLICITAÇÃO"). */
  eyebrow?: string;
  /** Linha abaixo do cabeçalho; vira a descrição acessível do diálogo. */
  description?: string;
  closeLabel?: string;
  children: ReactNode;
}

/** Diálogo do design system (base do NewTicketDialog). O conteúdo leva .ds porque o Radix renderiza fora da página. */
export function DetailDialog({ open, onOpenChange, title, eyebrow, description, closeLabel = "Fechar detalhes", children }: DetailDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="ds-overlay" />
        <Dialog.Content className="ds ds-dialog" {...(description ? {} : { "aria-describedby": undefined })}>
          <div className="ds-row">
            <div>
              {eyebrow && <div className="ds-eyebrow">{eyebrow}</div>}
              <Dialog.Title className="ds-h2">{title}</Dialog.Title>
            </div>
            <Dialog.Close className="ds-close" aria-label={closeLabel}>
              <X size={16} strokeWidth={1.6} aria-hidden="true" />
            </Dialog.Close>
          </div>
          {description && <Dialog.Description className="ds-subtitle">{description}</Dialog.Description>}
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Corpo padrão do detalhe (grade com espaçamento de 14px). */
export function DetailBody({ children }: { children: ReactNode }) {
  return <div className="ds-detail">{children}</div>;
}
