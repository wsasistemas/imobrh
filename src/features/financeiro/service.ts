import { ADMIN_ROLE, SUPER_ADMIN_ROLE } from "../../config/app";
import type { Json } from "../../lib/database.types";
import { supabase } from "../../lib/supabase";
import { DATA_SOURCE } from "../configuracoes/services";
import { currentActor, delay, recordAudit } from "../configuracoes/services/mock/runtime";
import { GESTOR_DO_SETOR, nomeDoSetor, SETOR_DO_USUARIO } from "../atendimento/services/setoresProducao";
import { fromPostgrest } from "../configuracoes/services/supabase/errors";
import { ServiceError } from "../configuracoes/services/types";

// Solicitações Financeiras (docs/Solicitacoes-financeiras/CONTEXTO.md; migrations 20261017100000–100200).
// Fase 1: aba "Aprovação financeira" do setor (Setores e números) e Cadastros financeiros. Escrita: Admin e Super admin.

export type ModoAprovacao = "sequencial" | "paralelo" | "qualquer_um";
export type PapelAdiantamento = "planejamento" | "gerente" | "diretor" | "presidente";
export const PAPEIS_ADIANTAMENTO: PapelAdiantamento[] = ["planejamento", "gerente", "diretor", "presidente"];

export interface Opcao {
  id: string;
  nome: string;
}

export interface NivelReembolso {
  papel: string;
  aprovadorId: string;
  substitutoId: string | null;
  alcadaMinima: number;
}

export interface NivelAdiantamento {
  papel: PapelAdiantamento;
  aprovadorId: string | null;
  substitutoId: string | null;
  /** Só diretor e presidente: aprova quando o valor passa disto. */
  alcadaMinima: number | null;
}

export interface ConfigSetorFinanceiro {
  setorId: number;
  obra: boolean;
  financeiro: boolean;
  modoAprovacao: ModoAprovacao;
  prazoHoras: number;
  acaoPrazoVencido: "lembrar" | "escalar";
  centroCustoPadrao: string | null;
  prazoComprovacaoDias: number;
  acaoComprovacaoVencida: "avisar" | "avisar_bloquear";
  /** [LIMITE] do PRD: nulo = sem limite. */
  limiteAdiantamentosAbertos: number | null;
  reembolso: NivelReembolso[];
  adiantamento: NivelAdiantamento[];
}

export interface SetorFinanceiro extends ConfigSetorFinanceiro {
  setor: string;
  podeEditar: boolean;
  /** Pessoas do setor no cadastro de Pessoas: seguem esta cadeia. */
  pessoas: number;
  /** Gestão do setor: sugerida como Gestor/Gerente. */
  gestores: Opcao[];
}

export interface ResumoSetor {
  setorId: number;
  obra: boolean;
  financeiro: boolean;
  niveisReembolso: number;
  niveisAdiantamento: number;
}

export interface FundoFixo {
  id: number;
  usuarioId: string;
  usuario: string;
  setor: string | null;
  valor: number;
  vigenteDesde: string;
}

export interface CategoriaMotivo {
  id: number;
  nome: string;
  descricao: string | null;
  palavrasChave: string[];
  tetoValor: number | null;
  ativo: boolean;
}

export interface RegraAceitacao {
  codigo: string;
  nome: string;
  descricao: string;
  aplicaA: "reembolso_fundo_fixo" | "adiantamento";
  severidade: "alerta" | "bloqueio";
  ativo: boolean;
  parametros: Record<string, unknown>;
}

export interface CadastrosFinanceiros {
  fundos: FundoFixo[];
  categorias: CategoriaMotivo[];
  regras: RegraAceitacao[];
  usuarios: Opcao[];
}

export type SalvarCategoria = Omit<CategoriaMotivo, "id"> & { id?: number };
export type SalvarRegra = Pick<RegraAceitacao, "codigo" | "ativo" | "severidade" | "parametros">;

export interface FinanceiroService {
  resumoSetores(): Promise<ResumoSetor[]>;
  setor(setorId: number): Promise<SetorFinanceiro>;
  usuarios(): Promise<Opcao[]>;
  salvarSetor(p: ConfigSetorFinanceiro): Promise<void>;
  cadastros(): Promise<CadastrosFinanceiros>;
  salvarFundoFixo(p: { usuarioId: string; valor: number; vigenteDesde?: string }): Promise<void>;
  salvarCategoria(p: SalvarCategoria): Promise<number>;
  salvarRegra(p: SalvarRegra): Promise<void>;
}

async function rpc<T>(nome: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(nome as never, args as never);
  if (error) throw fromPostgrest(error);
  return data as T;
}

interface AprovadorLido {
  tipo: "reembolso_fundo_fixo" | "adiantamento";
  papel: string;
  aprovadorId: string;
  substitutoId: string | null;
  alcadaMinima: number | null;
}

/** A RPC devolve os aprovadores numa lista só; a tela trabalha com as duas cadeias. */
function montarSetor(r: Omit<SetorFinanceiro, "reembolso" | "adiantamento"> & { aprovadores: AprovadorLido[] }): SetorFinanceiro {
  const { aprovadores, ...resto } = r;
  return {
    ...resto,
    reembolso: aprovadores
      .filter((a) => a.tipo === "reembolso_fundo_fixo")
      .map((a) => ({ papel: a.papel, aprovadorId: a.aprovadorId, substitutoId: a.substitutoId, alcadaMinima: Number(a.alcadaMinima ?? 0) })),
    adiantamento: PAPEIS_ADIANTAMENTO.map((papel) => {
      const a = aprovadores.find((x) => x.tipo === "adiantamento" && x.papel === papel);
      return { papel, aprovadorId: a?.aprovadorId ?? null, substitutoId: a?.substitutoId ?? null, alcadaMinima: a?.alcadaMinima == null ? null : Number(a.alcadaMinima) };
    }),
  };
}

const supabaseFinanceiro: FinanceiroService = {
  resumoSetores: () => rpc<ResumoSetor[]>("sf_setores_resumo"),
  setor: async (setorId) => montarSetor(await rpc("sf_setor_config_obter", { p_setor: setorId })),
  usuarios: () => rpc<Opcao[]>("sf_usuarios_opcoes"),
  salvarSetor: (p) => rpc<void>("sf_setor_config_salvar", { p: p as unknown as Json }),
  cadastros: async () => {
    const r = await rpc<CadastrosFinanceiros>("sf_cadastros_lista");
    return {
      ...r,
      fundos: r.fundos.map((f) => ({ ...f, valor: Number(f.valor) })),
      categorias: r.categorias.map((c) => ({ ...c, tetoValor: c.tetoValor == null ? null : Number(c.tetoValor) })),
    };
  },
  salvarFundoFixo: (p) => rpc<void>("sf_fundo_fixo_salvar", { p: p as unknown as Json }),
  salvarCategoria: (p) => rpc<number>("sf_categoria_salvar", { p: p as unknown as Json }),
  salvarRegra: (p) => rpc<void>("sf_regra_salvar", { p: p as unknown as Json }),
};

// ---------- Modo simulado (mesmas validações das RPCs) ----------
const USUARIOS: Opcao[] = [
  { id: "u-wagner", nome: "Wagner Antunes" }, { id: "u-marcos", nome: "Marcos Prado" }, { id: "u-paula", nome: "Paula Nunes" },
  { id: "u-renato", nome: "Renato Lopes" }, { id: "u-helena", nome: "Helena Costa" }, { id: "u-carla", nome: "Carla Mendes" },
  { id: "u-gustavo", nome: "Gustavo Reis" }, { id: "u-fernanda", nome: "Fernanda Dias" }, { id: "u-ana", nome: "Ana Lima" },
  { id: "u-bruno", nome: "Bruno Rocha" }, { id: "u-roberto", nome: "Roberto Alves" },
]
/** Configuração por setor no modo simulado (a demonstração preenche os setores de obra e o Financeiro). */
export const configs = new Map<number, ConfigSetorFinanceiro>();
const padrao = (setorId: number): ConfigSetorFinanceiro => ({
  setorId, obra: false, financeiro: false, modoAprovacao: "sequencial", prazoHoras: 48, acaoPrazoVencido: "escalar", centroCustoPadrao: null,
  prazoComprovacaoDias: 30, acaoComprovacaoVencida: "avisar_bloquear", limiteAdiantamentosAbertos: null, reembolso: [],
  adiantamento: PAPEIS_ADIANTAMENTO.map((papel) => ({ papel, aprovadorId: null, substitutoId: null, alcadaMinima: null })),
});
const CATEGORIAS = ["Material de obra", "Ferramentas", "EPI", "Combustível", "Transporte", "Estacionamento", "Alimentação", "Copa/mantimentos", "Material de escritório", "Outros"];
export const mockCadastros: CadastrosFinanceiros = {
  fundos: [],
  categorias: CATEGORIAS.map((nome, i) => ({ id: i + 1, nome, descricao: null, palavrasChave: [], tetoValor: null, ativo: true })),
  regras: [
    ["R01", "Comprovante anexado", "bloqueio", {}], ["R02", "Legível", "alerta", { limiar: 0.8 }], ["R03", "Data no período", "alerta", {}],
    ["R04", "Valor confere", "alerta", { tolerancia: 0 }], ["R05", "Documento fiscal", "alerta", {}], ["R06", "Sem duplicidade", "bloqueio", {}],
    ["R07", "Categoria permitida", "alerta", { itens_proibidos: [] }], ["R08", "Limite por categoria", "alerta", {}],
    ["R09", "Prazo de envio", "alerta", { dias: null }], ["R10", "Saldo do fundo fixo", "bloqueio", {}],
    ["A01", "Documento de origem", "bloqueio", {}], ["A02", "Valor × pedido", "alerta", {}], ["A03", "Favorecido × pedido", "alerta", {}],
    ["A04", "Titularidade bancária", "alerta", {}], ["A05", "Rateio", "bloqueio", {}], ["A06", "Adiantamento em aberto", "bloqueio", {}],
    ["A07", "Comprovação", "alerta", {}],
  ].map(([codigo, nome, severidade, parametros]) => ({
    codigo: codigo as string, nome: nome as string, descricao: "", severidade: severidade as RegraAceitacao["severidade"], ativo: true,
    parametros: parametros as Record<string, unknown>, aplicaA: (codigo as string).startsWith("A") ? "adiantamento" : "reembolso_fundo_fixo",
  })),
  usuarios: USUARIOS,
};

function exigirAdmin() {
  const role = currentActor().role;
  if (role !== ADMIN_ROLE && role !== SUPER_ADMIN_ROLE) throw new ServiceError("FORBIDDEN", "Só Admin e Super admin alteram os cadastros financeiros.");
}

/** Validações da aba (as mesmas de sf_setor_config_salvar). */
export function validarConfig(p: ConfigSetorFinanceiro): ServiceError | null {
  if (p.prazoHoras < 1 || p.prazoHoras > 720) return new ServiceError("INVALID_INPUT", "O prazo por etapa vai de 1 a 720 horas.", "prazoHoras");
  if (p.prazoComprovacaoDias < 1 || p.prazoComprovacaoDias > 365) return new ServiceError("INVALID_INPUT", "O prazo de comprovação vai de 1 a 365 dias.", "prazoComprovacaoDias");
  if (p.limiteAdiantamentosAbertos != null && (p.limiteAdiantamentosAbertos < 1 || p.limiteAdiantamentosAbertos > 99)) {
    return new ServiceError("INVALID_INPUT", "O limite de adiantamentos em aberto vai de 1 a 99 (vazio = sem limite).", "limiteAdiantamentosAbertos");
  }
  for (const [i, n] of p.reembolso.entries()) {
    if (n.papel.trim().length < 2) return new ServiceError("INVALID_INPUT", `Nível ${i + 1}: informe o papel (ex.: Gestor).`, "reembolso");
    if (!n.aprovadorId) return new ServiceError("INVALID_INPUT", `Nível ${i + 1}: escolha um aprovador ativo.`, "reembolso");
    if (n.substitutoId === n.aprovadorId) return new ServiceError("INVALID_INPUT", `Nível ${i + 1}: o substituto não pode ser o próprio aprovador.`, "reembolso");
    if (n.alcadaMinima < 0) return new ServiceError("INVALID_INPUT", `Nível ${i + 1}: alçada mínima não pode ser negativa.`, "reembolso");
  }
  for (const n of p.adiantamento) {
    if (!n.aprovadorId) continue;
    const nome = n.papel[0].toUpperCase() + n.papel.slice(1);
    if (n.substitutoId === n.aprovadorId) return new ServiceError("INVALID_INPUT", `${nome}: o substituto não pode ser o próprio aprovador.`, "adiantamento");
    if ((n.papel === "diretor" || n.papel === "presidente") && !(n.alcadaMinima && n.alcadaMinima > 0)) {
      return new ServiceError("INVALID_INPUT", `${nome}: informe a partir de que valor ele aprova.`, "adiantamento");
    }
  }
  return null;
}

const mockFinanceiro: FinanceiroService = {
  async resumoSetores() {
    await delay();
    return [...configs.values()].map((c) => ({
      setorId: c.setorId, obra: c.obra, financeiro: c.financeiro, niveisReembolso: c.reembolso.length,
      niveisAdiantamento: c.adiantamento.filter((n) => n.aprovadorId).length,
    }));
  },
  async setor(setorId) {
    await delay();
    const c = configs.get(setorId) ?? padrao(setorId);
    const g = GESTOR_DO_SETOR[setorId];
    return {
      ...structuredClone(c), setor: nomeDoSetor(setorId) ?? `Setor ${setorId}`, podeEditar: currentActor().role === ADMIN_ROLE || currentActor().role === SUPER_ADMIN_ROLE,
      pessoas: Object.values(SETOR_DO_USUARIO).filter((s) => s === setorId).length, gestores: g ? [{ id: g.id, nome: g.nome }] : [],
    };
  },
  async usuarios() {
    await delay();
    return USUARIOS;
  },
  async salvarSetor(p) {
    await delay();
    exigirAdmin();
    const erro = validarConfig(p);
    if (erro) throw erro;
    configs.set(p.setorId, structuredClone(p));
    recordAudit({ module: "atendimento", action: "update", description: "Setor: aprovação financeira salva." });
  },
  async cadastros() {
    await delay();
    exigirAdmin();
    return structuredClone(mockCadastros);
  },
  async salvarFundoFixo(p) {
    await delay();
    exigirAdmin();
    if (p.valor < 0) throw new ServiceError("INVALID_INPUT", "O valor não pode ser negativo.", "valor");
    mockCadastros.fundos = mockCadastros.fundos.filter((f) => f.usuarioId !== p.usuarioId);
    const u = USUARIOS.find((x) => x.id === p.usuarioId);
    if (!u) throw new ServiceError("INVALID_INPUT", "Escolha o colaborador.", "usuarioId");
    if (p.valor > 0) mockCadastros.fundos.push({ id: Date.now(), usuarioId: u.id, usuario: u.nome, setor: null, valor: p.valor, vigenteDesde: p.vigenteDesde ?? new Date().toISOString().slice(0, 10) });
  },
  async salvarCategoria(p) {
    await delay();
    exigirAdmin();
    const nome = p.nome.trim().replace(/\s+/g, " ");
    if (nome.length < 2 || nome.length > 60) throw new ServiceError("INVALID_INPUT", "Informe o nome (2 a 60 letras).", "nome");
    if (mockCadastros.categorias.some((c) => c.id !== p.id && c.nome.toLowerCase() === nome.toLowerCase())) {
      throw new ServiceError("DUPLICATE", "Já existe uma categoria com esse nome.", "nome");
    }
    const atual = mockCadastros.categorias.find((c) => c.id === p.id);
    if (atual) Object.assign(atual, { ...p, nome });
    else mockCadastros.categorias.push({ ...p, nome, id: Math.max(0, ...mockCadastros.categorias.map((c) => c.id)) + 1 });
    return atual?.id ?? mockCadastros.categorias[mockCadastros.categorias.length - 1].id;
  },
  async salvarRegra(p) {
    await delay();
    exigirAdmin();
    const r = mockCadastros.regras.find((x) => x.codigo === p.codigo);
    if (!r) throw new ServiceError("NOT_FOUND", "Regra não encontrada.");
    Object.assign(r, { ativo: p.ativo, severidade: p.severidade, parametros: { ...r.parametros, ...p.parametros } });
  },
};

export const financeiroService: FinanceiroService = DATA_SOURCE === "mock" ? mockFinanceiro : supabaseFinanceiro;
