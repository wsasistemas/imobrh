import * as Dialog from "@radix-ui/react-dialog";
import * as RadioGroup from "@radix-ui/react-radio-group";
import { EquipesDoUsuario } from "../../cadastros/pages/EquipesDoUsuario";
import { zodResolver } from "@hookform/resolvers/zod";
import { Eye, EyeOff, Info, X } from "lucide-react";
import { useId, useState } from "react";
import { Controller, useForm, type UseFormSetError } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { isAllowedLoginEmail } from "../../../config/app";
import { PageSkeleton } from "../../../components/PageSkeleton";
import { MIN_PASSWORD_LENGTH } from "../access/passwordRules";
import { ErrorState } from "../components/ErrorState";
import { useRoles } from "../hooks/useRoles";
import { useCreateUserWithPassword, useInviteUser, useUpdateUser } from "../hooks/useUsers";
import { ServiceError, type RoleSummary, type User } from "../services/types";
import { useReturnFocus } from "../components/useReturnFocus";
import "../components/Sheet.css";
import "./UserSheet.css";

export type UserSheetState = { mode: "create" } | { mode: "edit"; user: User };

const EMAIL_HELP = "O e-mail é o login da pessoa no portal.";

const userFormSchema = z
  .object({
    name: z.string().trim().min(3, "Informe o nome completo."),
    // O serviço repete a checagem; aqui ela só orienta antes de enviar.
    email: z.email("Informe um e-mail válido.").refine(isAllowedLoginEmail, "Informe um e-mail válido."),
    role: z.string().min(1, "Escolha um perfil."),
    accessMethod: z.enum(["invite", "password"]),
    password: z.string(),
  })
  .superRefine((values, ctx) => {
    if (values.accessMethod === "password" && values.password.length < MIN_PASSWORD_LENGTH) {
      ctx.addIssue({
        code: "custom",
        path: ["password"],
        message: `A senha temporária precisa de pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`,
      });
    }
  });

type UserFormValues = z.infer<typeof userFormSchema>;

const FORM_FIELDS = ["name", "email", "role", "password"] as const;

/** Erro com `field` vai para o próprio campo (ex.: EMAIL_EXISTS); o resto vira toast. */
function showServiceError(error: unknown, setError: UseFormSetError<UserFormValues>) {
  if (error instanceof ServiceError) {
    const field = FORM_FIELDS.find((name) => name === error.field);
    if (field) {
      setError(field, { type: "server", message: error.message }, { shouldFocus: true });
      return;
    }
    toast.error(error.message);
    return;
  }
  toast.error("Não foi possível salvar. Tente novamente.");
}

interface UserSheetProps {
  state: UserSheetState | null;
  onClose: () => void;
}

/** Painel lateral de 540px para criar ou editar usuário. */
export function UserSheet({ state, onClose }: UserSheetProps) {
  const returnFocus = useReturnFocus();
  return (
    <Dialog.Root open={state !== null} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="sheet" {...returnFocus}>
          {state && <UserSheetBody state={state} onClose={onClose} />}</Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Carrega os perfis antes do formulário: o combo de perfil depende deles. */
function UserSheetBody({ state, onClose }: { state: UserSheetState; onClose: () => void }) {
  const roles = useRoles();

  if (roles.isPending || roles.isError) {
    return (
      <div className="sheet__body">
        <Dialog.Title className="visually-hidden">{state.mode === "edit" ? "Editar usuário" : "Novo usuário"}</Dialog.Title>
        <Dialog.Description className="visually-hidden">Carregando os perfis de acesso.</Dialog.Description>
        {roles.isPending ? (
          <PageSkeleton />
        ) : (
          <ErrorState bare message="Não foi possível carregar os perfis." onRetry={() => void roles.refetch()} />
        )}
      </div>
    );
  }

  return (
    <UserForm key={state.mode === "edit" ? state.user.id : "create"} state={state} roles={roles.data} onClose={onClose} />
  );
}

function UserForm({ state, roles: allRoles, onClose }: { state: UserSheetState; roles: RoleSummary[]; onClose: () => void }) {
  const ids = useId();
  const [showPassword, setShowPassword] = useState(false);
  const invite = useInviteUser();
  const create = useCreateUserWithPassword();
  const update = useUpdateUser();

  const isEdit = state.mode === "edit";
  // Regra 3: o combo mostra só perfis do nível do usuário logado para baixo.
  const roles = allRoles.filter((role) => role.assignable);
  const lowestRole = roles[roles.length - 1]?.key ?? "";

  const {
    register,
    control,
    handleSubmit,
    watch,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<UserFormValues>({
    resolver: zodResolver(userFormSchema),
    defaultValues: {
      name: isEdit ? state.user.name : "",
      email: isEdit ? state.user.email : "",
      role: isEdit ? (state.user.role ?? lowestRole) : lowestRole,
      accessMethod: "invite",
      password: "",
    },
  });

  const accessMethod = watch("accessMethod");

  const onSubmit = handleSubmit(async (values) => {
    const input = { name: values.name, email: values.email.trim().toLowerCase(), role: values.role };
    try {
      if (state.mode === "edit") {
        await update.mutateAsync({ id: state.user.id, input: { name: input.name, role: input.role } });
        toast.success("Alterações salvas");
      } else if (values.accessMethod === "invite") {
        await invite.mutateAsync(input);
        toast.success(`Convite enviado para ${input.email}`);
      } else {
        await create.mutateAsync({ ...input, password: values.password });
        toast.success("Usuário criado. A troca de senha será exigida no primeiro acesso.");
      }
      onClose();
    } catch (error) {
      showServiceError(error, setError);
    }
  });

  const submitLabel = isEdit ? "Salvar alterações" : accessMethod === "invite" ? "Enviar convite" : "Criar usuário";
  const fieldId = (name: string) => `${ids}-${name}`;

  return (
    <form className="sheet__form" onSubmit={onSubmit} noValidate>
      <header className="sheet__header">
        <div>
          <Dialog.Title className="sheet__title">{isEdit ? "Editar usuário" : "Novo usuário"}</Dialog.Title>
          <Dialog.Description className="sheet__description">
            {isEdit ? "Altere os dados e o perfil de acesso." : "Cadastre quem pode entrar no sistema."}
          </Dialog.Description>
        </div>
        <Dialog.Close asChild>
          <button type="button" className="icon-btn" aria-label="Fechar">
            <X size={18} aria-hidden="true" />
          </button>
        </Dialog.Close>
      </header>

      <div className="sheet__body">
        <div className="field">
          <label className="field__label" htmlFor={fieldId("name")}>
            Nome completo
          </label>
          <input
            id={fieldId("name")}
            className="input"
            autoComplete="off"
            aria-invalid={errors.name ? "true" : undefined}
            aria-describedby={errors.name ? fieldId("name-error") : undefined}
            {...register("name")}
          />
          {errors.name && (
            <span id={fieldId("name-error")} className="field__error">
              {errors.name.message}
            </span>
          )}
        </div>

        <div className="field">
          <label className="field__label" htmlFor={fieldId("email")}>
            E-mail
          </label>
          <input
            id={fieldId("email")}
            type="email"
            className="input"
            autoComplete="off"
            placeholder="nome.sobrenome@suaempresa.com.br"
            // O e-mail é a conta de login (compartilhada com outros sistemas da WSA): não muda aqui.
            readOnly={isEdit}
            aria-invalid={errors.email ? "true" : undefined}
            aria-describedby={fieldId("email-help")}
            {...register("email")}
          />
          <span id={fieldId("email-help")} className={errors.email ? "field__error" : "field__help"}>
            {errors.email?.message ??
              (isEdit ? "O e-mail é a conta de login e não muda por aqui." : EMAIL_HELP)}
          </span>
        </div>

        <div className="field">
          <label className="field__label" htmlFor={fieldId("role")}>
            Perfil de acesso
          </label>
          <select
            id={fieldId("role")}
            className="input"
            aria-invalid={errors.role ? "true" : undefined}
            aria-describedby={fieldId("role-help")}
            {...register("role")}
          >
            {roles.map((role) => (
              <option key={role.key} value={role.key}>
                {role.label}
              </option>
            ))}
          </select>
          <span id={fieldId("role-help")} className={errors.role ? "field__error" : "field__help"}>
            {errors.role?.message ?? "Você só pode atribuir perfis do seu nível para baixo."}
          </span>
        </div>

        {!isEdit && (
          <fieldset className="field sheet__fieldset">
            <legend className="field__label">Forma de acesso</legend>
            <Controller
              control={control}
              name="accessMethod"
              render={({ field }) => (
                <RadioGroup.Root
                  className="radio-cards"
                  value={field.value}
                  onValueChange={field.onChange}
                  aria-label="Forma de acesso"
                >
                  <RadioGroup.Item value="invite" className="radio-card">
                    <span className="radio-card__dot" aria-hidden="true">
                      <RadioGroup.Indicator className="radio-card__dot-fill" />
                    </span>
                    <span>
                      <strong>Enviar convite por e-mail (recomendado)</strong>
                      <span>A pessoa recebe um link e cria a própria senha. Quem já tem conta só ganha o acesso, sem trocar a senha.</span>
                    </span>
                  </RadioGroup.Item>
                  <RadioGroup.Item value="password" className="radio-card">
                    <span className="radio-card__dot" aria-hidden="true">
                      <RadioGroup.Indicator className="radio-card__dot-fill" />
                    </span>
                    <span>
                      <strong>Definir senha temporária</strong>
                      <span>Só para quem ainda não tem conta. A troca de senha é exigida no primeiro acesso.</span>
                    </span>
                  </RadioGroup.Item>
                </RadioGroup.Root>
              )}
            />
          </fieldset>
        )}

        {!isEdit && accessMethod === "password" && (
          <div className="field">
            <label className="field__label" htmlFor={fieldId("password")}>
              Senha temporária
            </label>
            <div className="input-with-action">
              <input
                id={fieldId("password")}
                type={showPassword ? "text" : "password"}
                className="input"
                autoComplete="new-password"
                aria-invalid={errors.password ? "true" : undefined}
                aria-describedby={fieldId("password-help")}
                {...register("password")}
              />
              <button
                type="button"
                className="icon-btn"
                aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"}
                onClick={() => setShowPassword((value) => !value)}
              >
                {showPassword ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
              </button>
            </div>
            <span id={fieldId("password-help")} className={errors.password ? "field__error" : "field__help"}>
              {errors.password?.message ?? `Mínimo de ${MIN_PASSWORD_LENGTH} caracteres.`}
            </span>
          </div>
        )}

        {state.mode === "edit" && <EquipesDoUsuario usuarioId={state.user.id} />}

        <p className="sheet__notice">
          <Info size={16} aria-hidden="true" />
          {isEdit
            ? "A alteração fica registrada na auditoria com o seu usuário."
            : "A criação fica registrada na auditoria com o seu usuário."}
        </p>
      </div>

      <footer className="sheet__footer">
        <Dialog.Close asChild>
          <button type="button" className="btn btn--outline btn--lg" disabled={isSubmitting}>
            Cancelar
          </button>
        </Dialog.Close>
        <button type="submit" className="btn btn--primary btn--lg" disabled={isSubmitting}>
          {isSubmitting ? "Salvando…" : submitLabel}
        </button>
      </footer>
    </form>
  );
}
