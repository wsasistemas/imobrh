import { AuthError } from "@supabase/supabase-js";
import { OFFLINE_MESSAGE, signInThroughGateway } from "../../../../lib/authGateway";
import { supabase } from "../../../../lib/supabase";
import type { AuthService } from "../contracts";
import { ServiceError } from "../types";
import { fromPostgrest } from "./errors";

export const supabaseAuthService: AuthService = {
  async bindSession(email) {
    // O JWT já identifica o usuário; aqui só marca o último acesso (e conclui convite de quem já tinha senha).
    if (email) await supabase.rpc("registrar_acesso");
  },

  async changePassword(newPassword) {
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) {
      const code = error instanceof AuthError ? error.code : undefined;
      if (code === "same_password") {
        // A senha atual é a temporária (ou a do link de redefinição).
        throw new ServiceError("PASSWORD_REUSED", "A nova senha precisa ser diferente da atual.", "newPassword");
      }
      if (code === "weak_password") {
        throw new ServiceError("INVALID_PASSWORD", "A senha não atende aos requisitos de segurança.", "newPassword");
      }
      throw new ServiceError("INTERNAL", "Não foi possível salvar a nova senha. Tente novamente.");
    }
    // Libera o acesso de quem tinha troca obrigatória ou convite pendente.
    const done = await supabase.rpc("concluir_troca_senha");
    if (done.error) {
      const serviceError = fromPostgrest(done.error);
      // Redefinição de uma conta do login compartilhado que não usa o portal: a senha mudou, não há o que concluir aqui.
      if (serviceError.code !== "NO_PORTAL_ACCESS") throw serviceError;
    }
    // Quem provou ser dono da conta sai do bloqueio de tentativas, e as outras sessões caem
    // (no portal, pela RPC; no Auth, pelo signOut oficial). Falha aqui não desfaz a troca.
    const after = await supabase.rpc("security_apos_troca_senha");
    if (after.error) console.error("[auth] pós-troca de senha não concluída", after.error.code);
    await supabase.auth.signOut({ scope: "others" }).catch(() => {});
  },

  async verifyCurrentPassword(password) {
    // Reautentica pelo gateway (mesmos limites e bloqueio do login): prova que é o próprio usuário,
    // atende à "troca segura de senha" do Auth e já deixa a sessão nova registrada no portal.
    const { data } = await supabase.auth.getUser();
    const email = data.user?.email;
    if (!email) throw new ServiceError("UNAUTHENTICATED", "Sua sessão expirou. Entre novamente.");
    const result = await signInThroughGateway(email, password);
    if (!result.ok) {
      if (result.offline) throw new ServiceError("INTERNAL", OFFLINE_MESSAGE);
      throw new ServiceError("INVALID_PASSWORD", "Não foi possível confirmar a senha atual. Verifique e tente novamente mais tarde.", "currentPassword");
    }
  },

  async endSession() {
    // O signOut do Supabase Auth é feito pelo AuthProvider.
  },

  async listSwitchableUsers() {
    return [];
  },

  async switchUser() {
    throw new ServiceError("FORBIDDEN", "O “Ver como” só existe no modo de demonstração.");
  },
};
