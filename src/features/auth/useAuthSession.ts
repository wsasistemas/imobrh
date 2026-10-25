import { useContext } from "react";
import { AuthContext, type AuthContextValue } from "./AuthContext";

export function useAuthSession(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuthSession precisa estar dentro de <AuthProvider>.");
  return context;
}
