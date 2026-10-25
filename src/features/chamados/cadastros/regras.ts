import { cadeiaServico, type Campo, type CondicaoRegra, type Regra, type Servico } from "./types";

// Regras para exibição no front: a mesma lógica de ch_campos_estado / ch_regra_condicao (migration 20261007171000).
// Usada no "Testar regras" e no formulário do ticket. O banco confere de novo ao salvar e ao resolver.

export interface ContextoRegras {
  servicoId: number | null;
  categoriaId: number | null;
  urgenciaId: number | null;
  setorId: number | null;
  origem: string | null;
  /** Valores dos campos adicionais, por chave. */
  campos: Record<string, unknown>;
}

export interface EstadoCampo {
  visivel: boolean;
  obrigatorio: boolean;
}

function vazio(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (Array.isArray(v)) return v.length === 0;
  return String(v).trim() === "";
}

function valoresAtuais(campo: CondicaoRegra["campo"], ctx: ContextoRegras, servicos: readonly Servico[]): string[] {
  if (campo === "servico") return cadeiaServico(ctx.servicoId, servicos).map(String);
  if (campo === "categoria") return ctx.categoriaId === null ? [] : [String(ctx.categoriaId)];
  if (campo === "urgencia") return ctx.urgenciaId === null ? [] : [String(ctx.urgenciaId)];
  if (campo === "setor") return ctx.setorId === null ? [] : [String(ctx.setorId)];
  if (campo === "origem") return ctx.origem ? [ctx.origem] : [];
  const v = ctx.campos[campo.slice(6)];
  if (vazio(v)) return [];
  return Array.isArray(v) ? v.map(String) : [String(v)];
}

export function condicaoAtende(c: CondicaoRegra, ctx: ContextoRegras, servicos: readonly Servico[]): boolean {
  const atuais = valoresAtuais(c.campo, ctx, servicos);
  switch (c.operador) {
    case "um_de":
      return atuais.some((v) => c.valores.includes(v));
    case "nao_um_de":
      return !atuais.some((v) => c.valores.includes(v));
    case "preenchido":
      return atuais.length > 0;
    case "vazio":
      return atuais.length === 0;
  }
}

/** Estado de cada campo ativo: regras de cima para baixo; havendo conflito, a última vence. */
export function estadoCampos(campos: readonly Campo[], regras: readonly Regra[], ctx: ContextoRegras, servicos: readonly Servico[]): Record<string, EstadoCampo> {
  const estado: Record<string, EstadoCampo> = {};
  for (const c of campos) if (c.ativo) estado[c.chave] = { visivel: c.obrigatorio !== "regra", obrigatorio: c.obrigatorio === "sempre" };
  const ativas = [...regras].filter((r) => r.ativa).sort((a, b) => a.ordem - b.ordem || a.id - b.id);
  for (const r of ativas) {
    if (!r.condicoes.every((c) => condicaoAtende(c, ctx, servicos))) continue;
    for (const a of r.acoes) {
      const e = estado[a.campo];
      if (!e) continue;
      if (a.acao === "exibir") e.visivel = true;
      else if (a.acao === "ocultar") Object.assign(e, { visivel: false, obrigatorio: false });
      else if (a.acao === "obrigar") Object.assign(e, { visivel: true, obrigatorio: true });
      else if (a.acao === "liberar") e.obrigatorio = false;
    }
  }
  return estado;
}

/** Rótulos dos obrigatórios visíveis e vazios (o mesmo aviso do banco ao resolver). */
export function camposPendentes(campos: readonly Campo[], estado: Record<string, EstadoCampo>, valores: Record<string, unknown>): string[] {
  return [...campos]
    .sort((a, b) => a.ordem - b.ordem)
    .filter((c) => estado[c.chave]?.visivel && estado[c.chave]?.obrigatorio && vazio(valores[c.chave]))
    .map((c) => c.rotulo);
}
