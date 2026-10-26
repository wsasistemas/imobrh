import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowLeft, Eye, EyeOff, Lock, Mail, TriangleAlert } from "lucide-react";
import { useId, useState, type KeyboardEvent } from "react";
import { useForm } from "react-hook-form";
import { Navigate } from "react-router";
import { z } from "zod";
import { STORAGE_PREFIX } from "../../../config/app";
import { RECOVER_SENT_MESSAGE } from "../../../lib/authGateway";
import { AuthShell } from "../AuthShell";
import { AuthFailure } from "../authErrors";
import { useAuthSession } from "../useAuthSession";
import "../authCard.css";

const loginSchema = z.object({
  email: z.email("Informe um e-mail válido."),
  password: z.string().min(1, "Informe a senha."),
});

const resetSchema = z.object({ email: z.email("Informe um e-mail válido.") });

type LoginValues = z.infer<typeof loginSchema>;
type ResetValues = z.infer<typeof resetSchema>;

/** Só o e-mail fica guardado neste navegador (nunca a senha), e só se o usuário marcar. */
const REMEMBER_KEY = `${STORAGE_PREFIX}:login-email`;

function readRemembered(): string {
  try {
    return localStorage.getItem(REMEMBER_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveRemembered(email: string | null) {
  try {
    if (email) localStorage.setItem(REMEMBER_KEY, email);
    else localStorage.removeItem(REMEMBER_KEY);
  } catch {
    // navegador sem armazenamento: segue sem lembrar
  }
}

function failureMessage(error: unknown): string {
  return error instanceof AuthFailure ? error.message : "Não foi possível concluir. Tente novamente.";
}

/** Entrada do portal: e-mail e senha do Supabase (o acesso vem do cadastro do usuário na empresa). */
export function Login() {
  const { status } = useAuthSession();
  const [mode, setMode] = useState<"login" | "reset">("login");

  // Login sempre abre a Página Inicial, mesmo que o usuário tenha sido redirecionado
  // para cá a partir de outra rota protegida.
  if (status === "signedIn") {
    return <Navigate to="/" replace />;
  }

  return (
    <AuthShell kicker="Acesso da equipe de RH">
      <div className="card auth-card">
        {mode === "login" ? <LoginForm onForgot={() => setMode("reset")} /> : <ResetForm onBack={() => setMode("login")} />}
      </div>
    </AuthShell>
  );
}

function LoginForm({ onForgot }: { onForgot: () => void }) {
  const ids = useId();
  const { signIn, notice, clearNotice } = useAuthSession();
  const remembered = readRemembered();
  const [remember, setRemember] = useState(remembered !== "");
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [failure, setFailure] = useState<{ text: string; at: number } | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginValues>({ resolver: zodResolver(loginSchema), defaultValues: { email: remembered, password: "" } });

  const onSubmit = handleSubmit(async ({ email, password }) => {
    setFailure(null);
    clearNotice();
    try {
      await signIn(email, password);
      saveRemembered(remember ? email.trim().toLowerCase() : null);
      // Sucesso: o AuthProvider muda o status e a própria tela redireciona.
    } catch (error) {
      // `at` muda a chave do alerta: um novo erro repete a animação.
      setFailure({ text: failureMessage(error), at: Date.now() });
    }
  });

  const message = failure?.text ?? notice;
  const fieldId = (name: string) => `${ids}-${name}`;
  const checkCaps = (event: KeyboardEvent<HTMLInputElement>) => setCapsLock(event.getModifierState?.("CapsLock") ?? false);

  return (
    <>
      <h1>Entrar</h1>
      <p>Acesse o sistema com o seu e-mail.</p>

      {message && (
        <p key={failure?.at ?? "notice"} className="auth-card__alert auth-card__alert--error" role="alert">
          {message}
        </p>
      )}

      <form className="auth-card__form" onSubmit={onSubmit} noValidate>
        <div className="field">
          <label className="field__label" htmlFor={fieldId("email")}>
            E-mail
          </label>
          <div className="auth-input">
            <Mail size={16} className="auth-input__icon" aria-hidden="true" />
            <input
              id={fieldId("email")}
              type="email"
              className="input"
              autoComplete="username"
              autoFocus={!remembered}
              placeholder="voce@suaempresa.com.br"
              aria-invalid={errors.email ? "true" : undefined}
              aria-describedby={errors.email ? fieldId("email-error") : undefined}
              {...register("email")}
            />
          </div>
          {errors.email && (
            <span id={fieldId("email-error")} className="field__error">
              {errors.email.message}
            </span>
          )}
        </div>

        <div className="field">
          <label className="field__label" htmlFor={fieldId("password")}>
            Senha
          </label>
          <div className="auth-input auth-input--action">
            <Lock size={16} className="auth-input__icon" aria-hidden="true" />
            <input
              id={fieldId("password")}
              type={showPassword ? "text" : "password"}
              className="input"
              autoComplete="current-password"
              autoFocus={Boolean(remembered)}
              placeholder="••••••••"
              aria-invalid={errors.password ? "true" : undefined}
              aria-describedby={[errors.password ? fieldId("password-error") : "", capsLock ? fieldId("caps") : ""].filter(Boolean).join(" ") || undefined}
              onKeyDown={checkCaps}
              onKeyUp={checkCaps}
              {...register("password", { onBlur: () => setCapsLock(false) })}
            />
            <button
              type="button"
              className="icon-btn"
              aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"}
              aria-pressed={showPassword}
              onClick={() => setShowPassword((value) => !value)}
            >
              {showPassword ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
            </button>
          </div>
          {capsLock && (
            <span id={fieldId("caps")} className="auth-caps" role="status">
              <TriangleAlert size={13} aria-hidden="true" /> Caps Lock está ligado
            </span>
          )}
          {errors.password && (
            <span id={fieldId("password-error")} className="field__error">
              {errors.password.message}
            </span>
          )}
        </div>

        <div className="mpl-links">
          <label className="auth-remember">
            <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
            Lembrar meu e-mail
          </label>
          <button type="button" className="auth-card__link" onClick={onForgot}>
            Esqueceu a senha?
          </button>
        </div>

        <button type="submit" className="btn btn--primary btn--lg auth-card__submit" disabled={isSubmitting} aria-busy={isSubmitting}>
          {isSubmitting ? (
            <>
              Entrando… <span className="auth-spinner" aria-hidden="true" />
            </>
          ) : (
            <>
              Entrar <span className="mpl-seta" aria-hidden="true">→</span>
            </>
          )}
        </button>
      </form>
    </>
  );
}

function ResetForm({ onBack }: { onBack: () => void }) {
  const ids = useId();
  const { requestPasswordReset } = useAuthSession();
  const [sent, setSent] = useState(false);
  const [failure, setFailure] = useState<{ text: string; at: number } | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ResetValues>({ resolver: zodResolver(resetSchema), defaultValues: { email: readRemembered() } });

  const onSubmit = handleSubmit(async ({ email }) => {
    setFailure(null);
    try {
      await requestPasswordReset(email);
      setSent(true);
    } catch (error) {
      setFailure({ text: failureMessage(error), at: Date.now() });
    }
  });

  return (
    <>
      <h1>Redefinir senha</h1>
      <p>Informe o seu e-mail. Enviaremos um link para você criar uma nova senha.</p>

      {sent && (
        <p className="auth-card__alert auth-card__alert--success" role="status">
          {RECOVER_SENT_MESSAGE} Confira também a caixa de spam.
        </p>
      )}
      {failure && (
        <p key={failure.at} className="auth-card__alert auth-card__alert--error" role="alert">
          {failure.text}
        </p>
      )}

      <form className="auth-card__form" onSubmit={onSubmit} noValidate>
        <div className="field">
          <label className="field__label" htmlFor={`${ids}-email`}>
            E-mail
          </label>
          <div className="auth-input">
            <Mail size={16} className="auth-input__icon" aria-hidden="true" />
            <input
              id={`${ids}-email`}
              type="email"
              className="input"
              autoComplete="username"
              autoFocus
              placeholder="voce@suaempresa.com.br"
              aria-invalid={errors.email ? "true" : undefined}
              aria-describedby={errors.email ? `${ids}-email-error` : undefined}
              {...register("email")}
            />
          </div>
          {errors.email && (
            <span id={`${ids}-email-error`} className="field__error">
              {errors.email.message}
            </span>
          )}
        </div>
        <button type="submit" className="btn btn--primary btn--lg auth-card__submit" disabled={isSubmitting} aria-busy={isSubmitting}>
          {isSubmitting ? (
            <>
              <span className="auth-spinner" aria-hidden="true" /> Enviando…
            </>
          ) : (
            "Enviar link"
          )}
        </button>
      </form>

      <button type="button" className="auth-card__link" onClick={onBack}>
        <ArrowLeft size={13} aria-hidden="true" style={{ verticalAlign: "-2px", marginRight: 4 }} />
        Voltar para o login
      </button>
    </>
  );
}
