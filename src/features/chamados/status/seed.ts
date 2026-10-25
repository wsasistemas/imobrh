import type { StatusTicket } from "./types";

// Carga inicial do cadastro de status (a mesma da migration ch_status). O mock dos tickets usa estes ids.

export const STATUS_ID = {
  novo: 1,
  emAtendimento: 2,
  aguardando: 3,
  resolvido: 4,
  fechado: 5,
  cancelado: 6,
  reaberto: 7,
} as const;

export const JUSTIFICATIVA_ID = {
  retornoCliente: 1,
  fornecedor: 2,
  pendenciaVistoria: 3,
  preFechamento: 4,
  cotacao: 5,
  aprovacaoGestor: 6,
  peloCliente: 7,
} as const;

const j = (id: number, statusId: number, nome: string, ordem: number) => ({ id, statusId, nome, ordem, ativa: true });

export const STATUS_INICIAIS: StatusTicket[] = [
  { id: STATUS_ID.novo, nome: "Novo", categoria: "novo", ordem: 1, ativo: true, justificativas: [] },
  { id: STATUS_ID.emAtendimento, nome: "Em atendimento", categoria: "andamento", ordem: 2, ativo: true, justificativas: [] },
  {
    id: STATUS_ID.aguardando,
    nome: "Aguardando",
    categoria: "pendente",
    ordem: 3,
    ativo: true,
    justificativas: [
      j(JUSTIFICATIVA_ID.retornoCliente, STATUS_ID.aguardando, "Retorno do cliente", 1),
      j(JUSTIFICATIVA_ID.fornecedor, STATUS_ID.aguardando, "Fornecedor", 2),
      j(JUSTIFICATIVA_ID.pendenciaVistoria, STATUS_ID.aguardando, "Pendência vistoria", 3),
      j(JUSTIFICATIVA_ID.preFechamento, STATUS_ID.aguardando, "Pré-fechamento", 4),
      j(JUSTIFICATIVA_ID.cotacao, STATUS_ID.aguardando, "Cotação", 5),
      j(JUSTIFICATIVA_ID.aprovacaoGestor, STATUS_ID.aguardando, "Aprovação do gestor", 6),
    ],
  },
  { id: STATUS_ID.resolvido, nome: "Resolvido", categoria: "resolvido", ordem: 4, ativo: true, justificativas: [] },
  { id: STATUS_ID.fechado, nome: "Fechado", categoria: "fechado", ordem: 5, ativo: true, justificativas: [] },
  { id: STATUS_ID.cancelado, nome: "Cancelado", categoria: "cancelado", ordem: 6, ativo: true, justificativas: [] },
  {
    id: STATUS_ID.reaberto,
    nome: "Reaberto",
    categoria: "andamento",
    ordem: 7,
    ativo: true,
    justificativas: [j(JUSTIFICATIVA_ID.peloCliente, STATUS_ID.reaberto, "Pelo cliente", 1)],
  },
];

/** Campos de status de um ticket (status_id, nome, categoria e justificativa) a partir do cadastro inicial. */
export function statusFields(statusId: number, justificativaId: number | null = null) {
  const s = STATUS_INICIAIS.find((x) => x.id === statusId) ?? STATUS_INICIAIS[0];
  const j = s.justificativas.find((x) => x.id === justificativaId) ?? null;
  return { status_id: s.id, status: s.nome, status_categoria: s.categoria, justificativa_id: j?.id ?? null, justificativa: j?.nome ?? null };
}
