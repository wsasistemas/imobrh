import { PAPEIS } from "@imobrh/shared";
import type { RoleKey } from "../../../../config/app";
import type { UsersService } from "../contracts";
import { ServiceError, type UserTab } from "../types";
import { db } from "./db";
import { currentActor, delay, findUser, isAdmin, recordAudit, requirePermission, toPublicUser } from "./runtime";

const PAGE_SIZE = 10;

function byPapelOrder(a: RoleKey, b: RoleKey): number {
  return (PAPEIS as readonly string[]).indexOf(a) - (PAPEIS as readonly string[]).indexOf(b);
}

export const mockUsersService: UsersService = {
  async list({ tab, search, role, page }) {
    await delay();
    requirePermission("manage_users");
    const term = search.trim().toLowerCase();
    const all = db.users
      .filter((record) => role === "all" || record.roles.includes(role))
      .filter((record) => !term || record.name.toLowerCase().includes(term) || record.email.includes(term))
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))
      .map(toPublicUser);
    const matches = (which: UserTab) => (which === "all" ? all : all.filter((record) => record.status === which));
    const inTab = matches(tab);
    const start = (page - 1) * PAGE_SIZE;
    return {
      items: inTab.slice(start, start + PAGE_SIZE),
      total: inTab.length,
      page,
      pageSize: PAGE_SIZE,
      counts: { all: all.length, active: matches("active").length, inactive: matches("inactive").length, pending: matches("pending").length },
    };
  },

  async setRoles(id, roles) {
    await delay();
    const actor = requirePermission("manage_users");
    const target = findUser(id);
    if (roles.some((role) => !(PAPEIS as readonly string[]).includes(role))) {
      throw new ServiceError("VALIDACAO", "Papel inválido.", "roles");
    }
    // Como em app_imobrh.definir_papeis_usuario: os papéis de origem RM ficam; só os manuais mudam.
    const manualBefore = target.roles.filter((role) => !target.rmRoles.includes(role));
    const manualAfter = roles.filter((role) => !target.rmRoles.includes(role));
    for (const guarded of ["admin", "compliance"]) {
      if (!isAdmin(actor) && manualBefore.includes(guarded) !== manualAfter.includes(guarded)) {
        throw new ServiceError("SEM_PERMISSAO", "Só o Administrador concede ou retira os papéis Administrador e Compliance.", "roles");
      }
    }
    if (target.id === currentActor().id && manualBefore.includes("admin") && !manualAfter.includes("admin")) {
      throw new ServiceError("ESTADO_INVALIDO", "Você não pode retirar o seu próprio papel de Administrador.", "roles");
    }
    target.roles = [...new Set([...manualAfter, ...target.rmRoles])].sort(byPapelOrder);
    recordAudit({
      module: "usuarios",
      action: "update",
      description: `Papéis de ${target.name}: ${target.roles.join(", ") || "nenhum"}`,
      before: { papeis: manualBefore.join(", ") },
      after: { papeis: manualAfter.join(", ") },
    });
    return toPublicUser(target);
  },
};
