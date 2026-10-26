import { ChevronRight, type LucideIcon } from "lucide-react";
import { ThLabel } from "../../../components/ds/ThLabel";
import { Fragment, useState, type ReactNode } from "react";
import { ErrorState } from "./ErrorState";
import "./DataTable.css";

export interface Column<T> {
  id: string;
  header: string;
  /** Ícone ao lado do título (padrão do portal). */
  icon?: LucideIcon;
  cell: (row: T) => ReactNode;
  width?: string;
  align?: "left" | "right";
}

interface DataTableProps<T> {
  /** Descrição da tabela para leitores de tela. */
  caption: string;
  columns: Column<T>[];
  rows: T[] | undefined;
  rowKey: (row: T) => string;
  isLoading: boolean;
  isFetching?: boolean;
  isError: boolean;
  onRetry: () => void;
  emptyState: ReactNode;
  skeletonRows?: number;
  /** Conteúdo extra da linha; quando devolve null, a linha não expande. */
  renderExpanded?: (row: T) => ReactNode | null;
}

/** Tabela com os estados de carregando (skeleton), erro com "Tentar novamente", vazio e linhas expansíveis. */
export function DataTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  isLoading,
  isFetching = false,
  isError,
  onRetry,
  emptyState,
  skeletonRows = 5,
  renderExpanded,
}: DataTableProps<T>) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const expandable = renderExpanded !== undefined;
  const colSpan = columns.length + (expandable ? 1 : 0);

  const toggle = (key: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  let body: ReactNode;
  if (isLoading) {
    body = Array.from({ length: skeletonRows }, (_, index) => (
      <tr key={index}>
        {expandable && <td className="data-table__toggle-cell" />}
        {columns.map((column) => (
          <td key={column.id}>
            <div className="skeleton" style={{ height: 12, width: "70%" }} />
          </td>
        ))}
      </tr>
    ));
  } else if (isError) {
    body = (
      <tr>
        <td colSpan={colSpan} className="data-table__state">
          <ErrorState bare message="Não foi possível carregar os dados." onRetry={onRetry} />
        </td>
      </tr>
    );
  } else if (!rows || rows.length === 0) {
    body = (
      <tr>
        <td colSpan={colSpan} className="data-table__state">
          {emptyState}
        </td>
      </tr>
    );
  } else {
    body = rows.map((row) => {
      const key = rowKey(row);
      const detail = renderExpanded?.(row) ?? null;
      const isOpen = detail !== null && expanded.has(key);
      const detailId = `row-detail-${key}`;
      return (
        <Fragment key={key}>
          <tr className={isOpen ? "data-table__row--open" : undefined}>
            {expandable && (
              <td className="data-table__toggle-cell">
                {detail !== null && (
                  <button
                    type="button"
                    className="icon-btn"
                    aria-expanded={isOpen}
                    aria-controls={detailId}
                    aria-label={isOpen ? "Ocultar detalhes" : "Ver detalhes"}
                    onClick={() => toggle(key)}
                  >
                    <ChevronRight
                      size={16}
                      aria-hidden="true"
                      className={`data-table__chevron${isOpen ? " data-table__chevron--open" : ""}`}
                    />
                  </button>
                )}
              </td>
            )}
            {columns.map((column) => (
              <td key={column.id} style={{ textAlign: column.align }}>
                {column.cell(row)}
              </td>
            ))}
          </tr>
          {isOpen && (
            <tr id={detailId} className="data-table__detail">
              <td colSpan={colSpan}>{detail}</td>
            </tr>
          )}
        </Fragment>
      );
    });
  }

  return (
    <div className="data-table__wrap">
      <table
        className={`data-table${isFetching && !isLoading ? " data-table--fetching" : ""}`}
        aria-busy={isLoading || isFetching}
      >
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            {expandable && (
              <th scope="col" className="data-table__toggle-cell">
                <span className="visually-hidden">Detalhes</span>
              </th>
            )}
            {columns.map((column) => (
              <th key={column.id} scope="col" style={{ width: column.width, textAlign: column.align }}>
                {column.icon ? <ThLabel icon={column.icon}>{column.header}</ThLabel> : column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{body}</tbody>
      </table>
    </div>
  );
}
