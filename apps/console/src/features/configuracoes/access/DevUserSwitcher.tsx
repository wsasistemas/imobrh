import { StatusBadge } from "../components/StatusBadge";
import { useSwitchableUsers, useSwitchUser } from "../hooks/useAuth";
import { useAccess } from "./useAccess";
import "./DevUserSwitcher.css";

/** Somente em desenvolvimento: troca o usuário mock para testar menus e rotas por perfil. */
export function DevUserSwitcher() {
  const { user } = useAccess();
  const users = useSwitchableUsers();
  const switchUser = useSwitchUser();

  return (
    <label className="dev-switcher">
      <StatusBadge variant="info">DEV</StatusBadge>
      <span>Ver como:</span>
      <select
        value={user?.id ?? ""}
        disabled={!users.data || switchUser.isPending}
        onChange={(event) => switchUser.mutate(event.target.value)}
      >
        {!users.data && <option value={user?.id ?? ""}>{user?.name ?? "Carregando…"}</option>}
        {users.data?.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name} · {option.roleLabel ?? "Sem perfil"}
          </option>
        ))}
      </select>
    </label>
  );
}
