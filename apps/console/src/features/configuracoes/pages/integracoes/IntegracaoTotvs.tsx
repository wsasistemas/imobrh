import * as Switch from "@radix-ui/react-switch";
import { zodResolver } from "@hookform/resolvers/zod";
import { CheckCircle2, Database, ExternalLink, Lock, PlugZap, XCircle } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { PageSkeleton } from "../../../../components/PageSkeleton";
import { formatDate, formatDateTime } from "../../../../utils/dates";
import { ErrorState } from "../../components/ErrorState";
import { Notice } from "../../components/Notice";
import { StatusBadge } from "../../components/StatusBadge";
import { useSaveTotvsConnection, useTestTotvsConnection, useTotvsConnection } from "../../hooks/useTotvs";
import { ServiceError, type TotvsConnectionView, type TotvsTestResult } from "../../services/types";
import { IntegrationHistory } from "./IntegrationHistory";

const URL_PATTERN = /^https?:\/\/[^\s/]+/i;
const TOTVS_DOCS_URL = "https://api.totvs.com.br/";
const FORM_FIELDS = ["url", "user", "password"] as const;

function buildSchema(hasSavedPassword: boolean) {
  return z
    .object({
      url: z.string().trim().regex(URL_PATTERN, "Informe a URL completa, começando com http:// ou https://."),
      user: z.string().trim().min(1, "Informe o usuário de integração.").max(120, "Use no máximo 120 caracteres."),
      password: z.string().max(200, "Senha longa demais."),
      active: z.boolean(),
    })
    .refine((values) => hasSavedPassword || values.password !== "", {
      path: ["password"],
      message: "Informe a senha da integração.",
    });
}

type TotvsFormValues = z.infer<ReturnType<typeof buildSchema>>;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ServiceError ? error.message : fallback;
}

/** Seção Conexão: usuário de integração do RM (senha no Vault) e teste do token (só leitura no ERP). */
export function IntegracaoTotvs() {
  const connection = useTotvsConnection();

  return (
    <div className="integrations">
      <div className="integrations__main">
        <Notice icon={Lock}>
          A senha fica guardada no servidor e nunca volta a ser exibida. Para trocá-la, digite a nova senha e salve;
          em branco, a senha atual é mantida.
        </Notice>

        {connection.isPending ? (
          <PageSkeleton />
        ) : connection.isError ? (
          <ErrorState message="Não foi possível carregar a conexão TOTVS RM." onRetry={() => void connection.refetch()} />
        ) : (
          <TotvsConnectionCard connection={connection.data} />
        )}
      </div>

      <IntegrationHistory targetKey="totvs_rm" />
    </div>
  );
}

function TotvsConnectionCard({ connection }: { connection: TotvsConnectionView }) {
  const ids = useId();
  const save = useSaveTotvsConnection();
  const hasSavedPassword = connection.passwordMasked !== null;
  const schema = useMemo(() => buildSchema(hasSavedPassword), [hasSavedPassword]);

  const {
    register,
    control,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isDirty, isSubmitting },
  } = useForm<TotvsFormValues>({
    resolver: zodResolver(schema),
    defaultValues: { url: connection.url, user: connection.user, password: "", active: connection.active },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      const saved = await save.mutateAsync(values);
      // A senha digitada nunca fica no formulário depois de salva.
      reset({ url: saved.url, user: saved.user, password: "", active: saved.active });
      toast.success("Conexão TOTVS RM salva");
    } catch (error) {
      const field = error instanceof ServiceError ? FORM_FIELDS.find((name) => name === error.field) : undefined;
      if (field && error instanceof ServiceError) setError(field, { message: error.message });
      else toast.error(errorMessage(error, "Não foi possível salvar a conexão."));
    }
  });

  const configured = connection.url !== "" && connection.user !== "" && hasSavedPassword;

  return (
    <>
      <form className="card integration-card" onSubmit={onSubmit} noValidate aria-labelledby={`${ids}-title`}>
        <header className="integration-card__header">
          <div className="integration-card__icon">
            <Database size={20} aria-hidden="true" />
          </div>
          <div className="integration-card__title">
            <h2 id={`${ids}-title`}>TOTVS RM</h2>
            <p>Usuário de integração do RM: token por /api/connect/token e leitura pelas Consultas SQL API.RH.*.</p>
          </div>
          <StatusBadge variant={connection.active ? "success" : "neutral"}>
            {connection.active ? "Ativa" : configured ? "Inativa" : "Não configurada"}
          </StatusBadge>
        </header>

        <div className="integration-card__body">
          <div className="field">
            <label className="field__label" htmlFor={`${ids}-url`}>
              URL completa da API
            </label>
            <input
              id={`${ids}-url`}
              className="input"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="http://servidor:8051"
              aria-invalid={errors.url ? "true" : undefined}
              aria-describedby={`${ids}-url-help`}
              {...register("url")}
            />
            <span id={`${ids}-url-help`} className={errors.url ? "field__error" : "field__help"}>
              {errors.url?.message ?? (
                <>
                  Endereço do servidor do RM (host e porta). O caminho das consultas é completado sozinho.{" "}
                  <a href={TOTVS_DOCS_URL} target="_blank" rel="noreferrer" className="totvs__docs">
                    Portal de APIs TOTVS
                    <ExternalLink size={12} aria-hidden="true" />
                    <span className="visually-hidden">(abre em nova aba)</span>
                  </a>
                </>
              )}
            </span>
          </div>

          <div className="totvs__credentials">
            <div className="field">
              <label className="field__label" htmlFor={`${ids}-user`}>
                Usuário de integração
              </label>
              <input
                id={`${ids}-user`}
                className="input"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={errors.user ? "true" : undefined}
                aria-describedby={errors.user ? `${ids}-user-error` : undefined}
                {...register("user")}
              />
              {errors.user && (
                <span id={`${ids}-user-error`} className="field__error">
                  {errors.user.message}
                </span>
              )}
            </div>

            <div className="field">
              <label className="field__label" htmlFor={`${ids}-password`}>
                Senha (fica no Vault)
              </label>
              <input
                id={`${ids}-password`}
                type="password"
                className="input"
                autoComplete="new-password"
                placeholder={hasSavedPassword ? "•••••••• (em branco mantém a atual)" : "Senha do usuário de integração"}
                aria-invalid={errors.password ? "true" : undefined}
                aria-describedby={`${ids}-password-help`}
                {...register("password")}
              />
              <span id={`${ids}-password-help`} className={errors.password ? "field__error" : "field__help"}>
                {errors.password?.message ??
                  (connection.passwordSetAt
                    ? `Salva em ${formatDate(connection.passwordSetAt)}${connection.passwordSetBy ? ` por ${connection.passwordSetBy}` : ""}.`
                    : "Nenhuma senha salva ainda.")}
              </span>
            </div>
          </div>

          <div className="integration-card__switch">
            <label htmlFor={`${ids}-active`}>
              <strong>Integração ativa</strong>
              <span>Desligada, o ImobRH não lê o RM: o app mostra o último valor lido.</span>
            </label>
            <Controller
              control={control}
              name="active"
              render={({ field }) => (
                <Switch.Root id={`${ids}-active`} className="switch" checked={field.value} onCheckedChange={field.onChange}>
                  <Switch.Thumb className="switch__thumb" />
                </Switch.Root>
              )}
            />
          </div>
        </div>

        <footer className="integration-card__footer">
          <span className="integration-card__test">
            {isDirty ? "Alterações não salvas" : "Tudo salvo"}
          </span>
          <div className="integration-card__actions">
            <button
              type="button"
              className="btn btn--outline"
              disabled={!isDirty || isSubmitting}
              onClick={() => reset()}
            >
              Descartar
            </button>
            <button type="submit" className="btn btn--primary" disabled={!isDirty || isSubmitting}>
              {isSubmitting ? "Salvando…" : "Salvar conexão"}
            </button>
          </div>
        </footer>
      </form>

      <TotvsTestCard connection={connection} configured={configured} hasUnsavedChanges={isDirty} />
    </>
  );
}

function TotvsTestCard({
  connection,
  configured,
  hasUnsavedChanges,
}: {
  connection: TotvsConnectionView;
  configured: boolean;
  hasUnsavedChanges: boolean;
}) {
  const ids = useId();
  const test = useTestTotvsConnection();
  const [result, setResult] = useState<TotvsTestResult | null>(null);

  const blockedReason = !configured
    ? "Salve URL, usuário e senha antes de testar."
    : !connection.active
      ? "Ative a integração para testar."
      : hasUnsavedChanges
        ? "Salve as alterações antes de testar: o teste usa a conexão salva."
        : null;

  const handleTest = () => {
    setResult(null);
    test.mutate(null, {
      onSuccess: setResult,
      onError: (error) => toast.error(errorMessage(error, "Não foi possível testar a conexão.")),
    });
  };

  const lastTest = connection.lastTest;

  return (
    <section className="card totvs-test" aria-labelledby={`${ids}-title`}>
      <header className="totvs-test__header">
        <PlugZap size={18} aria-hidden="true" />
        <div>
          <h2 id={`${ids}-title`}>Teste de conexão</h2>
          <p>Só leitura: nada é gravado no RM.</p>
        </div>
      </header>

      <div className="totvs-test__body">
        <p className="field__help">
          Pede um token novo ao RM com o usuário de integração. O token não sai do servidor (Edge Function rm-token).
        </p>
        <button
          type="button"
          className="btn btn--primary totvs-test__button"
          disabled={blockedReason !== null || test.isPending}
          aria-describedby={blockedReason ? `${ids}-blocked` : undefined}
          onClick={handleTest}
        >
          <PlugZap size={16} aria-hidden="true" />
          {test.isPending ? "Testando…" : "Testar conexão"}
        </button>
      </div>

      {blockedReason && (
        <p id={`${ids}-blocked`} className="totvs-test__blocked">
          {blockedReason}
        </p>
      )}

      <div role="status" aria-live="polite">
        {result && (
          <div className={`totvs-test__result totvs-test__result--${result.ok ? "ok" : "fail"}`}>
            {result.ok ? <CheckCircle2 size={18} aria-hidden="true" /> : <XCircle size={18} aria-hidden="true" />}
            <span>{result.message}</span>
          </div>
        )}
        {result?.url && (
          <p className="totvs-test__url">
            <span>URL chamada:</span>
            <code className="mono">{result.url}</code>
          </p>
        )}
      </div>

      <p className="totvs-test__last">
        {lastTest ? (
          <>
            Último teste: {formatDateTime(lastTest.at)}
            {" · "}
            <strong className={lastTest.ok ? "integration-card__ok" : "integration-card__fail"}>
              {lastTest.ok ? "sucesso" : "falhou"}
            </strong>
          </>
        ) : (
          "Nenhum teste feito ainda"
        )}
      </p>
    </section>
  );
}
