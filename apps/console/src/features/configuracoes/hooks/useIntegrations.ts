import { useQuery } from "@tanstack/react-query";
import { integrationsService } from "../services";
import type { IntegrationHistoryKey } from "../services/types";
import { queryKeys } from "./queryKeys";

export function useIntegrationHistory(key: IntegrationHistoryKey) {
  return useQuery({ queryKey: queryKeys.integrationHistory(key), queryFn: () => integrationsService.history(key) });
}
