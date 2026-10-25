import { edgeFunction } from "../../config/app";
import type { Json } from "../../lib/database.types";
import { supabase } from "../../lib/supabase";
import { STATUS_INICIAIS } from "../chamados/status/seed";
import { CATEGORIAS_FECHADAS } from "../chamados/status/types";
import { DATA_SOURCE } from "../configuracoes/services";
import { delay } from "../configuracoes/services/mock/runtime";
import { fromFunction, fromPostgrest } from "../configuracoes/services/supabase/errors";
import { ServiceError } from "../configuracoes/services/types";
import { dashboardMock } from "../dashboard/mock";
import { ticketsMock } from "../dashboard/service";
import type { DashboardTicket } from "../dashboard/types";
import { METAS_PADRAO, type GerencialPayload, type Metas, type RecomendacaoIa, type TicketGerencial } from "./types";

// Dados da visão gerencial. Modo real: RPC ch_gerencial (migration 20261009180000) e a Edge Function de IA
// (acao "gerencial"). Modo simulado: 13 meses gerados de forma determinística + os tickets em memória do painel,
// para os números de hoje baterem com a Visão geral.

export interface GerencialService {
  carregar(): Promise<GerencialPayload>;
  salvarMetas(metas: Partial<Metas>): Promise<Metas>;
  enviarAlertas(): Promise<number>;
  recomendacoes(resumo: unknown): Promise<{ recomendacoes: RecomendacaoIa[]; resumoExecutivo: string; modelo: string }>;
}

async function rpc<T>(nome: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(nome as never, args as never);
  if (error) throw fromPostgrest(error);
  return data as T;
}

const supabaseGerencial: GerencialService = {
  carregar: () => rpc<GerencialPayload>("ch_gerencial", { p_meses: 13 }),
  salvarMetas: (metas) => rpc<Metas>("ch_gerencial_metas_salvar", { p: metas as unknown as Json }),
  enviarAlertas: () => rpc<number>("ch_gerencial_alertas_enviar"),
  async recomendacoes(resumo) {
    const { data, error } = await supabase.functions.invoke(edgeFunction("ia"), { body: { acao: "gerencial", resumo } });
    if (error) throw await fromFunction(error);
    return data as { recomendacoes: RecomendacaoIa[]; resumoExecutivo: string; modelo: string };
  },
};

// ---------- Modo simulado ----------

/** Gerador determinístico (mulberry32): a mesma amostra em todo carregamento e nos testes. */
export function aleatorio(semente: number): () => number {
  let a = semente >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const AGENTES = [
  { id: "u-wagner", nome: "Wagner Antunes" },
  { id: "u-ana", nome: "Ana Lima" },
  { id: "u-bruno", nome: "Bruno Rocha" },
  { id: "u-carla", nome: "Carla Nunes" },
];
const DEPARTAMENTOS = ["Engenharia", "Financeiro", "Obras", "Comercial", "RH", "Suprimentos", null];
const CATEGORIAS = ["Problema", "Solicitação", "Dúvida", "Incidente"];
const URGENCIAS = ["Baixa", "Normal", "Normal", "Normal", "Alta", "Urgente"];
const SOLICITANTES = ["Mariana Costa", "Pedro Alves", "Ana Souza", "Carla Mendes", "Bruno Lima", "Lucas Reis", "Juliana Prado", "Rafael Dias"];

const statusPorCategoria = (cat: TicketGerencial["categoriaStatus"]) => STATUS_INICIAIS.find((s) => s.categoria === cat)?.nome ?? cat;

/**
 * 13 meses de histórico: ~45 tickets/mês com crescimento suave, mais entradas às segundas e no início da tarde,
 * SLA cumprido em ~85% e um incidente (pico) há ~3 semanas.
 */
export function gerarHistoricoMock(agora: Date, meses = 13): TicketGerencial[] {
  const rnd = aleatorio(20261009);
  const servicos = dashboardMock.services;
  const lista: TicketGerencial[] = [];
  const inicio = new Date(agora);
  inicio.setMonth(inicio.getMonth() - (meses - 1), 1);
  inicio.setHours(0, 0, 0, 0);
  const dias = Math.floor((agora.getTime() - inicio.getTime()) / 86_400_000);
  const pico = dias - 22;
  let id = 40000;
  for (let d = 0; d < dias; d++) {
    const data = new Date(inicio.getTime() + d * 86_400_000);
    const dow = data.getDay();
    if (dow === 0 || dow === 6) {
      if (rnd() > 0.15) continue;
    }
    const crescimento = 1 + (0.25 * d) / dias;
    const fatorDia = dow === 1 ? 1.35 : dow === 5 ? 0.85 : 1;
    let n = Math.round((1.4 + rnd() * 1.6) * crescimento * fatorDia);
    if (d === pico) n += 14;
    for (let k = 0; k < n; k++) {
      const hora = 8 + Math.floor(Math.abs(rnd() + rnd() - 1) * 10) + (rnd() < 0.5 ? 5 : 0);
      const criado = new Date(data);
      criado.setHours(Math.min(hora, 18), Math.floor(rnd() * 60), 0, 0);
      if (criado.getTime() > agora.getTime()) continue;
      const servico = d === pico && k >= n - 14 ? servicos[2] : servicos[Math.floor(rnd() ** 1.6 * servicos.length)];
      const origem: TicketGerencial["origem"] = (["email", "email", "intranet", "intranet", "intranet", "whatsapp", "agente"] as const)[Math.floor(rnd() * 7)];
      const agente = AGENTES[Math.floor(rnd() * AGENTES.length)];
      const slaH = servico.sla_hours * (URGENCIAS[Math.floor(rnd() * URGENCIAS.length)] === "Urgente" ? 0.5 : 1);
      const slaSolucao = new Date(criado.getTime() + slaH * 1.6 * 3_600_000);
      const slaResposta = new Date(criado.getTime() + Math.max(1, slaH / 4) * 3_600_000);
      // Tempo de resolução: log-normal-ish; ~85% dentro do prazo; serviço de Rede piora no pico.
      const fator = (d === pico && servico.id === 7 ? 2.2 : 1) * (0.2 + rnd() ** 2 * 2.2);
      const resolvidoEm = new Date(criado.getTime() + Math.max(0.3, slaH * fator) * 3_600_000);
      const resposta = new Date(criado.getTime() + Math.max(0.1, (slaH / 4) * (0.3 + rnd() * 1.2)) * 3_600_000);
      const aberto = resolvidoEm.getTime() > agora.getTime();
      const cancelado = !aberto && rnd() < 0.04;
      const cat: TicketGerencial["categoriaStatus"] = aberto ? (rnd() < 0.25 ? "pendente" : "andamento") : cancelado ? "cancelado" : rnd() < 0.5 ? "fechado" : "resolvido";
      const semResp = aberto && rnd() < 0.2;
      lista.push({
        id: id++,
        assunto: `${servico.name}: chamado ${id}`,
        criadoEm: criado.toISOString(),
        assumidoEm: semResp ? null : new Date(criado.getTime() + 20 * 60_000).toISOString(),
        primeiraRespostaEm: resposta.getTime() <= agora.getTime() && !semResp ? resposta.toISOString() : null,
        encerradoEm: aberto ? null : resolvidoEm.toISOString(),
        slaRespostaAte: slaResposta.toISOString(),
        slaSolucaoAte: slaSolucao.toISOString(),
        slaManual: rnd() < 0.03,
        slaPausadoDesde: cat === "pendente" ? new Date(agora.getTime() - 3_600_000).toISOString() : null,
        ultimaAcaoEm: aberto ? new Date(Math.min(agora.getTime(), criado.getTime() + rnd() * 10 * 86_400_000)).toISOString() : resolvidoEm.toISOString(),
        status: statusPorCategoria(cat),
        categoriaStatus: cat,
        setor: "TI",
        equipe: servico.team,
        servico: servico.name,
        categoria: CATEGORIAS[Math.floor(rnd() * CATEGORIAS.length)],
        urgencia: URGENCIAS[Math.floor(rnd() * URGENCIAS.length)],
        origem,
        responsavelId: semResp ? null : agente.id,
        responsavel: semResp ? null : agente.nome,
        solicitante: SOLICITANTES[Math.floor(rnd() * SOLICITANTES.length)],
        departamento: DEPARTAMENTOS[Math.floor(rnd() * DEPARTAMENTOS.length)],
        reaberturas: !aberto && rnd() < 0.04 ? 1 : 0,
        acoesPublicas: 1 + Math.floor(rnd() * 5),
        ia: origem === "agente" ? null : rnd() < 0.62 ? "aplicado" : rnd() < 0.6 ? "sugerido" : "baixa_confianca",
      });
    }
  }
  return lista;
}

/** Ticket do painel (DashboardTicket) → linha gerencial, para o backlog de hoje bater com a Visão geral. */
export function doPainel(t: DashboardTicket, agora: Date): TicketGerencial {
  const servico = dashboardMock.services.find((s) => s.id === t.service_id);
  const slaSolucao = new Date(agora.getTime() + t.sla_due_minutes * 60_000);
  const origem = ({ "E-mail": "email", WhatsApp: "whatsapp", Intranet: "intranet", Agente: "agente" } as const)[t.origin];
  return {
    id: t.id,
    assunto: t.subject,
    criadoEm: t.criado_em,
    assumidoEm: t.owner ? t.criado_em : null,
    primeiraRespostaEm: t.owner ? new Date(Date.parse(t.criado_em) + 45 * 60_000).toISOString() : null,
    encerradoEm: t.closed_at,
    slaRespostaAte: new Date(Date.parse(t.criado_em) + 2 * 3_600_000).toISOString(),
    slaSolucaoAte: t.closed_at ? new Date(Date.parse(t.criado_em) + (servico?.sla_hours ?? 8) * 3_600_000).toISOString() : slaSolucao.toISOString(),
    slaManual: false,
    slaPausadoDesde: t.status_categoria === "pendente" ? agora.toISOString() : null,
    ultimaAcaoEm: t.closed_at ?? t.criado_em,
    status: t.status,
    categoriaStatus: t.status_categoria,
    setor: "TI",
    equipe: t.team || null,
    servico: servico?.name ?? null,
    categoria: "Problema",
    urgencia: t.prioridade,
    origem,
    responsavelId: t.owner?.id ?? null,
    responsavel: t.owner?.name ?? null,
    solicitante: t.requester,
    departamento: null,
    reaberturas: 0,
    acoesPublicas: CATEGORIAS_FECHADAS.includes(t.status_categoria) ? 3 : 1,
    ia: origem === "agente" ? null : "aplicado",
  };
}

let metasMock: Metas = { ...METAS_PADRAO };

const mockGerencial: GerencialService = {
  async carregar() {
    await delay();
    const agora = new Date(dashboardMock.generated_at);
    const inicio = new Date(agora);
    inicio.setMonth(inicio.getMonth() - 12, 1);
    return {
      generated_at: agora.toISOString(),
      inicio: inicio.toISOString(),
      metas: { ...metasMock },
      tickets: [...gerarHistoricoMock(agora), ...ticketsMock().map((t) => doPainel(t, agora))],
    };
  },
  async salvarMetas(metas) {
    await delay();
    for (const [k, v] of Object.entries(metas)) {
      if (typeof v !== "number" || v < 0) throw new ServiceError("INVALID_INPUT", `Valor inválido para ${k}.`, k);
    }
    metasMock = { ...metasMock, ...metas };
    return { ...metasMock };
  },
  async enviarAlertas() {
    await delay();
    return 0;
  },
  async recomendacoes() {
    await delay();
    return {
      modelo: "simulado",
      resumoExecutivo: "Demonstração: a demanda cresce devagar, o SLA está perto da meta e o backlog se concentra em Rede / VPN. Priorize a redistribuição dos vencidos e um formulário guiado para os serviços mais pedidos.",
      recomendacoes: [
        { titulo: "Redistribuir os tickets vencidos de Infraestrutura", causaProvavel: "Incidente de rede há 3 semanas gerou um pico que a equipe ainda não absorveu.", previsao: "Sem ação, os vencidos seguem acima do limite por mais 2 semanas.", recomendacao: "Mover os tickets de Rede / VPN sem ação há mais de 3 dias para a fila com menos carga e abrir um ticket-pai para o incidente.", prioridade: "alta" },
        { titulo: "Formulário guiado para Acessos e usuários", causaProvavel: "Pedidos repetitivos chegam por e-mail sem os dados mínimos, o que gera idas e vindas.", previsao: "Até 30% menos interações por ticket nesse serviço.", recomendacao: "Criar o formulário na intranet com os campos obrigatórios e uma regra de exibição por serviço.", prioridade: "media" },
        { titulo: "Revisar o prazo de SLA de Equipamentos", causaProvavel: "O prazo cadastrado (16 h) não considera a logística de entrega ao canteiro.", previsao: "SLA do serviço continua abaixo da meta mesmo com a equipe no ritmo normal.", recomendacao: "Ajustar o prazo por urgência ou criar o status Pendente › Aguardando entrega para pausar o SLA.", prioridade: "baixa" },
      ],
    };
  },
};

export const gerencialService: GerencialService = DATA_SOURCE === "mock" ? mockGerencial : supabaseGerencial;
