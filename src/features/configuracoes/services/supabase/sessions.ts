import { supabase } from "../../../../lib/supabase";
import type { SessionsService } from "../contracts";
import { required, unwrap } from "./errors";
import { describeDevice } from "./mappers";

export const supabaseSessionsService: SessionsService = {
  async list() {
    const rows = required(await supabase.rpc("listar_sessoes"));
    return rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      userName: row.nome,
      userEmail: row.email,
      device: describeDevice(row.user_agent),
      // O Supabase não guarda localização: mostra o IP de origem da sessão.
      location: row.ip ?? "—",
      startedAt: row.iniciada_em,
      lastActivityAt: row.ultima_atividade,
      isCurrent: row.atual,
    }));
  },

  async revoke(sessionId) {
    unwrap(await supabase.rpc("encerrar_sessao", { p_sessao: sessionId }));
  },
};
