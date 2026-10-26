import { supabase } from "../../../../lib/supabase";
import type { SessionsService } from "../contracts";
import { required, unwrap } from "./errors";
import { describeDevice } from "./mappers";

/** Linha de app_imobrh.listar_sessoes(). */
interface SessaoRow {
  id: string;
  user_id: string;
  nome: string;
  email: string;
  user_agent: string | null;
  ip: string | null;
  iniciada_em: string;
  ultima_atividade: string;
  atual: boolean;
}

export const supabaseSessionsService: SessionsService = {
  async list() {
    const rows = required(await supabase.rpc("listar_sessoes")) as SessaoRow[];
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
