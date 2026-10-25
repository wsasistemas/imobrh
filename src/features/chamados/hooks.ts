import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  cadastrosService,
  type SalvarCampo,
  type SalvarCategoria,
  type SalvarMacro,
  type SalvarRegra,
  type SalvarServico,
  type SalvarUrgencia,
  type TabelaOrdenavel,
} from "./cadastros/service";
import { statusService } from "./status/service";
import type { JustificativaSalvar, StatusSalvar } from "./status/types";
import { visoesService } from "./visoes/service";
import type { VisaoSalvar } from "./visoes/types";

// Gestão de Chamados: status e visões de Tickets.

const STATUS = ["chamados", "status"] as const;
const VISOES = ["chamados", "visoes"] as const;

export function useStatusTickets() {
  return useQuery({ queryKey: STATUS, queryFn: () => statusService.lista(), staleTime: 60_000 });
}

function useMudaStatus<T>(fn: (p: T) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => qc.invalidateQueries({ queryKey: STATUS }) });
}

export const useSalvarStatus = () => useMudaStatus((p: StatusSalvar) => statusService.salvarStatus(p));
export const useSalvarJustificativa = () => useMudaStatus((p: JustificativaSalvar) => statusService.salvarJustificativa(p));
export const useOrdenarStatus = () => useMudaStatus((ids: number[]) => statusService.ordenar(ids));

/** Visões que o usuário pode usar na tela Tickets (habilitadas; das equipes dele, ou todas para admin). */
export function useVisoesDisponiveis(userId: string | undefined) {
  return useQuery({ queryKey: [...VISOES, "disponiveis", userId], queryFn: () => visoesService.disponiveis(), enabled: Boolean(userId) });
}

/** Todas as visões, para a tela Configurar visões (só Admin e Super admin). */
export function useVisoesConfig() {
  return useQuery({ queryKey: [...VISOES, "config"], queryFn: () => visoesService.todas() });
}

export function useKanbanPadrao() {
  return useQuery({ queryKey: [...VISOES, "kanban-padrao"], queryFn: () => visoesService.kanbanPadrao() });
}

/** Colunas novas da Lista (ch_lista_extras): só busca quando a visão usa alguma ou o seletor de colunas abre. */
export function useListaExtras(enabled: boolean) {
  return useQuery({ queryKey: [...VISOES, "lista-extras"], queryFn: () => visoesService.listaExtras(), enabled, staleTime: 30_000 });
}

export function useEquipesVisoes() {
  return useQuery({ queryKey: [...VISOES, "equipes"], queryFn: () => visoesService.equipes(), staleTime: 60_000 });
}

function useMudaVisoes<T>(fn: (p: T) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => qc.invalidateQueries({ queryKey: VISOES }) });
}

export const useSalvarVisao = () => useMudaVisoes((p: VisaoSalvar) => visoesService.salvar(p));
export const useExcluirVisao = () => useMudaVisoes((id: number) => visoesService.excluir(id));
export const useSalvarKanbanPadrao = () => useMudaVisoes((p: VisaoSalvar["kanban"]["colunas"]) => visoesService.salvarKanbanPadrao(p));

// ---------- Cadastros do ticket (Administração) ----------

const CADASTROS = ["chamados", "cadastros"] as const;

export function useCadastros() {
  return useQuery({ queryKey: CADASTROS, queryFn: () => cadastrosService.carregar(), staleTime: 60_000 });
}

function useMudaCadastro<T>(fn: (p: T) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => qc.invalidateQueries({ queryKey: CADASTROS }) });
}

export const useSalvarUrgencia = () => useMudaCadastro((p: SalvarUrgencia) => cadastrosService.salvarUrgencia(p));
export const useSalvarCategoria = () => useMudaCadastro((p: SalvarCategoria) => cadastrosService.salvarCategoria(p));
export const useSalvarServico = () => useMudaCadastro((p: SalvarServico) => cadastrosService.salvarServico(p));
export const useSalvarCampo = () => useMudaCadastro((p: SalvarCampo) => cadastrosService.salvarCampo(p));
export const useSalvarRegra = () => useMudaCadastro((p: SalvarRegra) => cadastrosService.salvarRegra(p));
export const useOrdenarCadastro = () => useMudaCadastro((p: { tabela: TabelaOrdenavel; ids: number[] }) => cadastrosService.ordenar(p.tabela, p.ids));
export const useSalvarPadroesSetor = () =>
  useMudaCadastro((p: { setorId: number; equipeId: number | null; slaHoras: number }) => cadastrosService.salvarPadroesSetor(p.setorId, p.equipeId, p.slaHoras));

const MACROS = ["chamados", "macros"] as const;

export function useMacros() {
  return useQuery({ queryKey: MACROS, queryFn: () => cadastrosService.macros() });
}

export function useSalvarMacro() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (p: SalvarMacro) => cadastrosService.salvarMacro(p), onSuccess: () => qc.invalidateQueries({ queryKey: MACROS }) });
}
