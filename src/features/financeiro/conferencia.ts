import type { Json } from "../../lib/database.types";
import { supabase } from "../../lib/supabase";
import { DATA_SOURCE } from "../configuracoes/services";
import { delay } from "../configuracoes/services/mock/runtime";
import { ServiceError } from "../configuracoes/services/types";
import type { StatusSolicitacao } from "./components/StatusChip";
import { BUCKET, ocrMock, registros, regrasItemMock, rpc, sha256, validarArquivo, type Item, type LeituraOcr, type TipoSolicitacao } from "./solicitacoes";

// Solicitações Financeiras, Fase 5 (migration 20261017140000): fila do Financeiro, conferência item a item, pendência
// do solicitante, pagamento programado e paga. O lançamento no SIENGE entra na parte 2 da fase.

export interface LinhaConferencia {
  id: number;
  numero: string;
  tipo: TipoSolicitacao;
  status: StatusSolicitacao;
  solicitante: string;
  setor: string | null;
  valor: number;
  valorAPagar: number | null;
  ultimaAprovacaoEm: string | null;
  pagarAte: string | null;
  vencimento: string | null;
  itens: number;
  resolvidos: number;
}

export interface FilaConferencia {
  kpis: {
    aConferir: number;
    aConferirValor: number;
    pendencia: number;
    lancamentoGerado: number;
    pagamentoProgramado: number;
    aComprovar: number;
    aComprovarVencidos: number;
    pagasMes: number;
    pagasMesValor: number;
  };
  lista: LinhaConferencia[];
}

export interface ItemConferencia {
  id: number;
  ordem: number;
  data: string | null;
  valor: number;
  descricao: string | null;
  motivo: string | null;
  origem: Item["origem"];
  status: Item["statusConferencia"];
  valorGlosado: number;
  obs: string | null;
  anexos: { id: number; nome: string; path: string; mime: string; ocrStatus: string; ocr: LeituraOcr | null }[];
  regras: { codigo: string; resultado: "ok" | "alerta" | "bloqueio"; detalhe: string }[];
}

export interface Conferencia {
  podeConferir: boolean;
  itens: ItemConferencia[];
  gerais: { codigo: string; resultado?: string; detalhe: string }[];
}

export type DecisaoItem = "aceitar" | "ajuste" | "glosar";

export interface ConferenciaService {
  fila(): Promise<FilaConferencia>;
  itens(id: number): Promise<Conferencia>;
  decidirItem(p: { itemId: number; decisao: DecisaoItem; valorGlosa: number | null; obs: string | null }): Promise<void>;
  pedirAjuste(p: { id: number; comentario: string }): Promise<void>;
  pendenciaAnexar(p: { solicitacaoId: number; solicitanteId: string; itemId: number; arquivo: File }): Promise<void>;
  pendenciaResponder(p: { id: number; resposta: string }): Promise<void>;
  programarPagamento(p: { id: number; data: string }): Promise<void>;
  marcarPaga(id: number): Promise<void>;
}

const supabaseConferencia: ConferenciaService = {
  async fila() {
    const f = await rpc<FilaConferencia>("sf_conferencia_fila");
    return {
      kpis: { ...f.kpis, aConferirValor: Number(f.kpis.aConferirValor), pagasMesValor: Number(f.kpis.pagasMesValor) },
      lista: f.lista.map((l) => ({ ...l, valor: Number(l.valor), valorAPagar: l.valorAPagar == null ? null : Number(l.valorAPagar) })),
    };
  },
  async itens(id) {
    const c = await rpc<Conferencia>("sf_conferencia_itens", { p_id: id });
    return { ...c, itens: c.itens.map((i) => ({ ...i, valor: Number(i.valor), valorGlosado: Number(i.valorGlosado) })) };
  },
  async decidirItem(p) {
    await rpc("sf_decidir_item", { p_item: p.itemId, p_decisao: p.decisao, p_valor_glosa: p.valorGlosa, p_obs: p.obs });
  },
  pedirAjuste: (p) => rpc<void>("sf_pedir_ajuste", { p_id: p.id, p_comentario: p.comentario }),
  async pendenciaAnexar({ solicitacaoId, solicitanteId, itemId, arquivo }) {
    const invalido = validarArquivo(arquivo);
    if (invalido) throw invalido;
    const hash = await sha256(arquivo);
    const ext = (arquivo.name.split(".").pop() ?? "bin").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5) || "bin";
    const path = `${solicitanteId}/${solicitacaoId}/${hash.slice(0, 16)}-${Date.now()}.${ext}`;
    const { error } = await supabase.storage.from(BUCKET).upload(path, arquivo, { contentType: arquivo.type, upsert: false });
    if (error) throw new ServiceError("INVALID_INPUT", "Não foi possível enviar o arquivo.");
    try {
      await rpc("sf_pendencia_anexar", { p: { itemId, path, nome: arquivo.name, mime: arquivo.type, tamanho: arquivo.size, sha256: hash } as unknown as Json });
    } catch (e) {
      await supabase.storage.from(BUCKET).remove([path]);
      throw e;
    }
  },
  pendenciaResponder: (p) => rpc<void>("sf_pendencia_responder", { p_id: p.id, p_resposta: p.resposta }),
  programarPagamento: (p) => rpc<void>("sf_programar_pagamento", { p_id: p.id, p_data: p.data }),
  marcarPaga: (id) => rpc<void>("sf_marcar_paga", { p_id: id }),
};

// ---------- Modo simulado: trabalha sobre os registros em memória ----------
/** Decisões por item no modo simulado (a demonstração já traz itens conferidos). */
export const decisoes = new Map<number, { status: Item["statusConferencia"]; glosa: number; obs: string | null }>();
const FILA: StatusSolicitacao[] = ["em_conferencia", "pendencia_solicitante", "lancamento_gerado", "pagamento_programado", "comprovacao_pendente",
  "comprovacao_em_conferencia", "devolucao_pendente"];

const mockConferencia: ConferenciaService = {
  async fila() {
    await delay();
    const lista = [...registros.values()].filter((d) => FILA.includes(d.status));
    const conta = (s: StatusSolicitacao) => lista.filter((d) => d.status === s).length;
    return {
      kpis: {
        aConferir: conta("em_conferencia"), aConferirValor: lista.filter((d) => d.status === "em_conferencia").reduce((s, d) => s + (d.valorAPagar ?? d.totalDespesas), 0), pendencia: conta("pendencia_solicitante"), lancamentoGerado: conta("lancamento_gerado"),
        pagamentoProgramado: conta("pagamento_programado"), aComprovar: conta("comprovacao_pendente") + conta("comprovacao_em_conferencia"), aComprovarVencidos: 0,
        pagasMes: [...registros.values()].filter((d) => d.status === "paga" || d.status === "encerrada").length,
        pagasMesValor: [...registros.values()].filter((d) => d.status === "paga" || d.status === "encerrada").reduce((s, d) => s + (d.valorAPagar ?? d.totalDespesas), 0),
      },
      lista: lista.map((d) => ({
        id: d.id, numero: d.numero, tipo: d.tipo, status: d.status, solicitante: d.solicitante.nome, setor: d.setor?.nome ?? null, valor: d.totalDespesas,
        valorAPagar: d.valorAPagar, ultimaAprovacaoEm: d.enviadoEm, pagarAte: d.pagarAte, vencimento: d.adiantamento?.vencimento ?? null, itens: d.itens.length,
        resolvidos: d.itens.filter((i) => ["aceito", "glosado"].includes(decisoes.get(i.id)?.status ?? "")).length,
      })),
    };
  },
  async itens(id) {
    await delay();
    const d = registros.get(id);
    if (!d) throw new ServiceError("NOT_FOUND", "Solicitação não encontrada.");
    return {
      podeConferir: d.status === "em_conferencia",
      itens: d.itens.map((i) => {
        const x = decisoes.get(i.id);
        return {
          id: i.id, ordem: i.ordem, data: i.data, valor: i.valor ?? 0, descricao: i.descricao, motivo: i.motivo, origem: i.origem,
          status: x?.status ?? "pendente", valorGlosado: x?.glosa ?? 0, obs: x?.obs ?? null,
          anexos: i.anexos.map((a) => ({ ...a, ocrStatus: "lido", ocr: ocrMock.get(a.id) ?? null })), regras: regrasItemMock.get(i.id) ?? [],
        };
      }),
      gerais: [],
    };
  },
  async decidirItem(p) {
    await delay();
    if (p.decisao !== "aceitar" && !p.obs?.trim()) throw new ServiceError("INVALID_INPUT", "Escreva a observação.", "obs");
    decisoes.set(p.itemId, {
      status: p.decisao === "aceitar" ? "aceito" : p.decisao === "glosar" ? "glosado" : "ajuste",
      glosa: p.decisao === "glosar" ? (p.valorGlosa ?? 0) : 0,
      obs: p.obs,
    });
    for (const d of registros.values()) {
      if (!d.itens.some((i) => i.id === p.itemId)) continue;
      d.valorGlosado = d.itens.reduce((s, i) => s + (decisoes.get(i.id)?.glosa ?? 0), 0);
      d.valorAPagar = d.totalDespesas - d.valorGlosado;
    }
  },
  async pedirAjuste(p) {
    await delay();
    const d = registros.get(p.id);
    if (d) d.status = "pendencia_solicitante";
  },
  async pendenciaAnexar() {
    await delay();
  },
  async pendenciaResponder(p) {
    await delay();
    const d = registros.get(p.id);
    if (!d) return;
    d.status = "em_conferencia";
    for (const i of d.itens) if (decisoes.get(i.id)?.status === "ajuste") decisoes.delete(i.id);
  },
  async programarPagamento(p) {
    await delay();
    const d = registros.get(p.id);
    if (d) Object.assign(d, { status: "pagamento_programado", pagarAte: p.data });
  },
  async marcarPaga(id) {
    await delay();
    const d = registros.get(id);
    if (!d) return;
    d.status = d.tipo === "adiantamento" ? "comprovacao_pendente" : "paga";
    if (d.adiantamento) Object.assign(d.adiantamento, { pagoEm: new Date().toISOString(), statusComprovacao: "pendente" });
  },
};

export const conferenciaService: ConferenciaService = DATA_SOURCE === "mock" ? mockConferencia : supabaseConferencia;
