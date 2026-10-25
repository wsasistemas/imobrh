import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "../../../lib/supabase";
import { DATA_SOURCE } from "../../configuracoes/services";
import { currentActor, delay } from "../../configuracoes/services/mock/runtime";
import { fromPostgrest } from "../../configuracoes/services/supabase/errors";
import { notificacoesDe } from "./store";
import type { Notificacao } from "./types";

// Avisos do sino (G4). Separado do serviço dos gatilhos para o topo do portal não carregar o resto.

export interface Avisos {
  naoLidas: number;
  itens: Notificacao[];
}

export const NOTIFICACOES = ["chamados", "notificacoes"] as const;

async function lista(): Promise<Avisos> {
  if (DATA_SOURCE === "mock") {
    await delay();
    const itens = notificacoesDe(currentActor().id).slice(0, 30);
    return structuredClone({ naoLidas: itens.filter((n) => !n.lida).length, itens: itens.map(({ usuarioId: _u, ...n }) => n) });
  }
  const { data, error } = await supabase.rpc("ch_notificacoes_lista" as never);
  if (error) throw fromPostgrest(error);
  return data as unknown as Avisos;
}

async function ler(ids: number[] | null): Promise<void> {
  if (DATA_SOURCE === "mock") {
    await delay();
    for (const n of notificacoesDe(currentActor().id)) if (ids === null || ids.includes(n.id)) n.lida = true;
    return;
  }
  const { error } = await supabase.rpc("ch_notificacoes_ler" as never, { p_ids: ids } as never);
  if (error) throw fromPostgrest(error);
}

/** Confere a cada minuto. */
export function useNotificacoes(ativo: boolean) {
  return useQuery({ queryKey: NOTIFICACOES, queryFn: lista, enabled: ativo, refetchInterval: 60_000, staleTime: 30_000 });
}

export function useLerNotificacoes() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: ler, onSuccess: () => qc.invalidateQueries({ queryKey: NOTIFICACOES }) });
}
