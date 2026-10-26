import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { authService } from "../services";
import { queryKeys } from "./queryKeys";

export function useSwitchableUsers() {
  return useQuery({ queryKey: queryKeys.switchableUsers, queryFn: () => authService.listSwitchableUsers() });
}

/**
 * Troca o usuário logado (seletor "Ver como" do modo simulado). Só conclui depois de recarregar tudo, para o
 * guard não ler um acesso antigo e mandar o usuário de volta.
 */
export function useSwitchUser() {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: (userId: string) => authService.switchUser(userId), onSuccess: () => queryClient.invalidateQueries() });
}
