// Cadastro de status de ticket (docs/PLANO-tickets-visoes.md, D2: cadastro à parte).
// Cada status tem uma CATEGORIA fixa: é ela que decide os números do resumo (Abertos · Pendentes · Fechados),
// os KPIs e o que sai da fila de trabalho. O nome e as justificativas são livres.

export type CategoriaStatus = "novo" | "andamento" | "pendente" | "resolvido" | "fechado" | "cancelado";

export const CATEGORIAS: readonly { value: CategoriaStatus; label: string; descricao: string }[] = [
  { value: "novo", label: "Novo", descricao: "Entrou e ninguém começou. Conta em Abertos." },
  { value: "andamento", label: "Em andamento", descricao: "Alguém está atendendo. Conta em Abertos." },
  { value: "pendente", label: "Pendente", descricao: "Aguardando solicitante, fornecedor ou outra área. Conta em Pendentes." },
  { value: "resolvido", label: "Resolvido", descricao: "Solução entregue, aguardando confirmação. Conta em Fechados." },
  { value: "fechado", label: "Fechado", descricao: "Encerrado. Conta em Fechados." },
  { value: "cancelado", label: "Cancelado", descricao: "Encerrado sem solução. Sai da fila e não conta em Fechados." },
];

/** Categorias que tiram o ticket da fila de trabalho. */
export const CATEGORIAS_ENCERRADAS: readonly CategoriaStatus[] = ["resolvido", "fechado", "cancelado"];
/** Categorias que contam no card Fechados. */
export const CATEGORIAS_FECHADAS: readonly CategoriaStatus[] = ["resolvido", "fechado"];

export interface Justificativa {
  id: number;
  statusId: number;
  nome: string;
  ordem: number;
  ativa: boolean;
}

export interface StatusTicket {
  id: number;
  nome: string;
  categoria: CategoriaStatus;
  ordem: number;
  ativo: boolean;
  justificativas: Justificativa[];
}

export interface StatusSalvar {
  id?: number;
  nome: string;
  categoria: CategoriaStatus;
  ativo: boolean;
}

export interface JustificativaSalvar {
  id?: number;
  statusId: number;
  nome: string;
  ativa: boolean;
}

/** "Aguardando › Retorno do cliente" ou só "Novo". */
export function rotuloStatus(status: string, justificativa?: string | null): string {
  return justificativa ? `${status} › ${justificativa}` : status;
}
