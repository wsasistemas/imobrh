import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RoleKey } from "../../../config/app";
import { usersService } from "../services";
import type { UserListParams } from "../services/types";
import { queryKeys } from "./queryKeys";

export function useUsers(params: UserListParams) {
  return useQuery({
    queryKey: queryKeys.users(params),
    queryFn: () => usersService.list(params),
    // Mantém a lista anterior na tela enquanto a nova página/filtro carrega.
    placeholderData: keepPreviousData,
  });
}

/** Troca os papéis: recarrega a lista, o acesso do logado, o "Ver como" e as contagens por papel. */
export function useSetUserRoles() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, roles }: { id: string; roles: RoleKey[] }) => usersService.setRoles(id, roles),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.usersRoot });
      void queryClient.invalidateQueries({ queryKey: queryKeys.access });
      void queryClient.invalidateQueries({ queryKey: queryKeys.switchableUsers });
      void queryClient.invalidateQueries({ queryKey: queryKeys.roles });
    },
  });
}
