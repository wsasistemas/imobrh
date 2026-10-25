import type { ReactNode } from "react";
import { Navigate } from "react-router";
import { useAccess } from "./useAccess";

export const CHANGE_PASSWORD_PATH = "/trocar-senha";

/** Enquanto a troca de senha for obrigatória, qualquer rota protegida leva para /trocar-senha. */
export function PasswordGate({ children }: { children: ReactNode }) {
  const { mustChangePassword } = useAccess();
  if (mustChangePassword) return <Navigate to={CHANGE_PASSWORD_PATH} replace />;
  return children;
}
