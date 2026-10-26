import type { ReactNode } from "react";
import { Navigate } from "react-router";
import { PageSkeleton } from "../../components/PageSkeleton";
import { useAuthSession } from "./useAuthSession";

export const LOGIN_PATH = "/login";

/** Sem sessão do Supabase, qualquer rota protegida vai para /login (e de lá sempre para a Página Inicial). */
export function RequireSession({ children }: { children: ReactNode }) {
  const { status } = useAuthSession();

  if (status === "loading") {
    return (
      <div className="auth-page">
        <PageSkeleton />
      </div>
    );
  }
  if (status === "signedOut") {
    return <Navigate to={LOGIN_PATH} replace />;
  }
  return children;
}
