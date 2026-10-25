import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { gatilhosService } from "./service";
import type { GatilhoSalvar } from "./types";

const GATILHOS = ["chamados", "gatilhos"] as const;

export function useGatilhos() {
  return useQuery({ queryKey: GATILHOS, queryFn: () => gatilhosService.lista() });
}

export function useExecucoesGatilhos(dias: number, gatilhoId: number | null) {
  return useQuery({ queryKey: [...GATILHOS, "execucoes", dias, gatilhoId], queryFn: () => gatilhosService.execucoes(dias, gatilhoId) });
}

function useMudaGatilho<T, R>(fn: (p: T) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => qc.invalidateQueries({ queryKey: GATILHOS }) });
}

export const useSalvarGatilho = () => useMudaGatilho((p: GatilhoSalvar) => gatilhosService.salvar(p));
export const useOrdenarGatilhos = () => useMudaGatilho((ids: number[]) => gatilhosService.ordenar(ids));
