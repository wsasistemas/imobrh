import * as Dialog from "@radix-ui/react-dialog";
import { zodResolver } from "@hookform/resolvers/zod";
import { Info, X } from "lucide-react";
import { useId } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { useCreateRole, useUpdateRole } from "../hooks/useRoles";
import { ServiceError, type RoleSummary } from "../services/types";
import { useReturnFocus } from "../components/useReturnFocus";
import "../components/Sheet.css";

export type RoleSheetState = { mode: "create" } | { mode: "edit"; role: RoleSummary };

const roleFormSchema = z.object({
  label: z.string().trim().min(2, "Informe o nome do perfil.").max(40, "Use no máximo 40 caracteres."),
  description: z.string().trim().max(120, "Use no máximo 120 caracteres."),
  placeAfter: z.string().min(1, "Escolha a posição na hierarquia."),
});

type RoleFormValues = z.infer<typeof roleFormSchema>;

const FORM_FIELDS = ["label", "description", "placeAfter"] as const;

interface RoleSheetProps {
  state: RoleSheetState | null;
  /** Perfis em ordem de hierarquia, com as ações liberadas para o usuário logado. */
  roles: RoleSummary[];
  onClose: () => void;
  onCreated: (role: RoleSummary) => void;
}

/** Painel lateral para criar ou editar um perfil de acesso. */
export function RoleSheet({ state, roles, onClose, onCreated }: RoleSheetProps) {
  const returnFocus = useReturnFocus();
  return (
    <Dialog.Root open={state !== null} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="sheet" {...returnFocus}>
          {state && (
            <RoleForm
              key={state.mode === "edit" ? state.role.key : "create"}
              state={state}
              roles={roles}
              onClose={onClose}
              onCreated={onCreated}
            />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function RoleForm({ state, roles, onClose, onCreated }: Omit<RoleSheetProps, "state"> & { state: RoleSheetState }) {
  const ids = useId();
  const createRole = useCreateRole();
  const updateRole = useUpdateRole();
  const isEdit = state.mode === "edit";
  const editingKey = state.mode === "edit" ? state.role.key : null;

  // Posições possíveis: logo abaixo de um perfil do nível do usuário logado ou abaixo dele.
  const positions = roles.filter((role) => role.canPlaceBelow && role.key !== editingKey);
  const currentIndex = editingKey ? roles.findIndex((role) => role.key === editingKey) : -1;
  const currentAbove = currentIndex > 0 ? roles[currentIndex - 1]?.key : undefined;
  const defaultPlaceAfter =
    (currentAbove && positions.some((role) => role.key === currentAbove) ? currentAbove : undefined) ??
    positions[positions.length - 1]?.key ??
    "";

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<RoleFormValues>({
    resolver: zodResolver(roleFormSchema),
    defaultValues: {
      label: state.mode === "edit" ? state.role.label : "",
      description: state.mode === "edit" ? state.role.description : "",
      placeAfter: defaultPlaceAfter,
    },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      if (state.mode === "edit") {
        await updateRole.mutateAsync({ key: state.role.key, input: values });
        toast.success(`Perfil ${values.label} salvo`);
      } else {
        const created = await createRole.mutateAsync(values);
        toast.success(`Perfil ${created.label} criado. Libere os menus na matriz.`);
        onCreated(created);
      }
      onClose();
    } catch (error) {
      if (error instanceof ServiceError) {
        const field = FORM_FIELDS.find((name) => name === error.field);
        if (field) {
          setError(field, { type: "server", message: error.message }, { shouldFocus: true });
          return;
        }
        toast.error(error.message);
        return;
      }
      toast.error("Não foi possível salvar o perfil.");
    }
  });

  const fieldId = (name: string) => `${ids}-${name}`;

  return (
    <form className="sheet__form" onSubmit={onSubmit} noValidate>
      <header className="sheet__header">
        <div>
          <Dialog.Title className="sheet__title">{isEdit ? "Editar perfil" : "Novo perfil"}</Dialog.Title>
          <Dialog.Description className="sheet__description">
            {isEdit ? "Altere o nome, a descrição e a posição do perfil." : "Cadastre um perfil de acesso."}
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
          <label className="field__label" htmlFor={fieldId("label")}>
            Nome do perfil
          </label>
          <input
            id={fieldId("label")}
            className="input"
            autoComplete="off"
            aria-invalid={errors.label ? "true" : undefined}
            aria-describedby={errors.label ? fieldId("label-error") : undefined}
            {...register("label")}
          />
          {errors.label && (
            <span id={fieldId("label-error")} className="field__error">
              {errors.label.message}
            </span>
          )}
          {state.mode === "edit" && (
            <span className="field__help">
              Identificador: <code className="mono">{state.role.key}</code>
            </span>
          )}
        </div>

        <div className="field">
          <label className="field__label" htmlFor={fieldId("description")}>
            Descrição <span className="field__optional">(opcional)</span>
          </label>
          <input
            id={fieldId("description")}
            className="input"
            autoComplete="off"
            aria-invalid={errors.description ? "true" : undefined}
            aria-describedby={errors.description ? fieldId("description-error") : undefined}
            {...register("description")}
          />
          {errors.description && (
            <span id={fieldId("description-error")} className="field__error">
              {errors.description.message}
            </span>
          )}
        </div>

        <div className="field">
          <label className="field__label" htmlFor={fieldId("placeAfter")}>
            Posição na hierarquia
          </label>
          <select
            id={fieldId("placeAfter")}
            className="input"
            aria-invalid={errors.placeAfter ? "true" : undefined}
            aria-describedby={fieldId("placeAfter-help")}
            {...register("placeAfter")}
          >
            {positions.map((role) => (
              <option key={role.key} value={role.key}>
                Abaixo de {role.label}
              </option>
            ))}
          </select>
          <span id={fieldId("placeAfter-help")} className={errors.placeAfter ? "field__error" : "field__help"}>
            {errors.placeAfter?.message ??
              "Quem tem um perfil só atribui aos usuários perfis do mesmo nível ou abaixo dele."}
          </span>
        </div>


        <p className="sheet__notice">
          <Info size={16} aria-hidden="true" />
          {isEdit
            ? "A alteração fica registrada na auditoria com o seu usuário."
            : "O perfil novo começa com todos os menus negados. A criação fica registrada na auditoria."}
        </p>
      </div>

      <footer className="sheet__footer">
        <Dialog.Close asChild>
          <button type="button" className="btn btn--outline btn--lg" disabled={isSubmitting}>
            Cancelar
          </button>
        </Dialog.Close>
        <button type="submit" className="btn btn--primary btn--lg" disabled={isSubmitting}>
          {isSubmitting ? "Salvando…" : isEdit ? "Salvar alterações" : "Criar perfil"}
        </button>
      </footer>
    </form>
  );
}
