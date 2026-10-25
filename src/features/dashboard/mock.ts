import { JUSTIFICATIVA_ID, STATUS_ID, statusFields } from "../chamados/status/seed";
import type { DashboardPayload, DashboardService, DashboardTicket, DashboardUser, TicketOrigin, TicketPrioridade } from "./types";

// Mesma amostra da referência (Downloads/02-dashboard.html): 76 tickets abertos gerados pelas mesmas regras,
// para os números dos KPIs, da fila e da distribuição baterem com o protótipo. Mais 30 resolvidos/fechados
// para o card Fechados. Os responsáveis são usuários do modo simulado (mock/db.ts), então o "Ver como"
// mostra os números de cada um.

const GENERATED_AT = "2026-10-07T12:00:00-03:00";
const HOUR_MS = 3_600_000;

const CURRENT_USER: DashboardUser = { id: "u-wagner", name: "Wagner Antunes", initials: "WA" };
const ANA: DashboardUser = { id: "u-ana", name: "Ana Lima", initials: "AL" };
const BRUNO: DashboardUser = { id: "u-bruno", name: "Bruno Rocha", initials: "BR" };

const SERVICES: DashboardService[] = [
  // Mesmos ids do catálogo de serviços (Administração › Serviços, seed dos cadastros).
  { id: 3, name: "ERP Sienge", team: "Sistemas", sla_hours: 8 },
  { id: 4, name: "Portais internos", team: "Sistemas", sla_hours: 8 },
  { id: 7, name: "Rede / VPN", team: "Infraestrutura", sla_hours: 4 },
  { id: 5, name: "Acessos e usuários", team: "Sistemas", sla_hours: 8 },
  { id: 9, name: "Impressão", team: "Infraestrutura", sla_hours: 8 },
  { id: 10, name: "Equipamentos", team: "Infraestrutura", sla_hours: 16 },
];

const SUBJECTS = [
  "Sienge não gera boleto da unidade 1204",
  "Erro ao lançar NF no Portal Financeiro",
  "VPN sem acesso no canteiro Recreio",
  "Criar usuário para admissão (DP)",
  "Impressora do almoxarifado offline",
  "Troca de notebook — Engenharia",
];

const PEOPLE = ["Mariana Costa", "Pedro Alves", "Ana Souza", "Carla Mendes", "Bruno Lima", "Lucas Reis"];

function origin(i: number): TicketOrigin {
  if (i < 18) return "Intranet";
  if (i < 27) return "E-mail";
  if (i < 29) return "Agente";
  return i % 2 ? "Intranet" : "E-mail";
}

function owner(i: number): DashboardUser | null {
  if (i < 17) return null;
  if (i % 3 === 0) return CURRENT_USER;
  return i < 42 ? ANA : BRUNO;
}

const AGUARDANDO = [JUSTIFICATIVA_ID.retornoCliente, JUSTIFICATIVA_ID.fornecedor, JUSTIFICATIVA_ID.pendenciaVistoria, JUSTIFICATIVA_ID.preFechamento];

function status(i: number) {
  if (i < 17) return statusFields(STATUS_ID.novo);
  if (i < 49) return statusFields(STATUS_ID.emAtendimento);
  return statusFields(STATUS_ID.aguardando, AGUARDANDO[i % AGUARDANDO.length]);
}

const PRIORIDADES: TicketPrioridade[] = ["Normal", "Normal", "Alta", "Normal", "Baixa", "Urgente"];

function recebidoEm(o: TicketOrigin): string {
  if (o === "E-mail") return "chamados.ti@exemplo.com.br";
  return o === "Intranet" ? "Intranet" : "Agente";
}

/** Hora de criação: os "abertos hoje" caem no dia de GENERATED_AT; os demais, nos dias anteriores. */
function criadoEm(i: number, hoje: boolean): string {
  const horas = hoje ? (i % 4) + 1 : 24 + i * 3;
  return new Date(Date.parse(GENERATED_AT) - horas * HOUR_MS).toISOString();
}

function dueMinutes(i: number): number {
  if (i < 38) return -3120 + i * 80;
  if (i < 43) return 60 + (i - 38) * 50;
  return 1440 + (i - 43) * 90;
}

const OPEN_TICKETS: DashboardTicket[] = Array.from({ length: 76 }, (_, i) => {
  let cat = i < 42 ? (i % 2 ? 3 : 0) : [2, 4, 5][i % 3];
  if (i === 1) cat = 1;
  return {
    id: 48213 + i,
    subject: SUBJECTS[cat],
    requester: PEOPLE[i % 6],
    description: "Chamado demonstrativo para validar o fluxo de atendimento e a hierarquia visual.",
    service_id: SERVICES[cat].id,
    team: SERVICES[cat].team,
    origin: origin(i),
    owner: owner(i),
    ...status(i),
    prioridade: PRIORIDADES[i % PRIORIDADES.length],
    tags: i % 5 === 0 ? ["Verificado"] : i % 7 === 0 ? ["Urgente"] : [],
    recebido_em: recebidoEm(origin(i)),
    criado_em: criadoEm(i, i < 29),
    sla_due_minutes: dueMinutes(i),
    opened_today: i < 29,
    closed_at: null,
  };
});

// Fechados: um a cada 7h para trás a partir de GENERATED_AT; os 2 primeiros caem hoje, os 5 últimos fora dos 7 dias.
const CLOSED_TICKETS: DashboardTicket[] = Array.from({ length: 30 }, (_, i) => {
  const cat = i % 6;
  return {
    id: 48183 + i,
    subject: SUBJECTS[cat],
    requester: PEOPLE[(i + 2) % 6],
    description: "Chamado demonstrativo já resolvido.",
    service_id: SERVICES[cat].id,
    team: SERVICES[cat].team,
    origin: i % 2 ? "E-mail" : "Intranet",
    owner: [CURRENT_USER, ANA, BRUNO][i % 3],
    ...statusFields(i % 2 ? STATUS_ID.fechado : STATUS_ID.resolvido),
    prioridade: "Normal",
    tags: [],
    recebido_em: i % 2 ? "chamados.ti@exemplo.com.br" : "Intranet",
    criado_em: new Date(Date.parse(GENERATED_AT) - (i * 7 + 30) * HOUR_MS).toISOString(),
    sla_due_minutes: 0,
    opened_today: false,
    closed_at: new Date(Date.parse(GENERATED_AT) - i * 7 * HOUR_MS).toISOString(),
  };
});

export const dashboardMock: DashboardPayload = {
  generated_at: GENERATED_AT,
  current_user: CURRENT_USER,
  my_teams: ["Sistemas", "Infraestrutura"],
  teams: [
    { name: "Sistemas", color_token: "--ds-team-sistemas" },
    { name: "Infraestrutura", color_token: "--ds-team-infra" },
  ],
  services: SERVICES,
  tickets: [...OPEN_TICKETS, ...CLOSED_TICKETS],
  triage: {
    period: "Hoje · amostra geral",
    automatic: 26,
    total: 29,
    by_intranet_form: 18,
    by_email_rule: 5,
    by_ai: 3,
    manual: 3,
    pending_review: 1,
  },
  sla_health: { period: "7 dias", first_response_percent: 92, resolution_percent: 78 },
  inbound: [2, 6, 5, 4, 3, 1, 3, 2, 2, 1, 0].map((today, i) => ({
    hour: 8 + i,
    today,
    yesterday: [3, 4, 5, 3, 2, 2, 2, 1, 1, 1, 0][i],
  })),
};
