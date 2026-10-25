import { useEffect, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router";
import { toast } from "sonner";
import { useAccess } from "./useAccess";

const NO_ACCESS_TOAST_ID = "no-access";

/** Libera a rota atual conforme o menuRegistry; sem permissão, volta para /home com aviso. */
export function RequirePermission({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const { canAccessPath } = useAccess();

  if (!canAccessPath(pathname)) return <RedirectHome />;
  return children;
}

function RedirectHome() {
  useEffect(() => {
    // O id evita toast duplicado (StrictMode e trocas rápidas de usuário).
    toast.error("Você não tem acesso a esta área", { id: NO_ACCESS_TOAST_ID });
  }, []);
  return <Navigate to="/home" replace />;
}
