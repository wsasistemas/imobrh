import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { treinamento } from "./service";
import type { SalvarBalao, SalvarModulo } from "./types";

const CHAVE = ["treinamento"] as const;

/** Meus treinamentos; com setor (só Admin), "ver como" as pessoas daquele setor. */
export function useMeusTreinamentos(setor: number | null = null) {
  return useQuery({ queryKey: [...CHAVE, "meus", setor], queryFn: () => treinamento.meus(setor) });
}

export function useModulo(id: number) {
  // Sem staleTime: o tour sempre lê o passo atual de novo ao abrir (retoma de onde parou).
  return useQuery({ queryKey: [...CHAVE, "modulo", id], queryFn: () => treinamento.modulo(id), enabled: id > 0 });
}

/** Passo atual: grava em segundo plano, sem recarregar a lista a cada passo. */
export function useSalvarProgresso() {
  return useMutation({ mutationFn: (p: { moduloId: number; passo: number }) => treinamento.salvarProgresso(p.moduloId, p.passo) });
}

function useMuda<T, R>(fn: (p: T) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => qc.invalidateQueries({ queryKey: CHAVE }) });
}

export const useResponder = () => useMuda((p: { moduloId: number; opcao: number }) => treinamento.responder(p.moduloId, p.opcao));

// Gerenciar tutoriais (Admin)

export function usePainelTreinamento(ativo = true) {
  return useQuery({ queryKey: [...CHAVE, "painel"], queryFn: () => treinamento.painel(), enabled: ativo });
}

export function useModuloAdmin(id: number) {
  return useQuery({ queryKey: [...CHAVE, "admin", id], queryFn: () => treinamento.moduloAdmin(id), enabled: id > 0 });
}

export function useProgressoPorSetor() {
  return useQuery({ queryKey: [...CHAVE, "progresso"], queryFn: () => treinamento.progressoPorSetor() });
}

export function useProgressoPessoas(setorId: number | null, ativo: boolean) {
  return useQuery({ queryKey: [...CHAVE, "pessoas", setorId], queryFn: () => treinamento.progressoPessoas(setorId), enabled: ativo });
}

export const useSalvarModulo = () => useMuda((p: SalvarModulo) => treinamento.salvarModulo(p));
export const useSalvarBalao = () => useMuda((p: SalvarBalao) => treinamento.salvarBalao(p));
export const useExcluirBalao = () => useMuda((id: number) => treinamento.excluirBalao(id));
export const useReordenarBaloes = () => useMuda((p: { moduloId: number; ids: number[] }) => treinamento.reordenarBaloes(p.moduloId, p.ids));
export const useSalvarSetoresDaTrilha = () => useMuda((p: { trilhaId: number; setores: number[] }) => treinamento.salvarSetoresDaTrilha(p.trilhaId, p.setores));
