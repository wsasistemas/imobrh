import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { totvsService } from "../services";
import type { TotvsConnectionInput } from "../services/types";
import { queryKeys } from "./queryKeys";

export function useTotvsConnection() {
  return useQuery({ queryKey: queryKeys.totvsConnection, queryFn: () => totvsService.getConnection() });
}

/** Salvar e testar recarregam a conexão e o histórico (mesmo prefixo de chave). */
function useTotvsMutation<TVariables, TResult>(mutationFn: (variables: TVariables) => Promise<TResult>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.totvsConnection }),
  });
}

export function useSaveTotvsConnection() {
  return useTotvsMutation((input: TotvsConnectionInput) => totvsService.saveConnection(input));
}

export function useTestTotvsConnection() {
  return useTotvsMutation((proposalId: string | null) => totvsService.testConnection(proposalId));
}
