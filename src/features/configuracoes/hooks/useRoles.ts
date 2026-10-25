import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RoleKey } from "../../../config/app";
import { rolesService } from "../services";
import type { RoleInput } from "../services/types";
import { queryKeys } from "./queryKeys";

/** Perfis em ordem de hierarquia (usado em Usuários e em Perfis e permissões). */
export function useRoles() {
  return useQuery({ queryKey: queryKeys.roles, queryFn: () => rolesService.list() });
}

/** Mudança no cadastro de perfis: nomes aparecem em usuários, no acesso do logado e no "Ver como". */
function useRoleMutation<TVariables, TResult>(mutationFn: (variables: TVariables) => Promise<TResult>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.roles }),
        queryClient.invalidateQueries({ queryKey: queryKeys.usersRoot }),
        queryClient.invalidateQueries({ queryKey: queryKeys.access }),
        queryClient.invalidateQueries({ queryKey: queryKeys.switchableUsers }),
      ]),
  });
}

export function useCreateRole() {
  return useRoleMutation((input: RoleInput) => rolesService.create(input));
}

export function useUpdateRole() {
  return useRoleMutation(({ key, input }: { key: RoleKey; input: RoleInput }) => rolesService.update(key, input));
}

export function useDeleteRole() {
  return useRoleMutation((key: RoleKey) => rolesService.delete(key));
}
