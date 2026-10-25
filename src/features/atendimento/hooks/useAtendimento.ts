import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { centralService, contextoService, monitorService, zenviaService } from "../services/atendimento";
import { emailService, type ContaEmailDados } from "../services/email";
import { openwaService, type LinhaImportar } from "../services/openwa";
import type { AcaoConversa, Periodo, SalvarConexao, SetorConfig, SetorSalvar } from "../services/tipos";

const RAIZ = ["atendimento"] as const;
const CONTEXTO = [...RAIZ, "contexto"] as const;
const CONVERSAS = [...RAIZ, "conversas"] as const;
const MONITOR = [...RAIZ, "monitor"] as const;
const ZENVIA = [...RAIZ, "zenvia"] as const;
const mensagensDe = (id: number) => [...RAIZ, "mensagens", id] as const;

// ---------- Contexto (setores, papel, equipe) ----------

export function useContexto() {
  return useQuery({ queryKey: CONTEXTO, queryFn: () => contextoService.contexto(), refetchInterval: 60_000 });
}

export function useCandidatos(habilitado: boolean) {
  return useQuery({ queryKey: [...RAIZ, "candidatos"], queryFn: () => contextoService.candidatos(), enabled: habilitado });
}

function useMudaContexto<T, R>(fn: (dados: T) => Promise<R>) {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => void queryClient.invalidateQueries({ queryKey: RAIZ }) });
}

export const useSalvarSetor = () => useMudaContexto((p: SetorSalvar) => contextoService.setorSalvar(p));
export const useSalvarConfigSetor = () => useMudaContexto((p: SetorConfig) => contextoService.setorConfigSalvar(p));
export const useSalvarAtendente = () => useMudaContexto((p: { usuarioId: string; setorId: number; apto?: boolean }) => contextoService.atendenteSalvar(p));
export const useRemoverAtendente = () => useMudaContexto((usuarioId: string) => contextoService.atendenteRemover(usuarioId));
export const usePausa = () => useMudaContexto((pausa: boolean) => contextoService.pausa(pausa));

/** Presença do atendente: enquanto a Central estiver aberta, avisa a cada minuto que está online. */
export function usePresenca(ativo: boolean) {
  useEffect(() => {
    if (!ativo) return undefined;
    void contextoService.ping().catch(() => undefined);
    const id = window.setInterval(() => void contextoService.ping().catch(() => undefined), 60_000);
    return () => window.clearInterval(id);
  }, [ativo]);
}

// ---------- Central ----------

/** O Realtime avisa as mudanças; a consulta a cada 30 s é só a rede de segurança. */
export function useConversas() {
  return useQuery({ queryKey: CONVERSAS, queryFn: () => centralService.conversas(), refetchInterval: 30_000 });
}

export function useMensagens(conversaId: number | null) {
  return useQuery({
    queryKey: mensagensDe(conversaId ?? 0),
    queryFn: () => centralService.mensagens(conversaId!),
    enabled: conversaId !== null,
    refetchInterval: 30_000,
  });
}

export function useAcaoConversa() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (p: { conversaId: number; acao: AcaoConversa }) => centralService.acao(p.conversaId, p.acao),
    onSettled: (_r, _e, p) => {
      void queryClient.invalidateQueries({ queryKey: CONVERSAS });
      void queryClient.invalidateQueries({ queryKey: MONITOR });
      void queryClient.invalidateQueries({ queryKey: mensagensDe(p.conversaId) });
    },
  });
}

export function useMarcarLida() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (conversaId: number) => centralService.marcarLida(conversaId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: CONVERSAS }),
  });
}

export function useEditarConversa() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (p: { conversaId: number; nomeContato?: string; notaInterna?: string }) =>
      centralService.editar(p.conversaId, { nomeContato: p.nomeContato, notaInterna: p.notaInterna }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: CONVERSAS }),
  });
}

/** Tempo real: mensagem nova, mudança de conversa ou de presença atualiza Central e Monitor sem recarregar. */
export function useTempoReal() {
  const queryClient = useQueryClient();
  useEffect(() => {
    return centralService.assinar((tabela, conversaId) => {
      if (tabela === "atendentes") {
        void queryClient.invalidateQueries({ queryKey: MONITOR });
        return;
      }
      void queryClient.invalidateQueries({ queryKey: CONVERSAS });
      void queryClient.invalidateQueries({ queryKey: MONITOR });
      if (tabela === "mensagens" && conversaId) void queryClient.invalidateQueries({ queryKey: mensagensDe(conversaId) });
    });
  }, [queryClient]);
}

// ---------- Monitor ----------

export function useMonitorIndicadores(periodo: Periodo, setorId: number | null, habilitado: boolean) {
  return useQuery({ queryKey: [...MONITOR, "indicadores", periodo, setorId], queryFn: () => monitorService.indicadores(periodo, setorId), enabled: habilitado, refetchInterval: 60_000 });
}

export function useMonitorAtendentes(setorId: number | null, habilitado: boolean) {
  return useQuery({ queryKey: [...MONITOR, "atendentes", setorId], queryFn: () => monitorService.atendentes(setorId), enabled: habilitado, refetchInterval: 30_000 });
}

export function useMonitorConversas(setorId: number | null, habilitado: boolean) {
  return useQuery({ queryKey: [...MONITOR, "conversas", setorId], queryFn: () => monitorService.conversas(setorId), enabled: habilitado, refetchInterval: 30_000 });
}

// ---------- Zenvia ----------

export function useConexaoZenvia() {
  return useQuery({ queryKey: ZENVIA, queryFn: () => zenviaService.carregar() });
}

function useMudaZenvia<T, R>(fn: (dados: T) => Promise<R>) {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => void queryClient.invalidateQueries({ queryKey: RAIZ }) });
}

export const useSalvarConexao = () => useMudaZenvia((d: SalvarConexao) => zenviaService.salvar(d));
export const useSalvarToken = () => useMudaZenvia((t: string) => zenviaService.salvarToken(t));
export const useTestarZenvia = () => useMudaZenvia(() => zenviaService.testar());
export const useAssinarZenvia = () => useMudaZenvia(() => zenviaService.assinar());
export const useEnviarTeste = () => useMutation({ mutationFn: (p: { numeroId: number; telefone: string }) => zenviaService.enviarTeste(p.numeroId, p.telefone) });

// ---------- Central Email ----------

const EMAILS = [...RAIZ, "emails"] as const;
const APP_GOOGLE = [...RAIZ, "app-google"] as const;

export function useContasEmail() {
  return useQuery({ queryKey: EMAILS, queryFn: () => emailService.lista(), refetchInterval: 60_000 });
}

function useMudaEmail<T, R>(fn: (dados: T) => Promise<R>) {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => void queryClient.invalidateQueries({ queryKey: EMAILS }) });
}

export const useSalvarContaEmail = () => useMudaEmail((p: ContaEmailDados & { id?: number }) => emailService.salvar(p));
export const useSenhaContaEmail = () => useMudaEmail((p: { id: number; senha: string }) => emailService.senha(p.id, p.senha));
export const useHabilitarContasEmail = () => useMudaEmail((p: { ids: number[]; habilitada: boolean }) => emailService.habilitar(p.ids, p.habilitada));
export const useExcluirContaEmail = () => useMudaEmail((id: number) => emailService.excluir(id));
export const useAutorizarGoogle = () => useMutation({ mutationFn: (id: number) => emailService.autorizarGoogle(id) });

export function useAppGoogle() {
  return useQuery({ queryKey: APP_GOOGLE, queryFn: () => emailService.appGoogle() });
}

export function useSalvarAppGoogle() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (p: { clientId: string; clientSecret: string }) => emailService.salvarAppGoogle(p.clientId, p.clientSecret),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: APP_GOOGLE }),
  });
}
export const useTestarContaEmail = () => useMudaEmail((p: { id: number; enviarPara?: string }) => emailService.testar(p.id, p.enviarPara));


// ---------- WhatsApp OpenWA, resumo da IA e métrica ----------

const OPENWA = [...RAIZ, "openwa"] as const;

export function usePainelOpenwa() {
  return useQuery({ queryKey: OPENWA, queryFn: () => openwaService.painel() });
}

function useMudaOpenwa<T, R>(fn: (dados: T) => Promise<R>) {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => void queryClient.invalidateQueries({ queryKey: OPENWA }) });
}

export function useLigarOpenwa() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ligado: boolean) => openwaService.ligar(ligado),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: OPENWA });
      // Conversas e Monitor aparecem/somem conforme o recurso (AccessProvider).
      void queryClient.invalidateQueries({ queryKey: ["recursos"] });
    },
  });
}
export const useSalvarConexaoOpenwa = () => useMudaOpenwa((p: { url: string; chave?: string }) => openwaService.salvarConexao(p));
export const useSalvarNumeroWhatsapp = () =>
  useMudaOpenwa((p: { numeroId: number; canal: "zenvia" | "openwa"; sessao: string | null; grupo: string | null; grupoNome: string | null }) => openwaService.salvarNumero(p));
export const useSalvarSetorWhatsapp = () =>
  useMudaOpenwa((p: { setorId: number; waIdentificar: boolean; waSoCorporativo: boolean; waRespostasAuto: boolean; waPedirDescricao: boolean; msgNaoCorporativo: string }) => openwaService.salvarSetor(p));
export const useCriarGrupoInterno = () => useMudaOpenwa((numeroId: number) => openwaService.criarGrupo(numeroId));
export const useAdicionarAtendentesGrupo = () => useMudaOpenwa((numeroId: number) => openwaService.adicionarAtendentes(numeroId));
export const useSalvarWhatsappAtendente = () => useMudaOpenwa((p: { usuarioId: string; whatsapp: string }) => openwaService.salvarWhatsappAtendente(p));
export const useTestarOpenwa = () => useMudaOpenwa(() => openwaService.testar());
export const useImportarLinhas = () => useMudaOpenwa((linhas: LinhaImportar[]) => openwaService.importarLinhas(linhas));
export const useRemoverLinha = () => useMudaOpenwa((numero: string) => openwaService.removerLinha(numero));

export function useLinhas(busca: string) {
  return useQuery({ queryKey: [...OPENWA, "linhas", busca], queryFn: () => openwaService.linhas(busca) });
}

export function useGruposOpenwa(sessao: string | null) {
  return useQuery({ queryKey: [...OPENWA, "grupos", sessao], queryFn: () => openwaService.grupos(sessao!), enabled: Boolean(sessao), retry: false });
}

export function useMembrosGrupo(sessao: string | null, grupo: string | null) {
  return useQuery({ queryKey: [...OPENWA, "membros", sessao, grupo], queryFn: () => openwaService.membros(sessao!, grupo!), enabled: Boolean(sessao && grupo), retry: false });
}

export function useQrOpenwa(sessao: string | null, ligado: boolean) {
  return useQuery({ queryKey: [...OPENWA, "qr", sessao], queryFn: () => openwaService.qr(sessao!), enabled: Boolean(sessao) && ligado, refetchInterval: 5_000, retry: false });
}

export const useResumirConversa = () => useMutation({ mutationFn: (ticketId: number) => openwaService.resumir(ticketId) });

export function useTopSolicitantes(dias: number) {
  return useQuery({ queryKey: ["chamados", "painel", "top-solicitantes", dias], queryFn: () => openwaService.topSolicitantes(dias) });
}
