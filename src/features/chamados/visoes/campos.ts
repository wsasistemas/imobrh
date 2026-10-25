import type { CampoAgrupamento, CampoColuna, CampoId, ColunaLista, ColunaPadrao, Operador, Ordenacao } from "./types";

// Lista fechada de campos das condições (D3). A RPC ch_visao_salvar valida contra a mesma lista; a tela
// monta o seletor de valores conforme `valores`.

export type FonteValores = "recebido_em" | "origem" | "equipe" | "usuario" | "servico" | "status" | "justificativa" | "prioridade" | "tag" | "texto" | "data" | "dias" | null;

export interface CampoDef {
  id: CampoId;
  label: string;
  operadores: readonly Operador[];
  /** De onde vêm as opções do valor (null = operador sem valor). */
  valores: FonteValores;
}

export const OPERADORES: Record<Operador, { label: string; semValor?: boolean }> = {
  igual: { label: "Igual a" },
  diferente: { label: "Diferente de" },
  contem: { label: "Contém" },
  vazio: { label: "Não informado", semValor: true },
  preenchido: { label: "Informado", semValor: true },
  usuario_logado: { label: "É o usuário logado", semValor: true },
  ultimos_dias: { label: "Nos últimos (dias)" },
  antes: { label: "Antes de" },
  depois: { label: "Depois de" },
  vencido: { label: "Vencido", semValor: true },
  vence_hoje: { label: "Vence hoje", semValor: true },
  no_prazo: { label: "No prazo", semValor: true },
};

export const CAMPOS: readonly CampoDef[] = [
  { id: "recebido_em", label: "Ticket: Recebido em (conta/canal)", operadores: ["igual", "diferente"], valores: "recebido_em" },
  { id: "origem", label: "Ticket: Origem", operadores: ["igual", "diferente"], valores: "origem" },
  { id: "equipe", label: "Ticket: Equipe responsável", operadores: ["igual", "diferente", "vazio"], valores: "equipe" },
  { id: "responsavel", label: "Ticket: Responsável", operadores: ["igual", "diferente", "vazio", "preenchido", "usuario_logado"], valores: "usuario" },
  { id: "solicitante", label: "Ticket: Solicitante", operadores: ["contem", "igual"], valores: "texto" },
  { id: "servico", label: "Ticket: Serviço", operadores: ["igual", "diferente"], valores: "servico" },
  { id: "status", label: "Ticket: Status", operadores: ["igual", "diferente"], valores: "status" },
  { id: "justificativa", label: "Ticket: Justificativa", operadores: ["igual", "diferente", "vazio"], valores: "justificativa" },
  { id: "prioridade", label: "Ticket: Prioridade", operadores: ["igual", "diferente"], valores: "prioridade" },
  { id: "tag", label: "Ticket: TAG", operadores: ["igual", "diferente", "vazio", "preenchido"], valores: "tag" },
  { id: "criado_em", label: "Ticket: Criado em", operadores: ["ultimos_dias", "antes", "depois"], valores: "data" },
  { id: "sla", label: "Ticket: SLA de solução", operadores: ["vencido", "vence_hoje", "no_prazo"], valores: null },
];

export function campoDef(id: CampoId): CampoDef {
  const c = CAMPOS.find((x) => x.id === id);
  if (!c) throw new Error(`Campo de condição desconhecido: ${id}`);
  return c;
}

/** Fonte do valor conforme o operador ("Nos últimos" pede número de dias). */
export function fonteDoValor(campo: CampoId, operador: Operador): FonteValores {
  if (OPERADORES[operador].semValor) return null;
  if (operador === "ultimos_dias") return "dias";
  return campoDef(campo).valores;
}

export const ORDENACOES: Record<Ordenacao, string> = {
  sla: "Vencimento do SLA (vencidos primeiro)",
  criado: "Criado em (mais novo primeiro)",
  prioridade: "Prioridade (urgente primeiro)",
};

export const AGRUPAMENTOS: Record<CampoAgrupamento, string> = {
  equipe: "Equipe responsável",
  responsavel: "Responsável",
  status: "Status",
  servico: "Serviço",
  origem: "Origem",
  prioridade: "Prioridade",
};

export const COLUNAS_LISTA: Record<ColunaPadrao, string> = {
  solicitante: "Solicitante",
  status: "Status",
  responsavel: "Responsável",
  sla: "SLA de solução",
  origem: "Origem",
  servico: "Serviço",
  equipe: "Equipe",
  prioridade: "Prioridade",
  criado: "Criado em",
  tags: "Tags",
  recebido_em: "Recebido em",
  categoria: "Categoria",
  setor: "Departamento",
  contato: "Contato do solicitante",
  criado_por: "Criado por",
  atualizado: "Atualizado em",
  primeira_resposta: "1ª resposta",
  prazo_resposta: "Prazo de 1ª resposta",
  prazo_solucao: "Prazo de solução",
  encerrado: "Encerrado em",
  empreendimento: "Empreendimento",
  setor_solicitante: "Setor do solicitante",
};

/** Colunas que dependem de ch_lista_extras (a Lista só busca quando a visão usa alguma). */
export const COLUNAS_COM_EXTRAS: ReadonlySet<ColunaLista> = new Set<ColunaLista>([
  "categoria", "setor", "contato", "criado_por", "atualizado", "primeira_resposta", "prazo_resposta", "prazo_solucao", "encerrado", "empreendimento", "setor_solicitante",
]);

export const ehCampoAdicional = (c: ColunaLista): c is `campo:${string}` => c.startsWith("campo:");
export const precisaExtras = (colunas: readonly ColunaLista[]) => colunas.some((c) => COLUNAS_COM_EXTRAS.has(c) || ehCampoAdicional(c));

/** Rótulo de qualquer coluna (campo adicional sem cadastro: a própria chave). */
export function rotuloColuna(c: ColunaLista, campos: readonly CampoColuna[] = []): string {
  if (ehCampoAdicional(c)) {
    const chave = c.slice(6);
    return campos.find((x) => x.chave === chave)?.rotulo ?? chave;
  }
  return COLUNAS_LISTA[c] ?? c;
}

const FMT_DATA = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "America/Sao_Paulo" });
const FMT_DATA_HORA = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });

/** Valor de um campo adicional como texto da célula ("" = vazio). */
export function formatarCampo(tipo: CampoColuna["tipo"] | undefined, valor: unknown): string {
  if (valor === null || valor === undefined || valor === "") return "";
  if (Array.isArray(valor)) return valor.map((v) => String(v)).filter(Boolean).join(", ");
  switch (tipo) {
    case "sim_nao":
      return valor === true || valor === "true" || valor === "sim" ? "Sim" : valor === false || valor === "false" || valor === "nao" ? "Não" : String(valor);
    case "data": {
      // "2026-10-10" é data sem fuso: mostra o dia como está.
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(valor));
      if (m) return `${m[3]}/${m[2]}/${m[1]}`;
      const d = new Date(String(valor));
      return Number.isNaN(d.getTime()) ? String(valor) : FMT_DATA.format(d);
    }
    case "data_hora": {
      const d = new Date(String(valor));
      return Number.isNaN(d.getTime()) ? String(valor) : FMT_DATA_HORA.format(d);
    }
    case "numero": {
      const n = Number(valor);
      return Number.isFinite(n) ? n.toLocaleString("pt-BR") : String(valor);
    }
    default:
      return typeof valor === "object" ? JSON.stringify(valor) : String(valor);
  }
}

export const PRIORIDADES = ["Urgente", "Alta", "Normal", "Baixa"] as const;
