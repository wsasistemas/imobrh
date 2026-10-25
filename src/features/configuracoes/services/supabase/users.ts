import { edgeFunction } from "../../../../config/app";
import { OFFLINE_MESSAGE, requestResetThroughGateway } from "../../../../lib/authGateway";
import { supabase } from "../../../../lib/supabase";
import type { UsersService } from "../contracts";
import { ServiceError, type User, type UserTab } from "../types";
import { fromFunction, required, unwrap } from "./errors";
import { toUser, USUARIO_COLUMNS } from "./mappers";

const PAGE_SIZE = 10;

function resetRedirect(): string {
  return `${window.location.origin}/redefinir-senha`;
}

async function fetchUser(id: string): Promise<User> {
  return toUser(required(await supabase.from("usuarios").select(USUARIO_COLUMNS).eq("id", id).single()));
}

/** Convite e criação precisam da API de admin do Auth: vão pela Edge Function. */
async function invokeUsers(body: Record<string, string>): Promise<string> {
  const { data, error } = await supabase.functions.invoke<{ id: string }>(edgeFunction("usuarios"), { body });
  if (error) throw await fromFunction(error);
  if (!data?.id) throw new ServiceError("INTERNAL", "Não foi possível concluir. Tente novamente.");
  return data.id;
}

function matchesTab(user: User, tab: UserTab): boolean {
  return tab === "all" || user.status === tab;
}

export const supabaseUsersService: UsersService = {
  async list({ tab, search, role, page }) {
    let query = supabase.from("usuarios").select(USUARIO_COLUMNS).order("nome");
    if (role !== "all") query = query.eq("perfil_key", role);
    // Vírgula, parênteses e curingas quebram o filtro "or" do PostgREST.
    const term = search.trim().replace(/[%*,()\\]/g, " ").trim();
    if (term) query = query.or(`nome.ilike.*${term}*,email.ilike.*${term}*`);

    const users = required(await query).map(toUser);
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

  async invite({ name, email, role }) {
    const id = await invokeUsers({ action: "invite", name, email, role, redirectTo: resetRedirect() });
    return fetchUser(id);
  },

  async createWithTempPassword({ name, email, role, password }) {
    const id = await invokeUsers({ action: "create_with_password", name, email, role, password });
    return fetchUser(id);
  },

  async update(id, input) {
    const current = await fetchUser(id);
    // O e-mail é a conta de login compartilhada com outros sistemas da WSA.
    if (input.email !== undefined && input.email.trim().toLowerCase() !== current.email) {
      throw new ServiceError("INVALID_INPUT", "O e-mail é a conta de login e não muda por aqui.", "email");
    }
    unwrap(
      await supabase.rpc("atualizar_usuario", {
        p_id: id,
        p_nome: input.name ?? current.name,
        p_perfil: input.role ?? current.role ?? "",
      }),
    );
    return fetchUser(id);
  },

  async setActive(id, active) {
    unwrap(await supabase.rpc("definir_status_usuario", { p_id: id, p_ativo: active }));
    return fetchUser(id);
  },

  async delete(id) {
    unwrap(await supabase.rpc("excluir_usuario", { p_id: id }));
  },

  async setPasswordChangeRequired(id, required) {
    unwrap(await supabase.rpc("exigir_troca_senha", { p_id: id, p_exigir: required }));
    return fetchUser(id);
  },

  async setTemporaryPassword(id, password) {
    await invokeUsers({ action: "set_password", id, password });
    return fetchUser(id);
  },

  async sendPasswordReset(id) {
    // A RPC confere a permissão e registra na auditoria; o e-mail sai pelo Supabase Auth.
    const email = required(await supabase.rpc("registrar_redefinicao_senha", { p_id: id }));
    // Mesmo caminho do "Esqueci minha senha": passa pelo limite de pedidos por conta e por IP do gateway.
    const result = await requestResetThroughGateway(email);
    if (!result.ok) throw new ServiceError("INTERNAL", result.offline ? OFFLINE_MESSAGE : "Não foi possível enviar o e-mail de redefinição.");
  },
};
