import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RoleKey } from "../../../config/app";
import { permissionsService } from "../services";
import type { PermissionChange } from "../services/types";
import { queryKeys } from "./queryKeys";

export function useRolePermissions(role: RoleKey | undefined) {
  return useQuery({
    queryKey: queryKeys.rolePermissions(role ?? ""),
    queryFn: () => permissionsService.getRolePermissions(role ?? ""),
    enabled: role !== undefined,
  });
}

/** Salva o lote e só conclui depois de recarregar as regras e o acesso efetivo (valem na hora). */
export function useSaveRolePermissions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ role, changes }: { role: RoleKey; changes: PermissionChange[] }) =>
      permissionsService.saveRolePermissions(role, changes),
    onSuccess: (_, { role }) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.rolePermissions(role) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.access }),
      ]),
  });
}
