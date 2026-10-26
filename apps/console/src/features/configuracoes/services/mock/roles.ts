import { PAPEIS, ROTULO_PAPEL } from "@imobrh/shared";
import type { RolesService } from "../contracts";
import { ServiceError, type RoleSummary } from "../types";
import { db } from "./db";
import { currentActor, delay, hasConsoleRole, isAdmin } from "./runtime";

/** Descrição de cada papel (a mesma de app_imobrh.listar_perfis). */
const ROLE_DESCRIPTIONS: Record<string, string> = {
  admin: "Acesso total ao Console do RH, inclusive papéis e integrações.",
  rh_dp: "Atende as filas do DP: férias, documentos, dúvidas de folha e admissão.",
  rh_dp_restrita: "Fila restrita: atestados e desligamentos.",
  recrutamento: "Recebe a requisição aprovada e conduz a vaga até a admissão.",
  compliance: "Únicos que veem casos sensíveis.",
  diretoria: "Aprova requisição de pessoal e desligamento conforme a alçada (app).",
  gestor: "Chefe de seção no RM: aprova férias da equipe (app).",
  colaborador: "Funcionário ativo no RM: abre pedidos no app.",
};

const FIXED = "Os papéis do ImobRH são fixos (PRD v2): ajuste só os menus de cada um.";

export const mockRolesService: RolesService = {
  async list() {
    await delay();
    const actor = currentActor();
    if (!hasConsoleRole(actor)) throw new ServiceError("SEM_PERMISSAO", "Você não tem permissão para esta ação.");
    const admin = isAdmin(actor);
    return PAPEIS.map<RoleSummary>((key) => {
      const holders = db.users.filter((record) => record.roles.includes(key));
      return {
        key,
        label: ROTULO_PAPEL[key],
        description: ROLE_DESCRIPTIONS[key],
        userCount: holders.length,
        connectedCount: holders.filter((record) => db.sessions.some((session) => session.userId === record.id)).length,
        locked: key === "admin",
        assignable: admin || (key !== "admin" && key !== "compliance"),
        manageable: false,
        canPlaceBelow: false,
      };
    });
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
