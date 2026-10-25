import type { Json } from "../../lib/database.types";
import { supabase } from "../../lib/supabase";
import { CATEGORIAS_ENCERRADAS } from "../chamados/status/types";
import { STATUS_INICIAIS, statusFields } from "../chamados/status/seed";
import { DATA_SOURCE } from "../configuracoes/services";
import { currentActor, delay } from "../configuracoes/services/mock/runtime";
import { fromPostgrest } from "../configuracoes/services/supabase/errors";
import { ServiceError } from "../configuracoes/services/types";
import { dashboardMock } from "./mock";
import type { DashboardPayload, DashboardTicket } from "./types";
import { initialsOf } from "./initials";

// Painel da Gestão de Chamados e as ações rápidas sobre os tickets (Visão geral, Tickets e Página Inicial).
// Modo real: RPCs ch_painel / ch_ticket_criar / ch_ticket_atualizar (migration 20261007171000). Modo simulado:
// os tickets de exemplo ficam em memória, então uma mudança feita numa tela aparece nas outras.

/** Mesmas chaves de ch_ticket_atualizar (só as enviadas mudam). */
export interface TicketPatch {
  statusId?: number;
  justificativaId?: number | null;
  responsavelId?: string | null;
  servicoId?: number | null;
  categoriaId?: number | null;
  urgenciaId?: number | null;
  equipeId?: number | null;
  tags?: string[];
  campos?: Record<string, unknown>;
  solucaoAplicada?: string;
}

export interface NovoTicket {
  assunto: string;
  descricao: string;
  solicitanteNome: string;
  servicoId: number;
}

export interface PainelService {
  painel(): Promise<DashboardPayload>;
  criar(input: NovoTicket): Promise<number>;
  atualizar(id: number, patch: TicketPatch): Promise<void>;
}

async function rpc<T>(nome: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(nome as never, args as never);
  if (error) throw fromPostgrest(error);
  return data as T;
}

const supabasePainel: PainelService = {
  painel: () => rpc<DashboardPayload>("ch_painel"),
  criar: (input) => rpc<number>("ch_ticket_criar", { p: input as unknown as Json }),
  atualizar: (id, patch) => rpc<void>("ch_ticket_atualizar", { p_id: id, p: patch as unknown as Json }),
};

// ---------- Modo simulado ----------
const tickets: DashboardTicket[] = structuredClone(dashboardMock.tickets);

const mockPainel: PainelService = {
  async painel() {
    await delay();
    const actor = currentActor();
    return {
      ...dashboardMock,
      current_user: { id: actor.id, name: actor.name, initials: initialsOf(actor.name) },
      tickets: structuredClone(tickets),
    };
  },
  async criar(input) {
    await delay();
    const servico = dashboardMock.services.find((s) => s.id === input.servicoId);
    if (!servico) throw new ServiceError("INVALID_INPUT", "Serviço inválido.", "servicoId");
    if (!input.assunto.trim()) throw new ServiceError("INVALID_INPUT", "Informe o assunto.", "assunto");
    const id = Math.max(...tickets.map((t) => t.id)) + 1;
    tickets.push({
      id,
      subject: input.assunto.trim(),
      requester: input.solicitanteNome.trim(),
      description: input.descricao.trim(),
      service_id: servico.id,
      team: servico.team,
      origin: "Agente",
      owner: null,
      ...statusFields(STATUS_INICIAIS[0].id),
      prioridade: "Normal",
      tags: [],
      recebido_em: "Agente",
      criado_em: dashboardMock.generated_at,
      sla_due_minutes: servico.sla_hours * 60,
      opened_today: true,
      closed_at: null,
    });
    return id;
  },
  async atualizar(id, patch) {
    await delay();
    const t = tickets.find((x) => x.id === id);
    if (!t) throw new ServiceError("NOT_FOUND", "Ticket não encontrado.");
    if (patch.statusId !== undefined) {
      Object.assign(t, statusFields(patch.statusId, patch.justificativaId ?? null));
      const encerrado = CATEGORIAS_ENCERRADAS.includes(t.status_categoria);
      t.closed_at = encerrado ? (t.closed_at ?? dashboardMock.generated_at) : null;
    }
    if (patch.responsavelId !== undefined) {
      if (patch.responsavelId === null) t.owner = null;
      else {
        const actor = currentActor();
        const nome = actor.id === patch.responsavelId ? actor.name : (t.owner?.name ?? patch.responsavelId);
        t.owner = { id: patch.responsavelId, name: nome, initials: initialsOf(nome) };
      }
    }
    if (patch.tags) t.tags = [...patch.tags];
  },
};

/** Modo simulado: os tickets em memória (a tela do ticket lê e altera os mesmos). */
export function ticketsMock(): DashboardTicket[] {
  return tickets;
}

export const painelService: PainelService = DATA_SOURCE === "mock" ? mockPainel : supabasePainel;
