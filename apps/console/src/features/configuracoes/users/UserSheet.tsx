import * as Dialog from "@radix-ui/react-dialog";
import * as Switch from "@radix-ui/react-switch";
import { Info, X } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import type { RoleKey } from "../../../config/app";
import { PageSkeleton } from "../../../components/PageSkeleton";
import { ErrorState } from "../components/ErrorState";
import { useReturnFocus } from "../components/useReturnFocus";
import { useRoles } from "../hooks/useRoles";
import { useSetUserRoles } from "../hooks/useUsers";
import { ServiceError, type RoleSummary, type User } from "../services/types";
import { LinkStatusBadge } from "./userDisplay";
import "../components/Sheet.css";
import "./UserSheet.css";

/** Papéis que vêm do TOTVS RM (vínculo e hierarquia): a tela mostra, mas não concede nem retira. */
const RM_ROLES: readonly RoleKey[] = ["colaborador", "gestor"];

interface UserSheetProps {
  user: User | null;
  onClose: () => void;
}

/** Painel lateral de 540px com os papéis de um login no ImobRH. */
export function UserSheet({ user, onClose }: UserSheetProps) {
  const returnFocus = useReturnFocus();
  return (
    <Dialog.Root open={user !== null} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="sheet" {...returnFocus}>
          {user && <UserSheetBody user={user} onClose={onClose} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function UserSheetBody({ user, onClose }: { user: User; onClose: () => void }) {
  const roles = useRoles();
  if (roles.isPending || roles.isError) {
    return (
      <div className="sheet__body">
        <Dialog.Title className="visually-hidden">Papéis de {user.name}</Dialog.Title>
        <Dialog.Description className="visually-hidden">Carregando os papéis do ImobRH.</Dialog.Description>
        {roles.isPending ? <PageSkeleton /> : <ErrorState bare message="Não foi possível carregar os papéis." onRetry={() => void roles.refetch()} />}
      </div>
    );
  }
  return <RolesForm key={user.id} user={user} roles={roles.data} onClose={onClose} />;
}

function RolesForm({ user, roles, onClose }: { user: User; roles: RoleSummary[]; onClose: () => void }) {
  const ids = useId();
  const save = useSetUserRoles();
  const [selected, setSelected] = useState<RoleKey[]>(user.roles);
  const [error, setError] = useState<string | null>(null);

  const toggle = (key: RoleKey, on: boolean) => setSelected((current) => (on ? [...current, key] : current.filter((role) => role !== key)));
  const changed = selected.length !== user.roles.length || selected.some((role) => !user.roles.includes(role));

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      // Os papéis do RM seguem com o login; o banco ignora os que vierem aqui.
      await save.mutateAsync({ id: user.id, roles: selected.filter((role) => !RM_ROLES.includes(role)) });
      toast.success(`Papéis de ${user.name} salvos`);
      onClose();
    } catch (err) {
      const message = err instanceof ServiceError ? err.message : "Não foi possível salvar. Tente novamente.";
      setError(message);
    }
  };

  return (
    <form className="sheet__form" onSubmit={onSubmit} noValidate>
      <header className="sheet__header">
        <div>
          <Dialog.Title className="sheet__title">Papéis de {user.name}</Dialog.Title>
          <Dialog.Description className="sheet__description">{user.email}</Dialog.Description>
        </div>
        <Dialog.Close asChild>
          <button type="button" className="icon-btn" aria-label="Fechar">
            <X size={18} aria-hidden="true" />
          </button>
        </Dialog.Close>
      </header>

      <div className="sheet__body">
        <div className="user-link">
          <span className="field__label">Vínculo com o TOTVS RM</span>
          <LinkStatusBadge status={user.linkStatus} chapa={user.chapa} />
        </div>

        <fieldset className="field sheet__fieldset" aria-describedby={error ? `${ids}-error` : undefined}>
          <legend className="field__label">Papéis no ImobRH</legend>
          <ul className="role-toggles">
            {roles.map((role) => {
              const fromRm = RM_ROLES.includes(role.key);
              const locked = fromRm || !role.assignable;
              const id = `${ids}-${role.key}`;
              return (
                <li key={role.key} className={`role-toggle${locked ? " role-toggle--locked" : ""}`}>
                  <label htmlFor={id}>
                    <strong>{role.label}</strong>
                    <span>
                      {role.description}
                      {fromRm && " Vem do TOTVS RM."}
                      {!fromRm && !role.assignable && " Só o Administrador concede."}
                    </span>
                  </label>
                  <Switch.Root
                    id={id}
                    className="switch"
                    checked={selected.includes(role.key)}
                    disabled={locked || save.isPending}
                    onCheckedChange={(on) => toggle(role.key, on)}
                  >
                    <Switch.Thumb className="switch__thumb" />
                  </Switch.Root>
                </li>
              );
            })}
          </ul>
          {error && (
            <span id={`${ids}-error`} className="field__error" role="alert">
              {error}
            </span>
          )}
        </fieldset>

        <p className="sheet__notice">
          <Info size={16} aria-hidden="true" />
          A conta de login é a do imobdesk: nome, e-mail e senha mudam lá. Aqui só se definem os papéis do RH, e cada
          alteração fica na auditoria.
        </p>
      </div>

      <footer className="sheet__footer">
        <Dialog.Close asChild>
          <button type="button" className="btn btn--outline">
            Cancelar
          </button>
        </Dialog.Close>
        <button type="submit" className="btn btn--primary" disabled={!changed || save.isPending}>
          {save.isPending ? "Salvando…" : "Salvar papéis"}
        </button>
      </footer>
    </form>
  );
}
