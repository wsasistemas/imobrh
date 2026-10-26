import * as Dialog from "@radix-ui/react-dialog";
import { CheckCircle2, Columns3, Play, X, XCircle } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { ThLabel } from "../../../../components/ds/ThLabel";
import { useReturnFocus } from "../../components/useReturnFocus";
import { useTestSqlQuery } from "../../hooks/useSqlQueries";
import { useTotvsConnection } from "../../hooks/useTotvs";
import { ServiceError, type SqlQuery, type SqlQueryTestResult } from "../../services/types";
import { PARAMS_PATTERN, queryUrlPreview } from "./sqlQueryLabels";

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "—";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

interface SqlQueryTestDialogProps {
  query: SqlQuery | null;
  onClose: () => void;
}

/** Roda a consulta no RM (só leitura) com parâmetros opcionais e mostra uma prévia. Nada é gravado. */
export function SqlQueryTestDialog({ query, onClose }: SqlQueryTestDialogProps) {
  const returnFocus = useReturnFocus();
  return (
    <Dialog.Root open={query !== null} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="query-test" {...returnFocus}>
          {query && <TestPanel key={query.id} query={query} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function TestPanel({ query }: { query: SqlQuery }) {
  const ids = useId();
  const test = useTestSqlQuery();
  const connection = useTotvsConnection();
  // Abre com os parâmetros cadastrados na consulta (ex.: CODCOLIGADA=1;CPF=).
  const [parameters, setParameters] = useState(query.testParams ?? "");
  const [result, setResult] = useState<SqlQueryTestResult | null>(null);
  const invalidParams = parameters.trim() !== "" && !PARAMS_PATTERN.test(parameters);
  const previewUrl = queryUrlPreview(connection.data?.url, query.code, invalidParams ? "" : parameters);

  const run = () => {
    setResult(null);
    test.mutate(
      { id: query.id, parameters: parameters.trim() },
      {
        onSuccess: setResult,
        onError: (error) => toast.error(error instanceof ServiceError ? error.message : "Não foi possível testar a consulta."),
      },
    );
  };

  return (
    <>
      <header className="query-test__header">
        <div>
          <Dialog.Title className="query-test__title">
            Testar <code className="mono">{query.code}</code>
          </Dialog.Title>
          <Dialog.Description className="query-test__description">
            {query.name}. Só leitura: roda a consulta no TOTVS RM sem gravar nada.
          </Dialog.Description>
        </div>
        <Dialog.Close asChild>
          <button type="button" className="icon-btn" aria-label="Fechar">
            <X size={18} aria-hidden="true" />
          </button>
        </Dialog.Close>
      </header>

      <form
        className="query-test__form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!invalidParams) run();
        }}
      >
        <div className="field">
          <label className="field__label" htmlFor={`${ids}-params`}>
            Parâmetros <span className="field__optional">(opcional)</span>
          </label>
          <input
            id={`${ids}-params`}
            className="input mono-input"
            autoComplete="off"
            spellCheck={false}
            placeholder="CODCOLIGADA=1;CPF=52998224725;CHAPA="
            value={parameters}
            aria-invalid={invalidParams ? "true" : undefined}
            aria-describedby={`${ids}-params-help`}
            onChange={(event) => setParameters(event.target.value)}
          />
          <span id={`${ids}-params-help`} className={invalidParams ? "field__error" : "field__help"}>
            {invalidParams
              ? "Use NOME=valor, separados por ponto e vírgula."
              : "Só os parâmetros que a consulta aceita no RM: parâmetro a mais ou a menos devolve erro FE011."}
          </span>
        </div>
        <button type="submit" className="btn btn--primary" disabled={test.isPending || invalidParams}>
          <Play size={16} aria-hidden="true" />
          {test.isPending ? "Executando…" : "Executar"}
        </button>
      </form>

      <p className="query-test__url">
        <span>{result?.url ? "URL chamada" : "Será chamada"} (conexão da aba TOTVS RM):</span>
        <code className="mono">{result?.url || previewUrl}</code>
      </p>

      <div role="status" aria-live="polite" className="query-test__result-area">
        {test.isPending && <p className="query-test__hint">Consultando o TOTVS RM… consultas grandes podem levar até 1 minuto.</p>}
        {result && (
          <>
            <div className={`totvs-test__result totvs-test__result--${result.ok ? "ok" : "fail"}`}>
              {result.ok ? <CheckCircle2 size={18} aria-hidden="true" /> : <XCircle size={18} aria-hidden="true" />}
              <span>
                {result.message}
                {result.status > 0 && <span className="query-test__status"> · HTTP {result.status}</span>}
              </span>
            </div>
            {result.ok && result.columns.length > 0 && (
              <>
                <p className="query-test__hint">
                  {result.columns.length} colunas · prévia de {result.preview.length}{" "}
                  {result.preview.length === 1 ? "linha" : "linhas"}
                </p>
                <div className="query-test__table-wrap" tabIndex={0} aria-label="Prévia do resultado, role para ver mais colunas">
                  <table className="query-test__table">
                    <thead>
                      <tr>
                        {result.columns.map((column) => (
                          <th key={column} scope="col">
                            <ThLabel icon={Columns3}>{column}</ThLabel>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {result.preview.map((row, index) => (
                        <tr key={index}>
                          {result.columns.map((column) => (
                            <td key={column}>{cellText(row[column])}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}
