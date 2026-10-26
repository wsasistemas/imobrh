import { PAPEIS_CONSOLE, type Papel } from "@imobrh/shared";
import { SUPER_ADMIN_ROLE, type RoleKey } from "../../../../config/app";
import { getPermission, isPermissionId } from "../../../../config/menuRegistry";
import { supabase } from "../../../../lib/supabase";
import { computePermissionsForRoles, principalRole } from "../../access/policy";
import type { PermissionsService } from "../contracts";
import { ServiceError, type PermissionRules } from "../types";
import { required, unwrap } from "./errors";
import { roleLabel } from "./mappers";

/** jsonb { permission_id: boolean } → regras conhecidas pelo menuRegistry. */
function toRules(value: unknown): PermissionRules {
  const rules: PermissionRules = {};
  if (typeof value !== "object" || value === null) return rules;
  for (const [id, enabled] of Object.entries(value)) {
    if (isPermissionId(id) && typeof enabled === "boolean") rules[id] = enabled;
  }
  return rules;
}

interface MeuAcesso {
  user: { id: string; email: string; nome: string; last_access_at: string | null } | null;
  papeis: RoleKey[];
  regras: Record<string, unknown>;
  vinculo: { status: string; chapa: string | null } | null;
}

export const supabasePermissionsService: PermissionsService = {
  /** Regras efetivas do papel: o padrão do banco com as alterações da empresa por cima. */
  async getRolePermissions(role) {
    if (role === SUPER_ADMIN_ROLE) return {};
    return toRules(required(await supabase.rpc("regras_do_papel", { p_papel: role })));
  },

  async saveRolePermissions(role, changes) {
    unwrap(
      await supabase.rpc("salvar_permissoes_perfil", {
        p_perfil: role,
        p_alteracoes: changes.map((change) => ({ id: change.id, enabled: change.enabled, label: getPermission(change.id).label })),
      }),
    );
  },

  async getEffectiveAccess() {
    const { data } = await supabase.auth.getSession();
    if (!data.session) throw new ServiceError("NAO_AUTENTICADO", "Sua sessão expirou. Entre novamente.");

    const acesso = required(await supabase.rpc("meu_acesso")) as MeuAcesso;
    if (!acesso.user) throw new ServiceError("NAO_AUTENTICADO", "Sua sessão expirou. Entre novamente.");
    // Colaborador, gestor e diretoria usam o app do imobdesk; o Console é só dos papéis do RH.
    if (!acesso.papeis.some((papel) => PAPEIS_CONSOLE.includes(papel as Papel))) {
      throw new ServiceError("NO_APP_ACCESS", "O seu login não tem papel de RH no Console. Peça ao Administrador do RH.");
    }

    const rulesByRole = Object.fromEntries(acesso.papeis.map((papel) => [papel, toRules(acesso.regras[papel])]));
    const permissions = computePermissionsForRoles(acesso.papeis, rulesByRole);
    const role = principalRole(acesso.papeis);
    const vinculo = acesso.vinculo?.status;
    return {
      user: {
        id: acesso.user.id,
        name: acesso.user.nome,
        email: acesso.user.email,
        role,
        roles: acesso.papeis,
        roleLabel: roleLabel(role),
        isOwner: false,
        status: "active",
        lastAccessAt: acesso.user.last_access_at,
        mustChangePassword: false,
        linkStatus: vinculo === "vinculado" || vinculo === "pendente" || vinculo === "divergente" ? vinculo : "sem_registro",
        chapa: acesso.vinculo?.chapa ?? null,
      },
      role,
      roleLabel: roleLabel(role),
      isSuperAdmin: acesso.papeis.includes(SUPER_ADMIN_ROLE),
      // Os papéis são fixos: ninguém cria nem exclui papel.
      canManageRoles: false,
      permissions,
      mustChangePassword: false,
    };
  },
};
