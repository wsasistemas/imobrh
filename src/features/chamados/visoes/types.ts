// Visões da tela Tickets (docs/PLANO-tickets-visoes.md). Mesmo formato do jsonb gravado em ch_visoes.

export type TipoVisao = "lista" | "kanban";

/** Campos que as condições aceitam (lista fechada; a RPC valida contra a mesma lista). */
export type CampoId =
  | "recebido_em"
  | "origem"
  | "equipe"
  | "responsavel"
  | "solicitante"
  | "servico"
  | "status"
  | "justificativa"
  | "prioridade"
  | "tag"
  | "criado_em"
  | "sla";

export type Operador =
  | "igual"
  | "diferente"
  | "contem"
  | "vazio"
  | "preenchido"
  | "usuario_logado"
  | "ultimos_dias"
  | "antes"
  | "depois"
  | "vencido"
  | "vence_hoje"
  | "no_prazo";

export interface Condicao {
  campo: CampoId;
  operador: Operador;
  /** Vazio nos operadores sem valor (vazio, usuário logado, vencido…). "igual"/"diferente" aceitam vários (OU). */
  valores: string[];
}

/** TODAS = condições combinadas (E); QUALQUER = independentes (ao menos uma). */
export interface Condicoes {
  todas: Condicao[];
  qualquer: Condicao[];
}

export interface StatusRef {
  statusId: number;
  /** null = o status com qualquer justificativa (ou sem nenhuma). */
  justificativaId: number | null;
}

export interface ColunaKanban {
  id: string;
  nome: string;
  status: StatusRef[];
}

export type Ordenacao = "sla" | "criado" | "prioridade";

export interface ConfigKanban {
  colunas: ColunaKanban[];
  ordenar: Ordenacao;
  /** O que acontece ao arrastar um cartão para outra coluna (D5). */
  arrastar: "mudar_status" | "bloqueado";
}

export type CampoAgrupamento = "equipe" | "responsavel" | "status" | "servico" | "origem" | "prioridade";
/** Colunas padrão da Lista. As do segundo grupo vêm de ch_lista_extras (docs/PLANO-visoes-colunas.md, Fase 2). */
export type ColunaPadrao =
  | "solicitante" | "status" | "responsavel" | "sla" | "origem" | "servico" | "equipe" | "prioridade" | "criado"
  | "tags" | "recebido_em" | "categoria" | "setor" | "contato" | "criado_por" | "atualizado" | "primeira_resposta"
  | "prazo_resposta" | "prazo_solucao" | "encerrado" | "empreendimento" | "setor_solicitante";
/** Coluna da Lista: padrão ou campo adicional ("campo:<chave>" do cadastro de Campos adicionais). */
export type ColunaLista = ColunaPadrao | `campo:${string}`;

/** Dados extras das colunas novas (RPC ch_lista_extras). */
export interface CampoColuna {
  chave: string;
  rotulo: string;
  tipo: "texto" | "texto_longo" | "numero" | "data" | "data_hora" | "lista" | "multipla" | "sim_nao" | "usuario";
  interno: boolean;
}
export interface ExtrasTicket {
  categoria: string | null;
  setor: string | null;
  contato: string | null;
  criado_por: string | null;
  atualizado_em: string | null;
  primeira_resposta_em: string | null;
  sla_resposta_ate: string | null;
  sla_solucao_ate: string | null;
  encerrado_em: string | null;
  /** Administração › Empreendimentos (migration 20261012100000). */
  empreendimento_id?: number | null;
  empreendimento?: string | null;
  empreendimento_origem?: "ia" | "manual" | "solicitante" | null;
  /** Setor de quem pediu (migration 20261016100000); nulo = "A identificar". */
  setor_solicitante?: string | null;
  campos: Record<string, unknown>;
}
export interface ListaExtras {
  campos: CampoColuna[];
  tickets: Record<string, ExtrasTicket>;
}

export interface ConfigAgrupamento {
  por: CampoAgrupamento | null;
  ordemGrupos: "az" | "quantidade";
  ordenar: Ordenacao;
  porPagina: 25 | 50 | 100;
  colunas: ColunaLista[];
}

export interface Visao {
  id: number;
  nome: string;
  habilitada: boolean;
  tipo: TipoVisao;
  /** Abre primeiro na tela Tickets (uma só no sistema). */
  padrao: boolean;
  /** Equipes que veem a visão (D4). Vazio = só Admin e Super admin. */
  equipes: number[];
  condicoes: Condicoes;
  kanban: ConfigKanban;
  agrupamento: ConfigAgrupamento;
  atualizadoEm: string;
  atualizadoPor: string | null;
}

export type VisaoSalvar = Omit<Visao, "id" | "atualizadoEm" | "atualizadoPor"> & { id?: number };

export interface EquipeVisao {
  id: number;
  nome: string;
}
