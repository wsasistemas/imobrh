import { Lock } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router";
import { toast } from "sonner";
import { menuRegistry } from "../../../config/menuRegistry";
import { EmptyState } from "../components/EmptyState";
import { useAccess } from "./useAccess";

const NO_ACCESS_TOAST_ID = "no-access";

/**
 * Libera a rota atual conforme o menuRegistry (guarda de rota por papel). Sem permissão, vai para a primeira tela
 * liberada ao papel, com aviso; sem nenhuma tela liberada, mostra o aviso no lugar.
 */
export function RequirePermission({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const { canAccessPath, canOpen } = useAccess();

  if (canAccessPath(pathname)) return children;
  const first = menuRegistry.find((item) => !item.parent && canOpen(item.id));
  if (!first || first.path === pathname) {
    return (
      <div className="card">
        <EmptyState icon={Lock} title="Nenhuma tela liberada" description="O seu papel ainda não tem menus liberados. Peça ao Administrador do RH." />
      </div>
    );
  }
  return <RedirectTo path={first.path} />;
}

function RedirectTo({ path }: { path: string }) {
  useEffect(() => {
    // O id evita toast duplicado (StrictMode e trocas rápidas de usuário).
    toast.error("Você não tem acesso a esta área", { id: NO_ACCESS_TOAST_ID });
  }, []);
  return <Navigate to={path} replace />;
}
