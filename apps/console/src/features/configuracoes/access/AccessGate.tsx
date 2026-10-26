import { ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";
import { PageSkeleton } from "../../../components/PageSkeleton";
import { AppAccessDeniedPopup } from "../../auth/AppAccessDeniedPopup";
import { useAuthSession } from "../../auth/useAuthSession";
import { useSignOut } from "../../auth/useSignOut";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { RequirePermission } from "./RequirePermission";
import { useAccess } from "./useAccess";

/**
 * Guard do layout protegido (a sessão do Supabase já foi exigida pelo RequireSession), nesta ordem:
 * 1. carregando → skeleton;
 * 2. login sem papel de RH no Console (colaborador, gestor e diretoria usam o app do imobdesk) → aviso de acesso
 *    bloqueado, com a opção de sair e entrar com outra conta;
 * 3. sem permissão para a rota → primeira tela liberada, com toast (RequirePermission).
 */
export function AccessGate({ children }: { children: ReactNode }) {
  const { isLoading, isError, errorCode, refetch } = useAccess();
  const { email } = useAuthSession();
  const { signingOut, handleSignOut } = useSignOut();

  if (isLoading) return <PageSkeleton />;
  if (isError && (errorCode === "NO_APP_ACCESS" || errorCode === "NO_PORTAL_ACCESS" || errorCode === "SEM_PERMISSAO")) {
    return (
      <>
        <div className="card">
          <EmptyState
            icon={ShieldAlert}
            title="Sem acesso ao Console do RH"
            description="O Console é usado pela equipe de RH. Pedidos de férias, atestados e documentos são feitos no app do imobdesk."
          />
        </div>
        <AppAccessDeniedPopup open onOpenChange={() => {}} email={email} signingOut={signingOut} onSignOut={() => void handleSignOut()} />
      </>
    );
  }
  if (isError) return <ErrorState message="Não foi possível carregar as suas permissões." onRetry={refetch} />;

  return <RequirePermission>{children}</RequirePermission>;
}
