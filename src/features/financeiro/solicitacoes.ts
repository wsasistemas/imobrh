import type { Json } from "../../lib/database.types";
import { supabase } from "../../lib/supabase";
import { DATA_SOURCE } from "../configuracoes/services";
import { currentActor, delay } from "../configuracoes/services/mock/runtime";
import { DIRETOR, GESTOR_DO_SETOR, nomeDoSetor, SETOR_DO_USUARIO, SETORES_PRODUCAO } from "../atendimento/services/setoresProducao";
import { fromFunction, fromPostgrest } from "../configuracoes/services/supabase/errors";
import { edgeFunction } from "../../config/app";
import { ServiceError } from "../configuracoes/services/types";
import type { StatusSolicitacao } from "./components/StatusChip";

// Solicitações Financeiras, Fase 2 (migration 20261017110000): rascunho, linhas, anexos com SHA-256 no bucket
// imobdesk-sf-comprovantes (<usuário>/<solicitação>/<arquivo>), checagens antes de enviar, envio e cancelamento.

export type TipoSolicitacao = "reembolso" | "fundo_fixo" | "adiantamento";
export const BUCKET = "imobdesk-sf-comprovantes";
export const TAMANHO_MAXIMO = 10 * 1024 * 1024;
export const TIPOS_ACEITOS = ["image/jpeg", "image/png", "image/heic", "image/heif", "image/webp", "application/pdf"];

export interface LinhaLista {
  id: number;
  numero: string;
  tipo: TipoSolicitacao;
  status: StatusSolicitacao;
  competencia: string | null;
  vencimento: string | null;
  valor: number;
  pagarAte: string | null;
  atualizadoEm: string;
  etapa: { papel: string; nivel: number; de: number } | null;
}

export interface Minhas {
  kpis: { rascunho: number; emAprovacao: number; devolvida: number; noFinanceiro: number; aComprovar: number; pagasMes: number; pagasMesValor: number };
  temFundoFixo: boolean;
  temSetor: boolean;
  lista: LinhaLista[];
}

export interface Anexo {
  id: number;
  nome: string;
  path: string;
  mime: string;
  tamanho: number;
}

export interface Item {
  id: number;
  ordem: number;
  data: string | null;
  valor: number | null;
  descricao: string | null;
  motivo: string | null;
  categoriaId: number | null;
  origem: "manual" | "ocr_confirmado" | "ocr_editado";
  statusConferencia: "pendente" | "aceito" | "ajuste" | "glosado";
  anexos: Anexo[];
}

export interface EtapaPrevista {
  nivel: number;
  papel: string;
  exigido: boolean;
  pulado: boolean;
  motivo: string;
  aprovador: string | null;
  substituto: string | null;
}

export interface Aprovacao {
  ciclo: number;
  nivel: number;
  papel: string;
  status: "pendente" | "aguardando" | "aprovado" | "devolvido" | "reprovado" | "pulado" | "nao_exigido";
  comentario: string | null;
  aprovador: string | null;
  substituto: string | null;
  prazoEm: string | null;
  decididoEm: string | null;
}

export interface Evento {
  tipo: string;
  em: string;
  ator: string | null;
  payload: Record<string, unknown>;
}

export interface Detalhe {
  id: number;
  numero: string;
  tipo: TipoSolicitacao;
  status: StatusSolicitacao;
  ciclo: number;
  podeEditar: boolean;
  podeCancelar: boolean;
  solicitante: { id: string; nome: string; cpfMascarado: string | null };
  setor: { id: number; nome: string } | null;
  competencia: string | null;
  periodoDe: string | null;
  periodoAte: string | null;
  centroCusto: string | null;
  valorFundoFixo: number | null;
  saldoInicial: number | null;
  totalDespesas: number;
  saldoFinal: number | null;
  valorGlosado: number;
  valorAPagar: number | null;
  pagarAte: string | null;
  enviadoEm: string | null;
  aceiteEm: string | null;
  criadoEm: string;
  atualizadoEm: string;
  itens: Item[];
  aprovacoes: Aprovacao[];
  eventos: Evento[];
  cadeiaPrevista: EtapaPrevista[] | null;
  categorias: { id: number; nome: string }[];
  /** Fase 5B: só no adiantamento. */
  adiantamento?: DadosAdiantamento;
}

// ---------- Fase 5B: adiantamento de numerário (migration 20261017160000) ----------

export type FormaPagamento = "deposito" | "boleto" | "cheque" | "dinheiro";

export interface ArquivoLido {
  id: number;
  nome: string;
  path: string;
  mime: string;
  status: "fila" | "lendo" | "lido" | "ilegivel" | "erro";
  ocr: LeituraOcr | null;
  enviado?: boolean;
}

export interface Comprovacao {
  id: number;
  anexoId: number | null;
  tipoDocumento: LeituraOcr["tipo_documento"] | null;
  emitente: string | null;
  emitenteDoc: string | null;
  emissao: string | null;
  valor: number;
  numero: string | null;
  referencia: string | null;
  saldoPagar: number;
  saldoDevolver: number;
  status: "enviada" | "aceita" | "devolucao" | "ajuste";
  obs: string | null;
  conferidaEm: string | null;
  criadoEm: string;
}

export interface DadosAdiantamento {
  obra: string | null;
  contaCaixa: string | null;
  contaPagamento: string | null;
  centroCusto: string | null;
  centroApuracao: string | null;
  valor: number | null;
  favorecido: string | null;
  favorecidoDoc: string | null;
  finalidade: string | null;
  formaPagamento: FormaPagamento | null;
  banco: string | null;
  agencia: string | null;
  conta: string | null;
  tipoConta: "corrente" | "poupanca" | null;
  vencimento: string | null;
  prazoComprovacao: string | null;
  dataPreenchimento: string | null;
  pedidoNumero: string | null;
  pedidoData: string | null;
  pedidoFornecedor: string | null;
  pedidoFornecedorDoc: string | null;
  pedidoValor: number | null;
  pedidoPercentual: number | null;
  pedidoCondicao: string | null;
  statusComprovacao: "pendente" | "enviada" | "aceita" | "devolucao" | "vencida" | null;
  pagoEm: string | null;
  siengeSaldoId: string | null;
  siengeSaldoErro: string | null;
  prazoDias: number;
  setorObra: boolean;
  ehSolicitante: boolean;
  rateio: { id: number; tarefa: string; porcentagem: number; valor: number }[];
  documentos: ArquivoLido[];
  arquivosComprovacao: ArquivoLido[];
  comprovacoes: Comprovacao[];
  checagensComprovacao: { codigo: string; resultado: "ok" | "alerta" | "bloqueio"; detalhe: string }[];
  obras: string[] | null;
}

export interface Checagem {
  codigo: string;
  itemId: number | null;
  resultado: "ok" | "alerta" | "bloqueio";
  detalhe: string;
}

export interface LinhaEdicao {
  /** Chave da tela (id gravado ou provisória "n1", "n2"…). */
  chave: string;
  id?: number;
  data: string | null;
  valor: number | null;
  descricao: string | null;
  motivo: string | null;
  categoriaId: number | null;
}

export interface SalvarRascunho {
  id: number;
  competencia: string | null;
  periodoDe: string | null;
  periodoAte: string | null;
  centroCusto: string | null;
  itens: LinhaEdicao[];
  /** Ids de linhas que a tela já conhecia: só estas podem ser apagadas por omissão. */
  conhecidos?: number[];
}

export interface SolicitacoesService {
  minhas(): Promise<Minhas>;
  criar(tipo: TipoSolicitacao): Promise<number>;
  detalhe(id: number): Promise<Detalhe>;
  salvar(p: SalvarRascunho): Promise<{ itens: { chave: string; id: number }[] }>;
  anexar(p: { solicitacaoId: number; solicitanteId: string; itemId: number; arquivo: File }): Promise<{ id: number; duplicadoEm: string | null }>;
  removerAnexo(id: number): Promise<void>;
  urlAnexo(path: string): Promise<string>;
  checagens(id: number): Promise<Checagem[]>;
  enviar(id: number): Promise<{ status: string; alertas: number }>;
  cancelar(id: number): Promise<void>;
}

/** SHA-256 do arquivo (R06: o mesmo comprovante não pode ser usado duas vezes). */
export async function sha256(arquivo: Blob): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", await arquivo.arrayBuffer());
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function validarArquivo(arquivo: File): ServiceError | null {
  if (!TIPOS_ACEITOS.includes(arquivo.type)) return new ServiceError("INVALID_INPUT", "Envie JPG, PNG, HEIC ou PDF.");
  if (arquivo.size > TAMANHO_MAXIMO) return new ServiceError("INVALID_INPUT", "O arquivo precisa ter até 10 MB.");
  return null;
}

export async function rpc<T>(nome: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(nome as never, args as never);
  if (error) throw fromPostgrest(error);
  return data as T;
}

const num = (v: unknown) => (v == null ? null : Number(v));

function normalizarAdiantamento(a: DadosAdiantamento): DadosAdiantamento {
  return {
    ...a, valor: num(a.valor), pedidoValor: num(a.pedidoValor), pedidoPercentual: num(a.pedidoPercentual),
    rateio: a.rateio.map((r) => ({ ...r, porcentagem: Number(r.porcentagem), valor: Number(r.valor) })),
    comprovacoes: a.comprovacoes.map((c) => ({ ...c, valor: Number(c.valor), saldoPagar: Number(c.saldoPagar), saldoDevolver: Number(c.saldoDevolver) })),
  };
}

function normalizar(d: Detalhe): Detalhe {
  return {
    ...d,
    adiantamento: d.adiantamento ? normalizarAdiantamento(d.adiantamento) : undefined,
    valorFundoFixo: num(d.valorFundoFixo), saldoInicial: num(d.saldoInicial), totalDespesas: Number(d.totalDespesas), saldoFinal: num(d.saldoFinal),
    valorGlosado: Number(d.valorGlosado), valorAPagar: num(d.valorAPagar),
    itens: d.itens.map((i) => ({ ...i, valor: num(i.valor) })),
  };
}

const supabaseSolicitacoes: SolicitacoesService = {
  minhas: async () => {
    const m = await rpc<Minhas>("sf_minhas");
    return { ...m, kpis: { ...m.kpis, pagasMesValor: Number(m.kpis.pagasMesValor) }, lista: m.lista.map((l) => ({ ...l, valor: Number(l.valor) })) };
  },
  criar: (tipo) => rpc<number>("sf_rascunho_criar", { p_tipo: tipo }).then(Number),
  detalhe: async (id) => normalizar(await rpc<Detalhe>("sf_detalhe", { p_id: id })),
  salvar: (p) => rpc("sf_rascunho_salvar", { p: p as unknown as Json }),
  async anexar({ solicitacaoId, solicitanteId, itemId, arquivo }) {
    const invalido = validarArquivo(arquivo);
    if (invalido) throw invalido;
    const hash = await sha256(arquivo);
    const ext = (arquivo.name.split(".").pop() ?? "bin").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5) || "bin";
    const path = `${solicitanteId}/${solicitacaoId}/${hash.slice(0, 16)}-${Date.now()}.${ext}`;
    const { error } = await supabase.storage.from(BUCKET).upload(path, arquivo, { contentType: arquivo.type, upsert: false });
    if (error) throw new ServiceError("INVALID_INPUT", "Não foi possível enviar o arquivo. Tente de novo.");
    try {
      return await rpc("sf_anexo_registrar", {
        p: { solicitacaoId, itemId, path, nome: arquivo.name, mime: arquivo.type, tamanho: arquivo.size, sha256: hash } as unknown as Json,
      });
    } catch (e) {
      await supabase.storage.from(BUCKET).remove([path]);
      throw e;
    }
  },
  async removerAnexo(id) {
    const path = await rpc<string>("sf_anexo_remover", { p_id: id });
    await supabase.storage.from(BUCKET).remove([path]);
  },
  async urlAnexo(path) {
    // URL assinada de 5 minutos (CONTEXTO.md, seção 6).
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 300);
    if (error || !data) throw new ServiceError("NOT_FOUND", "Não foi possível abrir o arquivo.");
    return data.signedUrl;
  },
  checagens: (id) => rpc<Checagem[]>("sf_checagens", { p_id: id }),
  enviar: (id) => rpc("sf_enviar", { p_id: id, p_aceite: true }),
  cancelar: (id) => rpc<void>("sf_cancelar", { p_id: id }),
};

// ---------- Modo simulado ----------
/** Registros do modo simulado (também usados pela conferência simulada). */
export const registros = new Map<number, Detalhe>();
/** Leitura de cada anexo no modo simulado (Declarado × comprovante da conferência). */
export const ocrMock = new Map<number, LeituraOcr>();
/** Regras por item e as gravadas no envio, no modo simulado. */
export const regrasItemMock = new Map<number, { codigo: string; resultado: "ok" | "alerta" | "bloqueio"; detalhe: string }[]>();
export const regrasEnvioMock = new Map<number, DetalheExtra["regras"]>();
/** Próximo número e id do modo simulado (a demonstração começa depois dos dela). */
export const contadorMock = { solicitacao: 1, item: 1 };
/** Arquivos do modo simulado (também usados pelo adiantamento simulado). */
export const arquivos = new Map<string, Blob>();

function exigirEditavel(id: number): Detalhe {
  const d = registros.get(id);
  if (!d) throw new ServiceError("NOT_FOUND", "Solicitação não encontrada.");
  if (!["rascunho", "devolvida"].includes(d.status)) throw new ServiceError("INVALID_INPUT", "Esta solicitação não pode mais ser alterada.");
  return d;
}

/** Setor e gestor de quem está logado no modo simulado (os setores da produção; TI quando não há cadastro). */
function setorMock(): number {
  try {
    return SETOR_DO_USUARIO[currentActor().id] ?? 20;
  } catch {
    return 20;
  }
}
const gestorMock = () => GESTOR_DO_SETOR[setorMock()] ?? GESTOR_DO_SETOR[20];

/** Adiantamento novo no modo simulado. */
function adiantamentoVazio(hoje: string): DadosAdiantamento {
  return {
    obra: "Obra - Arte Wave", contaCaixa: null, contaPagamento: null, centroCusto: "00.00114", centroApuracao: null, valor: null, favorecido: null, favorecidoDoc: null,
    finalidade: null, formaPagamento: "deposito", banco: null, agencia: null, conta: null, tipoConta: "corrente", vencimento: null, prazoComprovacao: null,
    dataPreenchimento: hoje, pedidoNumero: null, pedidoData: null, pedidoFornecedor: null, pedidoFornecedorDoc: null, pedidoValor: null, pedidoPercentual: null,
    pedidoCondicao: null, statusComprovacao: null, pagoEm: null, siengeSaldoId: null, siengeSaldoErro: null, prazoDias: 30, setorObra: false, ehSolicitante: true, rateio: [],
    documentos: [], arquivosComprovacao: [], comprovacoes: [], checagensComprovacao: [], obras: SETORES_PRODUCAO.filter((s) => s.obra).map((s) => s.nome),
  };
}

/** Cadeia do adiantamento no modo simulado (mesma regra do banco: planejamento em obra, gerente sempre, diretor e presidente acima da alçada). */
export function cadeiaAdiantamentoMock(valor: number): EtapaPrevista[] {
  return [
    { nivel: 1, papel: "Planejamento", exigido: false, pulado: false, motivo: "não exigido: o setor não é de obra", aprovador: null, substituto: null },
    { nivel: 2, papel: "Gerente", exigido: true, pulado: false, motivo: "sempre", aprovador: gestorMock().nome, substituto: gestorMock().substituto },
    { nivel: 3, papel: "Diretor", exigido: valor > 5000, pulado: false, motivo: valor > 5000 ? "acima da alçada" : "não exigido para este valor", aprovador: DIRETOR.nome, substituto: null },
    { nivel: 4, papel: "Presidente", exigido: valor > 20000, pulado: false, motivo: valor > 20000 ? "acima da alçada" : "não exigido para este valor", aprovador: null, substituto: null },
  ];
}

function recalcular(d: Detalhe) {
  if (d.tipo === "adiantamento") {
    d.totalDespesas = d.adiantamento?.valor ?? 0;
    d.valorAPagar = d.totalDespesas - d.valorGlosado;
    d.atualizadoEm = new Date().toISOString();
    d.cadeiaPrevista = cadeiaAdiantamentoMock(d.totalDespesas);
    return;
  }
  d.totalDespesas = d.itens.reduce((s, i) => s + (i.valor ?? 0), 0);
  d.valorAPagar = d.totalDespesas - d.valorGlosado;
  if (d.tipo === "fundo_fixo") d.saldoFinal = (d.saldoInicial ?? 0) - d.totalDespesas;
  d.atualizadoEm = new Date().toISOString();
  d.cadeiaPrevista = [
    { nivel: 1, papel: "Gestor", exigido: true, pulado: false, motivo: "sempre", aprovador: gestorMock().nome, substituto: gestorMock().substituto },
  ];
}

/** A01–A06 no modo simulado (sem A06 de outros registros). */
export function checarAdiantamentoMock(d: Detalhe): Checagem[] {
  const a = d.adiantamento!;
  const lim = a.pedidoValor != null && a.pedidoPercentual != null ? Math.round(a.pedidoValor * a.pedidoPercentual) / 100 : null;
  const soma = Math.round(a.rateio.reduce((s, r) => s + r.porcentagem, 0) * 100) / 100;
  const br = (v: number) => v.toFixed(2).replace(".", ",").replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return [
    { codigo: "A01", itemId: null, resultado: a.documentos.length ? "ok" : "bloqueio", detalhe: a.documentos.length ? `${a.documentos.length} documento(s) anexado(s)` : "Anexe o pedido de compras, a proposta ou o e-mail" },
    { codigo: "A02", itemId: null, resultado: lim != null && a.valor != null && a.valor <= lim ? "ok" : "alerta",
      detalhe: lim != null && a.valor != null ? `${br(a.valor)} ${a.valor === lim ? "=" : a.valor < lim ? "≤" : ">"} ${br(a.pedidoValor!)} × ${String(a.pedidoPercentual).replace(".", ",")}%` : "Informe o valor do pedido e o percentual da condição" },
    { codigo: "A03", itemId: null, resultado: a.favorecidoDoc && a.favorecidoDoc === a.pedidoFornecedorDoc ? "ok" : "alerta",
      detalhe: !a.pedidoFornecedorDoc ? "CNPJ do fornecedor do pedido não informado" : a.favorecidoDoc === a.pedidoFornecedorDoc ? "CNPJ igual ao do fornecedor" : "CPF/CNPJ do favorecido diferente do fornecedor do pedido" },
    { codigo: "A05", itemId: null, resultado: a.rateio.length && soma === 100 ? "ok" : "bloqueio", detalhe: a.rateio.length ? `Soma ${String(soma).replace(".", ",")}%` : "Inclua ao menos uma tarefa" },
    { codigo: "A06", itemId: null, resultado: "ok", detalhe: "Pedido sem outro adiantamento · você tem 1 de 3" },
  ];
}

function checar(d: Detalhe): Checagem[] {
  if (d.tipo === "adiantamento") return checarAdiantamentoMock(d);
  const r: Checagem[] = d.itens
    .filter((i) => i.anexos.length === 0)
    .map((i) => ({ codigo: "R01", itemId: i.id, resultado: "bloqueio", detalhe: `Linha ${i.ordem} sem comprovante` }));
  if (d.tipo === "fundo_fixo" && d.totalDespesas > (d.saldoInicial ?? 0)) {
    r.push({ codigo: "R10", itemId: null, resultado: "bloqueio", detalhe: "Despesas acima do saldo inicial do fundo fixo" });
  }
  return r;
}

const NOMES_REGRA: Record<string, string> = {
  R01: "Comprovante anexado", R02: "Legível", R03: "Data no período", R04: "Valor confere", R05: "Documento fiscal", R06: "Sem duplicidade", R07: "Categoria permitida",
  R08: "Limite por categoria", R09: "Prazo de envio", R10: "Saldo do fundo fixo", A01: "Documento de origem", A02: "Valor × pedido", A03: "Favorecido × pedido",
  A04: "Titularidade bancária", A05: "Rateio", A06: "Adiantamento em aberto", A07: "Comprovação",
};

function etapaMock(d: Detalhe): LinhaLista["etapa"] {
  const a = d.aprovacoes.find((x) => x.ciclo === d.ciclo && x.status === "aguardando");
  if (!a) return null;
  return { papel: a.papel, nivel: a.nivel, de: d.aprovacoes.filter((x) => x.ciclo === d.ciclo && x.status !== "nao_exigido" && x.status !== "pulado").length };
}

const mockSolicitacoes: SolicitacoesService = {
  async minhas() {
    await delay();
    const eu = currentActor().id;
    const lista = [...registros.values()].filter((d) => d.status !== "cancelada" && d.solicitante.id === eu).sort((a, b) => b.atualizadoEm.localeCompare(a.atualizadoEm));
    const conta = (s: StatusSolicitacao[]) => lista.filter((d) => s.includes(d.status)).length;
    const pagas = lista.filter((d) => ["paga", "encerrada"].includes(d.status));
    return {
      kpis: {
        rascunho: conta(["rascunho"]), emAprovacao: conta(["em_aprovacao"]), devolvida: conta(["devolvida", "pendencia_solicitante"]),
        noFinanceiro: conta(["em_conferencia", "lancamento_gerado", "pagamento_programado"]), aComprovar: conta(["comprovacao_pendente"]), pagasMes: pagas.length,
        pagasMesValor: pagas.reduce((s, d) => s + (d.valorAPagar ?? d.totalDespesas), 0),
      },
      temFundoFixo: true,
      temSetor: true,
      lista: lista.map((d) => ({
        id: d.id, numero: d.numero, tipo: d.tipo, status: d.status, competencia: d.competencia, vencimento: d.adiantamento?.vencimento ?? null, valor: d.totalDespesas,
        pagarAte: d.pagarAte, atualizadoEm: d.atualizadoEm, etapa: etapaMock(d),
      })),
    };
  },
  async criar(tipo) {
    await delay();
    const id = contadorMock.solicitacao++;
    const hoje = new Date();
    const de = new Date(hoje.getFullYear(), hoje.getMonth(), 1).toISOString().slice(0, 10);
    const ate = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0).toISOString().slice(0, 10);
    const d: Detalhe = {
      id, numero: `SF-${hoje.getFullYear()}-${String(id).padStart(4, "0")}`, tipo, status: "rascunho", ciclo: 1, podeEditar: true, podeCancelar: true,
      solicitante: { id: currentActor().id, nome: currentActor().name, cpfMascarado: "***.456.789-**" }, setor: { id: setorMock(), nome: nomeDoSetor(setorMock()) ?? "—" },
      competencia: de, periodoDe: de, periodoAte: ate, centroCusto: null,
      valorFundoFixo: tipo === "fundo_fixo" ? 1000 : null, saldoInicial: tipo === "fundo_fixo" ? 1000 : null, totalDespesas: 0,
      saldoFinal: tipo === "fundo_fixo" ? 1000 : null, valorGlosado: 0, valorAPagar: 0, pagarAte: null, enviadoEm: null, aceiteEm: null,
      criadoEm: hoje.toISOString(), atualizadoEm: hoje.toISOString(), itens: [], aprovacoes: [], eventos: [{ tipo: "criada", em: hoje.toISOString(), ator: currentActor().name, payload: {} }],
      adiantamento: tipo === "adiantamento" ? adiantamentoVazio(hoje.toISOString().slice(0, 10)) : undefined,
      cadeiaPrevista: [], categorias: ["Material de obra", "Ferramentas", "EPI", "Combustível", "Transporte", "Estacionamento", "Alimentação", "Copa/mantimentos", "Material de escritório", "Outros"].map((nome, i) => ({ id: i + 1, nome })),
    };
    if (tipo === "adiantamento") Object.assign(d, { competencia: de, periodoDe: null, periodoAte: null });
    recalcular(d);
    registros.set(id, d);
    return id;
  },
  async detalhe(id) {
    await delay();
    const d = registros.get(id);
    if (!d) throw new ServiceError("NOT_FOUND", "Solicitação não encontrada.");
    return structuredClone({ ...d, podeEditar: ["rascunho", "devolvida"].includes(d.status) });
  },
  async salvar(p) {
    await delay();
    const d = exigirEditavel(p.id);
    Object.assign(d, { competencia: p.competencia, periodoDe: p.periodoDe, periodoAte: p.periodoAte, centroCusto: p.centroCusto });
    const mapa = p.itens.map((l, i) => {
      const atual = d.itens.find((x) => x.id === l.id);
      const item: Item = { ...(atual ?? { anexos: [], origem: "manual", statusConferencia: "pendente" }), id: atual?.id ?? contadorMock.item++, ordem: i + 1,
        data: l.data, valor: l.valor, descricao: l.descricao, motivo: l.motivo, categoriaId: l.categoriaId } as Item;
      return item;
    });
    d.itens = mapa;
    recalcular(d);
    return { itens: p.itens.map((l, i) => ({ chave: l.chave, id: mapa[i].id })) };
  },
  async anexar({ solicitacaoId, itemId, arquivo }) {
    await delay();
    const invalido = validarArquivo(arquivo);
    if (invalido) throw invalido;
    const d = exigirEditavel(solicitacaoId);
    const item = d.itens.find((i) => i.id === itemId);
    if (!item) throw new ServiceError("NOT_FOUND", "Linha não encontrada.");
    const id = Date.now();
    const path = `mock/${solicitacaoId}/${id}-${arquivo.name}`;
    arquivos.set(path, arquivo);
    item.anexos.push({ id, nome: arquivo.name, path, mime: arquivo.type, tamanho: arquivo.size });
    return { id, duplicadoEm: null };
  },
  async removerAnexo(id) {
    await delay();
    for (const d of registros.values()) for (const i of d.itens) i.anexos = i.anexos.filter((a) => a.id !== id);
  },
  async urlAnexo(path) {
    const blob = arquivos.get(path);
    if (!blob) throw new ServiceError("NOT_FOUND", "Não foi possível abrir o arquivo.");
    return URL.createObjectURL(blob);
  },
  async checagens(id) {
    await delay();
    const d = registros.get(id);
    return d ? checar(d) : [];
  },
  async enviar(id) {
    await delay();
    const d = exigirEditavel(id);
    if (d.tipo === "adiantamento") {
      const a = d.adiantamento!;
      if (!a.valor) throw new ServiceError("INVALID_INPUT", "Informe o valor do adiantamento.", "valor");
      if (!a.favorecido || !a.favorecidoDoc) throw new ServiceError("INVALID_INPUT", "Informe o favorecido e o CPF/CNPJ.", "favorecido");
      if (!a.finalidade) throw new ServiceError("INVALID_INPUT", "Informe a finalidade.", "finalidade");
      if (!a.vencimento) throw new ServiceError("INVALID_INPUT", "Informe o vencimento (hoje ou depois).", "vencimento");
      const b = checarAdiantamentoMock(d).filter((c) => c.resultado === "bloqueio");
      if (b.length) throw new ServiceError("INVALID_INPUT", `${b[0].codigo}: ${b[0].detalhe}`);
      d.status = "em_aprovacao";
      d.enviadoEm = d.aceiteEm = new Date().toISOString();
      d.aprovacoes = cadeiaAdiantamentoMock(a.valor).map((e, i) => ({
        ciclo: d.ciclo, nivel: e.nivel, papel: e.papel, status: !e.exigido ? "nao_exigido" : i === 0 ? "aguardando" : "pendente", comentario: null,
        aprovador: e.aprovador, substituto: e.substituto, prazoEm: i === 0 ? new Date(Date.now() + 48 * 3600_000).toISOString() : null, decididoEm: null,
      }));
      d.eventos.push({ tipo: "enviada", em: d.enviadoEm, ator: currentActor().name, payload: {} });
      return { status: "em_aprovacao", alertas: checarAdiantamentoMock(d).filter((c) => c.resultado === "alerta").length };
    }
    if (d.itens.length === 0) throw new ServiceError("INVALID_INPUT", "Inclua ao menos uma despesa.", "itens");
    const falta = d.itens.filter((i) => !i.data || !i.valor || !i.descricao || !i.motivo).length;
    if (falta) throw new ServiceError("INVALID_INPUT", `Preencha data, valor, descrição e motivo em todas as linhas (${falta} incompleta${falta > 1 ? "s" : ""}).`, "itens");
    const bloq = checar(d).filter((c) => c.resultado === "bloqueio");
    if (bloq.length) throw new ServiceError("INVALID_INPUT", `${bloq[0].codigo}: ${bloq[0].detalhe}`);
    d.status = "em_aprovacao";
    d.enviadoEm = d.aceiteEm = new Date().toISOString();
    d.aprovacoes = [{ ciclo: d.ciclo, nivel: 1, papel: "Gestor", status: "aguardando", comentario: null, aprovador: gestorMock().nome, substituto: gestorMock().substituto, prazoEm: null, decididoEm: null }];
    d.eventos.push({ tipo: "enviada", em: d.enviadoEm, ator: currentActor().name, payload: {} });
    return { status: "em_aprovacao", alertas: 0 };
  },
  async cancelar(id) {
    await delay();
    const d = registros.get(id);
    if (!d) throw new ServiceError("NOT_FOUND", "Solicitação não encontrada.");
    d.status = "cancelada";
  },
};

export const solicitacoesService: SolicitacoesService = DATA_SOURCE === "mock" ? mockSolicitacoes : supabaseSolicitacoes;

// ---------- Fase 3: aprovação (migration 20261017120000) ----------

export type AbaAprovacao = "aguardando" | "aprovadas" | "setor";
export type Decisao = "aprovar" | "devolver" | "reprovar";

export interface LinhaAprovacao {
  id: number;
  numero: string;
  tipo: TipoSolicitacao;
  status: StatusSolicitacao;
  solicitante: string;
  setor: string | null;
  valor: number;
  atualizadoEm: string;
  nivel: number | null;
  papel: string | null;
  de: number;
  desde: string | null;
  prazoEm: string | null;
  escaladoEm: string | null;
  /** Decidindo como substituto de alguém. */
  substitutoDe: string | null;
  alertas: number;
  decisao: string | null;
  decididoEm: string | null;
}

export interface FilaAprovacao {
  contagem: number;
  ehAprovador: boolean;
  substituicoes: { id: number; substituto: string; de: string; ate: string }[];
  usuarios: { id: string; nome: string }[];
  lista: LinhaAprovacao[];
}

export interface DetalheExtra {
  podeDecidir: boolean;
  etapa: { nivel: number; papel: string; prazoEm: string | null; emNomeDe: string | null } | null;
  regras: { codigo: string; nome: string; resultado: "ok" | "alerta" | "bloqueio"; detalhe: string | null; itemId: number | null }[];
}

export interface AprovacaoService {
  fila(aba: AbaAprovacao): Promise<FilaAprovacao>;
  extra(id: number): Promise<DetalheExtra>;
  decidir(p: { id: number; decisao: Decisao; comentario: string | null }): Promise<{ status: string; proximo?: string }>;
  definirSubstituto(p: { substitutoId: string; de: string; ate: string }): Promise<void>;
  removerSubstituto(id: number): Promise<void>;
}

const supabaseAprovacao: AprovacaoService = {
  fila: async (aba) => {
    const f = await rpc<FilaAprovacao>("sf_aprovacoes_fila", { p_aba: aba });
    return { ...f, lista: f.lista.map((l) => ({ ...l, valor: Number(l.valor) })) };
  },
  extra: (id) => rpc<DetalheExtra>("sf_detalhe_extra", { p_id: id }),
  decidir: (p) => rpc("sf_decidir_aprovacao", { p_id: p.id, p_decisao: p.decisao, p_comentario: p.comentario }),
  definirSubstituto: async (p) => {
    await rpc("sf_substituto_definir", { p: p as unknown as Json });
  },
  removerSubstituto: (id) => rpc<void>("sf_substituto_remover", { p_id: id }),
};

// Modo simulado: o próprio solicitante aprova a etapa (só para ver as telas).
const substituicoesMock: FilaAprovacao["substituicoes"] = [];
const mockAprovacao: AprovacaoService = {
  async fila(aba) {
    await delay();
    const lista: LinhaAprovacao[] = [...registros.values()]
      .filter((d) => (aba === "aguardando" ? d.status === "em_aprovacao" : aba === "aprovadas" ? d.aprovacoes.some((a) => a.status === "aprovado") : d.status !== "rascunho"))
      .map((d) => {
        const a = d.aprovacoes.find((x) => x.status === "aguardando");
        return {
          id: d.id, numero: d.numero, tipo: d.tipo, status: d.status, solicitante: d.solicitante.nome, setor: d.setor?.nome ?? null, valor: d.totalDespesas,
          atualizadoEm: d.atualizadoEm, nivel: a?.nivel ?? null, papel: a?.papel ?? null,
          de: d.aprovacoes.filter((x) => x.ciclo === d.ciclo && x.status !== "nao_exigido" && x.status !== "pulado").length, desde: d.enviadoEm,
          prazoEm: a?.prazoEm ?? null, escaladoEm: a?.prazoEm && Date.parse(a.prazoEm) < Date.now() ? a.prazoEm : null, substitutoDe: null,
          alertas: (regrasEnvioMock.get(d.id) ?? []).filter((r) => r.resultado !== "ok").length,
          decisao: d.aprovacoes.find((x) => x.status === "aprovado") ? "aprovado" : null, decididoEm: null,
        };
      });
    return { contagem: [...registros.values()].filter((d) => d.status === "em_aprovacao").length, ehAprovador: true, substituicoes: substituicoesMock,
      usuarios: [{ id: "u-marcos", nome: "Marcos Prado" }, { id: "u-helena", nome: "Helena Costa" }, { id: "u-gustavo", nome: "Gustavo Reis" }, { id: "u-ana", nome: "Ana Lima" }], lista };
  },
  async extra(id) {
    await delay();
    const d = registros.get(id);
    const a = d?.aprovacoes.find((x) => x.status === "aguardando");
    const regras: DetalheExtra["regras"] = d?.tipo === "adiantamento" && d.adiantamento
      ? checarAdiantamentoMock(d).map((c) => ({ codigo: c.codigo, nome: NOMES_REGRA[c.codigo] ?? c.codigo, resultado: c.resultado, detalhe: c.detalhe, itemId: null }))
      : regrasEnvioMock.get(id) ?? [];
    return { podeDecidir: !!a, etapa: a ? { nivel: a.nivel, papel: a.papel, prazoEm: a.prazoEm, emNomeDe: null } : null, regras };
  },
  async decidir({ id, decisao, comentario }) {
    await delay();
    const d = registros.get(id);
    const a = d?.aprovacoes.find((x) => x.status === "aguardando");
    if (!d || !a) throw new ServiceError("FORBIDDEN", "Esta solicitação não está aguardando a sua aprovação.");
    if (decisao !== "aprovar" && !comentario?.trim()) throw new ServiceError("INVALID_INPUT", "Escreva o motivo para devolver ou reprovar.", "comentario");
    a.status = decisao === "aprovar" ? "aprovado" : decisao === "devolver" ? "devolvido" : "reprovado";
    a.comentario = comentario;
    a.decididoEm = new Date().toISOString();
    const proximo = decisao === "aprovar" ? d.aprovacoes.find((x) => x.ciclo === d.ciclo && x.status === "pendente") : undefined;
    if (proximo) {
      proximo.status = "aguardando";
      proximo.prazoEm = new Date(Date.now() + 48 * 3600_000).toISOString();
      return { status: d.status, proximo: proximo.papel };
    }
    d.status = decisao === "aprovar" ? "em_conferencia" : decisao === "devolver" ? "devolvida" : "reprovada";
    if (decisao === "aprovar") d.pagarAte = d.tipo === "adiantamento" ? (d.adiantamento?.vencimento ?? null) : new Date(Date.now() + 15 * 86_400_000).toISOString().slice(0, 10);
    if (decisao === "devolver") d.ciclo += 1;
    return { status: d.status };
  },
  async definirSubstituto(p) {
    await delay();
    if (!p.substitutoId) throw new ServiceError("INVALID_INPUT", "Escolha outra pessoa ativa como substituta.", "substitutoId");
    if (!p.de || !p.ate || p.ate < p.de) throw new ServiceError("INVALID_INPUT", "Informe o período (fim igual ou depois do início).", "ate");
    substituicoesMock.push({ id: Date.now(), substituto: ({ "u-marcos": "Marcos Prado", "u-helena": "Helena Costa", "u-gustavo": "Gustavo Reis", "u-ana": "Ana Lima" } as Record<string, string>)[p.substitutoId] ?? p.substitutoId, de: p.de, ate: p.ate });
  },
  async removerSubstituto(id) {
    await delay();
    substituicoesMock.splice(substituicoesMock.findIndex((s) => s.id === id), 1);
  },
};

export const aprovacaoService: AprovacaoService = DATA_SOURCE === "mock" ? mockAprovacao : supabaseAprovacao;

// ---------- Fase 4: leitura de comprovantes (migration 20261017130000, Edge Function imobdesk-sf-ocr) ----------

export interface LeituraOcr {
  tipo_documento: "nfe" | "nfce" | "cupom" | "recibo" | "outro";
  data: string | null;
  valor_total: number | null;
  favorecido: string | null;
  cnpj_cpf_emissor: string | null;
  chave_acesso: string | null;
  itens: { descricao: string; valor: number | null }[];
  motivo_sugestoes: { categoria_id: number; texto: string; confianca: number }[];
  legibilidade: { data: number; valor: number; favorecido: number };
  alertas: string[];
  /** Fase 5B: número da nota/recibo ou do pedido, condição de pagamento e referência ao pedido. */
  numero_documento?: string | null;
  condicao_pagamento?: string | null;
  referencia_pedido?: string | null;
  erro?: string;
}

export interface ComprovanteNaFila {
  id: number;
  nome: string;
  path: string;
  mime: string;
  status: "fila" | "lendo" | "lido" | "ilegivel" | "erro";
  ocr: LeituraOcr | null;
  criadoEm: string;
}

export interface LeituraService {
  fila(solicitacaoId: number): Promise<ComprovanteNaFila[]>;
  /** Sobe o arquivo sem linha (fila de leitura) e devolve o id do anexo. */
  enviar(p: { solicitacaoId: number; solicitanteId: string; arquivo: File }): Promise<{ id: number; duplicadoEm: string | null }>;
  ler(anexoId: number): Promise<{ status: string; mensagem?: string }>;
  confirmar(p: { anexoId: number; data: string | null; valor: number | null; descricao: string | null; categoriaId: number | null; motivo: string | null }): Promise<number>;
}

const supabaseLeitura: LeituraService = {
  fila: (id) => rpc<ComprovanteNaFila[]>("sf_fila_leitura", { p_solicitacao: id }),
  async enviar({ solicitacaoId, solicitanteId, arquivo }) {
    const invalido = validarArquivo(arquivo);
    if (invalido) throw invalido;
    const hash = await sha256(arquivo);
    const ext = (arquivo.name.split(".").pop() ?? "bin").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5) || "bin";
    const path = `${solicitanteId}/${solicitacaoId}/${hash.slice(0, 16)}-${Date.now()}.${ext}`;
    const { error } = await supabase.storage.from(BUCKET).upload(path, arquivo, { contentType: arquivo.type, upsert: false });
    if (error) throw new ServiceError("INVALID_INPUT", `Não foi possível enviar ${arquivo.name}.`);
    try {
      const r = await rpc<{ id: number; duplicadoEm: string | null }>("sf_anexo_registrar", {
        p: { solicitacaoId, path, nome: arquivo.name, mime: arquivo.type, tamanho: arquivo.size, sha256: hash } as unknown as Json,
      });
      return { id: Number(r.id), duplicadoEm: r.duplicadoEm };
    } catch (e) {
      await supabase.storage.from(BUCKET).remove([path]);
      throw e;
    }
  },
  async ler(anexoId) {
    const { data, error } = await supabase.functions.invoke(edgeFunction("sf-ocr"), { body: { anexoId } });
    if (error) throw await fromFunction(error);
    return data as { status: string; mensagem?: string };
  },
  confirmar: (p) => rpc<number>("sf_linha_do_comprovante", { p: p as unknown as Json }),
};

// Modo simulado: leitura fixa de um cupom, com campos legíveis.
const filaMock = new Map<number, ComprovanteNaFila[]>();
const mockLeitura: LeituraService = {
  async fila(id) {
    await delay();
    return structuredClone(filaMock.get(id) ?? []);
  },
  async enviar({ solicitacaoId, arquivo }) {
    await delay();
    const invalido = validarArquivo(arquivo);
    if (invalido) throw invalido;
    const id = Date.now() + Math.floor(Math.random() * 1000);
    const path = `mock/${solicitacaoId}/${id}-${arquivo.name}`;
    arquivos.set(path, arquivo);
    filaMock.set(solicitacaoId, [...(filaMock.get(solicitacaoId) ?? []), { id, nome: arquivo.name, path, mime: arquivo.type, status: "fila", ocr: null, criadoEm: new Date().toISOString() }]);
    return { id, duplicadoEm: null };
  },
  async ler(anexoId) {
    await new Promise((r) => setTimeout(r, 900));
    for (const lista of filaMock.values()) {
      const a = lista.find((x) => x.id === anexoId);
      if (!a) continue;
      a.status = "lido";
      a.ocr = {
        tipo_documento: "nfce", data: new Date().toISOString().slice(0, 10), valor_total: 210, favorecido: "AUTO POSTO SHELL BARRA LTDA", cnpj_cpf_emissor: "12345678000190",
        chave_acesso: null, itens: [{ descricao: "GASOLINA COMUM", valor: 210 }],
        motivo_sugestoes: [{ categoria_id: 4, texto: "Combustível — abastecimento veículo", confianca: 0.91 }, { categoria_id: 5, texto: "Transporte — deslocamento obra", confianca: 0.42 }],
        legibilidade: { data: 0.99, valor: 0.98, favorecido: 0.95 }, alertas: [],
      };
    }
    return { status: "lido" };
  },
  async confirmar(p) {
    await delay();
    for (const [solId, lista] of filaMock) {
      const a = lista.find((x) => x.id === p.anexoId);
      if (!a) continue;
      filaMock.set(solId, lista.filter((x) => x.id !== p.anexoId));
      const d = registros.get(solId);
      if (!d) break;
      const id = contadorMock.item++;
      d.itens.push({ id, ordem: d.itens.length + 1, data: p.data, valor: p.valor, descricao: p.descricao, motivo: p.motivo, categoriaId: p.categoriaId,
        origem: "ocr_confirmado", statusConferencia: "pendente", anexos: [{ id: a.id, nome: a.nome, path: a.path, mime: a.mime, tamanho: 0 }] });
      recalcular(d);
      return id;
    }
    throw new ServiceError("NOT_FOUND", "Comprovante não encontrado.");
  },
};

export const leituraService: LeituraService = DATA_SOURCE === "mock" ? mockLeitura : supabaseLeitura;
