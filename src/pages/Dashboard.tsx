import { Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { getMenuItem } from "../config/menuRegistry";
import {
  AlertBanner,
  DetailBody,
  DetailDialog,
  FilterSelect,
  InboundChart,
  KpiCard,
  NewTicketDialog,
  PageHeading,
  Panel,
  PanelHeader,
  Pill,
  QueueTable,
  ScopeSegmented,
  SlaHealth,
  slaLabel,
  TablePagination,
  TeamDistribution,
  Toast,
  TriagePanel,
  useToast,
  type NewTicketInput,
  type TicketService,
} from "../components/ds";
import "./Dashboard.css";
import { STATUS_ID } from "../features/chamados/status/seed";
import { rotuloStatus } from "../features/chamados/status/types";
import { METRIC_LABELS, METRICS, parseMetric, parseScope, toQueueRow } from "../features/dashboard/metrics";
import { baseTickets, clampPage, isClosed, metricPredicates, QUEUE_PAGE_SIZE, queueTickets } from "../features/dashboard/queue";
import type { DashboardMetric, DashboardScope } from "../features/dashboard/types";
import { ComPainel, useAtualizarTicket, useCriarTicket } from "../features/dashboard/useDashboardData";
import type { DashboardPayload } from "../features/dashboard/types";
import { TopSolicitantes } from "../features/dashboard/TopSolicitantes";
import { ServiceError } from "../features/configuracoes/services/types";

// Gestão de Chamados › Visão geral (seção `gestao_chamados_visao_geral`), recriada da referência 02-dashboard.html
// dentro do layout do portal. Dados de exemplo em features/dashboard/mock.ts; sem Supabase nesta etapa.
// Abre já filtrada por ?escopo=, ?metrica= e ?ticket= (links do resumo da Página Inicial).


const SCOPES = [
  { value: "mine", label: "Meus" },
  { value: "team", label: "Minha equipe" },
  { value: "all", label: "Todos" },
] as const;

const ORIGINS = [
  { value: "", label: "Todas" },
  { value: "E-mail", label: "E-mail" },
  { value: "Intranet", label: "Intranet" },
  { value: "Agente", label: "Agente" },
];

type Detail = { kind: "ticket"; id: number } | { kind: "review" } | null;

export function Dashboard() {
  return <ComPainel>{(data) => <DashboardConteudo data={data} />}</ComPainel>;
}

function DashboardConteudo({ data }: { data: DashboardPayload }) {
  const [params] = useSearchParams();
  const me = data.current_user;
  const services: TicketService[] = data.services.map((s) => ({ id: s.id, name: s.name, team: s.team, slaHours: s.sla_hours }));
  const tickets = data.tickets;
  const atualizar = useAtualizarTicket();
  const criar = useCriarTicket();
  const [scope, setScope] = useState<DashboardScope>(() => parseScope(params.get("escopo")) ?? "team");
  const [team, setTeam] = useState("");
  const [origin, setOrigin] = useState("");
  const [metric, setMetricState] = useState<DashboardMetric>(() => parseMetric(params.get("metrica")) ?? "all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [newOpen, setNewOpen] = useState(false);
  const [detail, setDetail] = useState<Detail>(() => {
    const id = Number(params.get("ticket"));
    return data.tickets.some((t) => t.id === id) ? { kind: "ticket", id } : null;
  });
  const toast = useToast();

  const base = useMemo(
    () => baseTickets(tickets, { scope, team, origin, currentUserId: me.id, myTeams: data.my_teams }),
    [tickets, scope, team, origin, me.id, data.my_teams],
  );
  const now = useMemo(() => new Date(data.generated_at), [data.generated_at]);
  const predicates = useMemo(() => metricPredicates(now), [now]);
  const queue = useMemo(() => queueTickets(base, metric, search, now), [base, metric, search, now]);
  const currentPage = clampPage(page, queue.length);
  const late = base.filter(predicates.late).length;
  // Backlog = o que está aberto no recorte (base da Distribuição da equipe).
  const backlog = base.filter(predicates.all);

  const rows = queue.slice(currentPage * QUEUE_PAGE_SIZE, (currentPage + 1) * QUEUE_PAGE_SIZE).map((t) => toQueueRow(t, data));

  const teams = data.teams.map((tm) => {
    const own = backlog.filter((t) => t.team === tm.name);
    return {
      name: tm.name,
      total: own.length,
      late: own.filter(predicates.late).length,
      unassigned: own.filter(predicates.unassigned).length,
      colorToken: tm.color_token,
    };
  });

  // Todo filtro volta para a primeira página, como na referência.
  function withFirstPage<T>(set: (v: T) => void) {
    return (v: T) => {
      set(v);
      setPage(0);
    };
  }
  const setMetric = withFirstPage(setMetricState);

  function resetAll() {
    setScope("team");
    setMetricState("all");
    setTeam("");
    setOrigin("");
    setSearch("");
    setPage(0);
  }

  function filterTeam(name: string) {
    setTeam(name);
    setMetric("all");
  }

  const falhou = (e: unknown, padrao: string) => toast.show(e instanceof ServiceError ? e.message : padrao);

  function assign(id: number) {
    atualizar.mutate(
      { id, patch: { responsavelId: me.id, statusId: STATUS_ID.emAtendimento, justificativaId: null } },
      {
        onSuccess: () => {
          setDetail(null);
          toast.show(`Ticket #${id} atribuído a você.`);
        },
        onError: (e) => falhou(e, "Não foi possível assumir o ticket."),
      },
    );
  }

  function createTicket(input: NewTicketInput) {
    criar.mutate(
      { assunto: input.subject, descricao: input.description, solicitanteNome: input.requester, servicoId: input.serviceId },
      {
        onSuccess: (id) => {
          setNewOpen(false);
          resetAll();
          setSearch(String(id));
          toast.show(`Ticket #${id} criado.`);
        },
        onError: (e) => falhou(e, "Não foi possível criar o ticket."),
      },
    );
  }

  const openTicket = detail?.kind === "ticket" ? tickets.find((t) => t.id === detail.id) : undefined;
  const metricLabel = METRIC_LABELS[metric];
  // Recortes que não têm KPI nesta tela (vêm dos cards da Página Inicial): avisa qual está aplicado.
  const summaryMetric = metric === "open" || metric === "pending" || metric === "closed";

  return (
    <div className="ds ds-page">
      <div className="ds-main">
        <PageHeading
          eyebrow="PAINEL DA OPERAÇÃO"
          title={`Olá, ${me.name.split(" ")[0]}.`}
          description="Sua equipe, suas prioridades. Tudo em um só lugar."
          action={
            <button type="button" className="ds-btn ds-btn--primary" onClick={() => setNewOpen(true)}>
              <Plus size={16} strokeWidth={1.6} aria-hidden="true" className="ds-btn__icon" />
              Novo ticket
            </button>
          }
        />

        <div className="ds-filters">
          <ScopeSegmented label="Escopo" options={SCOPES} value={scope} onChange={withFirstPage(setScope)} />
          <div className="ds-selects">
            <FilterSelect
              label="Equipe"
              ariaLabel="Filtrar equipe"
              value={team}
              onChange={withFirstPage(setTeam)}
              options={[{ value: "", label: "Todas" }, ...data.teams.map((t) => ({ value: t.name, label: t.name }))]}
            />
            <FilterSelect label="Origem" ariaLabel="Filtrar origem" value={origin} onChange={withFirstPage(setOrigin)} options={ORIGINS} />
          </div>
        </div>

        <div className="ds-kpis">
          {METRICS.map((m) => (
            <KpiCard
              key={m.key}
              label={m.label}
              hint={m.hint}
              variant={m.variant}
              value={base.filter(predicates[m.key]).length}
              selected={metric === m.key}
              onClick={() => setMetric(m.key)}
            />
          ))}
        </div>

        <AlertBanner
          title={`${late} tickets com SLA vencido neste recorte`}
          description="Priorize o maior atraso e distribua os tickets sem responsável."
          actionLabel="Ver vencidos →"
          onAction={() => setMetric("late")}
        />

        <div className="ds-grid">
          <Panel id="queue" aria-labelledby="queue-title">
            <PanelHeader
              title={metric === "closed" ? "Fechados recentemente" : "Precisa de ação agora"}
              titleId="queue-title"
              subtitle={metric === "closed" ? "Do mais recente para o mais antigo." : "Vencidos primeiro, depois o próximo prazo de SLA."}
              aside={<Pill tone="blue">{queue.length} tickets</Pill>}
            />
            <div className="ds-queue-tools">
              <input
                className="ds-search"
                type="search"
                aria-label="Buscar tickets"
                placeholder="Buscar nº, assunto ou solicitante..."
                value={search}
                onChange={(e) => withFirstPage(setSearch)(e.target.value)}
              />
              {summaryMetric && <Pill>Recorte: {metricLabel}</Pill>}
              <button type="button" className="ds-linkbtn" onClick={resetAll}>
                Limpar filtros
              </button>
            </div>
            <QueueTable rows={rows} onOpen={(id) => setDetail({ kind: "ticket", id })} />
            <TablePagination page={currentPage} pageSize={QUEUE_PAGE_SIZE} total={queue.length} context={metricLabel} onPageChange={setPage} />
          </Panel>

          <aside className="ds-rail">
            <TriagePanel
              subtitle={data.triage.period}
              automatic={data.triage.automatic}
              total={data.triage.total}
              bars={[
                { label: "Formulário da intranet", value: data.triage.by_intranet_form, tone: "ai" },
                { label: "Regras de e-mail", value: data.triage.by_email_rule, tone: "rule" },
                { label: "IA · confiança ≥ 80%", value: data.triage.by_ai, tone: "triage-ai" },
              ]}
              note={`${data.triage.manual} encaminhados para triagem manual.`}
              review={
                data.triage.pending_review
                  ? {
                      title: `${data.triage.pending_review} e-mail precisa da sua revisão`,
                      text: "Confiança abaixo de 80%. Validar categoria.",
                      onClick: () => setDetail({ kind: "review" }),
                    }
                  : undefined
              }
            />
            <SlaHealth
              period={data.sla_health.period}
              metrics={[
                { label: "1ª resposta", percent: data.sla_health.first_response_percent, tone: "success" },
                { label: "Solução", percent: data.sla_health.resolution_percent, tone: "warning" },
              ]}
              note={
                <>
                  Exemplo global · horário comercial por equipe.
                  <br />
                  Metas a definir conforme o PRD.
                </>
              }
            />
          </aside>
        </div>

        <div className="ds-bottomgrid">
          <InboundChart subtitle="Tickets por hora · exemplo global" data={data.inbound} max={6} />
          <TeamDistribution teams={teams} grandTotal={backlog.length} onSelect={filterTeam} />
        </div>

        <TopSolicitantes />

        <p className="ds-footnote ds-page__footnote">
          Ambiente demonstrativo. Filtros e indicadores da fila usam a mesma amostra. “Minha equipe” reúne Sistemas e Infraestrutura neste exemplo.
          Novos tickets permanecem apenas nesta sessão.
        </p>
      </div>

      <NewTicketDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        services={services}
        submitLabel="Criar ticket de exemplo"
        disclaimer="Simulação local. Equipe, prioridade e SLA são regras ilustrativas do catálogo, ainda sujeitas à validação."
        onSubmit={createTicket}
      />

      <DetailDialog
        open={detail !== null}
        onOpenChange={(open) => !open && setDetail(null)}
        title={detail?.kind === "review" ? "Revisão da classificação" : openTicket ? `Ticket #${openTicket.id}` : ""}
      >
        {openTicket && (
          <DetailBody>
            <h2 className="ds-h2">{openTicket.subject}</h2>
            <p className="ds-muted">
              Solicitante: {openTicket.requester} · Origem: {openTicket.origin}
            </p>
            <p>
              <Pill tone="blue">{openTicket.team}</Pill> <Pill>{rotuloStatus(openTicket.status, openTicket.justificativa)}</Pill>
            </p>
            <p>{openTicket.description}</p>
            <p>
              <strong>Responsável:</strong> {openTicket.owner ? (openTicket.owner.id === me.id ? "Você" : openTicket.owner.name) : "Não atribuído"}
            </p>
            {isClosed(openTicket) ? (
              <p>
                <strong>Encerramento:</strong> {toQueueRow(openTicket, data).closedLabel}
              </p>
            ) : (
              <p>
                <strong>SLA de solução:</strong> {slaLabel(openTicket.sla_due_minutes).toLowerCase()}
              </p>
            )}
            <p>
              <Link className="ds-btn ds-btn--primary" to={`${getMenuItem("gestao_chamados_tickets").path}/${openTicket.id}`}>
                Abrir ticket
              </Link>
            </p>
            {!openTicket.owner && !isClosed(openTicket) && (
              <button type="button" className="ds-btn ds-btn--primary" onClick={() => assign(openTicket.id)}>
                Assumir ticket nesta demonstração
              </button>
            )}
          </DetailBody>
        )}
        {detail?.kind === "review" && (
          <DetailBody>
            <p>
              <Pill tone="amber">Demonstração · confiança de 68%</Pill>
            </p>
            <h2 className="ds-h2">Erro ao acessar o sistema de compras</h2>
            <p>
              A IA sugere <strong>Sistemas › ERP Sienge</strong>. Confirme qual sistema foi afetado antes de aplicar a classificação.
            </p>
            <p className="ds-muted">
              O PRD prevê revisão humana para confiança abaixo de 80%. Este painel ilustra a revisão; a integração com IA não está conectada.
            </p>
          </DetailBody>
        )}
      </DetailDialog>

      <Toast message={toast.message} />
    </div>
  );
}
