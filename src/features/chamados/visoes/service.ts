import type { Json } from "../../../lib/database.types";
import { supabase } from "../../../lib/supabase";
import { SUPER_ADMIN_ROLE } from "../../../config/app";
import { equipesAtivasMock } from "../../cadastros/services/equipes";
import { DATA_SOURCE } from "../../configuracoes/services";
import { currentActor, delay, recordAudit } from "../../configuracoes/services/mock/runtime";
import { fromPostgrest } from "../../configuracoes/services/supabase/errors";
import { ServiceError } from "../../configuracoes/services/types";
import { CAMPOS, OPERADORES } from "./campos";
import { permissoesVisoes } from "./permissoes";
import { KANBAN_PADRAO, VISOES_INICIAIS } from "./seed";
import type { ColunaKanban, EquipeVisao, ListaExtras, Visao, VisaoSalvar } from "./types";

// Visões da tela Tickets. Leitura: as habilitadas das equipes do usuário (Admin e Super admin veem todas).
// Escrita: Admin e Super admin; excluir e o Kanban padrão, só Super admin (permissoes.ts). As RPCs ch_visao*
// conferem as mesmas regras no banco.

export interface VisoesService {
  disponiveis(): Promise<Visao[]>;
  todas(): Promise<Visao[]>;
  equipes(): Promise<EquipeVisao[]>;
  salvar(p: VisaoSalvar): Promise<number>;
  excluir(id: number): Promise<void>;
  kanbanPadrao(): Promise<ColunaKanban[]>;
  salvarKanbanPadrao(colunas: ColunaKanban[]): Promise<void>;
  /** Dados das colunas novas da Lista e os campos adicionais "usar em visões" (ch_lista_extras). */
  listaExtras(): Promise<ListaExtras>;
}

async function rpc<T>(nome: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(nome as never, args as never);
  if (error) throw fromPostgrest(error);
  return data as T;
}

const supabaseVisoes: VisoesService = {
  disponiveis: () => rpc<Visao[]>("ch_visoes_disponiveis"),
  todas: () => rpc<Visao[]>("ch_visoes_lista"),
  equipes: () => rpc<EquipeVisao[]>("ch_visoes_equipes"),
  salvar: (p) => rpc<number>("ch_visao_salvar", { p: p as unknown as Json }),
  excluir: (id) => rpc<void>("ch_visao_excluir", { p_id: id }),
  kanbanPadrao: () => rpc<ColunaKanban[]>("ch_kanban_padrao"),
  salvarKanbanPadrao: (colunas) => rpc<void>("ch_kanban_padrao_salvar", { p_colunas: colunas as unknown as Json }),
  listaExtras: () => rpc<ListaExtras>("ch_lista_extras"),
};

/** Validação comum (a RPC repete): nome, tipo, campos e operadores da lista fechada, colunas do Kanban. */
export function validarVisao(p: VisaoSalvar): void {
  const nome = p.nome.trim();
  if (nome.length < 2 || nome.length > 60) throw new ServiceError("INVALID_INPUT", "Informe o nome da visão (2 a 60 letras).", "nome");
  for (const c of [...p.condicoes.todas, ...p.condicoes.qualquer]) {
    const def = CAMPOS.find((x) => x.id === c.campo);
    if (!def || !def.operadores.includes(c.operador)) throw new ServiceError("INVALID_INPUT", "Há uma condição com campo ou operador inválido.", "condicoes");
    if (!OPERADORES[c.operador].semValor && c.valores.filter((v) => v.trim()).length === 0) {
      throw new ServiceError("INVALID_INPUT", `Preencha o valor da condição "${def.label}".`, "condicoes");
    }
  }
  if (p.tipo === "kanban") {
    if (p.kanban.colunas.length === 0) throw new ServiceError("INVALID_INPUT", "O Kanban precisa de ao menos uma coluna.", "kanban");
    if (p.kanban.colunas.some((c) => !c.nome.trim())) throw new ServiceError("INVALID_INPUT", "Toda coluna do Kanban precisa de nome.", "kanban");
  }
}

// ---------- Modo simulado ----------
let visoes: Visao[] = structuredClone(VISOES_INICIAIS);
let padrao: ColunaKanban[] = structuredClone(KANBAN_PADRAO);
let seq = 100;

function permissoesAtuais() {
  const actor = currentActor();
  return { actor, ...permissoesVisoes(actor.role, actor.role === SUPER_ADMIN_ROLE) };
}

function exigir(ok: boolean, mensagem: string) {
  if (!ok) throw new ServiceError("FORBIDDEN", mensagem);
}

const mockVisoes: VisoesService = {
  async disponiveis() {
    await delay();
    const { actor, veTodas } = permissoesAtuais();
    const minhas = new Set(equipesAtivasMock().filter((e) => e.membros.includes(actor.id)).map((e) => e.id));
    return structuredClone(visoes.filter((v) => v.habilitada && (veTodas || v.equipes.some((id) => minhas.has(id)))));
  },
  async todas() {
    await delay();
    exigir(permissoesAtuais().podeConfigurar, "Só Admin e Super admin configuram visões.");
    return structuredClone(visoes);
  },
  async equipes() {
    return equipesAtivasMock().map(({ id, nome }) => ({ id, nome })).sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
  },
  async salvar(p) {
    await delay();
    const { actor, podeConfigurar } = permissoesAtuais();
    exigir(podeConfigurar, "Só Admin e Super admin configuram visões.");
    validarVisao(p);
    const nome = p.nome.trim();
    if (visoes.some((v) => v.id !== p.id && v.nome.toLowerCase() === nome.toLowerCase())) {
      throw new ServiceError("DUPLICATE", "Já existe uma visão com esse nome.", "nome");
    }
    const dados: Visao = { ...structuredClone(p), id: p.id ?? ++seq, nome, atualizadoEm: new Date().toISOString(), atualizadoPor: actor.name };
    // Só uma visão padrão no sistema.
    if (dados.padrao) visoes = visoes.map((v) => ({ ...v, padrao: false }));
    const i = visoes.findIndex((v) => v.id === p.id);
    if (i >= 0) visoes[i] = dados;
    else visoes.push(dados);
    recordAudit({ module: "atendimento", action: i >= 0 ? "update" : "create", description: `Visão de tickets "${nome}" ${i >= 0 ? "alterada" : "criada"}.` });
    return dados.id;
  },
  async excluir(id) {
    await delay();
    exigir(permissoesAtuais().podeExcluir, "Só o Super admin exclui visões.");
    const v = visoes.find((x) => x.id === id);
    if (!v) throw new ServiceError("NOT_FOUND", "Visão não encontrada.");
    visoes = visoes.filter((x) => x.id !== id);
    recordAudit({ module: "atendimento", action: "delete", description: `Visão de tickets "${v.nome}" excluída.` });
  },
  async kanbanPadrao() {
    return structuredClone(padrao);
  },
  async salvarKanbanPadrao(colunas) {
    await delay();
    exigir(permissoesAtuais().podeDefinirPadrao, "Só o Super admin define o Kanban padrão.");
    padrao = structuredClone(colunas);
    recordAudit({ module: "atendimento", action: "update", description: "Kanban padrão das visões de tickets redefinido." });
  },
  async listaExtras() {
    await delay();
    return { campos: [], tickets: {} };
  },
};

export const visoesService: VisoesService = DATA_SOURCE === "mock" ? mockVisoes : supabaseVisoes;
