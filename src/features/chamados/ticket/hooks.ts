import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ticketService } from "./service";
import type { NovaAcao, PatchTicket } from "./types";

const TICKET = ["chamados", "ticket"] as const;
const PAINEL = ["chamados", "painel"] as const;

export function useTicket(id: number) {
  return useQuery({ queryKey: [...TICKET, id], queryFn: () => ticketService.detalhe(id), enabled: Number.isFinite(id) && id > 0 });
}

export function useSolucoesAnteriores(id: number, servicoId: number | null | undefined) {
  return useQuery({ queryKey: [...TICKET, id, "solucoes", servicoId], queryFn: () => ticketService.solucoes(id), enabled: id > 0 });
}

export function useResponsaveis() {
  return useQuery({ queryKey: ["chamados", "responsaveis"], queryFn: () => ticketService.responsaveis(), staleTime: 60_000 });
}

/** Mutação do ticket: recarrega o ticket, o painel (listas, KPIs e Página Inicial), os avisos e os gatilhos. */
function useMudaTicket<T, R>(fn: (p: T) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: TICKET });
      void qc.invalidateQueries({ queryKey: PAINEL });
      // Gatilhos podem ter avisado alguém (sino) e registrado execuções.
      void qc.invalidateQueries({ queryKey: ["chamados", "notificacoes"] });
      void qc.invalidateQueries({ queryKey: ["chamados", "gatilhos"] });
    },
  });
}

export const useAtualizarDetalhe = () => useMudaTicket((p: { id: number; patch: PatchTicket }) => ticketService.atualizar(p.id, p.patch));
export const useAdicionarAcao = () => useMudaTicket((p: { id: number; acao: NovaAcao }) => ticketService.acao(p.id, p.acao));
export const useSeguirTicket = () => useMudaTicket((p: { id: number; seguir: boolean }) => ticketService.seguir(p.id, p.seguir));
export const useClonarTicket = () => useMudaTicket((p: { id: number; copiarCampos: boolean; copiarAcoes: boolean }) => ticketService.clonar(p.id, p));
export const useMesclarTicket = () => useMudaTicket((p: { origem: number; destino: number }) => ticketService.mesclar(p.origem, p.destino));
export const useExcluirTicket = () => useMudaTicket((id: number) => ticketService.excluir(id));
