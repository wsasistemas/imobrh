import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { equipesService, type EquipeSalvar } from "../services/equipes";
import { pessoasService, type FiltroPessoas, type PessoaDados, type TipoPessoa } from "../services/pessoas";

// ---------- Equipes ----------

const EQUIPES = ["cadastros", "equipes"] as const;

export function useEquipes(habilitado = true) {
  return useQuery({ queryKey: EQUIPES, queryFn: () => equipesService.lista(), enabled: habilitado });
}

export function useCandidatosEquipe(habilitado: boolean) {
  return useQuery({ queryKey: [...EQUIPES, "candidatos"], queryFn: () => equipesService.candidatos(), enabled: habilitado });
}

export function useSetoresEquipe(habilitado: boolean) {
  return useQuery({ queryKey: [...EQUIPES, "setores"], queryFn: () => equipesService.setores(), enabled: habilitado });
}

export function useEquipesDoUsuario(usuarioId: string) {
  return useQuery({ queryKey: [...EQUIPES, "usuario", usuarioId], queryFn: () => equipesService.doUsuario(usuarioId) });
}

function useMudaEquipe<T, R>(fn: (d: T) => Promise<R>) {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => void queryClient.invalidateQueries({ queryKey: EQUIPES }) });
}

export const useSalvarEquipe = () => useMudaEquipe((p: EquipeSalvar) => equipesService.salvar(p));
export const useExcluirEquipe = () => useMudaEquipe((id: number) => equipesService.excluir(id));
export const useSalvarEquipesDoUsuario = () => useMudaEquipe((p: { usuarioId: string; equipes: number[] }) => equipesService.salvarDoUsuario(p.usuarioId, p.equipes));

// ---------- Pessoas ----------

const PESSOAS = ["cadastros", "pessoas"] as const;

export function usePessoas(f: FiltroPessoas) {
  return useQuery({ queryKey: [...PESSOAS, "lista", f], queryFn: () => pessoasService.lista(f), placeholderData: keepPreviousData });
}

export function usePessoa(id: number | null) {
  return useQuery({ queryKey: [...PESSOAS, "detalhe", id], queryFn: () => pessoasService.detalhe(id!), enabled: id !== null });
}

export function useBuscaPessoas(q: string, tipos?: TipoPessoa[]) {
  return useQuery({ queryKey: [...PESSOAS, "busca", q, tipos], queryFn: () => pessoasService.busca(q, tipos), enabled: q.trim().length >= 2 });
}

function useMudaPessoa<T, R>(fn: (d: T) => Promise<R>) {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => void queryClient.invalidateQueries({ queryKey: PESSOAS }) });
}

export const useSalvarPessoa = () => useMudaPessoa((p: PessoaDados & { id?: number }) => pessoasService.salvar(p));
export const useMesclarPessoa = () => useMudaPessoa((p: { fica: number; sai: number }) => pessoasService.mesclar(p.fica, p.sai));
export const useExcluirPessoa = () => useMudaPessoa((id: number) => pessoasService.excluir(id));
export const useAnexarPessoa = () => useMudaPessoa((p: { pessoaId: number; arquivo: File }) => pessoasService.anexar(p.pessoaId, p.arquivo));
export const useRemoverAnexo = () => useMudaPessoa((id: number) => pessoasService.removerAnexo(id));
