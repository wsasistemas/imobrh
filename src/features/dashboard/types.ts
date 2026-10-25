import type { CategoriaStatus } from "../chamados/status/types";

// Formato que a RPC `imobdesk.ch_painel()` devolve (jsonb, snake_case). No modo simulado, o mock
// (./mock.ts) devolve o mesmo formato.

export type DashboardScope = "mine" | "team" | "all";

export type TicketOrigin = "E-mail" | "WhatsApp" | "Intranet" | "Agente";

/** Nome da urgência do cadastro (Administração › Urgências): "Urgente", "Alta", "Normal", "Baixa"… */
export type TicketPrioridade = string;

/**
 * Métrica dos KPIs; "all" = fila de trabalho (tudo que não está fechado).
 * open/pending/closed formam o resumo pessoal (Abertos · Pendentes · Fechados em 7 dias).
 */
export type DashboardMetric = "all" | "unassigned" | "late" | "today" | "active" | "waiting" | "opened" | "open" | "pending" | "closed";

export interface DashboardUser {
  id: string;
  name: string;
  /** Iniciais do avatar (ex.: "WA"). */
  initials: string;
}

export interface DashboardService {
  id: number;
  name: string;
  team: string;
  /** SLA de solução em horas úteis. */
  sla_hours: number;
}

export interface DashboardTicket {
  id: number;
  subject: string;
  requester: string;
  description: string;
  service_id: number;
  team: string;
  origin: TicketOrigin;
  /** null = sem responsável. */
  owner: DashboardUser | null;
  /** Status do cadastro (Gestão de Chamados › Status); a categoria decide os números do painel. */
  status_id: number;
  status: string;
  status_categoria: CategoriaStatus;
  justificativa_id: number | null;
  justificativa: string | null;
  prioridade: TicketPrioridade;
  tags: string[];
  /** Por onde chegou: conta de e-mail, número de WhatsApp ou "Intranet". */
  recebido_em: string;
  criado_em: string;
  /** Minutos até o prazo de solução, calculados no servidor; negativo = vencido. */
  sla_due_minutes: number;
  opened_today: boolean;
  /** Quando foi resolvido/fechado (ISO); null enquanto aberto. */
  closed_at: string | null;
}

export interface DashboardTeam {
  name: string;
  /** Token da cor da barra em Distribuição da equipe. */
  color_token: `--ds-${string}`;
}

export interface DashboardTriage {
  /** Recorte do painel (ex.: "Hoje · amostra geral"). */
  period: string;
  automatic: number;
  total: number;
  by_intranet_form: number;
  by_email_rule: number;
  by_ai: number;
  manual: number;
  /** E-mails com confiança abaixo de 80%, à espera de revisão humana. */
  pending_review: number;
}

export interface DashboardSlaHealth {
  period: string;
  first_response_percent: number;
  resolution_percent: number;
}

export interface DashboardInboundPoint {
  hour: number;
  today: number;
  yesterday: number;
}

export interface DashboardPayload {
  /** "Agora" do servidor: base de "fechados hoje" e "nos últimos 7 dias". */
  generated_at: string;
  current_user: DashboardUser;
  /** Equipes que compõem o escopo "Minha equipe". */
  my_teams: string[];
  teams: DashboardTeam[];
  services: DashboardService[];
  tickets: DashboardTicket[];
  triage: DashboardTriage;
  sla_health: DashboardSlaHealth;
  inbound: DashboardInboundPoint[];
}
