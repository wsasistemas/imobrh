import { ADMIN_ROLE, SUPER_ADMIN_ROLE } from "../../../config/app";
import type { Json } from "../../../lib/database.types";
import { supabase } from "../../../lib/supabase";
import { DATA_SOURCE } from "../../configuracoes/services";
import { currentActor, delay, recordAudit } from "../../configuracoes/services/mock/runtime";
import { fromPostgrest } from "../../configuracoes/services/supabase/errors";
import { ServiceError } from "../../configuracoes/services/types";
import { CADASTROS_INICIAIS } from "../cadastros/seed";
import { contextoGatilho, detalheMock } from "../ticket/service";
import { condicaoAtende, gatilhoAtende, validarGatilho, type AutorGatilho } from "./motor";
import { execucoesMock, gatilhosMock, jaExecutou, proximoId } from "./store";
import type { ExecucaoGatilho, Gatilho, GatilhoSalvar, SimulacaoGatilho } from "./types";

// Administração › Gatilhos (só Admin e Super admin). Modo real: RPCs ch_gatilho* (migration 20261007210000). Modo simulado: store.ts, com o mesmo motor de avaliação.

export interface GatilhosService {
  lista(): Promise<Gatilho[]>;
  salvar(p: GatilhoSalvar): Promise<number>;
  ordenar(ids: number[]): Promise<void>;
  simular(p: Pick<Gatilho, "todas" | "qualquer"> & { id?: number; autor?: AutorGatilho }, ticketId: number): Promise<SimulacaoGatilho>;
  execucoes(dias: number, gatilhoId: number | null): Promise<ExecucaoGatilho[]>;
}

async function rpc<T>(nome: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(nome as never, args as never);
  if (error) throw fromPostgrest(error);
  return data as T;
}

const supabaseGatilhos: GatilhosService = {
  lista: () => rpc<Gatilho[]>("ch_gatilhos_lista"),
  salvar: (p) => rpc<number>("ch_gatilho_salvar", { p: p as unknown as Json }),
  ordenar: (ids) => rpc<void>("ch_gatilho_ordenar", { p_ids: ids }),
  simular: (p, ticketId) => rpc<SimulacaoGatilho>("ch_gatilho_simular", { p: p as unknown as Json, p_ticket: ticketId }),
  execucoes: (dias, gatilhoId) => rpc<ExecucaoGatilho[]>("ch_gatilho_execucoes", { p_dias: dias, p_gatilho: gatilhoId }),
};

function exigirAdmin() {
  const r = currentActor().role;
  if (r !== ADMIN_ROLE && r !== SUPER_ADMIN_ROLE) throw new ServiceError("FORBIDDEN", "Só Admin e Super admin acessam os gatilhos.");
}

const mockGatilhos: GatilhosService = {
  async lista() {
    await delay();
    exigirAdmin();
    return structuredClone([...gatilhosMock()].sort((a, b) => a.ordem - b.ordem || a.id - b.id));
  },
  async salvar(p) {
    await delay();
    exigirAdmin();
    const erro = validarGatilho(p);
    if (erro) throw new ServiceError("INVALID_INPUT", erro);
    const nome = p.nome.trim();
    if (gatilhosMock().some((g) => g.id !== p.id && g.nome.toLowerCase() === nome.toLowerCase())) throw new ServiceError("DUPLICATE", "Já existe um gatilho com esse nome.", "nome");
    const dados = { ...p, nome, atualizadoEm: new Date().toISOString(), atualizadoPor: currentActor().name };
    const atual = gatilhosMock().find((g) => g.id === p.id);
    if (p.id && !atual) throw new ServiceError("NOT_FOUND", "Gatilho não encontrado.");
    let id = atual?.id;
    if (atual) Object.assign(atual, dados);
    else {
      id = proximoId();
      gatilhosMock().push({ ...dados, id, para: "tickets", ordem: Math.max(0, ...gatilhosMock().map((g) => g.ordem)) + 1, execucoes7d: 0, erros7d: 0 });
    }
    recordAudit({ module: "atendimento", action: "update", description: `Gatilho "${nome}" salvo.` });
    return id!;
  },
  async ordenar(ids) {
    await delay();
    exigirAdmin();
    for (const g of gatilhosMock()) {
      const i = ids.indexOf(g.id);
      if (i >= 0) g.ordem = i + 1;
    }
  },
  async simular(p, ticketId) {
    await delay();
    exigirAdmin();
    let d;
    try {
      d = detalheMock(ticketId);
    } catch {
      throw new ServiceError("NOT_FOUND", "Ticket não encontrado.");
    }
    const ctx = contextoGatilho(d);
    const autor = p.autor ?? "agente";
    const servicos = CADASTROS_INICIAIS.servicos;
    return {
      ticket: { id: d.id, assunto: d.assunto },
      todas: p.todas.map((c) => ({ condicao: c, ok: condicaoAtende(c, ctx, autor, servicos) })),
      qualquer: p.qualquer.map((c) => ({ condicao: c, ok: condicaoAtende(c, ctx, autor, servicos) })),
      executaria: gatilhoAtende(p, ctx, autor, servicos),
      jaExecutou: p.id !== undefined && (jaExecutou(p.id, d.id, "ticket") || execucoesMock().some((e) => e.gatilhoId === p.id && e.ticketId === d.id)),
    };
  },
  async execucoes(dias, gatilhoId) {
    await delay();
    exigirAdmin();
    const desde = Date.now() - dias * 86_400_000;
    return structuredClone(
      execucoesMock()
        .filter((e) => Date.parse(e.criadoEm) >= desde && (gatilhoId === null || e.gatilhoId === gatilhoId))
        .map(({ chave: _chave, ...e }) => e),
    );
  },
};

export const gatilhosService: GatilhosService = DATA_SOURCE === "mock" ? mockGatilhos : supabaseGatilhos;
