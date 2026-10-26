interface TablePaginationProps {
  /** Página atual, começando em 0. */
  page: number;
  pageSize: number;
  total: number;
  /** Recorte atual, depois do total (ex.: "Todos", "SLA vencido"). */
  context?: string;
  onPageChange: (page: number) => void;
}

export function TablePagination({ page, pageSize, total, context, onPageChange }: TablePaginationProps) {
  const first = page * pageSize + 1;
  const last = Math.min((page + 1) * pageSize, total);
  const label = total ? `${first}–${last} de ${total} tickets${context ? ` · ${context}` : ""}` : "0 tickets";
  return (
    <div className="ds-tablefoot">
      <span aria-live="polite">{label}</span>
      <div className="ds-tablefoot__nav">
        <button type="button" aria-label="Página anterior" disabled={page === 0} onClick={() => onPageChange(page - 1)}>
          ←
        </button>
        <button type="button" aria-label="Próxima página" disabled={(page + 1) * pageSize >= total} onClick={() => onPageChange(page + 1)}>
          →
        </button>
      </div>
    </div>
  );
}
