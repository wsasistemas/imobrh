import { supabase } from "../../../../lib/supabase";
import type { RolesService } from "../contracts";
import { ServiceError, type RoleSummary } from "../types";
import { required, unwrap } from "./errors";

/** Lista calculada no banco (contagens e ações por perfil para o usuário logado). */
async function listRoles(): Promise<RoleSummary[]> {
  const rows = required(await supabase.rpc("listar_perfis"));
  return rows.map((row) => ({
    key: row.key,
    label: row.label,
    description: row.description,
    userCount: row.user_count,
    connectedCount: row.connected_count,
    locked: row.locked,
    assignable: row.assignable,
    manageable: row.manageable,
    canPlaceBelow: row.can_place_below,
  }));
}

async function findRole(key: string): Promise<RoleSummary> {
  const role = (await listRoles()).find((entry) => entry.key === key);
  if (!role) throw new ServiceError("NOT_FOUND", "Perfil não encontrado.");
  return role;
}

export const supabaseRolesService: RolesService = {
  list: listRoles,

  async create({ label, description, placeAfter }) {
    const key = required(
      await supabase.rpc("criar_perfil", { p_label: label, p_descricao: description, p_abaixo_de: placeAfter }),
    );
    return findRole(key);
  },

  async update(key, { label, description, placeAfter }) {
    unwrap(
      await supabase.rpc("editar_perfil", {
        p_key: key,
        p_label: label,
        p_descricao: description,
        p_abaixo_de: placeAfter,
      }),
    );
    return findRole(key);
  },

  async delete(key) {
    unwrap(await supabase.rpc("excluir_perfil", { p_key: key }));
  },
};
