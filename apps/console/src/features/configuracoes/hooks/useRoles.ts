import { useQuery } from "@tanstack/react-query";
import { rolesService } from "../services";
import { queryKeys } from "./queryKeys";

/** Os 8 papéis do ImobRH, na ordem do PRD (usado em Usuários e papéis e em Permissões por papel). */
export function useRoles() {
  return useQuery({ queryKey: queryKeys.roles, queryFn: () => rolesService.list() });
}
