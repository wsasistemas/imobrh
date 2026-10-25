import { useState } from "react";
import { Navigate, useNavigate } from "react-router";
import { toast } from "sonner";
import { PageSkeleton } from "../../../components/PageSkeleton";
import { AuthShell } from "../../auth/AuthShell";
import { NewPasswordForm } from "../../auth/NewPasswordForm";
import { useAuthSession } from "../../auth/useAuthSession";
import { DevUserSwitcher } from "../access/DevUserSwitcher";
import { useAccess } from "../access/useAccess";
import { ErrorState } from "../components/ErrorState";
import { useChangePassword } from "../hooks/useAuth";
import { DATA_SOURCE } from "../services";
import { ServiceError } from "../services/types";
import "../../auth/authCard.css";

/** Tela fora do layout protegido: enquanto a troca for obrigatória, nenhuma outra rota abre. */
export function TrocarSenha() {
  const { isLoading, isError, refetch, mustChangePassword } = useAccess();

  if (isLoading) {
    return (
      <div className="auth-page">
        <PageSkeleton />
      </div>
    );
  }
  if (isError) {
    return (
      <div className="auth-page">
        <ErrorState message="Não foi possível carregar a sua sessão." onRetry={refetch} />
      </div>
    );
  }
  if (!mustChangePassword) return <Navigate to="/home" replace />;

  return (
    <AuthShell>
      <ChangePasswordCard />
    </AuthShell>
  );
}

function ChangePasswordCard() {
  const navigate = useNavigate();
  const changePassword = useChangePassword();
  const { signOut } = useAuthSession();
  const [signingOut, setSigningOut] = useState(false);
  // Senha que o serviço recusou por ser igual à temporária.
  const [reusedPassword, setReusedPassword] = useState<string | null>(null);

  const save = async (password: string) => {
    try {
      await changePassword.mutateAsync(password);
    } catch (error) {
      if (error instanceof ServiceError && error.code === "PASSWORD_REUSED") setReusedPassword(password);
      throw error instanceof ServiceError ? new Error(error.message) : error;
    }
    toast.success("Senha criada com sucesso");
    navigate("/home", { replace: true });
  };

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

  return (
    <div className="card auth-card">
      <h1>Crie uma nova senha</h1>
      <p>Por segurança, defina uma senha pessoal antes de continuar. Ela substitui a senha temporária que você recebeu.</p>

      <NewPasswordForm
        submitLabel="Salvar e continuar"
        disabled={signingOut}
        onSave={save}
        extraRules={(password) => [
          {
            id: "temporary",
            label: "Diferente da senha temporária",
            // Só o serviço conhece a temporária: fica pendente até salvar.
            state: reusedPassword !== null && reusedPassword === password ? "fail" : "pending",
          },
        ]}
      />

      <button type="button" className="auth-card__link" disabled={signingOut} onClick={() => void handleSignOut()}>
        Sair e voltar ao login
      </button>

      {import.meta.env.DEV && DATA_SOURCE === "mock" && <DevUserSwitcher />}
    </div>
  );
}
