import * as Dialog from "@radix-ui/react-dialog";
import * as RadioGroup from "@radix-ui/react-radio-group";
import { Eye, EyeOff, Info, KeyRound, TriangleAlert, X } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { MIN_PASSWORD_LENGTH, PASSWORD_RULES } from "../access/passwordRules";
import { useSetPasswordChangeRequired, useSetTemporaryPassword } from "../hooks/useUsers";
import { ServiceError, type User } from "../services/types";
import "../../auth/authCard.css";
import "../../auth/ChangeOwnPasswordDialog.css";
import "../components/Sheet.css";
import "./UserSheet.css";
import "./TempPasswordDialog.css";

type Method = "require" | "password";

/**
 * "Alterar senha" de outro usuário, no mesmo formato da "Forma de acesso" do cadastro:
 * exigir a troca no próximo login (recomendado, a senha atual continua valendo até lá) ou
 * definir uma senha temporária (esqueceu a senha), também com troca obrigatória no próximo login.
 */
export function TempPasswordDialog({ user, onClose }: { user: User | null; onClose: () => void }) {
  return (
    <Dialog.Root open={user !== null} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="card change-password">
          <div className="change-password__head">
            <span className="change-password__icon" aria-hidden="true">
              <KeyRound size={18} />
            </span>
            <div>
              <Dialog.Title>Alterar senha</Dialog.Title>
              <Dialog.Description>
                {user?.name} ({user?.email})
              </Dialog.Description>
            </div>
            <Dialog.Close className="icon-btn" aria-label="Fechar">
              <X size={16} />
            </Dialog.Close>
          </div>
          {user && <PasswordForm key={user.id} user={user} onDone={onClose} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function PasswordForm({ user, onDone }: { user: User; onDone: () => void }) {
  const ids = useId();
  const requireChange = useSetPasswordChangeRequired();
  const setPassword = useSetTemporaryPassword();
  const [method, setMethod] = useState<Method>("require");
  const [password, setPasswordValue] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = requireChange.isPending || setPassword.isPending;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      if (method === "require") {
        await requireChange.mutateAsync({ id: user.id, required: true });
        toast.success(`${user.name} vai precisar trocar a senha no próximo login`);
      } else {
        const missing = PASSWORD_RULES.filter((rule) => !rule.test(password)).map((rule) => rule.label.toLowerCase());
        if (missing.length > 0) {
          setError(`A senha temporária precisa de: ${missing.join(", ")}.`);
          return;
        }
        await setPassword.mutateAsync({ id: user.id, password });
        toast.success(`Senha temporária definida para ${user.name}. A troca será exigida no próximo login.`);
      }
      onDone();
    } catch (failure) {
      const message = failure instanceof ServiceError ? failure.message : "Não foi possível alterar a senha. Tente novamente.";
      if (method === "password") setError(message);
      else toast.error(message);
    }
  };

  return (
    <form className="change-password__body" onSubmit={submit} noValidate>
      <fieldset className="field sheet__fieldset">
        <legend className="field__label">Forma de alteração</legend>
        <RadioGroup.Root
          className="radio-cards"
          value={method}
          onValueChange={(value) => {
            setMethod(value as Method);
            setError(null);
          }}
          aria-label="Forma de alteração"
        >
          <RadioGroup.Item value="require" className="radio-card">
            <span className="radio-card__dot" aria-hidden="true">
              <RadioGroup.Indicator className="radio-card__dot-fill" />
            </span>
            <span>
              <strong>Exigir troca no próximo login (recomendado)</strong>
              <span>
                A pessoa entra com a senha atual e cria uma nova. Nenhuma senha muda agora
                {user.mustChangePassword ? " (a troca já está exigida)" : ""}.
              </span>
            </span>
          </RadioGroup.Item>
          <RadioGroup.Item value="password" className="radio-card">
            <span className="radio-card__dot" aria-hidden="true">
              <RadioGroup.Indicator className="radio-card__dot-fill" />
            </span>
            <span>
              <strong>Definir senha temporária</strong>
              <span>Para quem esqueceu a senha. A troca de senha é exigida no próximo login.</span>
            </span>
          </RadioGroup.Item>
        </RadioGroup.Root>
      </fieldset>

      {method === "password" && (
        <>
          <div className="field">
            <label className="field__label" htmlFor={`${ids}-password`}>
              Senha temporária
            </label>
            <div className="input-with-action">
              <input
                id={`${ids}-password`}
                type={show ? "text" : "password"}
                className="input"
                autoComplete="new-password"
                value={password}
                onChange={(event) => {
                  setPasswordValue(event.target.value);
                  setError(null);
                }}
                aria-invalid={error ? "true" : undefined}
                aria-describedby={`${ids}-password-help`}
              />
              <button
                type="button"
                className="icon-btn"
                aria-label={show ? "Ocultar senha" : "Mostrar senha"}
                onClick={() => setShow((value) => !value)}
              >
                {show ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
              </button>
            </div>
            <span id={`${ids}-password-help`} className={error ? "field__error" : "field__help"} role={error ? "alert" : undefined}>
              {error ?? `Mínimo de ${MIN_PASSWORD_LENGTH} caracteres, com uma letra maiúscula e um número.`}
            </span>
          </div>
          <p className="temp-password__warn">
            <TriangleAlert size={16} aria-hidden="true" />
            <span>O login é o mesmo dos outros sistemas da WSA: a senha atual deixa de valer em todos eles.</span>
          </p>
        </>
      )}

      <p className="sheet__notice">
        <Info size={16} aria-hidden="true" />
        A alteração fica registrada na auditoria com o seu usuário.
      </p>

      <div className="temp-password__actions">
        <Dialog.Close asChild>
          <button type="button" className="btn btn--outline" disabled={pending}>
            Cancelar
          </button>
        </Dialog.Close>
        <button type="submit" className="btn btn--primary" disabled={pending}>
          {pending ? "Salvando…" : method === "require" ? "Exigir troca" : "Definir senha temporária"}
        </button>
      </div>
    </form>
  );
}
