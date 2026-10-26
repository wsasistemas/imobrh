import { supabase } from "../../../../lib/supabase";
import type { RolesService } from "../contracts";
import { ServiceError, type RoleSummary } from "../types";
import { required } from "./errors";

interface PerfilRow {
  key: string;
  label: string;
  description: string;
  user_count: number;
  connected_count: number;
  locked: boolean;
  assignable: boolean;
  manageable: boolean;
  can_place_below: boolean;
}

const FIXED = "Os papéis do ImobRH são fixos (PRD v2): ajuste só os menus de cada um.";

export const supabaseRolesService: RolesService = {
  /** Os 8 papéis com contagens, calculados no banco (app_imobrh.listar_perfis). */
  async list() {
    const rows = required(await supabase.rpc("listar_perfis")) as PerfilRow[];
    return rows.map<RoleSummary>((row) => ({
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
  },

  async create() {
    throw new ServiceError("ESTADO_INVALIDO", FIXED);
  },

  async update() {
    throw new ServiceError("ESTADO_INVALIDO", FIXED);
  },

  async delete() {
    throw new ServiceError("ESTADO_INVALIDO", FIXED);
  },
};
