import { Activity, AlignLeft, CalendarClock, Download, FileSearch, Inbox, LayoutGrid, Search, User } from "lucide-react";
import { useState } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { Breadcrumb } from "../../../components/Breadcrumb";
import { getMenuItem } from "../../../config/menuRegistry";
import { formatDateTime } from "../../../utils/dates";
import { configBreadcrumb } from "../components/configBreadcrumb";
import { DataTable, type Column } from "../components/DataTable";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { Pagination } from "../components/Pagination";
import { StatusBadge, type StatusBadgeVariant } from "../components/StatusBadge";
import { useAuditLog, useExportAudit } from "../hooks/useAudit";
import { AUDIT_ACTION_LABELS, AUDIT_MODULE_LABELS } from "../services/labels";
import type { AuditAction, AuditEntry, AuditFilters, AuditModule, AuditPeriod, AuditValues } from "../services/types";
import "./Auditoria.css";

const PERIODS: { value: AuditPeriod; label: string }[] = [
  { value: "today", label: "Hoje" },
  { value: "7d", label: "Últimos 7 dias" },
  { value: "30d", label: "Últimos 30 dias" },
  { value: "all", label: "Todo o período" },
];

const ACTION_VARIANTS: Record<AuditAction, StatusBadgeVariant> = {
  create: "success",
  update: "warning",
  delete: "danger",
  deactivate: "warning",
  activate: "success",
  permission: "info",
  password_reset: "neutral",
  password_change: "neutral",
  secret: "warning",
  config: "warning",
  test: "neutral",
  session_revoked: "neutral",
  login_denied: "danger",
};

const DEFAULT_FILTERS: AuditFilters = { period: "30d", userId: "all", module: "all", action: "all" };

const MODULES = Object.keys(AUDIT_MODULE_LABELS) as AuditModule[];
const ACTIONS = Object.keys(AUDIT_ACTION_LABELS) as AuditAction[];

function isModule(value: string | null): value is AuditModule {
  return value !== null && (MODULES as string[]).includes(value);
}

function formatValue(value: AuditValues[string]): string {
  if (value === null) return "—";
  return String(value);
}

function ValuesBlock({ title, values }: { title: string; values?: AuditValues }) {
  return (
    <div className="audit-diff__block">
      <span className="audit-diff__title">{title}</span>
      {values && Object.keys(values).length > 0 ? (
        <dl>
          {Object.entries(values).map(([key, value]) => (
            <div key={key}>
              <dt>{key}:</dt>
              <dd>{formatValue(value)}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <span className="audit-diff__empty">—</span>
      )}
    </div>
  );
}

export function Auditoria() {
  const page = getMenuItem("view_audit_logs");
  const [searchParams] = useSearchParams();
  // O link "Ver na auditoria" das Integrações chega com ?modulo=integracoes.
  const initialModule = searchParams.get("modulo");
  const [filters, setFilters] = useState<AuditFilters>({
    ...DEFAULT_FILTERS,
    module: isModule(initialModule) ? initialModule : "all",
  });
  const [pageNumber, setPageNumber] = useState(1);
  const audit = useAuditLog(filters, pageNumber);
  const exportAudit = useExportAudit();

  const data = audit.data;
  const hasFilters = JSON.stringify(filters) !== JSON.stringify(DEFAULT_FILTERS);

  const setFilter = <K extends keyof AuditFilters>(key: K, value: AuditFilters[K]) => {
    setFilters((current) => ({ ...current, [key]: value }));
    setPageNumber(1);
  };

  const clearFilters = () => {
    setFilters(DEFAULT_FILTERS);
    setPageNumber(1);
  };

  const handleExport = () => {
    exportAudit.mutate(filters, {
      onSuccess: (csv) => {
        // BOM para o Excel reconhecer os acentos.
        const blob = new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `auditoria-${new Date().toISOString().slice(0, 10)}.csv`;
        link.click();
        URL.revokeObjectURL(url);
        toast.success("CSV exportado");
      },
      onError: () => toast.error("Não foi possível exportar a auditoria."),
    });
  };

  const columns: Column<AuditEntry>[] = [
    {
      id: "at",
      header: "Data e hora",
      icon: CalendarClock,
      width: "150px",
      cell: (row) => <span className="audit__nowrap">{formatDateTime(row.at)}</span>,
    },
    { id: "actor", header: "Usuário", icon: User, cell: (row) => <span className="audit__strong">{row.actorName}</span> },
    { id: "module", header: "Módulo", icon: LayoutGrid, cell: (row) => AUDIT_MODULE_LABELS[row.module] },
    {
      id: "action",
      header: "Ação",
      icon: Activity,
      cell: (row) => <StatusBadge variant={ACTION_VARIANTS[row.action]}>{AUDIT_ACTION_LABELS[row.action]}</StatusBadge>,
    },
    { id: "description", header: "Descrição", icon: AlignLeft, cell: (row) => row.description },
    { id: "origin", header: "Origem", icon: Inbox, cell: (row) => <span className="audit__muted">{row.origin}</span> },
  ];

  return (
    <>
      <Breadcrumb items={configBreadcrumb(page.label)} />
      <PageHeader
        title={page.label}
        description={page.description}
        actions={
          <button type="button" className="btn btn--outline" disabled={exportAudit.isPending} onClick={handleExport}>
            <Download size={16} aria-hidden="true" />
            {exportAudit.isPending ? "Exportando…" : "Exportar CSV"}
          </button>
        }
      />

      <section className="card audit" aria-label="Registros de auditoria">
        <div className="audit__filters">
          <div className="field">
            <label className="field__label" htmlFor="audit-period">
              Período
            </label>
            <select
              id="audit-period"
              className="input input--sm"
              value={filters.period}
              onChange={(event) => setFilter("period", event.target.value as AuditPeriod)}
            >
              {PERIODS.map((period) => (
                <option key={period.value} value={period.value}>
                  {period.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="audit-user">
              Usuário
            </label>
            <select
              id="audit-user"
              className="input input--sm"
              value={filters.userId}
              onChange={(event) => setFilter("userId", event.target.value)}
            >
              <option value="all">Todos</option>
              {data?.actors.map((actor) => (
                <option key={actor.id} value={actor.id}>
                  {actor.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="audit-module">
              Módulo
            </label>
            <select
              id="audit-module"
              className="input input--sm"
              value={filters.module}
              onChange={(event) => setFilter("module", event.target.value as AuditModule | "all")}
            >
              <option value="all">Todos</option>
              {MODULES.map((module) => (
                <option key={module} value={module}>
                  {AUDIT_MODULE_LABELS[module]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="audit-action">
              Ação
            </label>
            <select
              id="audit-action"
              className="input input--sm"
              value={filters.action}
              onChange={(event) => setFilter("action", event.target.value as AuditAction | "all")}
            >
              <option value="all">Todas</option>
              {ACTIONS.map((action) => (
                <option key={action} value={action}>
                  {AUDIT_ACTION_LABELS[action]}
                </option>
              ))}
            </select>
          </div>
          <button type="button" className="btn btn--outline audit__clear" disabled={!hasFilters} onClick={clearFilters}>
            Limpar filtros
          </button>
        </div>

        <DataTable
          caption="Registros de auditoria, do mais recente para o mais antigo"
          columns={columns}
          rows={data?.items}
          rowKey={(row) => row.id}
          isLoading={audit.isPending}
          isFetching={audit.isFetching}
          isError={audit.isError}
          onRetry={() => void audit.refetch()}
          renderExpanded={(row) =>
            row.before || row.after ? (
              <div className="audit-diff">
                <ValuesBlock title="Antes" values={row.before} />
                <ValuesBlock title="Depois" values={row.after} />
              </div>
            ) : null
          }
          emptyState={
            hasFilters ? (
              <EmptyState
                icon={Search}
                title="Nenhum registro encontrado"
                description="Ajuste os filtros para ver outros registros."
                action={
                  <button type="button" className="btn btn--outline" onClick={clearFilters}>
                    Limpar filtros
                  </button>
                }
              />
            ) : (
              <EmptyState icon={FileSearch} title="Nenhum registro no período" description="As alterações feitas no sistema aparecem aqui." />
            )
          }
        />
        {data && data.total > 0 && (
          <Pagination
            page={data.page}
            pageSize={data.pageSize}
            total={data.total}
            noun="registros"
            note="ordenado do mais recente"
            onPageChange={setPageNumber}
          />
        )}
      </section>
    </>
  );
}
