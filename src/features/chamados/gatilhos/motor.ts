import { cadeiaServico, type Servico } from "../cadastros/types";
import type { CondicaoGatilho, Disparo, Gatilho, TipoDisparo } from "./types";

// Mesma avaliação de ch_gatilho_condicao / ch_gatilho_atende (banco). Usada no modo simulado e nos testes.

export interface ContextoGatilho {
  statusId: number;
  justificativaId: number | null;
  urgenciaId: number;
  categoriaId: number | null;
  servicoId: number | null;
  equipeId: number | null;
  responsavelId: string | null;
  setorId: number;
  origem: string;
  tags: string[];
  /** Assunto e as últimas mensagens. */
  textos: string[];
  campos: Record<string, unknown>;
  dentroExpediente: boolean;
}

export type AutorGatilho = "solicitante" | "agente" | "sistema";

function valoresAtuais(campo: string, ctx: ContextoGatilho, autor: AutorGatilho, servicos: readonly Servico[]): string[] {
  const um = (v: number | string | null | undefined) => (v === null || v === undefined || v === "" ? [] : [String(v)]);
  switch (campo) {
    case "status":
      return [String(ctx.statusId), `${ctx.statusId}:${ctx.justificativaId ?? ""}`];
    case "urgencia":
      return um(ctx.urgenciaId);
    case "categoria":
      return um(ctx.categoriaId);
    case "servico":
      // O serviço e os de cima dele ("está dentro de").
      return cadeiaServico(ctx.servicoId, servicos).map(String);
    case "equipe":
      return um(ctx.equipeId);
    case "responsavel":
      return um(ctx.responsavelId);
    case "setor":
      return um(ctx.setorId);
    case "origem":
      return um(ctx.origem);
    case "tags":
      return ctx.tags;
    case "texto":
      return ctx.textos;
    case "horario":
      return [ctx.dentroExpediente ? "dentro" : "fora"];
    case "autor":
      return [autor];
    default: {
      if (!campo.startsWith("campo:")) return [];
      const v = ctx.campos[campo.slice(6)];
      if (Array.isArray(v)) return v.map(String);
      return um(v === null || v === undefined ? null : String(v).trim());
    }
  }
}

export function condicaoAtende(c: CondicaoGatilho, ctx: ContextoGatilho, autor: AutorGatilho, servicos: readonly Servico[]): boolean {
  const atual = valoresAtuais(c.campo, ctx, autor, servicos);
  const contem = () => c.valores.some((v) => v.trim() !== "" && atual.some((a) => a.toLowerCase().includes(v.trim().toLowerCase())));
  switch (c.operador) {
    case "um_de":
      return atual.some((a) => c.valores.includes(a));
    case "nao_um_de":
      return !atual.some((a) => c.valores.includes(a));
    case "preenchido":
      return atual.length > 0;
    case "vazio":
      return atual.length === 0;
    case "contem":
      return contem();
    case "nao_contem":
      return !contem();
  }
}

/** TODAS valem e (QUALQUER vazia ou pelo menos uma vale). */
export function gatilhoAtende(g: Pick<Gatilho, "todas" | "qualquer">, ctx: ContextoGatilho, autor: AutorGatilho, servicos: readonly Servico[]): boolean {
  return g.todas.every((c) => condicaoAtende(c, ctx, autor, servicos)) && (g.qualquer.length === 0 || g.qualquer.some((c) => condicaoAtende(c, ctx, autor, servicos)));
}

/** Gatilhos ativos que respondem a algum dos disparos, na ordem da lista. */
export function gatilhosDoEvento(gatilhos: readonly Gatilho[], disparos: readonly TipoDisparo[]): Gatilho[] {
  return gatilhos.filter((g) => g.ativo && g.disparos.some((d) => disparos.includes(d.tipo))).sort((a, b) => a.ordem - b.ordem || a.id - b.id);
}

/** Erros de preenchimento, iguais aos de ch_gatilho_salvar (para avisar antes de salvar). */
export function validarGatilho(g: { nome: string; disparos: Disparo[]; todas: CondicaoGatilho[]; qualquer: CondicaoGatilho[]; acoes: { tipo: string; texto?: string; tags?: string[]; statusId?: number; macroId?: number; chave?: string }[] }): string | null {
  if (g.nome.trim().length < 2 || g.nome.trim().length > 80) return "Informe o nome do gatilho (2 a 80 letras).";
  if (g.disparos.length === 0) return 'Marque pelo menos um disparo em "Dispara quando".';
  if (g.disparos.some((d) => (d.tipo === "tempo_status" || d.tipo === "sla_vence") && !(Number(d.horas) >= 0.25 && Number(d.horas) <= 2000))) {
    return "Revise os disparos: as horas precisam estar entre 0,25 e 2000.";
  }
  const semValor = (c: CondicaoGatilho) => ["um_de", "nao_um_de", "contem", "nao_contem"].includes(c.operador) && c.valores.length === 0;
  if ([...g.todas, ...g.qualquer].some(semValor)) return "Revise as condições: falta o valor de alguma delas.";
  if (g.acoes.length === 0) return "Adicione pelo menos uma ação.";
  const acaoIncompleta = g.acoes.some(
    (a) =>
      (a.tipo === "status" && !a.statusId) ||
      (a.tipo === "responder_macro" && !a.macroId) ||
      (a.tipo === "campo" && !a.chave) ||
      ((a.tipo === "nota_interna" || a.tipo === "solucao") && !a.texto?.trim()) ||
      ((a.tipo === "tags_adicionar" || a.tipo === "tags_remover") && !a.tags?.length),
  );
  return acaoIncompleta ? "Revise as ações: falta o valor de alguma delas." : null;
}
