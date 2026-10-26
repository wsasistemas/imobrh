import { supabase } from "../../../../lib/supabase";
import type { UsersService } from "../contracts";
import { ServiceError, type User, type UserTab } from "../types";
import { required } from "./errors";
import { toUser, type UsuarioRhRow } from "./mappers";

const PAGE_SIZE = 10;

/** Logins da empresa (cadastro do imobdesk) com os papéis do ImobRH; a RPC confere a permissão. */
async function listAll(): Promise<User[]> {
  return (required(await supabase.rpc("listar_usuarios_rh")) as UsuarioRhRow[]).map(toUser);
}

function matchesTab(user: User, tab: UserTab): boolean {
  return tab === "all" || user.status === tab;
}

export const supabaseUsersService: UsersService = {
  async list({ tab, search, role, page }) {
    const term = search.trim().toLowerCase();
    const users = (await listAll())
      .filter((user) => role === "all" || user.roles.includes(role))
      .filter((user) => !term || user.name.toLowerCase().includes(term) || user.email.toLowerCase().includes(term));
    const counts: Record<UserTab, number> = {
      all: users.length,
      active: users.filter((user) => matchesTab(user, "active")).length,
      inactive: users.filter((user) => matchesTab(user, "inactive")).length,
      pending: users.filter((user) => matchesTab(user, "pending")).length,
    };
    const inTab = users.filter((user) => matchesTab(user, tab));
    const start = (page - 1) * PAGE_SIZE;
    return { items: inTab.slice(start, start + PAGE_SIZE), total: inTab.length, page, pageSize: PAGE_SIZE, counts };
  },

  async setRoles(id, roles) {
    required(await supabase.rpc("definir_papeis_usuario", { p_usuario: id, p_papeis: roles }));
    const user = (await listAll()).find((entry) => entry.id === id);
    if (!user) throw new ServiceError("VALIDACAO", "Usuário não encontrado nesta empresa.");
    return user;
  },
};
