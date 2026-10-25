import { edgeFunction } from "../../../config/app";
import type { Json } from "../../../lib/database.types";
import { supabase } from "../../../lib/supabase";
import { DATA_SOURCE } from "../../configuracoes/services";
import { fromFunction, fromPostgrest } from "../../configuracoes/services/supabase/errors";
import { ServiceError } from "../../configuracoes/services/types";

// WhatsApp OpenWA (opção A: privado com o número do sistema + grupo interno de atendentes), resumo da IA no
// encerramento e a métrica "Quem mais abre chamados". Regras no banco (RPCs at_openwa_*, at_linhas_*); o que
// fala com o OpenWA passa pela Edge imobdesk-whatsapp (a API key nunca chega ao navegador).

export interface NumeroWhatsapp {
  id: number;
  numero: string;
  canal: "zenvia" | "openwa";
  sessao: string | null;
  grupo: string | null;
  grupoNome: string | null;
}

export interface SetorWhatsapp {
  id: number;
  nome: string;
  waIdentificar: boolean;
  waSoCorporativo: boolean;
  /** Respostas automáticas (boas-vindas, identificação, encerramento) nos números OpenWA do setor. */
  waRespostasAuto: boolean;
  /** Depois de identificar, pede a descrição do problema e o print quando a 1ª mensagem não explicou. */
  waPedirDescricao: boolean;
  msgNaoCorporativo: string;
  gestor: boolean;
  numeros: NumeroWhatsapp[];
  atendentes: { usuarioId: string; nome: string; whatsapp: string | null }[];
}

export interface VerificacaoOpenwa {
  em: string;
  ok: boolean;
  erro: string | null;
  sessoes: { id: string; nome: string | null; status: string | null; telefone: string | null }[];
}

export interface PainelOpenwa {
  superAdmin: boolean;
  /** Administrador ou Super admin: liga/desliga o recurso. */
  podeLigar: boolean;
  supervisor: boolean;
  conexao: {
    url: string | null;
    chaveMascara: string | null;
    definidoEm: string | null;
    verificacao: VerificacaoOpenwa | null;
    autoLigado: boolean;
    travaPiloto: boolean;
    dominios: string[];
    /** Chave geral: desligado, o OpenWA não recebe nem envia nada (a Zenvia e o e-mail seguem). */
    ligado: boolean;
  };
  setores: SetorWhatsapp[];
  linhas: number;
}

export interface Linha {
  numero: string;
  corporativa: boolean;
  confirmadoEm: string | null;
  observacao: string | null;
  pessoaId: number | null;
  pessoa: string | null;
  email: string | null;
}

export interface LinhaImportar {
  numero: string;
  nome?: string;
  email?: string;
  observacao?: string;
}

export interface MembroGrupo {
  id: string;
  numero: string;
  nome: string | null;
  admin: boolean;
}

export interface TopSolicitantes {
  periodoDias: number;
  total: number;
  whatsapp: number;
  resolvidosNaConversa: number | null;
  identificados: number | null;
  top: { pessoaId: number; nome: string; tickets: number; servico: string | null }[];
  departamentos: { nome: string; tickets: number }[];
}

export interface OpenwaService {
  painel(): Promise<PainelOpenwa>;
  salvarConexao(p: { url: string; chave?: string }): Promise<void>;
  ligar(ligado: boolean): Promise<{ ligado: boolean; canceladas: number }>;
  /** Há WhatsApp em uso (OpenWA ligado com número, ou número Zenvia)? Sem isso, Conversas e Monitor somem. */
  whatsappDisponivel(): Promise<boolean>;
  salvarNumero(p: { numeroId: number; canal: "zenvia" | "openwa"; sessao: string | null; grupo: string | null; grupoNome: string | null }): Promise<void>;
  salvarSetor(p: { setorId: number; waIdentificar: boolean; waSoCorporativo: boolean; waRespostasAuto: boolean; waPedirDescricao: boolean; msgNaoCorporativo: string }): Promise<void>;
  salvarWhatsappAtendente(p: { usuarioId: string; whatsapp: string }): Promise<void>;
  linhas(busca: string): Promise<Linha[]>;
  importarLinhas(linhas: LinhaImportar[]): Promise<{ salvas: number; invalidas: string[] }>;
  removerLinha(numero: string): Promise<void>;
  testar(): Promise<VerificacaoOpenwa>;
  criarSessao(nome: string): Promise<{ id: string }>;
  iniciarSessao(sessao: string): Promise<void>;
  qr(sessao: string): Promise<{ qr: string | null; erro: string | null }>;
  status(sessao: string): Promise<{ status?: string; phone?: string | null }>;
  grupos(sessao: string): Promise<{ id: string; name: string }[]>;
  membros(sessao: string, grupo: string): Promise<MembroGrupo[]>;
  webhook(sessao: string): Promise<{ criado: boolean; url: string }>;
  criarGrupo(numeroId: number): Promise<{ grupo: string; nome: string; participantes: number }>;
  adicionarAtendentes(numeroId: number): Promise<{ adicionados: number; jaEstavam: number; falhas: { numero: string; motivo: string }[] }>;
  resumir(ticketId: number): Promise<{ solucao: string; resolvido: boolean }>;
  topSolicitantes(dias: number): Promise<TopSolicitantes>;
}

async function rpc<T>(nome: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(nome as never, args as never);
  if (error) throw fromPostgrest(error);
  return data as T;
}

async function funcao<T>(nome: "whatsapp" | "ia", corpo: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(edgeFunction(nome), { body: corpo });
  if (error) throw await fromFunction(error);
  return data as T;
}

const supabaseOpenwa: OpenwaService = {
  painel: () => rpc<PainelOpenwa>("at_openwa_painel"),
  salvarConexao: (p) => rpc<void>("at_openwa_salvar", { p: p as unknown as Json }),
  ligar: (ligado) => rpc<{ ligado: boolean; canceladas: number }>("at_openwa_ligar", { p_ligado: ligado }),
  whatsappDisponivel: () => rpc<boolean>("at_whatsapp_disponivel"),
  salvarNumero: (p) => rpc<void>("at_openwa_numero_salvar", { p: p as unknown as Json }),
  salvarSetor: (p) => rpc<void>("at_setor_whatsapp_salvar", { p: p as unknown as Json }),
  salvarWhatsappAtendente: (p) => rpc<void>("at_atendente_whatsapp_salvar", { p: p as unknown as Json }),
  linhas: (busca) => rpc<Linha[]>("at_linhas_lista", { p_busca: busca }),
  importarLinhas: (linhas) => rpc<{ salvas: number; invalidas: string[] }>("at_linhas_importar", { p: linhas as unknown as Json }),
  removerLinha: (numero) => rpc<void>("at_linha_remover", { p_numero: numero }),
  testar: () => funcao<VerificacaoOpenwa>("whatsapp", { acao: "openwa_testar" }),
  criarSessao: (nome) => funcao<{ id: string }>("whatsapp", { acao: "openwa_criar_sessao", nome }),
  async iniciarSessao(sessao) {
    await funcao("whatsapp", { acao: "openwa_iniciar", sessao });
  },
  qr: (sessao) => funcao<{ qr: string | null; erro: string | null }>("whatsapp", { acao: "openwa_qr", sessao }),
  status: (sessao) => funcao<{ status?: string; phone?: string | null }>("whatsapp", { acao: "openwa_status", sessao }),
  grupos: (sessao) => funcao<{ id: string; name: string }[]>("whatsapp", { acao: "openwa_grupos", sessao }),
  membros: (sessao, grupo) => funcao<MembroGrupo[]>("whatsapp", { acao: "openwa_membros", sessao, grupo }),
  webhook: (sessao) => funcao<{ criado: boolean; url: string }>("whatsapp", { acao: "openwa_webhook", sessao }),
  criarGrupo: (numeroId) => funcao<{ grupo: string; nome: string; participantes: number }>("whatsapp", { acao: "openwa_criar_grupo", numeroId }),
  adicionarAtendentes: (numeroId) => funcao<{ adicionados: number; jaEstavam: number; falhas: { numero: string; motivo: string }[] }>("whatsapp", { acao: "openwa_adicionar_atendentes", numeroId }),
  resumir: (ticketId) => funcao<{ solucao: string; resolvido: boolean }>("ia", { acao: "resumir", ticketId }),
  topSolicitantes: (dias) => rpc<TopSolicitantes>("ch_top_solicitantes", { p_dias: dias }),
};

// ---------- Modo simulado (sem .env.local): dados de exemplo, nada sai do navegador ----------

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));
const semOpenwa = () => new ServiceError("INTEGRATION_NOT_CONFIGURED", "Modo simulado: o OpenWA só responde com o Supabase configurado.");

const mockPainel: PainelOpenwa = {
  superAdmin: true,
  podeLigar: true,
  supervisor: true,
  conexao: { url: null, chaveMascara: null, definidoEm: null, verificacao: null, autoLigado: false, travaPiloto: true, dominios: ["exemplo.com.br"], ligado: true },
  setores: [
    {
      id: 1,
      nome: "TI",
      waIdentificar: true,
      waSoCorporativo: true,
      waRespostasAuto: true,
      waPedirDescricao: true,
      msgNaoCorporativo: "Este canal atende apenas linhas corporativas da empresa. Envie sua solicitação por e-mail.",
      gestor: true,
      numeros: [{ id: 1, numero: "5521900000001", canal: "openwa", sessao: null, grupo: null, grupoNome: null }],
      atendentes: [{ usuarioId: "u1", nome: "Wagner Antunes", whatsapp: "5521977770000" }],
    },
  ],
  linhas: 1,
};
let mockLinhas: Linha[] = [
  { numero: "5521996453552", corporativa: true, confirmadoEm: new Date().toISOString(), observacao: null, pessoaId: 1, pessoa: "Vinicius Carvalho", email: "vinicius.carvalho@exemplo.com.br" },
];

const mockOpenwa: OpenwaService = {
  async painel() {
    await esperar(120);
    return structuredClone({ ...mockPainel, linhas: mockLinhas.length });
  },
  async whatsappDisponivel() {
    return mockPainel.conexao.ligado;
  },
  async ligar(ligado) {
    await esperar(120);
    mockPainel.conexao.ligado = ligado;
    return { ligado, canceladas: 0 };
  },
  async salvarConexao(p) {
    await esperar(120);
    mockPainel.conexao.url = p.url;
    if (p.chave) mockPainel.conexao.chaveMascara = `••••••••${p.chave.slice(-4)}`;
  },
  async salvarNumero(p) {
    await esperar(120);
    for (const s of mockPainel.setores) for (const n of s.numeros) if (n.id === p.numeroId) Object.assign(n, p);
  },
  async salvarSetor(p) {
    await esperar(120);
    const s = mockPainel.setores.find((x) => x.id === p.setorId);
    if (s) Object.assign(s, p);
  },
  async salvarWhatsappAtendente(p) {
    await esperar(120);
    for (const s of mockPainel.setores) for (const a of s.atendentes) if (a.usuarioId === p.usuarioId) a.whatsapp = p.whatsapp.replace(/\D/g, "") || null;
  },
  async linhas(busca) {
    await esperar(120);
    const q = busca.trim().toLowerCase();
    return mockLinhas.filter((l) => !q || l.numero.includes(q.replace(/\D/g, "") || "§") || (l.pessoa ?? "").toLowerCase().includes(q));
  },
  async importarLinhas(linhas) {
    await esperar(200);
    const invalidas: string[] = [];
    let salvas = 0;
    for (const l of linhas) {
      let d = l.numero.replace(/\D/g, "");
      if (d.length === 10 || d.length === 11) d = `55${d}`;
      if (!/^\d{10,15}$/.test(d)) {
        invalidas.push(l.numero);
        continue;
      }
      mockLinhas = [...mockLinhas.filter((x) => x.numero !== d), { numero: d, corporativa: true, confirmadoEm: null, observacao: l.observacao ?? null, pessoaId: null, pessoa: l.nome ?? null, email: l.email ?? null }];
      salvas += 1;
    }
    return { salvas, invalidas };
  },
  async removerLinha(numero) {
    await esperar(120);
    mockLinhas = mockLinhas.filter((l) => l.numero !== numero);
  },
  testar: async () => Promise.reject(semOpenwa()),
  criarSessao: async () => Promise.reject(semOpenwa()),
  iniciarSessao: async () => Promise.reject(semOpenwa()),
  qr: async () => Promise.reject(semOpenwa()),
  status: async () => Promise.reject(semOpenwa()),
  grupos: async () => Promise.reject(semOpenwa()),
  membros: async () => Promise.reject(semOpenwa()),
  webhook: async () => Promise.reject(semOpenwa()),
  criarGrupo: async () => Promise.reject(semOpenwa()),
  adicionarAtendentes: async () => Promise.reject(semOpenwa()),
  async resumir() {
    await esperar(400);
    return { solucao: "Impressora com papel atolado; fila de impressão limpa remotamente e impressão normalizada.", resolvido: true };
  },
  async topSolicitantes(dias) {
    await esperar(150);
    return {
      periodoDias: dias,
      total: 184,
      whatsapp: 97,
      resolvidosNaConversa: 71,
      identificados: 96,
      top: [
        { pessoaId: 1, nome: "Vinicius Carvalho", tickets: 12, servico: "Sistema PVI" },
        { pessoaId: 2, nome: "Ana Ribeiro", tickets: 9, servico: "Impressoras" },
        { pessoaId: 3, nome: "Marcos Lima", tickets: 7, servico: "Acesso VPN" },
      ],
      departamentos: [
        { nome: "Financeiro", tickets: 41 },
        { nome: "Comercial", tickets: 33 },
      ],
    };
  },
};

export const openwaService: OpenwaService = DATA_SOURCE === "mock" ? mockOpenwa : supabaseOpenwa;
