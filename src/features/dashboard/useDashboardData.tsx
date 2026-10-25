import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { PageSkeleton } from "../../components/PageSkeleton";
import { useAccess } from "../configuracoes/access/useAccess";
import { ErrorState } from "../configuracoes/components/ErrorState";
import { painelService, type NovoTicket, type TicketPatch } from "./service";
import type { DashboardPayload } from "./types";

export { initialsOf } from "./initials";

// Ponto único de leitura do painel da Gestão de Chamados: ch_painel() no modo real, o mock no modo simulado.
// A chave leva o usuário: no "Ver como", trocar de usuário recarrega o painel com o que ele pode ver.

const PAINEL = ["chamados", "painel"] as const;

// Tickets também chegam sozinhos (e-mail lido a cada 1 min, WhatsApp): o painel se atualiza a cada 30 s e ao voltar à aba.
export function usePainel() {
  const { user } = useAccess();
  return useQuery({
    queryKey: [...PAINEL, user?.id],
    queryFn: () => painelService.painel(),
    enabled: Boolean(user),
    staleTime: 30_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function useAtualizarTicket() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: TicketPatch }) => painelService.atualizar(id, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: PAINEL }),
  });
}

export function useCriarTicket() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: NovoTicket) => painelService.criar(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: PAINEL }),
  });
}

/** Carrega o painel e entrega os dados prontos; mostra o esqueleto ou o erro enquanto isso. */
export function ComPainel({ children, skeleton = true }: { children: (data: DashboardPayload) => ReactNode; skeleton?: boolean }) {
  const painel = usePainel();
  if (painel.isPending) return skeleton ? <PageSkeleton /> : null;
  if (painel.isError) return <ErrorState message="Não foi possível carregar os tickets." onRetry={() => void painel.refetch()} />;
  return <>{children(painel.data)}</>;
}
