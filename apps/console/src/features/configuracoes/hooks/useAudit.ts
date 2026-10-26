import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { auditService } from "../services";
import type { AuditFilters } from "../services/types";
import { queryKeys } from "./queryKeys";

export function useAuditLog(filters: AuditFilters, page: number) {
  return useQuery({
    queryKey: queryKeys.audit(filters, page),
    queryFn: () => auditService.list(filters, page),
    placeholderData: keepPreviousData,
  });
}

export function useExportAudit() {
  return useMutation({ mutationFn: (filters: AuditFilters) => auditService.exportCsv(filters) });
}
