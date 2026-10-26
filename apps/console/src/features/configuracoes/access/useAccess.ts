import { useContext } from "react";
import { AccessContext, type AccessContextValue } from "./AccessContext";

export function useAccess(): AccessContextValue {
  const context = useContext(AccessContext);
  if (!context) throw new Error("useAccess precisa estar dentro de <AccessProvider>.");
  return context;
}
