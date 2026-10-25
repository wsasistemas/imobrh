import { APP_SCHEMA } from "../../../../config/app";
import { central, SUPABASE_PUBLIC_KEY, SUPABASE_URL } from "../../../../lib/supabase";
import type { AppAccessService } from "../contracts";
import type { AppAccessApp, AppAccessGrantResult, AppAccessUser } from "../types";
import { required, unwrap } from "./errors";

/** Chave deste aplicativo na tabela de Permissões por aplicativo (= schema). */
const CURRENT_APP = APP_SCHEMA;

// Tudo pelos atalhos public.pa_* da Central (migration 20260929150000 da Central de acessos):
// a mesma tela e os mesmos dados em todos os aplicativos.

/**
 * Schemas que a API expõe de fato, perguntados ao próprio PostgREST: um schema inexistente no
 * Accept-Profile devolve PGRST106 com "Only the following schemas are exposed: a, b, c".
 * Vale tanto para a lista gravada no banco quanto para a do painel. null se a API não responder assim.
 */
export async function fetchExposedSchemas(): Promise<string[] | null> {
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/pa_consulta_schemas_expostos`, {
      headers: { apikey: SUPABASE_PUBLIC_KEY, "Accept-Profile": "pa_consulta_schemas_expostos" },
    });
    const body = (await response.json()) as { code?: string; hint?: string | null };
    const match = body.code === "PGRST106" ? /exposed:\s*(.+)$/i.exec(body.hint ?? "") : null;
    if (!match) return null;
    const list = match[1].split(",").map((schema) => schema.trim()).filter(Boolean);
    return list.length > 0 ? list : null;
  } catch {
    return null;
  }
}

export const supabaseAppAccessService: AppAccessService = {
  async listApps() {
    const exposed = await fetchExposedSchemas();
    return required(await central.rpc("pa_listar_aplicativos_expostos", { p_expostos: exposed ?? [] })) as unknown as AppAccessApp[];
  },

  async listUsers(schema) {
    return required(await central.rpc("pa_listar_usuarios", { p_schema: schema })) as unknown as AppAccessUser[];
  },

  async saveApp(schema, input) {
    const args = { p_schema: schema, p_nome: input.name, p_url: input.url, p_padrao_novos: input.newLoginsDefault };
    unwrap(await central.rpc("pa_salvar_aplicativo_v2", { ...args, p_perfil_liberar: input.releaseProfile ?? "" }));
  },

  async addApp(input) {
    unwrap(
      await central.rpc("pa_adicionar_aplicativo", {
        p_chave: input.key,
        p_nome: input.name,
        p_url: input.url,
        p_schema_dados: input.dataSchema,
      }),
    );
  },

  async setControl(schema, active) {
    unwrap(await central.rpc("pa_definir_controle", { p_schema: schema, p_ativo: active }));
  },

  async setPermission(schema, userIds, canEnter) {
    const args = { p_schema: schema, p_usuarios: userIds, p_pode: canEnter };
    return required(await central.rpc("pa_definir_permissao_v2", args)) as unknown as AppAccessGrantResult;
  },

  async canAccessCurrentApp() {
    return required(await central.rpc("pode_acessar_app", { p_app: CURRENT_APP }));
  },
};
