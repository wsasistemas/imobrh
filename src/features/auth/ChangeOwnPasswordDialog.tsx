import * as Dialog from "@radix-ui/react-dialog";
import { Eye, EyeOff, KeyRound, X } from "lucide-react";
import { useId, useState, type ReactElement } from "react";
import { toast } from "sonner";
import { useChangeOwnPassword } from "../configuracoes/hooks/useAuth";
import { ServiceError } from "../configuracoes/services/types";
import { NewPasswordForm } from "./NewPasswordForm";
import "./authCard.css";
import "./ChangeOwnPasswordDialog.css";

/**
 * "Alterar senha" do próprio usuário logado (inclusive a conta proprietária, que ninguém mais
 * pode alterar). Pede a senha atual para reautenticar antes de gravar a nova.
 */
export function ChangeOwnPasswordDialog({ trigger }: { trigger: ReactElement }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="card change-password">
          <div className="change-password__head">
            <span className="change-password__icon" aria-hidden="true">
              <KeyRound size={18} />
            </span>
            <div>
              <Dialog.Title>Alterar senha</Dialog.Title>
              <Dialog.Description>Confirme a senha atual e defina a nova. As outras sessões continuam abertas.</Dialog.Description>
            </div>
            <Dialog.Close className="icon-btn" aria-label="Fechar">
              <X size={16} />
            </Dialog.Close>
          </div>
          {open && <Form onDone={() => setOpen(false)} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Form({ onDone }: { onDone: () => void }) {
  const ids = useId();
  const change = useChangeOwnPassword();
  const [current, setCurrent] = useState("");
  const [show, setShow] = useState(false);
  const [currentError, setCurrentError] = useState<string | null>(null);

  const save = async (next: string) => {
    if (!current) {
      setCurrentError("Informe a senha atual.");
      throw new Error("Confira a senha atual acima.");
    }
    setCurrentError(null);
    try {
      await change.mutateAsync({ current, next });
    } catch (error) {
      if (error instanceof ServiceError && error.field === "currentPassword") {
        setCurrentError(error.message);
        throw new Error("Confira a senha atual acima.");
      }
      throw error instanceof ServiceError ? new Error(error.message) : error;
    }
    toast.success("Senha alterada com sucesso");
    onDone();
  };

  return (
    <div className="change-password__body">
      <div className="field">
        <label className="field__label" htmlFor={`${ids}-current`}>
          Senha atual
        </label>
        <div className="input-with-action">
          <input
            id={`${ids}-current`}
            className="input"
            type={show ? "text" : "password"}
            autoComplete="current-password"
            value={current}
            onChange={(event) => {
              setCurrent(event.target.value);
              setCurrentError(null);
            }}
            aria-invalid={currentError ? true : undefined}
            aria-describedby={currentError ? `${ids}-current-error` : undefined}
          />
          <button type="button" className="icon-btn" onClick={() => setShow((v) => !v)} aria-label={show ? "Ocultar senha" : "Mostrar senha"}>
            {show ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>
        {currentError && (
          <p id={`${ids}-current-error`} className="field__error" role="alert">
            {currentError}
          </p>
        )}
      </div>
      <NewPasswordForm
        submitLabel="Salvar nova senha"
        onSave={save}
        extraRules={(password) => [
          {
            id: "different",
            label: "Diferente da senha atual",
            state: !password ? "pending" : current && password === current ? "fail" : "ok",
          },
        ]}
      />
    </div>
  );
}
