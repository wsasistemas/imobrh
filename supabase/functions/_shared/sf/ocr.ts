// Solicitações Financeiras, Fase 4: leitura de comprovantes (CONTEXTO.md, seção 5). Módulo puro (sem rede): esquema da
// resposta, instruções para a IA e normalização. Princípio: a IA TRANSCREVE; não sugere data, valor nem favorecido.
// Campo com legibilidade abaixo do limiar (R02, padrão 0,80) volta nulo e o comprovante fica "ilegivel".
// A única sugestão é o motivo: até 3 opções, só entre as categorias ativas enviadas.

export type ModoLeitura = "comprovante" | "pedido_compra" | "comprovacao";
export type TipoDocumento = "nfe" | "nfce" | "cupom" | "recibo" | "outro";

export interface Categoria {
  id: number;
  nome: string;
  descricao?: string | null;
  palavrasChave?: string[];
}

export interface Leitura {
  tipo_documento: TipoDocumento;
  data: string | null;
  valor_total: number | null;
  favorecido: string | null;
  cnpj_cpf_emissor: string | null;
  chave_acesso: string | null;
  /** Número do documento (NF, recibo) ou do pedido de compras, como impresso. */
  numero_documento: string | null;
  /** Condição de pagamento impressa no pedido/proposta/e-mail (ex.: "50% sinal - 50% na entrega"). */
  condicao_pagamento: string | null;
  /** Referência a pedido impressa na nota (ex.: "PED 001298"). */
  referencia_pedido: string | null;
  itens: { descricao: string; valor: number | null }[];
  motivo_sugestoes: { categoria_id: number; texto: string; confianca: number }[];
  legibilidade: { data: number; valor: number; favorecido: number };
  alertas: string[];
}

/** Esquema JSON da resposta (structured outputs). */
export const ESQUEMA_LEITURA = {
  type: "object",
  additionalProperties: false,
  required: ["tipo_documento", "data", "valor_total", "favorecido", "cnpj_cpf_emissor", "chave_acesso", "numero_documento", "condicao_pagamento", "referencia_pedido", "itens", "motivo_sugestoes", "legibilidade", "alertas"],
  properties: {
    tipo_documento: { type: "string", enum: ["nfe", "nfce", "cupom", "recibo", "outro"] },
    data: { type: ["string", "null"], description: "Data de emissão impressa, no formato AAAA-MM-DD." },
    valor_total: { type: ["number", "null"], description: "Valor total impresso, em reais." },
    favorecido: { type: ["string", "null"], description: "Nome do emissor (razão social ou nome) como impresso." },
    cnpj_cpf_emissor: { type: ["string", "null"], description: "CNPJ ou CPF do emissor como impresso." },
    chave_acesso: { type: ["string", "null"], description: "Chave de acesso de 44 dígitos (NF-e/NFC-e), se impressa." },
    numero_documento: { type: ["string", "null"], description: "Número da nota, do recibo ou do pedido de compras, como impresso." },
    condicao_pagamento: { type: ["string", "null"], description: "Condição de pagamento impressa (pedido, proposta ou e-mail), literal." },
    referencia_pedido: { type: ["string", "null"], description: "Referência a pedido de compras impressa no documento, literal." },
    itens: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["descricao", "valor"],
        properties: { descricao: { type: "string" }, valor: { type: ["number", "null"] } },
      },
    },
    motivo_sugestoes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["categoria_id", "texto", "confianca"],
        properties: { categoria_id: { type: "integer" }, texto: { type: "string" }, confianca: { type: "number" } },
      },
    },
    legibilidade: {
      type: "object",
      additionalProperties: false,
      required: ["data", "valor", "favorecido"],
      properties: { data: { type: "number" }, valor: { type: "number" }, favorecido: { type: "number" } },
    },
    alertas: { type: "array", items: { type: "string" } },
  },
} as const;

export const INSTRUCOES = `Você transcreve comprovantes fiscais brasileiros (NF-e, NFC-e, cupom, recibo) para o setor Financeiro da empresa.

Regras obrigatórias:
1. TRANSCREVA literalmente o que está impresso, campo a campo. Não estime, não corrija, não complete, não deduza.
   Se um campo não está impresso ou não é possível lê-lo com segurança, devolva null.
2. Para data, valor e favorecido, informe em "legibilidade" um número de 0 a 1: o quanto o campo está nítido e
   inequívoco na imagem (1 = perfeitamente legível; 0 = ilegível ou ausente).
3. "data": data de emissão no formato AAAA-MM-DD. "valor_total": o valor total do documento (número, ponto decimal).
   "favorecido": nome do emissor como impresso. "cnpj_cpf_emissor": como impresso.
4. "itens": as linhas de produtos/serviços impressas, com descrição e valor de cada uma.
5. "motivo_sugestoes": até 3 sugestões de motivo, escolhidas SOMENTE entre as categorias listadas no pedido (use o id).
   "texto" no padrão "Categoria — detalhe curto". "confianca" de 0 a 1. Esta é a única sugestão permitida.
6. "numero_documento": número da nota/recibo ou do pedido de compras. "condicao_pagamento": a condição de pagamento
   como escrita (ex.: "50% sinal - 50% após a entrega"); não calcule o valor. "referencia_pedido": referência a pedido
   impressa na nota. Nos documentos em que não existem, devolva null.
7. "alertas": códigos curtos para situações que o conferente deve ver, como "possivel_bebida_alcoolica",
   "documento_rasurado", "documento_cortado", "mais_de_um_comprovante", "nao_e_comprovante".
Responda apenas com o JSON do esquema.`;

export function montarPedido(modo: ModoLeitura, categorias: Categoria[]): string {
  const lista = categorias
    .map((c) => `- id ${c.id}: ${c.nome}${c.descricao ? ` (${c.descricao})` : ""}${c.palavrasChave?.length ? ` · palavras: ${c.palavrasChave.join(", ")}` : ""}`)
    .join("\n");
  const foco =
    modo === "comprovacao"
      ? "Este é o documento de comprovação de um adiantamento (nota fiscal ou recibo). Transcreva também o número da nota e a referência ao pedido, se impressa."
      : modo === "pedido_compra"
        ? "Este é um documento de origem (pedido de compras, proposta ou e-mail). Em \"favorecido\" e \"cnpj_cpf_emissor\" vai o fornecedor; em \"numero_documento\" o número do pedido; em \"valor_total\" o valor total do pedido; transcreva a condição de pagamento."
        : "Este é um comprovante de despesa.";
  return `${foco}\n\nCategorias de motivo ativas (escolha só entre estas):\n${lista || "- (nenhuma)"}\n\nTranscreva o documento anexo.`;
}

const so = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");
const num01 = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/** Valida a forma da resposta. Devolve null se não for uma leitura. */
export function validarLeitura(bruto: unknown): Leitura | null {
  if (!bruto || typeof bruto !== "object") return null;
  const r = bruto as Record<string, unknown>;
  const leg = (r.legibilidade ?? {}) as Record<string, unknown>;
  const tipos: TipoDocumento[] = ["nfe", "nfce", "cupom", "recibo", "outro"];
  if (typeof r.tipo_documento !== "string" || !tipos.includes(r.tipo_documento as TipoDocumento)) return null;
  if (!Array.isArray(r.itens) || !Array.isArray(r.motivo_sugestoes) || !Array.isArray(r.alertas)) return null;
  const texto = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    tipo_documento: r.tipo_documento as TipoDocumento,
    data: texto(r.data),
    valor_total: typeof r.valor_total === "number" && Number.isFinite(r.valor_total) ? r.valor_total : null,
    favorecido: texto(r.favorecido),
    cnpj_cpf_emissor: texto(r.cnpj_cpf_emissor),
    chave_acesso: texto(r.chave_acesso),
    numero_documento: texto(r.numero_documento)?.slice(0, 60) ?? null,
    condicao_pagamento: texto(r.condicao_pagamento)?.slice(0, 200) ?? null,
    referencia_pedido: texto(r.referencia_pedido)?.slice(0, 120) ?? null,
    itens: (r.itens as unknown[])
      .filter((i): i is Record<string, unknown> => !!i && typeof i === "object")
      .map((i) => ({ descricao: String(i.descricao ?? "").slice(0, 200), valor: typeof i.valor === "number" ? i.valor : null }))
      .slice(0, 100),
    motivo_sugestoes: (r.motivo_sugestoes as unknown[])
      .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
      .map((s) => ({ categoria_id: Number(s.categoria_id), texto: String(s.texto ?? "").slice(0, 120), confianca: num01(s.confianca) })),
    legibilidade: { data: num01(leg.data), valor: num01(leg.valor), favorecido: num01(leg.favorecido) },
    alertas: (r.alertas as unknown[]).map(String).slice(0, 10),
  };
}

/**
 * Aplica o princípio da transcrição: campo abaixo do limiar vira null; formatos inválidos também (data fora de
 * AAAA-MM-DD, documento sem 11/14 dígitos, chave sem 44 dígitos); sugestões só das categorias enviadas, no máximo 3.
 * Status "ilegivel" quando data, valor ou favorecido ficou abaixo do limiar.
 */
export function normalizarLeitura(l: Leitura, limiar: number, categorias: Categoria[]): { status: "lido" | "ilegivel"; leitura: Leitura } {
  const ok = (campo: keyof Leitura["legibilidade"]) => l.legibilidade[campo] >= limiar;
  const dataValida = l.data && /^\d{4}-\d{2}-\d{2}$/.test(l.data) && !Number.isNaN(Date.parse(`${l.data}T12:00:00Z`)) ? l.data : null;
  const doc = so(l.cnpj_cpf_emissor);
  const chave = so(l.chave_acesso);
  const ids = new Set(categorias.map((c) => c.id));
  const leitura: Leitura = {
    ...l,
    data: ok("data") ? dataValida : null,
    valor_total: ok("valor") && l.valor_total != null && l.valor_total > 0 ? Math.round(l.valor_total * 100) / 100 : null,
    favorecido: ok("favorecido") ? l.favorecido : null,
    cnpj_cpf_emissor: doc.length === 11 || doc.length === 14 ? doc : null,
    chave_acesso: chave.length === 44 ? chave : null,
    motivo_sugestoes: l.motivo_sugestoes
      .filter((s) => ids.has(s.categoria_id))
      .sort((a, b) => b.confianca - a.confianca)
      .slice(0, 3),
  };
  const ilegivel = !ok("data") || !ok("valor") || !ok("favorecido");
  return { status: ilegivel ? "ilegivel" : "lido", leitura };
}

/** Tipos de arquivo que a API lê: imagem (JPEG, PNG, WEBP, GIF) e PDF. HEIC não é lido. */
export function blocoDoArquivo(mime: string, base64: string):
  | { type: "image"; source: { type: "base64"; media_type: "image/jpeg" | "image/png" | "image/webp" | "image/gif"; data: string } }
  | { type: "document"; source: { type: "base64"; media_type: "application/pdf"; data: string } }
  | null {
  if (mime === "application/pdf") return { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } };
  if (mime === "image/jpeg" || mime === "image/png" || mime === "image/webp" || mime === "image/gif") {
    return { type: "image", source: { type: "base64", media_type: mime, data: base64 } };
  }
  return null;
}
