import type { Json } from "../../../lib/database.types";
import { supabase } from "../../../lib/supabase";
import { ADMIN_ROLE, SUPER_ADMIN_ROLE } from "../../../config/app";
import { DATA_SOURCE } from "../../configuracoes/services";
import { currentActor, delay, recordAudit } from "../../configuracoes/services/mock/runtime";
import { fromPostgrest } from "../../configuracoes/services/supabase/errors";
import { ServiceError } from "../../configuracoes/services/types";
import { STATUS_INICIAIS } from "./seed";
import type { JustificativaSalvar, StatusSalvar, StatusTicket } from "./types";

// Gestão de Chamados › Status: cadastro de status e justificativas. Leitura para quem usa Tickets;
// escrita só Admin e Super admin (regra fixa, conferida também nas RPCs ch_status_*). Não há exclusão:
// status e justificativas em uso só são desativados.

export interface StatusService {
  lista(): Promise<StatusTicket[]>;
  salvarStatus(p: StatusSalvar): Promise<number>;
  salvarJustificativa(p: JustificativaSalvar): Promise<number>;
  /** Nova ordem dos status (ids na ordem desejada). */
  ordenar(ids: number[]): Promise<void>;
}

async function rpc<T>(nome: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(nome as never, args as never);
  if (error) throw fromPostgrest(error);
  return data as T;
}

const supabaseStatus: StatusService = {
  lista: () => rpc<StatusTicket[]>("ch_status_lista"),
  salvarStatus: (p) => rpc<number>("ch_status_salvar", { p: p as unknown as Json }),
  salvarJustificativa: (p) => rpc<number>("ch_justificativa_salvar", { p: p as unknown as Json }),
  ordenar: (ids) => rpc<void>("ch_status_ordenar", { p_ids: ids }),
};

// ---------- Modo simulado ----------
let status: StatusTicket[] = structuredClone(STATUS_INICIAIS);
let seqStatus = 100;
let seqJust = 100;

function exigirAdmin() {
  const actor = currentActor();
  if (actor.role !== ADMIN_ROLE && actor.role !== SUPER_ADMIN_ROLE) {
    throw new ServiceError("FORBIDDEN", "Só Admin e Super admin alteram o cadastro de status.");
  }
}

function validarNome(nome: string, campo: string): string {
  const n = nome.trim();
  if (n.length < 2 || n.length > 40) throw new ServiceError("INVALID_INPUT", "Informe o nome (2 a 40 letras).", campo);
  return n;
}

const mockStatus: StatusService = {
  async lista() {
    await delay();
    return structuredClone(status).sort((a, b) => a.ordem - b.ordem);
  },
  async salvarStatus(p) {
    await delay();
    exigirAdmin();
    const nome = validarNome(p.nome, "nome");
    if (status.some((s) => s.id !== p.id && s.nome.toLowerCase() === nome.toLowerCase())) {
      throw new ServiceError("DUPLICATE", "Já existe um status com esse nome.", "nome");
    }
    const atual = status.find((s) => s.id === p.id);
    if (atual) Object.assign(atual, { nome, categoria: p.categoria, ativo: p.ativo });
    else status.push({ id: ++seqStatus, nome, categoria: p.categoria, ativo: p.ativo, ordem: status.length + 1, justificativas: [] });
    recordAudit({ module: "atendimento", action: atual ? "update" : "create", description: `Status de ticket "${nome}" ${atual ? "alterado" : "criado"}.` });
    return atual?.id ?? seqStatus;
  },
  async salvarJustificativa(p) {
    await delay();
    exigirAdmin();
    const nome = validarNome(p.nome, "nome");
    const dono = status.find((s) => s.id === p.statusId);
    if (!dono) throw new ServiceError("NOT_FOUND", "Status não encontrado.");
    if (dono.justificativas.some((j) => j.id !== p.id && j.nome.toLowerCase() === nome.toLowerCase())) {
      throw new ServiceError("DUPLICATE", "Esse status já tem uma justificativa com esse nome.", "nome");
    }
    const atual = dono.justificativas.find((j) => j.id === p.id);
    if (atual) Object.assign(atual, { nome, ativa: p.ativa });
    else dono.justificativas.push({ id: ++seqJust, statusId: dono.id, nome, ativa: p.ativa, ordem: dono.justificativas.length + 1 });
    recordAudit({ module: "atendimento", action: atual ? "update" : "create", description: `Justificativa "${dono.nome} › ${nome}" ${atual ? "alterada" : "criada"}.` });
    return atual?.id ?? seqJust;
  },
  async ordenar(ids) {
    await delay();
    exigirAdmin();
    status = status.map((s) => ({ ...s, ordem: ids.indexOf(s.id) + 1 || s.ordem }));
  },
};

export const statusService: StatusService = DATA_SOURCE === "mock" ? mockStatus : supabaseStatus;
