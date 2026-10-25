import { ADMIN_ROLE, SUPER_ADMIN_ROLE } from "../../../config/app";
import type { Json } from "../../../lib/database.types";
import { supabase } from "../../../lib/supabase";
import { DATA_SOURCE } from "../../configuracoes/services";
import { currentActor, delay, recordAudit } from "../../configuracoes/services/mock/runtime";
import { fromPostgrest } from "../../configuracoes/services/supabase/errors";
import { ServiceError } from "../../configuracoes/services/types";

// Administração › Empreendimentos (docs/PLANO-empreendimentos-cftv.md, migration 20261012100000).
// Cadastro e, por setor, se o App do solicitante pede o empreendimento e se a IA identifica. Escrita: Admin e Super admin.
// No ticket: o empreendimento atual, a avaliação da IA (sugestões) e a troca manual.

export interface Empreendimento {
  id: number;
  nome: string;
  apelidos: string[];
  cidade: string | null;
  endereco: string | null;
  observacao: string | null;
  ativo: boolean;
  /** Tickets ligados a ele. */
  tickets: number;
}

export interface ConfigSetor {
  setorId: number;
  setor: string;
  pedirNoApp: boolean;
  iaLigada: boolean;
  limiar: number;
}

export interface CadastroEmpreendimentos {
  empreendimentos: Empreendimento[];
  setores: ConfigSetor[];
}

export type SalvarEmpreendimento = Omit<Empreendimento, "id" | "tickets"> & { id?: number };

export interface OpcaoEmpreendimento {
  id: number;
  nome: string;
}

export interface EmpreendimentoDoTicket {
  /** O setor do ticket usa empreendimento (ou o ticket já tem um). */
  usa: boolean;
  empreendimento: (OpcaoEmpreendimento & { cidade: string | null; endereco: string | null; observacao: string | null }) | null;
  origem: "ia" | "manual" | "solicitante" | null;
  ia: { situacao: "aplicado" | "baixa_confianca"; confianca: number; motivo: string | null; criadoEm: string; sugestoes: OpcaoEmpreendimento[] } | null;
  opcoes: OpcaoEmpreendimento[];
}

export interface EmpreendimentosService {
  carregar(): Promise<CadastroEmpreendimentos>;
  salvar(p: SalvarEmpreendimento): Promise<number>;
  salvarConfig(p: ConfigSetor): Promise<void>;
  doTicket(ticketId: number): Promise<EmpreendimentoDoTicket>;
  definirNoTicket(ticketId: number, empreendimentoId: number | null): Promise<void>;
}

async function rpc<T>(nome: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(nome as never, args as never);
  if (error) throw fromPostgrest(error);
  return data as T;
}

const supabaseEmpreendimentos: EmpreendimentosService = {
  carregar: () => rpc<CadastroEmpreendimentos>("ch_empreendimentos_lista"),
  salvar: (p) => rpc<number>("ch_empreendimento_salvar", { p: p as unknown as Json }),
  salvarConfig: (p) => rpc<void>("ch_empreendimento_config_salvar", { p: p as unknown as Json }),
  doTicket: (id) => rpc<EmpreendimentoDoTicket>("ch_ticket_empreendimento", { p_id: id }),
  definirNoTicket: (id, emp) => rpc<void>("ch_ticket_empreendimento_definir", { p_id: id, p_empreendimento: emp }),
};

// ---------- Modo simulado (mesmas validações das RPCs) ----------
const NOMES = ["ARTE WAVE SURF RESIDENCES", "CONDOMINIO ARTE WAVE", "CONDOMINIO NEXUS", "FEEL NATURE", "FEEL PONTAL OCEANICO", "NEXUS HOTEL & RESIDENCE"];
const mock: CadastroEmpreendimentos = {
  empreendimentos: NOMES.map((nome, i) => ({ id: i + 1, nome, apelidos: [], cidade: null, endereco: null, observacao: null, ativo: true, tickets: 0 })),
  setores: [
    { setorId: 20, setor: "TI -  Suporte", pedirNoApp: false, iaLigada: false, limiar: 80 },
    { setorId: 21, setor: "CFTV", pedirNoApp: true, iaLigada: true, limiar: 80 },
  ],
};
const noTicket = new Map<number, number | null>();

function exigirAdmin() {
  const role = currentActor().role;
  if (role !== ADMIN_ROLE && role !== SUPER_ADMIN_ROLE) throw new ServiceError("FORBIDDEN", "Só Admin e Super admin alteram os cadastros do ticket.");
}

const mockEmpreendimentos: EmpreendimentosService = {
  async carregar() {
    await delay();
    return structuredClone(mock);
  },
  async salvar(p) {
    await delay();
    exigirAdmin();
    const nome = p.nome.trim().replace(/\s+/g, " ");
    if (nome.length < 2 || nome.length > 120) throw new ServiceError("INVALID_INPUT", "Informe o nome (2 a 120 letras).", "nome");
    if (mock.empreendimentos.some((e) => e.id !== p.id && e.nome.toLowerCase() === nome.toLowerCase())) {
      throw new ServiceError("DUPLICATE", "Já existe um empreendimento com esse nome.", "nome");
    }
    const apelidos = [...new Map(p.apelidos.map((a) => a.trim()).filter((a) => a.length >= 2).map((a) => [a.toLowerCase(), a])).values()];
    const dados = { ...p, nome, apelidos };
    const atual = mock.empreendimentos.find((e) => e.id === p.id);
    if (atual) Object.assign(atual, dados);
    else mock.empreendimentos.push({ ...dados, id: Math.max(0, ...mock.empreendimentos.map((e) => e.id)) + 1, tickets: 0 });
    mock.empreendimentos.sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
    recordAudit({ module: "atendimento", action: "update", description: `Empreendimento "${nome}" salvo.` });
    return atual?.id ?? mock.empreendimentos.find((e) => e.nome === nome)!.id;
  },
  async salvarConfig(p) {
    await delay();
    exigirAdmin();
    if (p.limiar < 50 || p.limiar > 100) throw new ServiceError("INVALID_INPUT", "O limiar vai de 50 a 100%.", "limiar");
    const s = mock.setores.find((x) => x.setorId === p.setorId);
    if (!s) throw new ServiceError("NOT_FOUND", "Setor não encontrado.");
    Object.assign(s, p);
  },
  async doTicket(id) {
    await delay();
    const atual = mock.empreendimentos.find((e) => e.id === noTicket.get(id));
    return {
      usa: true,
      empreendimento: atual ? { id: atual.id, nome: atual.nome, cidade: atual.cidade, endereco: atual.endereco, observacao: atual.observacao } : null,
      origem: atual ? "manual" : null,
      ia: null,
      opcoes: mock.empreendimentos.filter((e) => e.ativo).map(({ id: i, nome }) => ({ id: i, nome })),
    };
  },
  async definirNoTicket(id, emp) {
    await delay();
    noTicket.set(id, emp);
  },
};

export const empreendimentosService: EmpreendimentosService = DATA_SOURCE === "mock" ? mockEmpreendimentos : supabaseEmpreendimentos;
