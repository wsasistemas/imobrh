import { supabase } from "../../../../lib/supabase";
import type { AuthService } from "../contracts";
import { ServiceError } from "../types";

export const supabaseAuthService: AuthService = {
  async bindSession() {
    // O JWT já identifica o usuário; o acesso é lido de app_imobrh.meu_acesso() pelo AccessProvider.
    await supabase.auth.getSession();
  },

  async endSession() {
    // O signOut do Supabase Auth é feito pelo AuthProvider.
  },

  async listSwitchableUsers() {
    return [];
  },

  async switchUser() {
    throw new ServiceError("SEM_PERMISSAO", "O “Ver como” só existe no modo simulado.");
  },
};
