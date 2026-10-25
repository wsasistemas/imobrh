import { UserX } from "lucide-react";
import type { ReactNode } from "react";
import { Navigate } from "react-router";
import { PageSkeleton } from "../../../components/PageSkeleton";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { PasswordGate } from "./PasswordGate";
import { RequirePermission } from "./RequirePermission";
import { useAccess } from "./useAccess";

/**
 * Guard do layout protegido (a sessão do Supabase já foi exigida pelo RequireSession), nesta ordem:
 * 1. carregando → skeleton; 2. e-mail sem acesso ao portal (ou bloqueado na Central) → App do solicitante (/app), que mostra o aviso;
 * 3. troca de senha obrigatória → /trocar-senha; 4. sem perfil → aviso;
 * 5. sem permissão para a rota → /home com toast.
 * App do solicitante: perfil Solicitante, ou e-mail de uma empresa cliente ainda sem cadastro no portal → app do solicitante (/app),
 * que faz o 1º acesso. O bloqueio manual da Central também é conferido lá.
 */
const SOLICITANTE_ROLE = "solicitante";

export function AccessGate({ children }: { children: ReactNode }) {
  const { isLoading, isError, errorCode, refetch, role } = useAccess();

  if (isLoading) return <PageSkeleton />;
  if (isError && (errorCode === "NO_PORTAL_ACCESS" || errorCode === "NO_APP_ACCESS")) {
    return <Navigate to="/app" replace />;
  }
  if (role === SOLICITANTE_ROLE) return <Navigate to="/app" replace />;
  if (isError) {
    return <ErrorState message="Não foi possível carregar as suas permissões." onRetry={refetch} />;
  }

  return (
    <PasswordGate>
      {role ? (
        <RequirePermission>{children}</RequirePermission>
      ) : (
        <div className="card">
          <EmptyState
            icon={UserX}
            title="Sem perfil atribuído"
            description="A sua conta ainda não tem um perfil de acesso. Peça a um administrador para atribuir um."
          />
        </div>
      )}
    </PasswordGate>
  );
}

