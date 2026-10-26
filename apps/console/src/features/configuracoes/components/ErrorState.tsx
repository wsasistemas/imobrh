import { AlertTriangle, RotateCw } from "lucide-react";
import { EmptyState } from "./EmptyState";

interface ErrorStateProps {
  message: string;
  onRetry: () => void;
  /** Sem o card em volta, para uso dentro de tabelas e cards já existentes. */
  bare?: boolean;
}

export function ErrorState({ message, onRetry, bare = false }: ErrorStateProps) {
  const content = (
    <EmptyState
      icon={AlertTriangle}
      title="Algo deu errado"
      description={message}
      action={
        <button type="button" className="btn btn--outline" onClick={onRetry}>
          <RotateCw size={16} aria-hidden="true" />
          Tentar novamente
        </button>
      }
    />
  );

  return (
    <div className={bare ? undefined : "card"} role="alert">
      {content}
    </div>
  );
}
