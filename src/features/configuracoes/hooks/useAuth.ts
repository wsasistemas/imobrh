import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { authService } from "../services";
import { queryKeys } from "./queryKeys";

export function useSwitchableUsers() {
  return useQuery({ queryKey: queryKeys.switchableUsers, queryFn: () => authService.listSwitchableUsers() });
}

/**
 * Mutações que trocam quem está logado (ou o estado dele). Só concluem depois de recarregar
 * tudo, para o guard não ler um acesso antigo e mandar o usuário de volta.
 */
function useSessionMutation<TVariables>(mutationFn: (variables: TVariables) => Promise<void>) {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn, onSuccess: () => queryClient.invalidateQueries() });
}

/** Troca o usuário logado (seletor "Ver como") e recarrega tudo que depende dele. */
export function useSwitchUser() {
  return useSessionMutation((userId: string) => authService.switchUser(userId));
}

/** Troca voluntária da própria senha: confere a atual e grava a nova. */
export function useChangeOwnPassword() {
  return useSessionMutation(async ({ current, next }: { current: string; next: string }) => {
    await authService.verifyCurrentPassword(current);
    await authService.changePassword(next);
  });
}

export function useChangePassword() {
  return useSessionMutation((newPassword: string) => authService.changePassword(newPassword));
}
