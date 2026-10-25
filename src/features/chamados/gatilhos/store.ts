import { JUSTIFICATIVA_ID, STATUS_ID } from "../status/seed";
import type { ExecucaoGatilho, Gatilho, Notificacao, TipoDisparo } from "./types";

// Dados do modo simulado (os mesmos gatilhos de exemplo da migration, inativos: G7). Sem imports do ticket,
// para o serviço do ticket e o dos gatilhos usarem este módulo sem ciclo.

const base = { para: "tickets" as const, ativo: false, atualizadoEm: null, atualizadoPor: "Sistema", execucoes7d: 0, erros7d: 0 };

const gatilhos: Gatilho[] = [
  {
    ...base,
    id: 1,
    ordem: 1,
    nome: "Cliente respondeu → volta para Em atendimento",
    disparos: [{ tipo: "acao_solicitante" }],
    todas: [{ campo: "status", operador: "um_de", valores: [String(STATUS_ID.aguardando)] }],
    qualquer: [],
    acoes: [
      { tipo: "status", statusId: STATUS_ID.emAtendimento, justificativaId: null },
      { tipo: "avisar", quem: "responsavel", texto: "O solicitante respondeu." },
    ],
    execucao: "evento",
  },
  {
    ...base,
    id: 2,
    ordem: 2,
    nome: "Sem retorno do cliente em 48 h úteis → Resolvido",
    disparos: [{ tipo: "tempo_status", horas: 48 }],
    todas: [{ campo: "status", operador: "um_de", valores: [`${STATUS_ID.aguardando}:${JUSTIFICATIVA_ID.retornoCliente}`] }],
    qualquer: [],
    acoes: [
      { tipo: "responder_macro", macroId: 4 },
      { tipo: "solucao", texto: "Encerrado por falta de retorno do solicitante." },
      { tipo: "status", statusId: STATUS_ID.resolvido, justificativaId: null },
    ],
    execucao: "evento",
  },
  {
    ...base,
    id: 3,
    ordem: 3,
    nome: "Urgência urgente → avisar a equipe",
    disparos: [{ tipo: "criado" }, { tipo: "alterado" }],
    todas: [{ campo: "urgencia", operador: "um_de", valores: ["1"] }],
    qualquer: [],
    acoes: [
      { tipo: "tags_adicionar", tags: ["urgente"] },
      { tipo: "nota_interna", texto: "Ticket urgente: a equipe foi avisada." },
      { tipo: "avisar", quem: "equipe", texto: "Chegou um ticket urgente." },
    ],
    execucao: "ticket",
  },
  {
    ...base,
    id: 4,
    ordem: 4,
    nome: "SLA vence em 2 h sem responsável",
    disparos: [{ tipo: "sla_vence", horas: 2 }],
    todas: [{ campo: "responsavel", operador: "vazio", valores: [] }],
    qualquer: [],
    acoes: [
      { tipo: "avisar", quem: "lider", texto: "O SLA vence em menos de 2 h e o ticket está sem responsável." },
      { tipo: "seguidor", modo: "lider" },
    ],
    execucao: "evento",
  },
];

/** A chave evita repetir (como a unique do banco): 'ev:<n>', 'ticket', 'tempo:<entrada>'... */
const execucoes: (ExecucaoGatilho & { chave: string })[] = [];
const notificacoes: (Notificacao & { usuarioId: string })[] = [];
let seq = 100;

export const gatilhosMock = () => gatilhos;
export const execucoesMock = () => execucoes;
export const proximoId = () => ++seq;

export function jaExecutou(gatilhoId: number, ticketId: number, chave: string) {
  return execucoes.some((e) => e.gatilhoId === gatilhoId && e.ticketId === ticketId && e.chave === chave);
}

export function registrarExecucao(g: Gatilho, ticketId: number, chave: string, disparo: TipoDisparo, resultado: "executado" | "erro", detalhe: string) {
  execucoes.unshift({ id: ++seq, gatilhoId: g.id, gatilho: g.nome, ticketId, disparo, resultado, detalhe, criadoEm: new Date().toISOString(), chave });
  if (resultado === "executado") g.execucoes7d++;
  else g.erros7d++;
}

export function notificarMock(usuarios: (string | null | undefined)[], ticketId: number, titulo: string, texto: string) {
  for (const u of new Set(usuarios.filter((x): x is string => Boolean(x)))) {
    notificacoes.unshift({ id: ++seq, usuarioId: u, ticketId, titulo, texto, lida: false, criadoEm: new Date().toISOString() });
  }
}

export function notificacoesDe(usuarioId: string) {
  return notificacoes.filter((n) => n.usuarioId === usuarioId);
}
