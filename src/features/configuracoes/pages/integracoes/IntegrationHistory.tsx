import { ArrowRight, History } from "lucide-react";
import { Link } from "react-router";
import { formatDateTime } from "../../../../utils/dates";
import { useAccess } from "../../access/useAccess";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { useIntegrationHistory } from "../../hooks/useIntegrations";
import type { IntegrationHistoryKey } from "../../services/types";

/** Histórico lateral de uma integração, lido da auditoria (módulo integracoes + chave do objeto). */
export function IntegrationHistory({ targetKey }: { targetKey: IntegrationHistoryKey }) {
  const { hasPermission } = useAccess();
  const history = useIntegrationHistory(targetKey);

  return (
    <aside className="card integration-history" aria-labelledby={`integration-history-${targetKey}`}>
      <h2 id={`integration-history-${targetKey}`} className="section-title">
        Histórico da integração
      </h2>
      {history.isPending ? (
        <div className="integration-history__loading">
          {Array.from({ length: 3 }, (_, index) => (
            <div key={index} className="skeleton" style={{ height: 44 }} />
          ))}
        </div>
      ) : history.isError ? (
        <ErrorState bare message="Não foi possível carregar o histórico." onRetry={() => void history.refetch()} />
      ) : history.data.length === 0 ? (
        <EmptyState icon={History} title="Sem alterações" description="As mudanças nesta integração aparecem aqui." />
      ) : (
        <ol className="integration-history__list">
          {history.data.map((entry) => (
            <li key={entry.id}>
              <span className="integration-history__dot" aria-hidden="true" />
              <div>
                <p>{entry.description}</p>
                <span>
                  {entry.actorName} · {formatDateTime(entry.at)}
                </span>
              </div>
            </li>
          ))}
        </ol>
      )}
      {hasPermission("view_audit_logs") && (
        <Link to="/configuracoes/auditoria?modulo=integracoes" className="integration-history__link">
          Ver na auditoria
          <ArrowRight size={14} aria-hidden="true" />
        </Link>
      )}
    </aside>
  );
}
