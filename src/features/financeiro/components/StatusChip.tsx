// StatusChip (CONTEXTO.md, seção 7 e 9.5): sempre com texto, nunca só a cor.

export type StatusSolicitacao =
  | "rascunho" | "em_aprovacao" | "devolvida" | "reprovada" | "cancelada" | "em_conferencia" | "pendencia_solicitante" | "lancamento_gerado"
  | "pagamento_programado" | "paga" | "comprovacao_pendente" | "comprovacao_em_conferencia" | "devolucao_pendente" | "encerrada";

type Tom = "neutro" | "aviso" | "roxo" | "info" | "ok" | "erro";

export const STATUS: Record<StatusSolicitacao, { rotulo: string; tom: Tom }> = {
  rascunho: { rotulo: "Rascunho", tom: "neutro" },
  em_aprovacao: { rotulo: "Em aprovação", tom: "aviso" },
  devolvida: { rotulo: "Devolvida para ajuste", tom: "roxo" },
  reprovada: { rotulo: "Reprovada", tom: "erro" },
  cancelada: { rotulo: "Cancelada", tom: "neutro" },
  em_conferencia: { rotulo: "Em conferência", tom: "aviso" },
  pendencia_solicitante: { rotulo: "Pendência", tom: "roxo" },
  lancamento_gerado: { rotulo: "Lançamento gerado", tom: "info" },
  pagamento_programado: { rotulo: "Aguardando pagamento", tom: "info" },
  paga: { rotulo: "Paga", tom: "ok" },
  comprovacao_pendente: { rotulo: "Comprovação pendente", tom: "aviso" },
  comprovacao_em_conferencia: { rotulo: "Comprovação em conferência", tom: "aviso" },
  devolucao_pendente: { rotulo: "Devolução pendente", tom: "erro" },
  encerrada: { rotulo: "Encerrado", tom: "ok" },
};

export function StatusChip({ status, texto }: { status: StatusSolicitacao; texto?: string }) {
  const s = STATUS[status];
  return <span className={`sf-chip sf-chip--${s.tom}`}>{texto ?? s.rotulo}</span>;
}
