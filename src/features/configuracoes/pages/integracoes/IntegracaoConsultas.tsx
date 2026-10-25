import * as Switch from "@radix-ui/react-switch";
import { ArrowDown, ArrowUp, ArrowUpDown, FileCode2, FlaskConical, Hash, Info, Pencil, Play, Plus, Shapes, Tag, ToggleRight, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { formatDateTime } from "../../../../utils/dates";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { DataTable, type Column } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { Notice } from "../../components/Notice";
import { StatusBadge } from "../../components/StatusBadge";
import { useDeleteSqlQuery, useMoveSqlQuery, useSetSqlQueryActive, useSqlQueries } from "../../hooks/useSqlQueries";
import { ServiceError, type SqlQuery } from "../../services/types";
import { SqlQuerySheet, type SqlQuerySheetState } from "./SqlQuerySheet";
import { SqlQueryTestDialog } from "./SqlQueryTestDialog";
import { SQL_QUERY_TYPE_LABELS } from "./sqlQueryLabels";
import "./IntegracaoConsultas.css";

type PendingConfirm = { kind: "delete" | "deactivate"; query: SqlQuery } | null;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ServiceError ? error.message : fallback;
}

/** Aba Consultas SQL: catálogo das consultas do TOTVS RM, que também guia as sincronizações. */
export function IntegracaoConsultas() {
  const queries = useSqlQueries();
  const setActive = useSetSqlQueryActive();
  const move = useMoveSqlQuery();
  const remove = useDeleteSqlQuery();

  const [sheet, setSheet] = useState<SqlQuerySheetState | null>(null);
  const [testing, setTesting] = useState<SqlQuery | null>(null);
  const [confirm, setConfirm] = useState<PendingConfirm>(null);

  const rows = queries.data;
  const total = rows?.length ?? 0;

  const toggle = (query: SqlQuery, active: boolean) => {
    // Desligar uma consulta de sincronização muda o que a rotina faz: pede confirmação.
    if (!active && query.usedBy) {
      setConfirm({ kind: "deactivate", query });
      return;
    }
    setActive.mutate(
      { id: query.id, active },
      {
        onSuccess: () => toast.success(`Consulta ${query.code} ${active ? "ativada" : "desativada"}`),
        onError: (error) => toast.error(errorMessage(error, "Não foi possível alterar a consulta.")),
      },
    );
  };

  const handleMove = (query: SqlQuery, direction: "up" | "down") => {
    move.mutate(
      { id: query.id, direction },
      { onError: (error) => toast.error(errorMessage(error, "Não foi possível mudar a ordem.")) },
    );
  };

  const handleConfirm = () => {
    if (!confirm) return;
    const { kind, query } = confirm;
    const options = {
      onSuccess: () => {
        toast.success(kind === "delete" ? `Consulta ${query.code} excluída` : `Consulta ${query.code} desativada`);
        setConfirm(null);
      },
      onError: (error: unknown) => toast.error(errorMessage(error, "Não foi possível concluir a ação.")),
    };
    if (kind === "delete") remove.mutate(query.id, options);
    else setActive.mutate({ id: query.id, active: false }, options);
  };

  const columns: Column<SqlQuery>[] = [
    {
      id: "order",
      header: "Ordem",
      icon: ArrowUpDown,
      width: "92px",
      cell: (row) => {
        const index = rows?.indexOf(row) ?? 0;
        return (
          <div className="sql-query__order">
            <button
              type="button"
              className="icon-btn"
              disabled={index === 0 || move.isPending}
              aria-label={`Subir ${row.code}`}
              onClick={() => handleMove(row, "up")}
            >
              <ArrowUp size={15} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="icon-btn"
              disabled={index === total - 1 || move.isPending}
              aria-label={`Descer ${row.code}`}
              onClick={() => handleMove(row, "down")}
            >
              <ArrowDown size={15} aria-hidden="true" />
            </button>
          </div>
        );
      },
    },
    { id: "code", header: "Código", icon: Hash, cell: (row) => <code className="sql-query__code">{row.code}</code> },
    {
      id: "name",
      header: "Nome",
      icon: Tag,
      cell: (row) => (
        <div className="sql-query__name">
          <span>{row.name}</span>
          {row.description && <small>{row.description}</small>}
          {row.usedBy && (
            <span className="sql-query__usage">
              <StatusBadge variant="info">Sincronização</StatusBadge>
              <small>{row.usedBy}</small>
            </span>
          )}
        </div>
      ),
    },
    { id: "type", header: "Tipo", icon: Shapes, cell: (row) => <StatusBadge variant="neutral">{SQL_QUERY_TYPE_LABELS[row.type]}</StatusBadge> },
    {
      id: "status",
      header: "Status",
      icon: ToggleRight,
      width: "80px",
      cell: (row) => (
        <Switch.Root
          className="switch"
          checked={row.active}
          disabled={setActive.isPending}
          onCheckedChange={(checked) => toggle(row, checked)}
          aria-label={`${row.active ? "Desativar" : "Ativar"} ${row.code}`}
        >
          <Switch.Thumb className="switch__thumb" />
        </Switch.Root>
      ),
    },
    {
      id: "lastTest",
      header: "Último teste",
      icon: FlaskConical,
      cell: (row) =>
        row.lastTest ? (
          <span className={`sql-query__test ${row.lastTest.ok ? "integration-card__ok" : "integration-card__fail"}`} title={row.lastTest.message}>
            {row.lastTest.ok ? "OK" : "Falhou"} · {formatDateTime(row.lastTest.at)}
          </span>
        ) : (
          <span className="sql-query__muted">Nunca testada</span>
        ),
    },
    {
      id: "actions",
      header: "Ações",
      align: "right",
      width: "132px",
      cell: (row) => (
        <div className="sql-query__actions">
          <button type="button" className="icon-btn" aria-label={`Testar ${row.code}`} title="Testar consulta" onClick={() => setTesting(row)}>
            <Play size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label={`Editar ${row.code}`}
            title="Editar"
            onClick={() => setSheet({ mode: "edit", query: row })}
          >
            <Pencil size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-btn"
            disabled={row.usedBy !== null}
            aria-label={row.usedBy ? `${row.code} não pode ser excluída: usada na sincronização` : `Excluir ${row.code}`}
            title={row.usedBy ? "Usada por uma sincronização: desative em vez de excluir" : "Excluir"}
            onClick={() => setConfirm({ kind: "delete", query: row })}
          >
            <Trash2 size={16} aria-hidden="true" />
          </button>
        </div>
      ),
    },
  ];

  return (
    <div className="sql-queries">
      <Notice icon={Info}>
        As sincronizações chamam estas consultas pelo código e na ordem da lista. Consultas marcadas como{" "}
        <strong>Sincronização</strong> não podem ser excluídas; desativá-las pausa a rotina que depende delas.
      </Notice>

      <section className="card sql-queries__card" aria-labelledby="sql-queries-title">
        <header className="sql-queries__header">
          <div>
            <h2 id="sql-queries-title">Consultas API</h2>
            <p>{total === 1 ? "1 consulta cadastrada" : `${total} consultas cadastradas`} no TOTVS RM.</p>
          </div>
          <button type="button" className="btn btn--primary" onClick={() => setSheet({ mode: "create" })}>
            <Plus size={16} aria-hidden="true" />
            Nova consulta
          </button>
        </header>

        <DataTable
          caption="Consultas SQL do TOTVS RM"
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          isLoading={queries.isPending}
          isFetching={queries.isFetching}
          isError={queries.isError}
          onRetry={() => void queries.refetch()}
          skeletonRows={8}
          emptyState={
            <EmptyState icon={FileCode2} title="Nenhuma consulta cadastrada" description="Cadastre as consultas SQL do TOTVS RM em Nova consulta." />
          }
        />
      </section>

      <SqlQuerySheet state={sheet} onClose={() => setSheet(null)} />
      <SqlQueryTestDialog query={testing} onClose={() => setTesting(null)} />

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
        tone={confirm?.kind === "delete" ? "danger" : "warning"}
        title={confirm?.kind === "delete" ? `Excluir ${confirm.query.code}?` : `Desativar ${confirm?.query.code ?? ""}?`}
        description={
          confirm?.kind === "delete"
            ? `A consulta "${confirm.query.name}" sai do cadastro. A exclusão fica registrada na auditoria.`
            : `Esta consulta é usada na ${confirm?.query.usedBy?.toLowerCase() ?? "sincronização"}. Desativada, essa rotina deixa de buscar os dados dela até ser reativada.`
        }
        confirmLabel={confirm?.kind === "delete" ? "Excluir consulta" : "Desativar consulta"}
        isPending={remove.isPending || setActive.isPending}
        onConfirm={handleConfirm}
      />
    </div>
  );
}
