import { useState } from "react";
import { toast } from "sonner";
import { useAuthSession } from "./useAuthSession";

/** Sair da conta (sidebar e topo). Sem sessão, o RequireSession leva para /login sozinho. */
export function useSignOut() {
  const { signOut } = useAuthSession();
  const [signingOut, setSigningOut] = useState(false);

  const handleSignOut = async () => {
    setSigningOut(true);
    try {
      await signOut();
      toast.success("Sessão encerrada");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Não foi possível sair.");
      setSigningOut(false);
    }
  };

  return { signingOut, handleSignOut };
}
