import { SLA_SOON_MINUTES } from "../../../components/ds/sla";
import { isClosed } from "../../dashboard/queue";
import type { DashboardTicket } from "../../dashboard/types";
import { PRIORIDADES } from "./campos";
import type { ColunaKanban, Condicao, Condicoes, Ordenacao, StatusRef } from "./types";

// Avaliador das condições de uma visão (docs/PLANO-tickets-visoes.md, Fase 4). Puro e testado: roda no front
// sobre o mock enquanto não há tabela de tickets (D7); a RPC vai aplicar a mesma regra em SQL.
// Regra do modelo: o ticket atende a TODAS as combinadas E (se houver) a ao menos uma das independentes.

export interface ContextoAvaliacao {
  /** Usuário logado (operador "É o usuário logado"). */
  userId: string;
  /** "Agora" do servidor (generated_at). */
  now: Date;
  /** Nome do serviço por id. */
  servicoNome: (id: number) => string;
}

const DAY_MS = 86_400_000;
const TIME_ZONE = "America/Sao_Paulo";
const dia = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: TIME_ZONE });

/** Valor (ou valores) do ticket para o campo, como texto comparável. */
function valoresDoCampo(t: DashboardTicket, c: Condicao, ctx: ContextoAvaliacao): string[] {
  switch (c.campo) {
    case "recebido_em":
      return [t.recebido_em];
    case "origem":
      return [t.origin];
    case "equipe":
      return t.team ? [t.team] : [];
    case "responsavel":
      return t.owner ? [t.owner.id] : [];
    case "solicitante":
      return [t.requester];
    case "servico":
      return [ctx.servicoNome(t.service_id)];
    case "status":
      return [String(t.status_id)];
    case "justificativa":
      return t.justificativa_id === null ? [] : [String(t.justificativa_id)];
    case "prioridade":
      return [t.prioridade];
    case "tag":
      return t.tags;
    default:
      return [];
  }
}

export function atende(t: DashboardTicket, c: Condicao, ctx: ContextoAvaliacao): boolean {
  const lower = (s: string) => s.trim().toLowerCase();
  if (c.campo === "criado_em") {
    const criado = Date.parse(t.criado_em);
    const v = c.valores[0] ?? "";
    if (c.operador === "ultimos_dias") return criado >= ctx.now.getTime() - Number(v) * DAY_MS;
    if (c.operador === "antes") return dia(new Date(criado)) < v;
    if (c.operador === "depois") return dia(new Date(criado)) > v;
    return false;
  }
  if (c.campo === "sla") {
    if (isClosed(t)) return false;
    if (c.operador === "vencido") return t.sla_due_minutes < 0;
    if (c.operador === "vence_hoje") return t.sla_due_minutes >= 0 && t.sla_due_minutes < SLA_SOON_MINUTES;
    if (c.operador === "no_prazo") return t.sla_due_minutes >= SLA_SOON_MINUTES;
    return false;
  }
  const doTicket = valoresDoCampo(t, c, ctx).map(lower);
  const alvo = c.valores.map(lower).filter(Boolean);
  switch (c.operador) {
    case "igual":
      return alvo.some((v) => doTicket.includes(v));
    case "diferente":
      return !alvo.some((v) => doTicket.includes(v));
    case "contem":
      return alvo.some((v) => doTicket.some((x) => x.includes(v)));
    case "vazio":
      return doTicket.every((x) => x === "");
    case "preenchido":
      return doTicket.some((x) => x !== "");
    case "usuario_logado":
      return t.owner?.id === ctx.userId;
    default:
      return false;
  }
}

export function atendeCondicoes(t: DashboardTicket, condicoes: Condicoes, ctx: ContextoAvaliacao): boolean {
  return (
    condicoes.todas.every((c) => atende(t, c, ctx)) &&
    (condicoes.qualquer.length === 0 || condicoes.qualquer.some((c) => atende(t, c, ctx)))
  );
}

/** O status do ticket cai neste item da coluna? (justificativa null = qualquer justificativa). */
function casaStatus(t: DashboardTicket, ref: StatusRef): boolean {
  return t.status_id === ref.statusId && (ref.justificativaId === null || ref.justificativaId === t.justificativa_id);
}

/**
 * Coluna do Kanban de cada ticket: a primeira cuja lista de status casa (a referência exata de justificativa
 * vence a genérica). Tickets sem coluna ficam fora do quadro.
 */
export function colunaDoTicket(t: DashboardTicket, colunas: readonly ColunaKanban[]): string | null {
  const exata = colunas.find((col) => col.status.some((r) => r.justificativaId !== null && casaStatus(t, r)));
  if (exata) return exata.id;
  return colunas.find((col) => col.status.some((r) => casaStatus(t, r)))?.id ?? null;
}

export function ordenarTickets(tickets: readonly DashboardTicket[], ordem: Ordenacao): DashboardTicket[] {
  const peso = (p: string) => PRIORIDADES.indexOf(p as (typeof PRIORIDADES)[number]);
  const cmp: Record<Ordenacao, (a: DashboardTicket, b: DashboardTicket) => number> = {
    sla: (a, b) => Number(isClosed(a)) - Number(isClosed(b)) || a.sla_due_minutes - b.sla_due_minutes,
    criado: (a, b) => Date.parse(b.criado_em) - Date.parse(a.criado_em),
    prioridade: (a, b) => peso(a.prioridade) - peso(b.prioridade) || a.sla_due_minutes - b.sla_due_minutes,
  };
  return [...tickets].sort(cmp[ordem]);
}
