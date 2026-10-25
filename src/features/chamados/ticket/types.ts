// Tela do ticket (docs/PLANO-tela-ticket.md). Mesmo formato de ch_ticket_detalhe (migration 20261007171000).

export type OrigemTicket = "email" | "whatsapp" | "intranet" | "agente";

export interface AcaoTicket {
  numero: number;
  tipo: "publica" | "interna";
  canal: "email" | "whatsapp" | "portal";
  /** entrada = veio do solicitante. */
  direcao: "entrada" | "saida";
  autorId: string | null;
  autorNome: string;
  texto: string;
  html: string | null;
  anexos: unknown[];
  envioStatus: "pendente" | "enviado" | "falhou" | "nao_se_aplica" | null;
  criadoEm: string;
  enviadoEm?: string | null;
  envioErro?: string | null;
  envioTentativas?: number;
  /** Cabeçalhos para o "Visualizar e-mail" (só ações públicas de e-mail). */
  email?: EmailDaAcao | null;
}

export interface EmailDaAcao {
  de: string | null;
  deNome: string | null;
  para: (string | null)[];
  cc: string[];
  assunto: string | null;
  data: string | null;
}

export interface EventoTicket {
  tipo: string;
  descricao: string;
  autorNome: string;
  criadoEm: string;
}

export interface TicketDetalhe {
  id: number;
  assunto: string;
  origem: OrigemTicket;
  recebidoEm: string;
  solicitante: { pessoaId: number | null; nome: string; contato: string | null; departamento: string | null };
  /** Setor de quem pediu (migration 20261016100000). Nulo = "A identificar". */
  setorSolicitanteId: number | null;
  setorSolicitante: string | null;
  setorId: number;
  equipeId: number | null;
  responsavelId: string | null;
  servicoId: number | null;
  categoriaId: number | null;
  urgenciaId: number;
  statusId: number;
  justificativaId: number | null;
  tags: string[];
  cc: string[];
  campos: Record<string, unknown>;
  solucaoAplicada: string | null;
  criadoEm: string;
  assumidoEm: string | null;
  primeiraRespostaEm: string | null;
  slaRespostaAte: string | null;
  slaSolucaoAte: string | null;
  slaManual: boolean;
  slaPausadoDesde: string | null;
  encerradoEm: string | null;
  mescladoEmId: number | null;
  clonadoDeId: number | null;
  excluidoEm: string | null;
  clones: number[];
  mesclados: number[];
  seguindo: boolean;
  acoes: AcaoTicket[];
  eventos: EventoTicket[];
  podeAlterarPrazo: boolean;
  podeExcluir: boolean;
}

/** Mesmas chaves de ch_ticket_atualizar (só as enviadas mudam). */
export interface PatchTicket {
  servicoId?: number | null;
  categoriaId?: number | null;
  urgenciaId?: number;
  equipeId?: number | null;
  responsavelId?: string | null;
  statusId?: number;
  justificativaId?: number | null;
  tags?: string[];
  cc?: string[];
  campos?: Record<string, unknown>;
  solucaoAplicada?: string | null;
  slaSolucaoAte?: string;
  slaJustificativa?: string;
}

export interface NovaAcao {
  tipo: "publica" | "interna";
  texto: string;
  /** Status depois de enviar ("Depois de enviar"). */
  statusDepois?: { statusId: number; justificativaId: number | null };
  /** Campos alterados junto (ex.: ações da macro). */
  campos?: PatchTicket;
}

export interface SolucaoAnterior {
  id: number;
  assunto: string;
  solucao: string;
  encerradoEm: string;
  responsavel: string;
  servico: string | null;
}

export interface Responsavel {
  id: string;
  nome: string;
  equipes: number[];
}

export const ORIGENS: Record<OrigemTicket, string> = { email: "E-mail", whatsapp: "WhatsApp", intranet: "Intranet", agente: "Agente" };
