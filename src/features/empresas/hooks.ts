import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { empresasService, type NovaEmpresa, type Tema } from "./service";

export const chavesEmpresas = {
  minhas: ["empresas", "minhas"] as const,
  preferencias: ["empresas", "preferencias"] as const,
  wsa: ["empresas", "wsa"] as const,
};

export function useMinhasEmpresas(ativo = true) {
  return useQuery({ queryKey: chavesEmpresas.minhas, queryFn: () => empresasService.minhas(), enabled: ativo, staleTime: 60_000 });
}

export function usePreferencias(ativo = true) {
  return useQuery({ queryKey: chavesEmpresas.preferencias, queryFn: () => empresasService.preferencias(), enabled: ativo, staleTime: 60_000 });
}

/** Troca de empresa recarrega o portal inteiro: todo dado em tela é da empresa anterior. */
export function useTrocarEmpresa() {
  return useMutation({
    mutationFn: (id: string) => empresasService.trocar(id),
    onSuccess: () => window.location.assign("/home"),
  });
}

export function useSalvarTema() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (tema: Tema) => empresasService.salvarTema(tema),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: chavesEmpresas.preferencias }),
  });
}

export function useEmpresasWsa() {
  return useQuery({ queryKey: chavesEmpresas.wsa, queryFn: () => empresasService.listarWsa() });
}

export function useCriarEmpresa() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (dados: NovaEmpresa) => empresasService.criar(dados),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["empresas"] }),
  });
}
