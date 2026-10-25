import { edgeFunction } from "../../config/app";
import type { Json } from "../../lib/database.types";
import { supabase } from "../../lib/supabase";
import { DATA_SOURCE } from "../configuracoes/services";
import { delay } from "../configuracoes/services/mock/runtime";
import { fromFunction } from "../configuracoes/services/supabase/errors";
import { ServiceError } from "../configuracoes/services/types";
import { acerto, prazoComprovacao, valorDaTarefa } from "../../../supabase/functions/_shared/sf/adiantamento.ts";
import {
  arquivos, BUCKET, leituraService, registros, rpc, sha256, validarArquivo, type ArquivoLido, type Comprovacao, type DadosAdiantamento, type FormaPagamento, type LeituraOcr,
} from "./solicitacoes";

// Fase 5B — adiantamento de numerário (migration 20261017160000): formulário (tela 13), documento de origem lido no
// modo pedido_compra, comprovação (tela 15) com a NF lida no modo comprovacao, A07, decisão do Financeiro, devolução e
// o lançamento do saldo do pedido no SIENGE.

export interface SalvarAdiantamento {
  id: number;
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
  pedidoNumero: string | null;
  pedidoData: string | null;
  pedidoFornecedor: string | null;
  pedidoFornecedorDoc: string | null;
  pedidoValor: number | null;
  pedidoPercentual: number | null;
  pedidoCondicao: string | null;
  rateio: { tarefa: string; porcentagem: number | null }[];
}

export interface ChecagemA07 {
  codigo: "A07";
  nome: string;
  resultado: "ok" | "alerta" | "bloqueio";
  detalhe: string;
}

export interface DadosComprovacao {
  id: number;
  anexoId: number | null;
  tipoDocumento: LeituraOcr["tipo_documento"];
  emissao: string | null;
  emitente: string | null;
  emitenteDoc: string | null;
  valor: number | null;
  numero: string | null;
  referencia: string | null;
}

export interface AdiantamentoService {
  salvar(p: SalvarAdiantamento): Promise<{ itemId: number; prazoComprovacao: string | null }>;
  anexarDocumento(p: { solicitacaoId: number; solicitanteId: string; arquivo: File }): Promise<{ id: number }>;
  removerDocumento(id: number): Promise<void>;
  ler(anexoId: number): Promise<{ status: string; mensagem?: string }>;
  anexarComprovacao(p: { solicitacaoId: number; solicitanteId: string; arquivo: File }): Promise<{ id: number }>;
  removerComprovacao(id: number): Promise<void>;
  checarComprovacao(p: DadosComprovacao): Promise<ChecagemA07[]>;
  enviarComprovacao(p: DadosComprovacao): Promise<{ acerto: "comprovado" | "devolucao"; saldoPagar: number; saldoDevolver: number }>;
  decidirComprovacao(p: { id: number; decisao: "aceitar" | "ajuste"; obs: string | null }): Promise<{ status: string }>;
  confirmarDevolucao(p: { id: number; obs: string | null }): Promise<void>;
  lancarSaldo(p: { solicitacaoId: number; centroCustoId: number; plano: string; vencimento: string }): Promise<{ titulo: number; jaExistia: boolean; avisos: string[] }>;
}

const so = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");

/** Sobe o arquivo para <usuário>/<solicitação>/<hash>-<hora>.<ext> e registra com a RPC; desfaz o upload se a RPC falhar. */
async function subir(rpcNome: string, p: { solicitacaoId: number; solicitanteId: string; arquivo: File }, extra: Record<string, unknown> = {}): Promise<{ id: number }> {
  const invalido = validarArquivo(p.arquivo);
  if (invalido) throw invalido;
  const hash = await sha256(p.arquivo);
  const ext = (p.arquivo.name.split(".").pop() ?? "bin").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5) || "bin";
  const path = `${p.solicitanteId}/${p.solicitacaoId}/${hash.slice(0, 16)}-${Date.now()}.${ext}`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, p.arquivo, { contentType: p.arquivo.type, upsert: false });
  if (error) throw new ServiceError("INVALID_INPUT", `Não foi possível enviar ${p.arquivo.name}.`);
  try {
    const r = await rpc<{ id: number }>(rpcNome, {
      p: { solicitacaoId: p.solicitacaoId, path, nome: p.arquivo.name, mime: p.arquivo.type, tamanho: p.arquivo.size, sha256: hash, ...extra } as unknown as Json,
    });
    return { id: Number(r.id) };
  } catch (e) {
    await supabase.storage.from(BUCKET).remove([path]);
    throw e;
  }
}

const supabaseAdiantamento: AdiantamentoService = {
  salvar: (p) => rpc("sf_adiantamento_salvar", { p: p as unknown as Json }),
  anexarDocumento: (p) => subir("sf_anexo_registrar", p, { finalidade: "documento_origem" }),
  async removerDocumento(id) {
    const path = await rpc<string>("sf_anexo_remover", { p_id: id });
    await supabase.storage.from(BUCKET).remove([path]);
  },
  ler: (id) => leituraService.ler(id),
  anexarComprovacao: (p) => subir("sf_comprovacao_anexar", p),
  async removerComprovacao(id) {
    const path = await rpc<string>("sf_comprovacao_anexo_remover", { p_id: id });
    await supabase.storage.from(BUCKET).remove([path]);
  },
  checarComprovacao: (p) => rpc("sf_comprovacao_checar", { p_id: p.id, p: p as unknown as Json }),
  enviarComprovacao: async (p) => {
    const r = await rpc<{ acerto: "comprovado" | "devolucao"; saldoPagar: number; saldoDevolver: number }>("sf_enviar_comprovacao", { p: p as unknown as Json });
    return { ...r, saldoPagar: Number(r.saldoPagar), saldoDevolver: Number(r.saldoDevolver) };
  },
  decidirComprovacao: (p) => rpc("sf_decidir_comprovacao", { p_id: p.id, p_decisao: p.decisao, p_obs: p.obs }),
  confirmarDevolucao: (p) => rpc<void>("sf_confirmar_devolucao", { p_id: p.id, p_obs: p.obs }),
  async lancarSaldo(p) {
    const { data, error } = await supabase.functions.invoke(edgeFunction("sf-sienge"), { body: { acao: "lancar_saldo", ...p } });
    if (error) throw await fromFunction(error);
    return data as { titulo: number; jaExistia: boolean; avisos: string[] };
  },
};

// ---------- Modo simulado (sobre os registros em memória) ----------
let proximoArquivo = 50_000;

function doMock(id: number) {
  const d = registros.get(id);
  if (!d?.adiantamento) throw new ServiceError("NOT_FOUND", "Solicitação não encontrada.");
  return { d, a: d.adiantamento };
}

function arquivoMock(solicitacaoId: number, arquivo: File, ocr: LeituraOcr): ArquivoLido {
  const id = proximoArquivo++;
  const path = `mock/${solicitacaoId}/${id}-${arquivo.name}`;
  arquivos.set(path, arquivo);
  return { id, nome: arquivo.name, path, mime: arquivo.type, status: "lido", ocr };
}

const leituraMock = (o: Partial<LeituraOcr>): LeituraOcr => ({
  tipo_documento: "outro", data: null, valor_total: null, favorecido: null, cnpj_cpf_emissor: null, chave_acesso: null, itens: [], motivo_sugestoes: [],
  legibilidade: { data: 0.97, valor: 0.99, favorecido: 0.96 }, alertas: [], numero_documento: null, condicao_pagamento: null, referencia_pedido: null, ...o,
});

function checarMock(p: DadosComprovacao): ChecagemA07[] {
  const { a } = doMock(p.id);
  const pago = a.pagoEm?.slice(0, 10) ?? null;
  const br = (v: number) => v.toFixed(2).replace(".", ",");
  const r = (nome: string, ok: boolean, detalhe: string): ChecagemA07 => ({ codigo: "A07", nome, resultado: ok ? "ok" : "alerta", detalhe });
  return [
    r("Emitente = favorecido", !!p.emitenteDoc && so(p.emitenteDoc) === a.favorecidoDoc, so(p.emitenteDoc) === a.favorecidoDoc ? "CNPJ igual ao do adiantamento" : "Emitente diferente do favorecido"),
    r("Emissão após o pagamento", !!p.emissao && !!pago && p.emissao >= pago, p.emissao && pago ? `${p.emissao.slice(8, 10)}/${p.emissao.slice(5, 7)} ${p.emissao >= pago ? "≥" : "<"} ${pago.slice(8, 10)}/${pago.slice(5, 7)}` : "Informe a emissão"),
    r("Dentro do prazo", !!a.prazoComprovacao && new Date().toISOString().slice(0, 10) <= a.prazoComprovacao, `até ${a.prazoComprovacao?.split("-").reverse().join("/") ?? "—"}`),
    r("Valor ≥ adiantado", p.valor != null && p.valor >= (a.valor ?? 0), p.valor == null ? "Informe o valor da nota" : `${br(p.valor)} ${p.valor >= (a.valor ?? 0) ? "≥" : "<"} ${br(a.valor ?? 0)}`),
    r("Nota não usada antes", true, "Chave de acesso inédita"),
  ];
}

const mockAdiantamento: AdiantamentoService = {
  async salvar(p) {
    await delay();
    const { d, a } = doMock(p.id);
    if (!["rascunho", "devolvida"].includes(d.status)) throw new ServiceError("INVALID_INPUT", "Esta solicitação não pode mais ser alterada.");
    const doc = so(p.favorecidoDoc);
    if (doc && doc.length !== 11 && doc.length !== 14) throw new ServiceError("INVALID_INPUT", "CPF/CNPJ do favorecido inválido.", "favorecidoDoc");
    Object.assign(a, { ...p, favorecidoDoc: doc || null, pedidoFornecedorDoc: so(p.pedidoFornecedorDoc) || null, prazoComprovacao: prazoComprovacao(p.vencimento, a.prazoDias) });
    a.rateio = p.rateio.filter((r) => r.tarefa.trim()).map((r, i) => ({ id: i + 1, tarefa: r.tarefa.trim(), porcentagem: r.porcentagem ?? 0, valor: valorDaTarefa(p.valor, r.porcentagem) }));
    const item = d.itens[0] ?? { id: 900_000 + d.id, ordem: 1, categoriaId: null, origem: "manual" as const, statusConferencia: "pendente" as const, anexos: [] };
    Object.assign(item, { data: a.dataPreenchimento, valor: p.valor, descricao: p.favorecido, motivo: p.finalidade });
    item.anexos = a.documentos.map((x) => ({ id: x.id, nome: x.nome, path: x.path, mime: x.mime, tamanho: 0 }));
    d.itens = [item];
    d.totalDespesas = p.valor ?? 0;
    d.valorAPagar = d.totalDespesas - d.valorGlosado;
    d.atualizadoEm = new Date().toISOString();
    return { itemId: item.id, prazoComprovacao: a.prazoComprovacao };
  },
  async anexarDocumento({ solicitacaoId, arquivo }) {
    await new Promise((r) => setTimeout(r, 400));
    const invalido = validarArquivo(arquivo);
    if (invalido) throw invalido;
    const { a } = doMock(solicitacaoId);
    const x = arquivoMock(solicitacaoId, arquivo, leituraMock({
      tipo_documento: "outro", data: "2026-01-09", valor_total: 1316.8, favorecido: "J.A BLINDAGEM ARQUITETONICA LTDA", cnpj_cpf_emissor: "53520864000109",
      numero_documento: "001355", condicao_pagamento: "50% sinal - 50% após a entrega",
    }));
    a.documentos.push(x);
    return { id: x.id };
  },
  async removerDocumento(id) {
    await delay();
    for (const d of registros.values()) if (d.adiantamento) d.adiantamento.documentos = d.adiantamento.documentos.filter((x) => x.id !== id);
  },
  async ler() {
    await new Promise((r) => setTimeout(r, 600));
    return { status: "lido" };
  },
  async anexarComprovacao({ solicitacaoId, arquivo }) {
    await new Promise((r) => setTimeout(r, 400));
    const invalido = validarArquivo(arquivo);
    if (invalido) throw invalido;
    const { a } = doMock(solicitacaoId);
    const x = arquivoMock(solicitacaoId, arquivo, leituraMock({
      tipo_documento: "nfe", data: new Date().toISOString().slice(0, 10), valor_total: (a.valor ?? 0) * 2, favorecido: a.favorecido, cnpj_cpf_emissor: a.favorecidoDoc,
      numero_documento: "000874", referencia_pedido: a.pedidoNumero ? `PED ${a.pedidoNumero}` : null,
    }));
    a.arquivosComprovacao.push(x);
    return { id: x.id };
  },
  async removerComprovacao(id) {
    await delay();
    for (const d of registros.values()) if (d.adiantamento) d.adiantamento.arquivosComprovacao = d.adiantamento.arquivosComprovacao.filter((x) => x.id !== id);
  },
  async checarComprovacao(p) {
    await delay();
    return checarMock(p);
  },
  async enviarComprovacao(p) {
    await delay();
    const { d, a } = doMock(p.id);
    if (d.status !== "comprovacao_pendente") throw new ServiceError("INVALID_INPUT", "Este adiantamento não está aguardando comprovação.");
    if (!p.anexoId) throw new ServiceError("INVALID_INPUT", "Anexe a nota fiscal, o recibo ou a foto.", "anexo");
    if (!p.emissao || !p.valor || !p.emitenteDoc) throw new ServiceError("INVALID_INPUT", "Preencha emissão, CNPJ/CPF do emitente e valor.");
    const r = acerto(a.valor ?? 0, p.valor);
    const c: Comprovacao = {
      id: Date.now(), anexoId: p.anexoId, tipoDocumento: p.tipoDocumento, emitente: p.emitente, emitenteDoc: so(p.emitenteDoc), emissao: p.emissao, valor: p.valor,
      numero: p.numero, referencia: p.referencia, saldoPagar: r.saldoPagar, saldoDevolver: r.saldoDevolver, status: "enviada", obs: null, conferidaEm: null, criadoEm: new Date().toISOString(),
    };
    a.comprovacoes.unshift(c);
    a.checagensComprovacao = checarMock(p).map((x) => ({ codigo: "A07", resultado: x.resultado, detalhe: `${x.nome}: ${x.detalhe}` }));
    a.arquivosComprovacao = a.arquivosComprovacao.map((x) => (x.id === p.anexoId ? { ...x, enviado: true } : x));
    a.statusComprovacao = "enviada";
    d.status = "comprovacao_em_conferencia";
    return { acerto: r.resultado, saldoPagar: r.saldoPagar, saldoDevolver: r.saldoDevolver };
  },
  async decidirComprovacao({ id, decisao, obs }) {
    await delay();
    const { d, a } = doMock(id);
    const c = a.comprovacoes[0];
    if (decisao === "ajuste" && !obs?.trim()) throw new ServiceError("INVALID_INPUT", "Escreva o que o colaborador precisa ajustar.", "obs");
    if (decisao === "ajuste") {
      Object.assign(c, { status: "ajuste", obs });
      d.status = "comprovacao_pendente";
      a.statusComprovacao = "pendente";
    } else {
      const encerra = c.valor >= (a.valor ?? 0);
      Object.assign(c, { status: encerra ? "aceita" : "devolucao", obs, conferidaEm: new Date().toISOString() });
      d.status = encerra ? "encerrada" : "devolucao_pendente";
      a.statusComprovacao = encerra ? "aceita" : "devolucao";
    }
    return { status: d.status };
  },
  async confirmarDevolucao({ id }) {
    await delay();
    const { d } = doMock(id);
    if (d.status !== "devolucao_pendente") throw new ServiceError("INVALID_INPUT", "Não há devolução pendente nesta solicitação.");
    d.status = "encerrada";
  },
  async lancarSaldo({ solicitacaoId }) {
    await delay();
    const { a } = doMock(solicitacaoId);
    a.siengeSaldoId = String(9500 + solicitacaoId);
    return { titulo: 9500 + solicitacaoId, jaExistia: false, avisos: [] };
  },
};

export const adiantamentoService: AdiantamentoService = DATA_SOURCE === "mock" ? mockAdiantamento : supabaseAdiantamento;

export type { DadosAdiantamento };
