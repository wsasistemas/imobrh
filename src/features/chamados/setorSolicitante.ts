import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "../../lib/supabase";
import { DATA_SOURCE } from "../configuracoes/services";
import { delay } from "../configuracoes/services/mock/runtime";
import { fromPostgrest } from "../configuracoes/services/supabase/errors";
import { SETORES_PRODUCAO } from "../atendimento/services/setoresProducao";

// Setor do solicitante (docs/PLANO-setor-solicitante.md, migration 20261016100000). Qualquer setor ativo, inclusive os
// que não recebem chamado. No ticket nasce do setor da pessoa; trocar no ticket atualiza também o cadastro dela.

/** Texto do ticket quando o solicitante não tem setor. */
export const A_IDENTIFICAR = "A identificar";

export interface OpcaoSetor {
  id: number;
  nome: string;
  recebeChamados: boolean;
}

async function rpc<T>(nome: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(nome as never, args as never);
  if (error) throw fromPostgrest(error);
  return data as T;
}

const MOCK_SETORES: OpcaoSetor[] = SETORES_PRODUCAO.map(({ id, nome, recebeChamados }) => ({ id, nome, recebeChamados }));
export const setorSolicitanteMock = new Map<number, number | null>();

const service = {
  opcoes: (): Promise<OpcaoSetor[]> => (DATA_SOURCE === "mock" ? delay().then(() => structuredClone(MOCK_SETORES)) : rpc<OpcaoSetor[]>("ch_setores_opcoes")),
  noTicket: (ticketId: number, setorId: number | null): Promise<void> =>
    DATA_SOURCE === "mock"
      ? delay().then(() => void setorSolicitanteMock.set(ticketId, setorId))
      : rpc<void>("ch_ticket_setor_solicitante_definir", { p_id: ticketId, p_setor: setorId }),
  naPessoa: (pessoaId: number, setorId: number | null): Promise<void> =>
    DATA_SOURCE === "mock" ? delay() : rpc<void>("at_pessoa_setor_definir", { p_pessoa: pessoaId, p_setor: setorId }),
};

export const nomeSetorMock = (id: number | null) => MOCK_SETORES.find((s) => s.id === id)?.nome ?? null;

export function useSetoresOpcoes() {
  return useQuery({ queryKey: ["setores", "opcoes"], queryFn: service.opcoes, staleTime: 60_000 });
}

/** Troca no ticket: recarrega o ticket (histórico), a coluna da Lista e a ficha da pessoa. */
export function useDefinirSetorNoTicket() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: { ticketId: number; setorId: number | null }) => service.noTicket(p.ticketId, p.setorId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["chamados", "ticket"] });
      void qc.invalidateQueries({ queryKey: ["chamados", "visoes", "lista-extras"] });
      void qc.invalidateQueries({ queryKey: ["cadastros", "pessoas"] });
    },
  });
}

export function useDefinirSetorNaPessoa() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: { pessoaId: number; setorId: number | null }) => service.naPessoa(p.pessoaId, p.setorId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["cadastros", "pessoas"] });
      void qc.invalidateQueries({ queryKey: ["chamados", "ticket"] });
    },
  });
}
