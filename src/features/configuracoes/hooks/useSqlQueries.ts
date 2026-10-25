import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { sqlQueriesService } from "../services";
import type { SqlQueryInput } from "../services/types";
import { queryKeys } from "./queryKeys";

export function useSqlQueries() {
  return useQuery({ queryKey: queryKeys.sqlQueries, queryFn: () => sqlQueriesService.list() });
}

/** Toda mutação recarrega a lista e o histórico (mesmo prefixo de chave). */
function useSqlQueryMutation<TVariables, TResult>(mutationFn: (variables: TVariables) => Promise<TResult>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.sqlQueries }),
  });
}

export function useSaveSqlQuery() {
  return useSqlQueryMutation(({ id, input }: { id: string | null; input: SqlQueryInput }) => sqlQueriesService.save(id, input));
}

export function useSetSqlQueryActive() {
  return useSqlQueryMutation(({ id, active }: { id: string; active: boolean }) => sqlQueriesService.setActive(id, active));
}

export function useMoveSqlQuery() {
  return useSqlQueryMutation(({ id, direction }: { id: string; direction: "up" | "down" }) =>
    sqlQueriesService.move(id, direction),
  );
}

export function useDeleteSqlQuery() {
  return useSqlQueryMutation((id: string) => sqlQueriesService.delete(id));
}

export function useTestSqlQuery() {
  return useSqlQueryMutation(({ id, parameters }: { id: string; parameters: string }) => sqlQueriesService.test(id, parameters));
}
