import { APP_NAME, APP_SCHEMA, ROLE_MANAGER_ROLES, SUPER_ADMIN_ROLE, type RoleKey } from "../../../../config/app";
import { getPermission, isPermissionId, menuRegistry } from "../../../../config/menuRegistry";
import { central, supabase } from "../../../../lib/supabase";
import { computePermissions } from "../../access/policy";
import type { PermissionsService } from "../contracts";
import { ServiceError, type PermissionRules } from "../types";
import { fromPostgrest, required, unwrap } from "./errors";
import { toUser, USUARIO_COLUMNS } from "./mappers";

async function rulesFor(role: RoleKey): Promise<PermissionRules> {
  const rows = required(await supabase.from("profile_permissions").select("permission_id, enabled").eq("role", role));
  const rules: PermissionRules = {};
  for (const row of rows) {
    if (row.enabled !== null && isPermissionId(row.permission_id)) rules[row.permission_id] = row.enabled;
  }
  return rules;
}

export const supabasePermissionsService: PermissionsService = {
  async getRolePermissions(role) {
    return role === SUPER_ADMIN_ROLE ? {} : rulesFor(role);
  },

  async saveRolePermissions(role, changes) {
    unwrap(
      await supabase.rpc("salvar_permissoes_perfil", {
        p_perfil: role,
        // O nome do menu vai só para a descrição da auditoria.
        p_alteracoes: changes.map((change) => ({ id: change.id, enabled: change.enabled, label: getPermission(change.id).label })),
      }),
    );
  },

  async getEffectiveAccess() {
    const { data } = await supabase.auth.getSession();
    const session = data.session;
    if (!session) throw new ServiceError("UNAUTHENTICATED", "Sua sessão expirou. Entre novamente.");

    // Permissões por aplicativo, ANTES do cadastro: com a proteção no banco ligada, o login bloqueado
    // nem enxerga a própria linha em <schema>.usuarios.
    // Enquanto a migration não foi aplicada (função inexistente, PGRST202), ninguém é barrado.
    const appAccess = await central.rpc("pode_acessar_app", { p_app: APP_SCHEMA });
    if (appAccess.error && appAccess.error.code !== "PGRST202") throw fromPostgrest(appAccess.error);
    if (appAccess.data === false) {
      throw new ServiceError("NO_APP_ACCESS", `O seu login não tem acesso liberado ao ${APP_NAME}.`);
    }

    const row = unwrap(await supabase.from("usuarios").select(USUARIO_COLUMNS).eq("id", session.user.id).maybeSingle());
    if (!row || row.status === "inactive") {
      throw new ServiceError(
        "NO_PORTAL_ACCESS",
        row
          ? "Sua conta no portal está inativa. Fale com um administrador."
          : "Seu e-mail ainda não está autorizado no portal. Peça a um administrador para cadastrá-lo.",
      );
    }

    const user = toUser(row);
    const role = user.role;
    const rules = role && role !== SUPER_ADMIN_ROLE ? await rulesFor(role) : {};
    const permissions = computePermissions(role, rules);
    // Menus da Central (Permissões por aplicativo): só o Super admin da Central, que é o super_admin
    // do Gestão Comercial, e não o super admin local deste aplicativo.
    if (menuRegistry.some((item) => item.centralOnly)) {
      const souCentral = await central.rpc("pa_sou_super_admin" as "pode_acessar_app", {} as { p_app: string });
      const liberado = !souCentral.error && (souCentral.data as unknown) === true;
      for (const item of menuRegistry) if (item.centralOnly) permissions[item.id] = liberado;
    }
    // Menus do Super admin da WSA (Empresas): não basta ser Super admin da empresa aberta.
    if (menuRegistry.some((item) => item.wsaOnly)) {
      // RPC nova, fora dos tipos gerados: chamada sem tipo.
      const rpcSemTipo = supabase.rpc as unknown as (nome: string) => PromiseLike<{ data: { adminWsa?: boolean } | null; error: unknown }>;
      const pref = await rpcSemTipo("minhas_preferencias");
      const adminWsa = !pref.error && pref.data?.adminWsa === true;
      for (const item of menuRegistry) if (item.wsaOnly) permissions[item.id] = adminWsa;
    }

    return {
      user,
      role,
      roleLabel: user.roleLabel,
      isSuperAdmin: role === SUPER_ADMIN_ROLE,
      canManageRoles: role !== null && ROLE_MANAGER_ROLES.includes(role) && permissions.manage_permissions,
      permissions,
      mustChangePassword: user.mustChangePassword,
    };
  },
};
