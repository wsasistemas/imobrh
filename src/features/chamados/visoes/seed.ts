import { JUSTIFICATIVA_ID as J, STATUS_ID as S } from "../status/seed";
import type { ColunaKanban, ConfigAgrupamento, Visao } from "./types";

// Visões iniciais e Kanban padrão do sistema (os mesmos da migration ch_visoes). As colunas seguem o modelo
// da Movidesk do print do Wagner; "Cotação" e "Aprovação do gestor" ficam em "Status sem coluna".

export const KANBAN_PADRAO: ColunaKanban[] = [
  { id: "a-fazer", nome: "A Fazer", status: [{ statusId: S.novo, justificativaId: null }] },
  { id: "a-fazer-aguardando", nome: "A Fazer · Aguardando", status: [{ statusId: S.aguardando, justificativaId: J.retornoCliente }] },
  {
    id: "em-atendimento",
    nome: "Em atendimento",
    status: [
      { statusId: S.emAtendimento, justificativaId: null },
      { statusId: S.aguardando, justificativaId: J.pendenciaVistoria },
      { statusId: S.aguardando, justificativaId: J.fornecedor },
    ],
  },
  {
    id: "pre-fechamento",
    nome: "Pré-fechamento",
    status: [
      { statusId: S.aguardando, justificativaId: J.preFechamento },
      { statusId: S.resolvido, justificativaId: null },
    ],
  },
  { id: "reabertura", nome: "Reabertura", status: [{ statusId: S.reaberto, justificativaId: null }] },
  {
    id: "concluido",
    nome: "Concluído",
    status: [
      { statusId: S.fechado, justificativaId: null },
      { statusId: S.cancelado, justificativaId: null },
    ],
  },
];

export const AGRUPAMENTO_PADRAO: ConfigAgrupamento = {
  por: null,
  ordemGrupos: "az",
  ordenar: "sla",
  porPagina: 25,
  colunas: ["solicitante", "status", "responsavel", "sla"],
};

/** Equipes "Sistemas" e "Infraestrutura" (mock de equipes). */
const EQUIPES_TI = [6, 7];

const base = {
  habilitada: true,
  equipes: EQUIPES_TI,
  kanban: { colunas: KANBAN_PADRAO, ordenar: "sla" as const, arrastar: "mudar_status" as const },
  agrupamento: AGRUPAMENTO_PADRAO,
  atualizadoEm: "2026-10-07T12:00:00-03:00",
  atualizadoPor: "Wagner Antunes",
};

export const VISOES_INICIAIS: Visao[] = [
  {
    ...base,
    id: 1,
    nome: "TI · Fila de chamados",
    tipo: "kanban",
    padrao: true,
    condicoes: { todas: [{ campo: "equipe", operador: "igual", valores: ["Sistemas", "Infraestrutura"] }], qualquer: [] },
  },
  {
    ...base,
    id: 2,
    nome: "TI · Por equipe",
    tipo: "lista",
    padrao: false,
    condicoes: { todas: [{ campo: "equipe", operador: "igual", valores: ["Sistemas", "Infraestrutura"] }], qualquer: [] },
    agrupamento: { ...AGRUPAMENTO_PADRAO, por: "equipe", colunas: ["solicitante", "status", "responsavel", "prioridade", "sla"] },
  },
  {
    ...base,
    id: 3,
    nome: "Meus tickets",
    tipo: "kanban",
    padrao: false,
    condicoes: { todas: [{ campo: "responsavel", operador: "usuario_logado", valores: [] }], qualquer: [] },
  },
];
