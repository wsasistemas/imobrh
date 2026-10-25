import { ChevronLeft, ChevronRight } from "lucide-react";
import "./Pagination.css";

interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  /** Substantivo no plural, ex.: "usuários". */
  noun: string;
  /** Complemento após a contagem, ex.: "ordenado do mais recente". */
  note?: string;
  onPageChange: (page: number) => void;
}

export function Pagination({ page, pageSize, total, noun, note, onPageChange }: PaginationProps) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  return (
    <div className="pagination">
      <span aria-live="polite">
        Mostrando {from}–{to} de {total} {noun}
        {note && ` · ${note}`}
      </span>
      <div className="pagination__controls">
        <button
          type="button"
          className="icon-btn icon-btn--bordered"
          aria-label="Página anterior"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          <ChevronLeft size={16} aria-hidden="true" />
        </button>
        <span>
          Página {page} de {pageCount}
        </span>
        <button
          type="button"
          className="icon-btn icon-btn--bordered"
          aria-label="Próxima página"
          disabled={page >= pageCount}
          onClick={() => onPageChange(page + 1)}
        >
          <ChevronRight size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
