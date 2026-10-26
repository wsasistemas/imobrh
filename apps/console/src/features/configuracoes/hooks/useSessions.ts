import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { sessionsService } from "../services";
import { queryKeys } from "./queryKeys";

export function useSessions() {
  return useQuery({ queryKey: queryKeys.sessions, queryFn: () => sessionsService.list() });
}

export function useRevokeSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) => sessionsService.revoke(sessionId),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.sessions }),
        // "Usuários conectados" na barra de Perfis e permissões.
        queryClient.invalidateQueries({ queryKey: queryKeys.roles }),
      ]),
  });
}
