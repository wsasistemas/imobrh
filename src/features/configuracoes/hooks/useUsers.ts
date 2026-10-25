import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { usersService } from "../services";
import type {
  CreateUserWithPasswordInput,
  InviteUserInput,
  UpdateUserInput,
  UserListParams,
} from "../services/types";
import { queryKeys } from "./queryKeys";

export function useUsers(params: UserListParams) {
  return useQuery({
    queryKey: queryKeys.users(params),
    queryFn: () => usersService.list(params),
    // Mantém a lista anterior na tela enquanto a nova página/filtro carrega.
    placeholderData: keepPreviousData,
  });
}

/** Mutação de usuário: ao concluir, recarrega a lista, o acesso do logado, o seletor "Ver como" e os perfis. */
function useUserMutation<TVariables, TResult>(mutationFn: (variables: TVariables) => Promise<TResult>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.usersRoot });
      void queryClient.invalidateQueries({ queryKey: queryKeys.access });
      void queryClient.invalidateQueries({ queryKey: queryKeys.switchableUsers });
      // Contagem de usuários por perfil, na tela de Perfis e permissões.
      void queryClient.invalidateQueries({ queryKey: queryKeys.roles });
    },
  });
}

export function useInviteUser() {
  return useUserMutation((input: InviteUserInput) => usersService.invite(input));
}

export function useCreateUserWithPassword() {
  return useUserMutation((input: CreateUserWithPasswordInput) => usersService.createWithTempPassword(input));
}

export function useUpdateUser() {
  return useUserMutation(({ id, input }: { id: string; input: UpdateUserInput }) => usersService.update(id, input));
}

export function useSetUserActive() {
  return useUserMutation(({ id, active }: { id: string; active: boolean }) => usersService.setActive(id, active));
}

export function useDeleteUser() {
  return useUserMutation((id: string) => usersService.delete(id));
}

export function useSetPasswordChangeRequired() {
  return useUserMutation(({ id, required }: { id: string; required: boolean }) =>
    usersService.setPasswordChangeRequired(id, required),
  );
}

export function useSetTemporaryPassword() {
  return useUserMutation(({ id, password }: { id: string; password: string }) =>
    usersService.setTemporaryPassword(id, password),
  );
}

export function useSendPasswordReset() {
  return useUserMutation((id: string) => usersService.sendPasswordReset(id));
}
