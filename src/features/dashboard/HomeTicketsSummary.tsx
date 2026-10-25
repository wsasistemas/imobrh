import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { formatDuration, slaTone } from "../../components/ds/sla";
import { STORAGE_PREFIX } from "../../config/app";
import { getMenuItem } from "../../config/menuRegistry";
import { dashboardLink, parseScope } from "./metrics";
import { baseTickets, closedToday, CLOSED_WINDOW_DAYS, metricPredicates, queueTickets } from "./queue";
import type { DashboardMetric, DashboardScope, DashboardTicket } from "./types";
import { ComPainel } from "./useDashboardData";
import type { DashboardPayload } from "./types";
import "./HomeTicketsSummary.css";

// Resumo de chamados na Página Inicial, no visual do portal (Inter, cor de destaque, cards dos módulos).
// Abertos · Pendentes · Fechados (7 dias), mais "Sem responsável" no escopo da equipe, e os próximos prazos.
// Montado com key = id do usuário (Home), para o "Ver como" recalcular o escopo inicial.
// Cada card e cada chamado abrem a Gestão de Chamados já filtrada (?escopo=, ?metrica=, ?ticket=).

const SCOPES: { value: DashboardScope; label: string }[] = [
  { value: "mine", label: "Meus" },
  { value: "team", label: "Minha equipe" },
];

const PREVIEW_SIZE = 5;
/** Escolha do escopo, por usuário (computador compartilhado). */
const scopeKey = (userId: string) => `${STORAGE_PREFIX}:home-chamados-escopo:${userId}`;

function readScope(userId: string): DashboardScope | null {
  try {
    return parseScope(localStorage.getItem(scopeKey(userId)));
  } catch {
    return null;
  }
}

function saveScope(userId: string, scope: DashboardScope) {
  try {
    localStorage.setItem(scopeKey(userId), scope);
  } catch {
    // Sem storage (aba privada): só não lembra a escolha.
  }
}

const SLA_CLASS = { red: "ts-badge--danger", amber: "ts-badge--warning", blue: "" } as const;

function SlaBadge({ minutes }: { minutes: number }) {
  return (
    <span className={`ts-badge ${SLA_CLASS[slaTone(minutes)]}`}>
      {minutes < 0 ? "Vencido há" : "Vence em"} {formatDuration(minutes)}
    </span>
  );
}

interface SummaryCardProps {
  to: string;
  label: string;
  aside?: string;
  value: number;
  action: string;
  children: ReactNode;
  wide?: boolean;
}

function SummaryCard({ to, label, aside, value, action, children, wide = false }: SummaryCardProps) {
  return (
    <Link to={to} className={`ts-card${wide ? " ts-card--wide" : ""}`}>
      <span className="ts-card__label">
        {label}
        {aside && <small>{aside}</small>}
      </span>
      <strong className="ts-card__value">{value}</strong>
      <span className="ts-card__detail">{children}</span>
      <span className="ts-card__action" aria-hidden="true">
        {action} →
      </span>
    </Link>
  );
}

export function HomeTicketsSummary() {
  return <ComPainel skeleton={false}>{(data) => <Resumo data={data} />}</ComPainel>;
}

function Resumo({ data }: { data: DashboardPayload }) {
  const { path } = getMenuItem("gestao_chamados_visao_geral");
  const now = useMemo(() => new Date(data.generated_at), [data.generated_at]);
  const P = useMemo(() => metricPredicates(now), [now]);

  const baseFor = (scope: DashboardScope) =>
    baseTickets(data.tickets, { scope, team: "", origin: "", currentUserId: data.current_user.id, myTeams: data.my_teams });

  // Sem escolha salva: "Meus" quando o usuário tem chamados em aberto, senão a equipe.
  const [scope, setScope] = useState<DashboardScope>(() => readScope(data.current_user.id) ?? (baseFor("mine").some(P.all) ? "mine" : "team"));
  const mine = scope === "mine";

  const base = useMemo(
    () => baseTickets(data.tickets, { scope, team: "", origin: "", currentUserId: data.current_user.id, myTeams: data.my_teams }),
    [data, scope],
  );
  const queue = useMemo(() => queueTickets(base, "all", "", now), [base, now]);

  const open = base.filter(P.open);
  const lateOpen = open.filter(P.late).length;
  const todayOpen = open.filter(P.today).length;
  const pending = base.filter(P.pending).length;
  const closed = base.filter(P.closed).length;
  const closedNow = base.filter((t) => closedToday(t, now)).length;
  const unassigned = base.filter(P.unassigned).length;

  const link = (params: { metric?: DashboardMetric; ticket?: number }) => dashboardLink(path, { scope, ...params });

  function changeScope(next: DashboardScope) {
    setScope(next);
    saveScope(data.current_user.id, next);
  }

  function ownerText(t: DashboardTicket) {
    if (!t.owner) return <span className="ts-row__unassigned">Não atribuído</span>;
    return t.owner.id === data.current_user.id ? "Você" : t.owner.name;
  }

  return (
    <section className="ts" aria-labelledby="ts-title">
      <div className="ts-head">
        <h2 className="section-title" id="ts-title">
          {mine ? "Meus chamados" : "Chamados da equipe"}
        </h2>
        <div className="ts-head__tools">
          <div className="ts-seg" role="group" aria-label="Escopo dos chamados">
            {SCOPES.map((s) => (
              <button key={s.value} type="button" aria-pressed={scope === s.value} onClick={() => changeScope(s.value)}>
                {s.label}
              </button>
            ))}
          </div>
          <Link className="ts-link" to={link({})}>
            Abrir Gestão de Chamados →
          </Link>
        </div>
      </div>

      <div className={`ts-cards${mine ? "" : " ts-cards--four"}`}>
        <SummaryCard to={link({ metric: "open" })} label="Abertos" aside={mine ? "com você" : "na equipe"} value={open.length} action="Ver abertos" wide={mine}>
          <span className="ts-chips">
            {lateOpen > 0 && <span className="ts-badge ts-badge--danger">{lateOpen} vencidos</span>}
            {todayOpen > 0 && <span className="ts-badge ts-badge--warning">{todayOpen} vencem hoje</span>}
            {open.length === 0 && <span className="ts-badge">Nenhum aberto</span>}
            {open.length > 0 && lateOpen === 0 && todayOpen === 0 && <span className="ts-badge ts-badge--success">Tudo no prazo</span>}
          </span>
        </SummaryCard>
        <SummaryCard to={link({ metric: "pending" })} label="Pendentes" value={pending} action="Ver pendentes">
          Aguardando solicitante ou fornecedor
        </SummaryCard>
        <SummaryCard to={link({ metric: "closed" })} label="Fechados" aside={`${CLOSED_WINDOW_DAYS} dias`} value={closed} action="Ver fechados">
          {closedNow} hoje
        </SummaryCard>
        {!mine && (
          <SummaryCard to={link({ metric: "unassigned" })} label="Sem responsável" value={unassigned} action="Assumir">
            Disponíveis para assumir
          </SummaryCard>
        )}
      </div>

      <section className="ts-panel" aria-labelledby="ts-queue-title">
        <div className="ts-panel__head">
          <div>
            <h3 id="ts-queue-title">{mine ? "Seus próximos prazos" : "Próximos prazos da equipe"}</h3>
            <p>Vencidos primeiro, depois o próximo prazo de SLA.</p>
          </div>
          <span className="ts-badge">{queue.length} tickets</span>
        </div>

        {queue.length === 0 ? (
          <p className="ts-empty">
            {mine ? "Nenhum chamado aberto com você agora." : "Nenhum chamado aberto na equipe."}{" "}
            {mine && (
              <button type="button" className="ts-link" onClick={() => changeScope("team")}>
                Ver fila da equipe →
              </button>
            )}
          </p>
        ) : (
          <ul className="ts-list">
            {queue.slice(0, PREVIEW_SIZE).map((t) => (
              <li key={t.id} className="ts-row">
                <div className="ts-row__main">
                  <div className="ts-row__meta">
                    <span className="ts-row__id">#{t.id}</span> · {t.requester}
                    {!mine && <> · {ownerText(t)}</>}
                  </div>
                  <Link className="ts-row__subject" to={`${getMenuItem("gestao_chamados_tickets").path}/${t.id}`}>
                    {t.subject}
                  </Link>
                  <div className="ts-row__category">
                    {t.team} › {data.services.find((s) => s.id === t.service_id)?.name}
                  </div>
                </div>
                <span className="ts-row__origin">
                  <span className="ts-badge">{t.origin}</span>
                </span>
                <span className="ts-row__sla">
                  <SlaBadge minutes={t.sla_due_minutes} />
                </span>
              </li>
            ))}
          </ul>
        )}

        {queue.length > PREVIEW_SIZE && (
          <div className="ts-panel__foot">
            <span>
              {PREVIEW_SIZE} de {queue.length} tickets
            </span>
            <Link className="ts-link" to={link({})}>
              Ver fila completa →
            </Link>
          </div>
        )}
      </section>
    </section>
  );
}
