import { ADMIN_ROLE, SUPER_ADMIN_ROLE } from "../../../config/app";
import type { Json } from "../../../lib/database.types";
import { supabase } from "../../../lib/supabase";
import { DATA_SOURCE } from "../../configuracoes/services";
import { currentActor, delay, recordAudit } from "../../configuracoes/services/mock/runtime";
import { fromPostgrest } from "../../configuracoes/services/supabase/errors";
import { ServiceError } from "../../configuracoes/services/types";
import { CADASTROS_INICIAIS, MACROS_INICIAIS } from "./seed";
import { chaveDoRotulo, type Cadastros, type Campo, type Categoria, type Macro, type Regra, type Servico, type Urgencia } from "./types";

// Administração › Serviços, Urgências, Categorias, Campos adicionais, Regras para exibição (e Macros).
// Leitura: quem usa a Gestão de Chamados. Escrita: Admin e Super admin (regra fixa; as RPCs ch_* conferem).
// Nada se exclui: desativa (D5 do plano de cadastros).

export type SalvarUrgencia = Omit<Urgencia, "id" | "ordem"> & { id?: number };
export type SalvarCategoria = Omit<Categoria, "id" | "ordem"> & { id?: number };
export type SalvarServico = Omit<Servico, "id" | "ordem" | "nivel"> & { id?: number };
export type SalvarCampo = Omit<Campo, "id" | "ordem"> & { id?: number };
export type SalvarRegra = Omit<Regra, "id" | "ordem"> & { id?: number };
export type SalvarMacro = Omit<Macro, "id" | "donoId"> & { id?: number };
export type TabelaOrdenavel = "urgencias" | "categorias" | "campos" | "regras";

export interface CadastrosService {
  carregar(): Promise<Cadastros>;
  salvarUrgencia(p: SalvarUrgencia): Promise<number>;
  salvarCategoria(p: SalvarCategoria): Promise<number>;
  salvarServico(p: SalvarServico): Promise<number>;
  salvarCampo(p: SalvarCampo): Promise<number>;
  salvarRegra(p: SalvarRegra): Promise<number>;
  ordenar(tabela: TabelaOrdenavel, ids: number[]): Promise<void>;
  macros(): Promise<Macro[]>;
  salvarMacro(p: SalvarMacro): Promise<number>;
  salvarPadroesSetor(setorId: number, equipeId: number | null, slaHoras: number): Promise<void>;
}

async function rpc<T>(nome: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(nome as never, args as never);
  if (error) throw fromPostgrest(error);
  return data as T;
}

const supabaseCadastros: CadastrosService = {
  carregar: () => rpc<Cadastros>("ch_cadastros"),
  salvarUrgencia: (p) => rpc<number>("ch_urgencia_salvar", { p: p as unknown as Json }),
  salvarCategoria: (p) => rpc<number>("ch_categoria_salvar", { p: p as unknown as Json }),
  salvarServico: (p) => rpc<number>("ch_servico_salvar", { p: p as unknown as Json }),
  salvarCampo: (p) => rpc<number>("ch_campo_salvar", { p: p as unknown as Json }),
  salvarRegra: (p) => rpc<number>("ch_regra_salvar", { p: p as unknown as Json }),
  ordenar: (tabela, ids) => rpc<void>("ch_cadastro_ordenar", { p_tabela: tabela, p_ids: ids }),
  macros: () => rpc<Macro[]>("ch_macros_lista"),
  salvarMacro: (p) => rpc<number>("ch_macro_salvar", { p: p as unknown as Json }),
  salvarPadroesSetor: (setorId, equipeId, slaHoras) => rpc<void>("ch_setor_padroes_salvar", { p_setor: setorId, p_equipe: equipeId, p_sla_horas: slaHoras }),
};

// ---------- Modo simulado (mesmas validações das RPCs) ----------
const db: Cadastros = structuredClone(CADASTROS_INICIAIS);
let macros: Macro[] = structuredClone(MACROS_INICIAIS);
let seq = 500;

function ehAdmin(): boolean {
  const role = currentActor().role;
  return role === ADMIN_ROLE || role === SUPER_ADMIN_ROLE;
}

function exigirAdmin() {
  if (!ehAdmin()) throw new ServiceError("FORBIDDEN", "Só Admin e Super admin alteram os cadastros do ticket.");
}

function nomeValido(nome: string, min: number, max: number, campo = "nome"): string {
  const n = nome.trim();
  if (n.length < min || n.length > max) throw new ServiceError("INVALID_INPUT", `Informe o nome (${min} a ${max} letras).`, campo);
  return n;
}

function semDuplicado<T extends { id: number }>(lista: T[], id: number | undefined, igual: (x: T) => boolean, msg: string) {
  if (lista.some((x) => x.id !== id && igual(x))) throw new ServiceError("DUPLICATE", msg, "nome");
}

/** Insere ou atualiza; devolve o id. */
function gravar<T extends { id: number; ordem: number }>(lista: T[], id: number | undefined, dados: Omit<T, "id" | "ordem">): number {
  const atual = lista.find((x) => x.id === id);
  if (atual) {
    Object.assign(atual, dados);
    return atual.id;
  }
  const novo = { ...dados, id: ++seq, ordem: Math.max(0, ...lista.map((x) => x.ordem)) + 1 } as T;
  lista.push(novo);
  return novo.id;
}

const mockCadastros: CadastrosService = {
  async carregar() {
    await delay();
    return structuredClone(db);
  },
  async salvarUrgencia(p) {
    await delay();
    exigirAdmin();
    const nome = nomeValido(p.nome, 2, 30);
    semDuplicado(db.urgencias, p.id, (u) => u.nome.toLowerCase() === nome.toLowerCase(), "Já existe uma urgência com esse nome.");
    if (p.padrao) db.urgencias.forEach((u) => (u.padrao = false));
    const id = gravar(db.urgencias, p.id, { ...p, nome, descricao: p.descricao?.trim() || null });
    recordAudit({ module: "atendimento", action: "update", description: `Urgência "${nome}" salva.` });
    return id;
  },
  async salvarCategoria(p) {
    await delay();
    exigirAdmin();
    const nome = nomeValido(p.nome, 2, 40);
    semDuplicado(db.categorias, p.id, (c) => c.nome.toLowerCase() === nome.toLowerCase(), "Já existe uma categoria com esse nome.");
    if (p.padrao) db.categorias.forEach((c) => (c.padrao = false));
    const id = gravar(db.categorias, p.id, { ...p, nome, descricao: p.descricao?.trim() || null });
    recordAudit({ module: "atendimento", action: "update", description: `Categoria "${nome}" salva.` });
    return id;
  },
  async salvarServico(p) {
    await delay();
    exigirAdmin();
    const nome = nomeValido(p.nome, 2, 80);
    const pai = db.servicos.find((s) => s.id === p.paiId);
    if (p.paiId !== null && !pai) throw new ServiceError("NOT_FOUND", "Serviço pai não encontrado.", "paiId");
    const nivel = pai ? pai.nivel + 1 : 1;
    if (nivel > 3) throw new ServiceError("INVALID_INPUT", "O catálogo tem no máximo 3 níveis.", "paiId");
    // Sem ciclo e sem passar de 3 níveis com os filhos.
    for (let c = pai; c; c = db.servicos.find((s) => s.id === c!.paiId)) {
      if (c.id === p.id) throw new ServiceError("INVALID_INPUT", "Um serviço não pode ficar dentro dele mesmo.", "paiId");
    }
    const profundidade = (id: number | undefined): number => {
      const filhos = db.servicos.filter((s) => s.paiId === id && id !== undefined);
      return filhos.length ? 1 + Math.max(...filhos.map((f) => profundidade(f.id))) : 0;
    };
    if (nivel + profundidade(p.id) > 3) throw new ServiceError("INVALID_INPUT", "Com os serviços de dentro, o catálogo passaria de 3 níveis.", "paiId");
    const setorId = pai ? pai.setorId : p.setorId;
    if (!db.setores.some((s) => s.id === setorId)) throw new ServiceError("INVALID_INPUT", "Escolha o setor.", "setorId");
    semDuplicado(db.servicos, p.id, (s) => s.setorId === setorId && s.paiId === p.paiId && s.nome.toLowerCase() === nome.toLowerCase(), "Já existe um serviço com esse nome neste nível.");
    const id = gravar(db.servicos, p.id, { ...p, nome, setorId, nivel, descricao: p.descricao?.trim() || null });
    // Filhos acompanham setor e nível.
    const ajustar = (paiId: number, niv: number) =>
      db.servicos.filter((s) => s.paiId === paiId).forEach((f) => {
        f.setorId = setorId;
        f.nivel = niv + 1;
        ajustar(f.id, niv + 1);
      });
    ajustar(id, nivel);
    recordAudit({ module: "atendimento", action: "update", description: `Serviço "${nome}" salvo.` });
    return id;
  },
  async salvarCampo(p) {
    await delay();
    exigirAdmin();
    const rotulo = nomeValido(p.rotulo, 2, 60, "rotulo");
    const atual = db.campos.find((c) => c.id === p.id);
    const chave = atual ? atual.chave : p.chave || chaveDoRotulo(rotulo);
    if (!/^[a-z][a-z0-9_]{1,39}$/.test(chave)) throw new ServiceError("INVALID_INPUT", "Chave inválida (letras minúsculas, números e _).", "chave");
    if (!atual && db.campos.some((c) => c.chave === chave)) throw new ServiceError("DUPLICATE", "Já existe um campo com essa chave.", "chave");
    const opcoes = p.opcoes.map((o) => o.trim()).filter(Boolean);
    if ((p.tipo === "lista" || p.tipo === "multipla") && opcoes.length === 0) throw new ServiceError("INVALID_INPUT", "Informe as opções da lista.", "opcoes");
    const id = gravar(db.campos, p.id, { ...p, chave, rotulo, opcoes, ajuda: p.ajuda?.trim() || null });
    recordAudit({ module: "atendimento", action: "update", description: `Campo adicional "${rotulo}" salvo.` });
    return id;
  },
  async salvarRegra(p) {
    await delay();
    exigirAdmin();
    const nome = nomeValido(p.nome, 2, 80);
    if (p.condicoes.length === 0 || p.condicoes.some((c) => (c.operador === "um_de" || c.operador === "nao_um_de") && c.valores.length === 0)) {
      throw new ServiceError("INVALID_INPUT", "Revise as condições: campo, operador e valores.", "condicoes");
    }
    if (p.acoes.length === 0 || p.acoes.some((a) => !db.campos.some((c) => c.chave === a.campo))) {
      throw new ServiceError("INVALID_INPUT", "Revise as ações: cada uma precisa de um campo existente.", "acoes");
    }
    const id = gravar(db.regras, p.id, { ...p, nome });
    recordAudit({ module: "atendimento", action: "update", description: `Regra para exibição "${nome}" salva.` });
    return id;
  },
  async ordenar(tabela, ids) {
    await delay();
    exigirAdmin();
    const lista: { id: number; ordem: number }[] = db[tabela];
    for (const item of lista) {
      const i = ids.indexOf(item.id);
      if (i >= 0) item.ordem = i + 1;
    }
  },
  async macros() {
    await delay();
    const actor = currentActor();
    return structuredClone(macros.filter((m) => ehAdmin() || (m.ativa && (m.escopo === "todos" || (m.escopo === "pessoal" && m.donoId === actor.id)))));
  },
  async salvarMacro(p) {
    await delay();
    const actor = currentActor();
    const atual = macros.find((m) => m.id === p.id);
    if (!ehAdmin() && (p.escopo !== "pessoal" || (atual && atual.donoId !== actor.id))) {
      throw new ServiceError("FORBIDDEN", "Você só pode criar e editar as suas macros pessoais.");
    }
    const nome = nomeValido(p.nome, 2, 80);
    if (p.escopo === "equipe" && !p.equipeId) throw new ServiceError("INVALID_INPUT", "Escolha a equipe.", "equipeId");
    const dados = { ...p, nome, donoId: p.escopo === "pessoal" ? (atual?.donoId ?? actor.id) : null };
    if (atual) Object.assign(atual, dados);
    else macros = [...macros, { ...dados, id: ++seq }];
    return atual?.id ?? seq;
  },
  async salvarPadroesSetor(setorId, equipeId, slaHoras) {
    await delay();
    exigirAdmin();
    const setor = db.setores.find((s) => s.id === setorId);
    if (!setor) throw new ServiceError("NOT_FOUND", "Setor não encontrado.");
    if (equipeId !== null && !db.equipes.some((e) => e.id === equipeId && e.setorId === setorId)) {
      throw new ServiceError("INVALID_INPUT", "A equipe padrão precisa ser do mesmo setor.", "equipePadraoId");
    }
    if (!(slaHoras > 0 && slaHoras <= 999)) throw new ServiceError("INVALID_INPUT", "SLA padrão inválido.", "slaPadraoHoras");
    Object.assign(setor, { equipePadraoId: equipeId, slaPadraoHoras: slaHoras });
  },
};

export const cadastrosService: CadastrosService = DATA_SOURCE === "mock" ? mockCadastros : supabaseCadastros;
