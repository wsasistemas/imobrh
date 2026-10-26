import type { VinculoRm } from "@imobrh/shared";
import { supabase } from "../../../../lib/supabase";
import type { PendingLink, VinculosService } from "../contracts";
import { invokeFunction, required } from "./errors";

interface PendenteRow {
  user_id: string;
  nome: string;
  email: string;
  status: PendingLink["status"];
  motivo: string | null;
  cpf: string | null;
  atualizado_em: string;
}

export const supabaseVinculosService: VinculosService = {
  /** Logins sem chapa no RM (app_imobrh.listar_vinculos_pendentes; exige o menu Vínculos pendentes). */
  async listPending() {
    const rows = required(await supabase.rpc("listar_vinculos_pendentes")) as PendenteRow[];
    return rows.map((row) => ({
      userId: row.user_id,
      name: row.nome,
      email: row.email,
      status: row.status,
      reason: row.motivo,
      cpfMasked: row.cpf,
      updatedAt: row.atualizado_em,
    }));
  },

  /** Edge Function rm-funcionario: procura o CPF no RM e grava o vínculo. */
  async link(userId, cpf) {
    const { vinculo, motivo } = await invokeFunction<{ vinculo: VinculoRm; motivo: string | null }>("rm-funcionario", {
      action: "vincular",
      usuario_id: userId,
      cpf: cpf.replace(/\D/g, ""),
    });
    return { status: vinculo.status, chapa: vinculo.chapa, name: vinculo.nome, reason: motivo };
  },
};
