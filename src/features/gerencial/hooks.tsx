import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { useAccess } from "../configuracoes/access/useAccess";
import {
  agrupar,
  alertas,
  backlogEm,
  dia,
  entradasNoPeriodo,
  filtrarDimensoes,
  indicadores,
  insights,
  instanteFinal,
  kpis,
  periodoAnterior,
  produtividade,
  resolvidosNoPeriodo,
  serieDiaria,
  serieMensal,
  somarDias,
} from "./calculos";
import { gerencialService } from "./service";
import { METAS_PADRAO, type Alerta, type Filtros, type GerencialPayload, type Grupo, type Insight, type Kpis, type Metas, type OrigemTicket, type PontoDiario, type PontoMensal, type TicketGerencial } from "./types";
import type { Indicador, Produtividade } from "./calculos";

// Estado compartilhado das dez telas: um carregamento (RPC), os filtros na URL e os cálculos memorizados.

const GERENCIAL = ["chamados", "gerencial"] as const;

/** `ativo = false` não carrega (o sino do topo só carrega para quem tem acesso ao Gerencial). */
export function useGerencialDados(ativo = true) {
  const { user } = useAccess();
  return useQuery({
    queryKey: [...GERENCIAL, user?.id],
    queryFn: () => gerencialService.carregar(),
    enabled: Boolean(user) && ativo,
    staleTime: 60_000,
    refetchInterval: 120_000,
    refetchOnWindowFocus: true,
  });
}

export function useSalvarMetas() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (metas: Partial<Metas>) => gerencialService.salvarMetas(metas),
    onSuccess: () => qc.invalidateQueries({ queryKey: GERENCIAL }),
  });
}

export function useEnviarAlertas() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => gerencialService.enviarAlertas(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["chamados", "notificacoes"] }),
  });
}

export function useRecomendacoesIa() {
  return useMutation({ mutationFn: (resumo: unknown) => gerencialService.recomendacoes(resumo) });
}

// ---------- Filtros na URL ----------

export type Preset = "7d" | "30d" | "90d" | "mes" | "12m" | "custom";

export const PRESETS: { id: Exclude<Preset, "custom">; label: string }[] = [
  { id: "7d", label: "7 dias" },
  { id: "30d", label: "30 dias" },
  { id: "90d", label: "90 dias" },
  { id: "mes", label: "Mês atual" },
  { id: "12m", label: "12 meses" },
];

export function periodoDoPreset(preset: Exclude<Preset, "custom">, hoje: string): { de: string; ate: string } {
  switch (preset) {
    case "7d":
      return { de: somarDias(hoje, -6), ate: hoje };
    case "30d":
      return { de: somarDias(hoje, -29), ate: hoje };
    case "90d":
      return { de: somarDias(hoje, -89), ate: hoje };
    case "mes":
      return { de: `${hoje.slice(0, 7)}-01`, ate: hoje };
    case "12m": {
      const [a, m] = hoje.split("-").map(Number);
      const ini = new Date(Date.UTC(a, m - 12, 1));
      return { de: ini.toISOString().slice(0, 10), ate: hoje };
    }
  }
}

const ORIGENS: OrigemTicket[] = ["email", "whatsapp", "intranet", "agente"];

export function useFiltros(hoje: string): { filtros: Filtros; preset: Preset; definir: (p: Partial<Filtros>) => void; aplicarPreset: (p: Exclude<Preset, "custom">) => void } {
  const [params, setParams] = useSearchParams();
  const padrao = periodoDoPreset("30d", hoje);
  const de = /^\d{4}-\d{2}-\d{2}$/.test(params.get("de") ?? "") ? params.get("de")! : padrao.de;
  const ate = /^\d{4}-\d{2}-\d{2}$/.test(params.get("ate") ?? "") ? params.get("ate")! : padrao.ate;
  const origemParam = params.get("origem") ?? "";
  const filtros: Filtros = {
    de: de <= ate ? de : ate,
    ate,
    setor: params.get("setor") ?? "",
    equipe: params.get("equipe") ?? "",
    origem: ORIGENS.includes(origemParam as OrigemTicket) ? (origemParam as OrigemTicket) : "",
  };
  const preset = (PRESETS.find((p) => {
    const x = periodoDoPreset(p.id, hoje);
    return x.de === filtros.de && x.ate === filtros.ate;
  })?.id ?? "custom") as Preset;

  const definir = (p: Partial<Filtros>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries({ ...filtros, ...p })) {
      if (v) next.set(k, String(v));
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };
  return { filtros, preset, definir, aplicarPreset: (p) => definir(periodoDoPreset(p, hoje)) };
}

// ---------- Cálculos memorizados ----------

export interface Visao {
  payload: GerencialPayload;
  agora: Date;
  hoje: string;
  filtros: Filtros;
  anterior: { de: string; ate: string };
  metas: Metas;
  /** Tickets dentro do recorte de setor/equipe/canal (todas as datas carregadas). */
  tickets: TicketGerencial[];
  entradas: TicketGerencial[];
  resolvidos: TicketGerencial[];
  backlog: TicketGerencial[];
  kpis: Kpis;
  kpisAnterior: Kpis;
  indicadores: Indicador[];
  diaria: PontoDiario[];
  mensal: PontoMensal[];
  grupos: Record<"setor" | "equipe" | "servico" | "categoria" | "urgencia" | "origem" | "responsavel" | "departamento", Grupo[]>;
  produtividade: Produtividade[];
  alertas: Alerta[];
  insights: Insight[];
  /** Opções dos filtros (de todos os tickets carregados). */
  opcoes: { setores: string[]; equipes: string[] };
}

export function montarVisao(payload: GerencialPayload, filtros: Filtros): Visao {
  const agora = new Date(payload.generated_at);
  const metas: Metas = { ...METAS_PADRAO, ...payload.metas };
  const tickets = filtrarDimensoes(payload.tickets, filtros);
  const anterior = periodoAnterior(filtros);
  const atual = kpis(tickets, filtros, agora, metas);
  const kpisAnterior = kpis(tickets, anterior, agora, metas);
  const grupos = {
    setor: agrupar(tickets, "setor", filtros, agora),
    equipe: agrupar(tickets, "equipe", filtros, agora),
    servico: agrupar(tickets, "servico", filtros, agora),
    categoria: agrupar(tickets, "categoria", filtros, agora),
    urgencia: agrupar(tickets, "urgencia", filtros, agora),
    origem: agrupar(tickets, "origem", filtros, agora),
    responsavel: agrupar(tickets, "responsavel", filtros, agora),
    departamento: agrupar(tickets, "departamento", filtros, agora),
  };
  const diaria = serieDiaria(tickets, filtros, agora);
  const mensal = serieMensal(tickets, 13, agora);
  const prod = produtividade(tickets, filtros, agora);
  const listaAlertas = alertas(atual, kpisAnterior, metas, { equipe: grupos.equipe });
  return {
    payload,
    agora,
    hoje: dia(agora),
    filtros,
    anterior,
    metas,
    tickets,
    entradas: entradasNoPeriodo(tickets, filtros),
    resolvidos: resolvidosNoPeriodo(tickets, filtros),
    backlog: backlogEm(tickets, instanteFinal(filtros, agora)),
    kpis: atual,
    kpisAnterior,
    indicadores: indicadores(atual, kpisAnterior, metas),
    diaria,
    mensal,
    grupos,
    produtividade: prod,
    alertas: listaAlertas,
    insights: insights({ atual, anterior: kpisAnterior, diaria, mensal, porServico: grupos.servico, porEquipe: grupos.equipe, porOrigem: grupos.origem, produtividade: prod, metas }),
    opcoes: {
      setores: [...new Set(payload.tickets.map((t) => t.setor).filter((s): s is string => Boolean(s)))].sort(),
      equipes: [...new Set(payload.tickets.filter((t) => !filtros.setor || t.setor === filtros.setor).map((t) => t.equipe ?? "").filter(Boolean))].sort(),
    },
  };
}

const VisaoContext = createContext<Visao | null>(null);

export function VisaoProvider({ payload, filtros, children }: { payload: GerencialPayload; filtros: Filtros; children: ReactNode }) {
  const visao = useMemo(() => montarVisao(payload, filtros), [payload, filtros]);
  return <VisaoContext.Provider value={visao}>{children}</VisaoContext.Provider>;
}

export function useVisao(): Visao {
  const v = useContext(VisaoContext);
  if (!v) throw new Error("useVisao precisa estar dentro de <VisaoProvider>.");
  return v;
}

// ---------- Alertas para o sino do topo ----------

/**
 * Alertas do Gerencial para o sino: os mesmos limites da tela Alertas, sobre os últimos 30 dias e sem filtros.
 * Só carrega para quem tem acesso ao Gerencial; reaproveita o cache da tela (mesma consulta).
 */
export function useAlertasGerenciais(ativo: boolean): { alertas: Alerta[]; carregando: boolean; erro: boolean } {
  const dados = useGerencialDados(ativo);
  const alertasAtivos = useMemo(() => {
    if (!dados.data) return [];
    const hoje = dia(dados.data.generated_at);
    const filtros: Filtros = { ...periodoDoPreset("30d", hoje), setor: "", equipe: "", origem: "" };
    return montarVisao(dados.data, filtros).alertas.filter((a) => a.nivel !== "ok");
  }, [dados.data]);
  return { alertas: alertasAtivos, carregando: ativo && dados.isPending, erro: dados.isError };
}
