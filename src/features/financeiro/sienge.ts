import { edgeFunction } from "../../config/app";
import type { Json } from "../../lib/database.types";
import { supabase } from "../../lib/supabase";
import { DATA_SOURCE } from "../configuracoes/services";
import { delay } from "../configuracoes/services/mock/runtime";
import { fromFunction } from "../configuracoes/services/supabase/errors";
import { ServiceError } from "../configuracoes/services/types";
import { registros, rpc } from "./solicitacoes";

// Integração SIENGE (migration 20261017150000, Edge Function imobdesk-sf-sienge):
// Configurações › Integrações › SIENGE e o botão "Lançamento no SIENGE" da conferência.

export interface ConfigSienge {
  ativo: boolean;
  ambiente: "homologacao" | "producao";
  subdominio: string | null;
  usuario: string | null;
  senhaDefinida: boolean;
  senhaDefinidaEm: string | null;
  empresaId: number | null;
  tipoDocumento: string | null;
  indexadorId: number | null;
  planoReembolso: string | null;
  planoFundoFixo: string | null;
  planoAdiantamento: string | null;
  centroCustoPadrao: number | null;
  ultimoTeste: { ok: boolean; em: string; passos: { passo: string; ok: boolean; detalhe: string }[] } | null;
  atualizadoEm: string;
}

export type SalvarSienge = Omit<ConfigSienge, "senhaDefinida" | "senhaDefinidaEm" | "ultimoTeste" | "atualizadoEm">;

export interface ListasSienge {
  centrosCusto: { id: number; nome: string }[];
  planos: { id: string; nome: string }[];
  documentos: { id: string; nome: string }[];
  padroes: { planoReembolso: string | null; planoFundoFixo: string | null; planoAdiantamento: string | null; centroCustoPadrao: number | null };
}

export interface SituacaoSienge {
  titulo: string | null;
  status: "lancando" | "erro" | null;
  erro: string | null;
  credorId: number | null;
  centroCusto: number | null;
  plano: string | null;
  configurada: boolean;
  ambiente: "homologacao" | "producao";
}

export interface SiengeService {
  config(): Promise<ConfigSienge>;
  salvar(p: SalvarSienge): Promise<void>;
  salvarSenha(senha: string): Promise<void>;
  testar(): Promise<{ ok: boolean; passos: { passo: string; ok: boolean; detalhe: string }[] }>;
  listas(): Promise<ListasSienge>;
  situacao(id: number): Promise<SituacaoSienge>;
  lancar(p: { solicitacaoId: number; centroCustoId: number; plano: string; vencimento: string; obraId?: number | null; unidadeId?: number | null }): Promise<{ titulo: number; jaExistia: boolean; avisos: string[] }>;
  pdf(id: number): Promise<Blob>;
}

async function funcao<T>(corpo: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(edgeFunction("sf-sienge"), { body: corpo });
  if (error) throw await fromFunction(error);
  return data as T;
}

const supabaseSienge: SiengeService = {
  config: () => rpc<ConfigSienge>("sf_sienge_config_ler"),
  salvar: (p) => rpc<void>("sf_sienge_config_salvar", { p: p as unknown as Json }),
  salvarSenha: (senha) => rpc<void>("sf_sienge_senha_salvar", { p_senha: senha }),
  testar: () => funcao({ acao: "testar" }),
  listas: () => funcao({ acao: "listas" }),
  situacao: (id) => rpc<SituacaoSienge>("sf_sienge_situacao", { p_id: id }),
  lancar: (p) => funcao({ acao: "lancar", ...p }),
  pdf: async (id) => {
    const r = await funcao<Blob | ArrayBuffer>({ acao: "pdf", solicitacaoId: id });
    return r instanceof Blob ? r : new Blob([r], { type: "application/pdf" });
  },
};

// ---------- Modo simulado ----------
/** Configuração do modo simulado (a demonstração liga a integração em homologação). */
export const cfg: ConfigSienge = {
  ativo: false, ambiente: "homologacao", subdominio: null, usuario: null, senhaDefinida: false, senhaDefinidaEm: null, empresaId: null, tipoDocumento: null,
  indexadorId: null, planoReembolso: null, planoFundoFixo: null, planoAdiantamento: null, centroCustoPadrao: null, ultimoTeste: null, atualizadoEm: new Date().toISOString(),
};
export const titulos = new Map<number, string>();
const mockSienge: SiengeService = {
  async config() {
    await delay();
    return structuredClone(cfg);
  },
  async salvar(p) {
    await delay();
    if (p.ativo && !cfg.senhaDefinida) throw new ServiceError("INVALID_INPUT", "Para ativar, salve a senha da API.", "ativo");
    Object.assign(cfg, p, { atualizadoEm: new Date().toISOString() });
  },
  async salvarSenha() {
    await delay();
    Object.assign(cfg, { senhaDefinida: true, senhaDefinidaEm: new Date().toISOString() });
  },
  async testar() {
    await delay();
    const passos = ["Centros de custo", "Credores", "Planos financeiros"].map((passo) => ({ passo, ok: true, detalhe: "modo simulado" }));
    cfg.ultimoTeste = { ok: true, em: new Date().toISOString(), passos };
    return { ok: true, passos };
  },
  async listas() {
    await delay();
    return {
      centrosCusto: [{ id: 114, nome: "SEDE ADMINISTRATIVA" }, { id: 120, nome: "OBRA - ARTE WAVE" }, { id: 121, nome: "OBRA - ARTE JARDIM" }],
      planos: [{ id: "2010101", nome: "Reembolso de despesas" }, { id: "2010102", nome: "Fundo fixo" }, { id: "2010103", nome: "Adiantamento a fornecedor" }],
      documentos: [{ id: "AV", nome: "Aviso de débito" }],
      padroes: { planoReembolso: cfg.planoReembolso, planoFundoFixo: cfg.planoFundoFixo, planoAdiantamento: cfg.planoAdiantamento, centroCustoPadrao: cfg.centroCustoPadrao },
    };
  },
  async situacao(id) {
    await delay();
    return { titulo: titulos.get(id) ?? null, status: null, erro: null, credorId: null, centroCusto: null, plano: null, configurada: cfg.ativo, ambiente: cfg.ambiente };
  },
  async lancar(p) {
    await delay();
    const d = registros.get(p.solicitacaoId);
    if (!d) throw new ServiceError("NOT_FOUND", "Solicitação não encontrada.");
    const titulo = 9000 + p.solicitacaoId;
    titulos.set(p.solicitacaoId, String(titulo));
    d.status = "lancamento_gerado";
    return { titulo, jaExistia: false, avisos: [] };
  },
  async pdf() {
    throw new ServiceError("INVALID_INPUT", "O PDF do servidor não existe no modo simulado. Use Imprimir.");
  },
};

export const siengeService: SiengeService = DATA_SOURCE === "mock" ? mockSienge : supabaseSienge;
