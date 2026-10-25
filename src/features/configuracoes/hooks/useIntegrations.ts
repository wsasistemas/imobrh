import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { integrationsService } from "../services";
import type {
  IntegrationHistoryKey,
  IntegrationKey,
  IntegrationPublicFields,
  IntegrationTestResult,
} from "../services/types";
import { queryKeys } from "./queryKeys";

export function useIntegration(key: IntegrationKey) {
  return useQuery({ queryKey: queryKeys.integration(key), queryFn: () => integrationsService.get(key) });
}

export function useIntegrationHistory(key: IntegrationHistoryKey) {
  return useQuery({ queryKey: queryKeys.integrationHistory(key), queryFn: () => integrationsService.history(key) });
}

/**
 * Toda mutação da integração recarrega o card e o histórico: a chave ["integration", key]
 * também cobre ["integration", key, "history"]. A auditoria é gravada pelo serviço.
 */
function useIntegrationMutation<TVariables, TResult>(
  key: IntegrationKey,
  mutationFn: (variables: TVariables) => Promise<TResult>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.integration(key) }),
  });
}

export function useUpdateIntegration(key: IntegrationKey) {
  return useIntegrationMutation(key, (fields: IntegrationPublicFields) => integrationsService.update(key, fields));
}

export function useReplaceSecret(key: IntegrationKey) {
  return useIntegrationMutation(key, (secret: string) => integrationsService.replaceSecret(key, secret));
}

export function useTestIntegration(key: IntegrationKey) {
  return useIntegrationMutation<void, IntegrationTestResult>(key, () => integrationsService.test(key));
}
