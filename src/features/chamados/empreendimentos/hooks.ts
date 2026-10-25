import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { empreendimentosService, type ConfigSetor, type SalvarEmpreendimento } from "./service";

const CHAVE = ["chamados", "empreendimentos"] as const;

/** Cadastro e configuração por setor (também alimenta o filtro da tela Tickets). */
export function useEmpreendimentos(enabled = true) {
  return useQuery({ queryKey: CHAVE, queryFn: () => empreendimentosService.carregar(), staleTime: 60_000, enabled });
}

function useMuda<T>(fn: (p: T) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => qc.invalidateQueries({ queryKey: CHAVE }) });
}

export const useSalvarEmpreendimento = () => useMuda((p: SalvarEmpreendimento) => empreendimentosService.salvar(p));
export const useSalvarConfigEmpreendimento = () => useMuda((p: ConfigSetor) => empreendimentosService.salvarConfig(p));

export function useEmpreendimentoDoTicket(ticketId: number) {
  return useQuery({ queryKey: [...CHAVE, "ticket", ticketId], queryFn: () => empreendimentosService.doTicket(ticketId), enabled: ticketId > 0 });
}

/** Troca no ticket: recarrega o ticket (histórico), o painel e a coluna da Lista. */
export function useDefinirEmpreendimento() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: { ticketId: number; empreendimentoId: number | null }) => empreendimentosService.definirNoTicket(p.ticketId, p.empreendimentoId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: CHAVE });
      void qc.invalidateQueries({ queryKey: ["chamados", "ticket"] });
      void qc.invalidateQueries({ queryKey: ["chamados", "visoes", "lista-extras"] });
    },
  });
}
