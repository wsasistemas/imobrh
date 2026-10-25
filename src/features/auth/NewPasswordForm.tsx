import { zodResolver } from "@hookform/resolvers/zod";
import { Eye, EyeOff } from "lucide-react";
import { useId, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { meetsPasswordRules } from "../configuracoes/access/passwordRules";
import { PasswordChecklist, type ExtraRule } from "./PasswordChecklist";

const schema = z
  .object({
    newPassword: z.string().refine(meetsPasswordRules, "A senha não atende aos requisitos abaixo."),
    confirmPassword: z.string(),
  })
  .refine((values) => values.newPassword === values.confirmPassword, {
    path: ["confirmPassword"],
    message: "As senhas não conferem.",
  });

type NewPasswordValues = z.infer<typeof schema>;

interface NewPasswordFormProps {
  submitLabel: string;
  /** Regras extras do checklist, calculadas a partir da senha digitada. */
  extraRules?: (password: string) => ExtraRule[];
  /** Salva a senha. Um erro lançado aparece embaixo do campo "Nova senha". */
  onSave: (password: string) => Promise<void>;
  disabled?: boolean;
}

/** Nova senha + confirmação, com checklist ao vivo. Usado na troca obrigatória e na redefinição. */
export function NewPasswordForm({ submitLabel, extraRules, onSave, disabled = false }: NewPasswordFormProps) {
  const ids = useId();
  const [showPassword, setShowPassword] = useState(false);
  const {
    register,
    handleSubmit,
    watch,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<NewPasswordValues>({
    resolver: zodResolver(schema),
    defaultValues: { newPassword: "", confirmPassword: "" },
  });

  const newPassword = watch("newPassword");
  const fieldId = (name: string) => `${ids}-${name}`;

  const onSubmit = handleSubmit(async ({ newPassword: password }) => {
    try {
      await onSave(password);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Não foi possível salvar a senha.";
      setError("newPassword", { type: "server", message }, { shouldFocus: true });
    }
  });

  return (
    <form className="auth-card__form" onSubmit={onSubmit} noValidate>
      <div className="field">
        <label className="field__label" htmlFor={fieldId("new")}>
          Nova senha
        </label>
        <div className="input-with-action">
          <input
            id={fieldId("new")}
            type={showPassword ? "text" : "password"}
            className="input"
            autoComplete="new-password"
            autoFocus
            aria-invalid={errors.newPassword ? "true" : undefined}
            aria-describedby={`${fieldId("rules")}${errors.newPassword ? ` ${fieldId("new-error")}` : ""}`}
            {...register("newPassword")}
          />
          <button
            type="button"
            className="icon-btn"
            aria-label={showPassword ? "Ocultar senhas" : "Mostrar senhas"}
            onClick={() => setShowPassword((value) => !value)}
          >
            {showPassword ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
          </button>
        </div>
        {errors.newPassword && (
          <span id={fieldId("new-error")} className="field__error">
            {errors.newPassword.message}
          </span>
        )}
      </div>

      <div className="field">
        <label className="field__label" htmlFor={fieldId("confirm")}>
          Confirmar nova senha
        </label>
        <input
          id={fieldId("confirm")}
          type={showPassword ? "text" : "password"}
          className="input"
          autoComplete="new-password"
          aria-invalid={errors.confirmPassword ? "true" : undefined}
          aria-describedby={errors.confirmPassword ? fieldId("confirm-error") : undefined}
          {...register("confirmPassword")}
        />
        {errors.confirmPassword && (
          <span id={fieldId("confirm-error")} className="field__error">
            {errors.confirmPassword.message}
          </span>
        )}
      </div>

      <PasswordChecklist id={fieldId("rules")} password={newPassword} extraRules={extraRules?.(newPassword)} />

      <button type="submit" className="btn btn--primary btn--lg auth-card__submit" disabled={disabled || isSubmitting}>
        {isSubmitting ? "Salvando…" : submitLabel}
      </button>
    </form>
  );
}
