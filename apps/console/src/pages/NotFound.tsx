import { SearchX } from "lucide-react";
import { Link } from "react-router";
import { EmptyState } from "../features/configuracoes/components/EmptyState";

export function NotFound() {
  return (
    <div className="card">
      <EmptyState
        icon={SearchX}
        title="Página não encontrada"
        description="O endereço acessado não existe ou foi removido."
        action={
          <Link to="/" className="btn btn--primary">
            Voltar ao início
          </Link>
        }
      />
    </div>
  );
}
