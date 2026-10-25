import * as Dialog from "@radix-ui/react-dialog";
import * as Switch from "@radix-ui/react-switch";
import { zodResolver } from "@hookform/resolvers/zod";
import { Info, X } from "lucide-react";
import { useId } from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { useReturnFocus } from "../../components/useReturnFocus";
import { useSaveSqlQuery } from "../../hooks/useSqlQueries";
import { useTotvsConnection } from "../../hooks/useTotvs";
import { ServiceError, SQL_QUERY_TYPES, type SqlQuery } from "../../services/types";
import { PARAMS_PATTERN, queryUrlPreview, SQL_QUERY_TYPE_LABELS } from "./sqlQueryLabels";
import "../../components/Sheet.css";

export type SqlQuerySheetState = { mode: "create" } | { mode: "edit"; query: SqlQuery };

const CODE_PATTERN = /^[A-Z0-9][A-Z0-9._-]{2,59}(\/[A-Z0-9?._-]+)*$/;
const schema = z.object({
  code: z
    .string()
    .transform((value) => value.replace(/\s/g, "").toUpperCase())
    .pipe(z.string().regex(CODE_PATTERN, "Use o código da consulta no RM, como API.00.02.001.")),
  name: z.string().trim().min(2, "Informe o nome da consulta.").max(120, "Use no máximo 120 caracteres."),
  description: z.string().trim().max(300, "Use no máximo 300 caracteres."),
  type: z.enum(SQL_QUERY_TYPES),
  active: z.boolean(),
  testParams: z
    .string()
    .trim()
    .refine((value) => value === "" || PARAMS_PATTERN.test(value), "Use NOME=valor, separados por ponto e vírgula."),
});

type FormInput = z.input<typeof schema>;
type FormOutput = z.output<typeof schema>;

const FORM_FIELDS = ["code", "name", "description", "type", "testParams"] as const;

interface SqlQuerySheetProps {
  state: SqlQuerySheetState | null;
  onClose: () => void;
}

/** Painel lateral para criar ou editar uma consulta do TOTVS RM. */
export function SqlQuerySheet({ state, onClose }: SqlQuerySheetProps) {
  const returnFocus = useReturnFocus();
  return (
    <Dialog.Root open={state !== null} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="sheet" {...returnFocus}>
          {state && <SqlQueryForm key={state.mode === "edit" ? state.query.id : "create"} state={state} onClose={onClose} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SqlQueryForm({ state, onClose }: { state: SqlQuerySheetState; onClose: () => void }) {
  const ids = useId();
  const save = useSaveSqlQuery();
  const connection = useTotvsConnection();
  const editing = state.mode === "edit" ? state.query : null;

  const {
    register,
    control,
    handleSubmit,
    setError,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<FormInput, unknown, FormOutput>({
    resolver: zodResolver(schema),
    defaultValues: {
      code: editing?.code ?? "",
      name: editing?.name ?? "",
      description: editing?.description ?? "",
      type: editing?.type ?? "resumo",
      active: editing?.active ?? true,
      testParams: editing?.testParams ?? "",
    },
  });

  const code = watch("code");
  const testParams = watch("testParams");

  const onSubmit = handleSubmit(async (values) => {
    try {
      await save.mutateAsync({ id: editing?.id ?? null, input: values });
      toast.success(editing ? `Consulta ${values.code} salva` : `Consulta ${values.code} criada`);
      onClose();
    } catch (error) {
      if (error instanceof ServiceError) {
        const field = FORM_FIELDS.find((name) => name === error.field);
        if (field) {
          setError(field, { type: "server", message: error.message }, { shouldFocus: true });
          return;
        }
        toast.error(error.message);
        return;
      }
      toast.error("Não foi possível salvar a consulta.");
    }
  });

  const fieldId = (name: string) => `${ids}-${name}`;

  return (
    <form className="sheet__form" onSubmit={onSubmit} noValidate>
      <header className="sheet__header">
        <div>
          <Dialog.Title className="sheet__title">{editing ? "Editar consulta" : "Nova consulta"}</Dialog.Title>
          <Dialog.Description className="sheet__description">
            Consulta SQL cadastrada no TOTVS RM e chamada pela API RealizaConsulta.
          </Dialog.Description>
        </div>
        <Dialog.Close asChild>
          <button type="button" className="icon-btn" aria-label="Fechar">
            <X size={18} aria-hidden="true" />
          </button>
        </Dialog.Close>
      </header>

      <div className="sheet__body">
        <div className="field">
          <label className="field__label" htmlFor={fieldId("code")}>
            Código da consulta
          </label>
          <input
            id={fieldId("code")}
            className="input mono-input"
            autoComplete="off"
            spellCheck={false}
            placeholder="API.00.02.001"
            aria-invalid={errors.code ? "true" : undefined}
            aria-describedby={fieldId("code-help")}
            {...register("code")}
          />
          <span id={fieldId("code-help")} className={errors.code ? "field__error" : "field__help"}>
            {errors.code?.message ?? (
              <>
                Chamada:{" "}
                <code className="mono sql-query__url">
                  {queryUrlPreview(connection.data?.url, code.toUpperCase(), PARAMS_PATTERN.test(testParams) ? testParams : "")}
                </code>
              </>
            )}
          </span>
          {editing?.usedBy && <span className="field__help">Usada na {editing.usedBy.toLowerCase()}: o código não muda.</span>}
        </div>

        <div className="field">
          <label className="field__label" htmlFor={fieldId("name")}>
            Nome
          </label>
          <input
            id={fieldId("name")}
            className="input"
            autoComplete="off"
            aria-invalid={errors.name ? "true" : undefined}
            aria-describedby={errors.name ? fieldId("name-error") : undefined}
            {...register("name")}
          />
          {errors.name && (
            <span id={fieldId("name-error")} className="field__error">
              {errors.name.message}
            </span>
          )}
        </div>

        <div className="field">
          <label className="field__label" htmlFor={fieldId("description")}>
            Descrição <span className="field__optional">(opcional)</span>
          </label>
          <input
            id={fieldId("description")}
            className="input"
            autoComplete="off"
            aria-invalid={errors.description ? "true" : undefined}
            aria-describedby={errors.description ? fieldId("description-error") : undefined}
            {...register("description")}
          />
          {errors.description && (
            <span id={fieldId("description-error")} className="field__error">
              {errors.description.message}
            </span>
          )}
        </div>

        <div className="field">
          <label className="field__label" htmlFor={fieldId("testParams")}>
            Parâmetros de teste <span className="field__optional">(opcional)</span>
          </label>
          <input
            id={fieldId("testParams")}
            className="input mono-input"
            autoComplete="off"
            spellCheck={false}
            placeholder="CODEMPREENDIMENTO=229"
            aria-invalid={errors.testParams ? "true" : undefined}
            aria-describedby={fieldId("testParams-help")}
            {...register("testParams")}
          />
          <span id={fieldId("testParams-help")} className={errors.testParams ? "field__error" : "field__help"}>
            {errors.testParams?.message ??
              "Preencha se a consulta exige parâmetros no RM; sem eles o RM responde FE011. Abrem preenchidos no ▶ Testar."}
          </span>
        </div>

        <div className="field">
          <label className="field__label" htmlFor={fieldId("type")}>
            Tipo de dados
          </label>
          <select id={fieldId("type")} className="input" {...register("type")}>
            {SQL_QUERY_TYPES.map((type) => (
              <option key={type} value={type}>
                {SQL_QUERY_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
        </div>

        <div className="integration-card__switch">
          <label htmlFor={fieldId("active")}>
            <strong>Ativa</strong>
            <span>Inativa, a consulta não é chamada pelas sincronizações.</span>
          </label>
          <Controller
            control={control}
            name="active"
            render={({ field }) => (
              <Switch.Root id={fieldId("active")} className="switch" checked={field.value} onCheckedChange={field.onChange}>
                <Switch.Thumb className="switch__thumb" />
              </Switch.Root>
            )}
          />
        </div>

        <p className="sheet__notice">
          <Info size={16} aria-hidden="true" />A alteração vale na hora para as sincronizações e fica registrada na auditoria.
        </p>
      </div>

      <footer className="sheet__footer">
        <Dialog.Close asChild>
          <button type="button" className="btn btn--outline btn--lg" disabled={isSubmitting}>
            Cancelar
          </button>
        </Dialog.Close>
        <button type="submit" className="btn btn--primary btn--lg" disabled={isSubmitting}>
          {isSubmitting ? "Salvando…" : editing ? "Salvar alterações" : "Criar consulta"}
        </button>
      </footer>
    </form>
  );
}
