// Cadastros do ticket (Administração › Serviços, Urgências, Categorias, Campos adicionais e Regras para exibição).
// Mesmo formato da RPC ch_cadastros() (migration 20261007170000).

export interface SetorCad {
  id: number;
  nome: string;
  ativo: boolean;
  /** Atende chamados (Setores e números › Receber chamado). Só esses recebem serviços. */
  recebeChamados: boolean;
  slaPadraoHoras: number;
  equipePadraoId: number | null;
}

export interface EquipeCad {
  id: number;
  nome: string;
  setorId: number | null;
  ativa: boolean;
  descricaoIa: string | null;
}

export type CorUrgencia = "vermelho" | "laranja" | "azul" | "verde" | "roxo" | "cinza";

export interface Urgencia {
  id: number;
  nome: string;
  ordem: number;
  cor: CorUrgencia;
  descricao: string | null;
  padrao: boolean;
  ativa: boolean;
}

export interface Categoria {
  id: number;
  nome: string;
  descricao: string | null;
  /** null = vale para todos os serviços. */
  servicos: number[] | null;
  ordem: number;
  padrao: boolean;
  ativa: boolean;
}

export type Canal = "agente" | "intranet" | "email" | "whatsapp";

export interface SlaServico {
  urgenciaId: number;
  respostaHoras: number | null;
  solucaoHoras: number | null;
}

export interface Servico {
  id: number;
  paiId: number | null;
  setorId: number;
  nivel: number;
  nome: string;
  /** null = herda do pai. */
  equipeId: number | null;
  descricao: string | null;
  urgenciaPadraoId: number | null;
  categoriaPadraoId: number | null;
  canais: Canal[];
  ordem: number;
  ativo: boolean;
  sla: SlaServico[];
}

export type TipoCampo = "texto" | "texto_longo" | "numero" | "data" | "data_hora" | "lista" | "multipla" | "sim_nao" | "usuario";
export type LocalCampo = "abertura" | "detalhe" | "encerramento";
export type Obrigatoriedade = "sempre" | "nao" | "regra";

export interface Campo {
  id: number;
  chave: string;
  rotulo: string;
  tipo: TipoCampo;
  opcoes: string[];
  ajuda: string | null;
  aparece: LocalCampo[];
  interno: boolean;
  obrigatorio: Obrigatoriedade;
  usarEmVisoes: boolean;
  ordem: number;
  ativo: boolean;
}

/** "servico" | "categoria" | "urgencia" | "setor" | "origem" | "campo:<chave>" */
export type CampoRegra = "servico" | "categoria" | "urgencia" | "setor" | "origem" | `campo:${string}`;
export type OperadorRegra = "um_de" | "nao_um_de" | "preenchido" | "vazio";
export type AcaoRegra = "exibir" | "ocultar" | "obrigar" | "liberar";

export interface CondicaoRegra {
  campo: CampoRegra;
  operador: OperadorRegra;
  valores: string[];
}

export interface Regra {
  id: number;
  nome: string;
  ordem: number;
  condicoes: CondicaoRegra[];
  acoes: { acao: AcaoRegra; campo: string }[];
  ativa: boolean;
}

export interface Cadastros {
  setores: SetorCad[];
  equipes: EquipeCad[];
  urgencias: Urgencia[];
  categorias: Categoria[];
  servicos: Servico[];
  campos: Campo[];
  regras: Regra[];
}

export interface AcoesMacro {
  statusId?: number;
  justificativaId?: number | null;
  categoriaId?: number;
  urgenciaId?: number;
  equipeId?: number;
  responsavelId?: string;
  tags?: string[];
}

export interface Macro {
  id: number;
  nome: string;
  texto: string;
  acoes: AcoesMacro;
  escopo: "pessoal" | "equipe" | "todos";
  donoId: string | null;
  equipeId: number | null;
  ativa: boolean;
}

export const CORES_URGENCIA: Record<CorUrgencia, { label: string; token: string }> = {
  vermelho: { label: "Vermelho", token: "var(--danger-fg)" },
  laranja: { label: "Laranja", token: "var(--warning-strong)" },
  azul: { label: "Azul", token: "var(--info-fg)" },
  verde: { label: "Verde", token: "var(--success-fg)" },
  roxo: { label: "Roxo", token: "var(--ds-ai)" },
  cinza: { label: "Cinza", token: "var(--neutral-fg)" },
};

export const TIPOS_CAMPO: Record<TipoCampo, string> = {
  texto: "Texto curto",
  texto_longo: "Texto longo",
  numero: "Número",
  data: "Data",
  data_hora: "Data e hora",
  lista: "Lista de opções",
  multipla: "Várias opções",
  sim_nao: "Sim / Não",
  usuario: "Usuário do portal",
};

export const CANAIS: Record<Canal, string> = { agente: "Agente", intranet: "Intranet", email: "E-mail", whatsapp: "WhatsApp" };
export const LOCAIS_CAMPO: Record<LocalCampo, string> = { abertura: "Abertura", detalhe: "Detalhe", encerramento: "Encerramento" };
export const ACOES_REGRA: Record<AcaoRegra, string> = { exibir: "Exibir", ocultar: "Ocultar", obrigar: "Exibir e tornar obrigatório", liberar: "Tornar opcional" };
export const OPERADORES_REGRA: Record<OperadorRegra, string> = { um_de: "for um de", nao_um_de: "não for nenhum de", preenchido: "estiver preenchido", vazio: "estiver vazio" };

/** Chave estável a partir do rótulo ("Obra / unidade" → "obra_unidade"). */
export function chaveDoRotulo(rotulo: string): string {
  return rotulo
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^(\d)/, "c_$1")
    .slice(0, 40);
}

/** "TI › Infraestrutura › Rede / VPN". */
/** Equipe do serviço: a dele ou a do nível acima mais próximo (igual a ch_servico_equipe no banco). */
export function equipeDoServico(id: number | null, servicos: readonly Servico[]): number | null {
  let atual = servicos.find((s) => s.id === id);
  while (atual) {
    if (atual.equipeId !== null) return atual.equipeId;
    const pai = atual.paiId;
    atual = servicos.find((s) => s.id === pai);
  }
  return null;
}

export function caminhoServico(id: number | null, servicos: readonly Servico[]): string {
  const partes: string[] = [];
  let atual = servicos.find((s) => s.id === id);
  while (atual) {
    partes.unshift(atual.nome);
    const pai = atual.paiId;
    atual = servicos.find((s) => s.id === pai);
  }
  return partes.join(" › ");
}

/** O próprio serviço e todos os que estão acima dele (as regras e categorias valem para os filhos). */
export function cadeiaServico(id: number | null, servicos: readonly Servico[]): number[] {
  const ids: number[] = [];
  let atual = servicos.find((s) => s.id === id);
  while (atual) {
    ids.push(atual.id);
    const pai = atual.paiId;
    atual = servicos.find((s) => s.id === pai);
  }
  return ids;
}
