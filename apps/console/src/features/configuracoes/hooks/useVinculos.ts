import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { vinculosService } from "../services";
import { queryKeys } from "./queryKeys";

export function usePendingLinks() {
  return useQuery({ queryKey: queryKeys.pendingLinks, queryFn: () => vinculosService.listPending() });
}

/** Vincula pelo CPF: recarrega a lista de pendentes e a de usuários (situação do vínculo e papel colaborador). */
export function useLinkUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, cpf }: { userId: string; cpf: string }) => vinculosService.link(userId, cpf),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.pendingLinks });
      void queryClient.invalidateQueries({ queryKey: queryKeys.usersRoot });
    },
  });
}
