import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { appAccessService } from "../services";
import type { AppAccessAppInput, AppAccessNewApp } from "../services/types";
import { queryKeys } from "./queryKeys";

export function useAppAccessApps() {
  // Atualiza sozinha: o selo "Bloqueio NÃO está valendo" vira "Controle ativo" assim que o site do
  // aplicativo faz a primeira verificação, sem precisar recarregar a página.
  return useQuery({ queryKey: queryKeys.appAccess, queryFn: () => appAccessService.listApps(), refetchInterval: 60_000 });
}

export function useAppAccessUsers(schema: string | null) {
  return useQuery({
    queryKey: queryKeys.appAccessUsers(schema ?? ""),
    queryFn: () => appAccessService.listUsers(schema ?? ""),
    enabled: schema !== null,
  });
}

/** Toda mudança recarrega o catálogo (contagens) e as listas de logins (mesmo prefixo). */
function useAppAccessMutation<TVariables, TResult>(mutationFn: (variables: TVariables) => Promise<TResult>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.appAccess }),
  });
}

export function useSaveApp() {
  return useAppAccessMutation(({ schema, input }: { schema: string; input: AppAccessAppInput }) =>
    appAccessService.saveApp(schema, input),
  );
}

export function useAddApp() {
  return useAppAccessMutation((input: AppAccessNewApp) => appAccessService.addApp(input));
}

export function useSetAppControl() {
  return useAppAccessMutation(({ schema, active }: { schema: string; active: boolean }) =>
    appAccessService.setControl(schema, active),
  );
}

export function useSetAppPermission() {
  return useAppAccessMutation(
    ({ schema, userIds, canEnter }: { schema: string; userIds: string[]; canEnter: boolean }) =>
      appAccessService.setPermission(schema, userIds, canEnter),
  );
}
