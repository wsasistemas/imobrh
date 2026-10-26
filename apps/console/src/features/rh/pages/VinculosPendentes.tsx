import * as Dialog from "@radix-ui/react-dialog";
import { CircleDot, Clock, IdCard, Info, Link2, Search, UserCheck, UserRound, X } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { Breadcrumb } from "../../../components/Breadcrumb";
import { getMenuItem } from "../../../config/menuRegistry";
import { useDebouncedValue } from "../../../hooks/useDebouncedValue";
import { formatDateTime } from "../../../utils/dates";
import { normalizeText } from "../../../utils/text";
import { configBreadcrumb } from "../../configuracoes/components/configBreadcrumb";
import { DataTable, type Column } from "../../configuracoes/components/DataTable";
import { EmptyState } from "../../configuracoes/components/EmptyState";
import { Notice } from "../../configuracoes/components/Notice";
import { PageHeader } from "../../configuracoes/components/PageHeader";
import { StatusBadge } from "../../configuracoes/components/StatusBadge";
import { UserAvatar } from "../../configuracoes/components/UserAvatar";
import { useReturnFocus } from "../../configuracoes/components/useReturnFocus";
import { useLinkUser, usePendingLinks } from "../../configuracoes/hooks/useVinculos";
import type { PendingLink } from "../../configuracoes/services/contracts";
import { ServiceError } from "../../configuracoes/services/types";
import "../../configuracoes/components/Sheet.css";
import "./VinculosPendentes.css";

const STATUS: Record<PendingLink["status"], { label: string; variant: "neutral" | "warning" | "danger" }> = {
  sem_registro: { label: "Nunca vinculado", variant: "neutral" },
  pendente: { label: "CPF não encontrado", variant: "warning" },
  divergente: { label: "Divergente no RM", variant: "danger" },
};

/** "529.982.247-25" enquanto digita (só exibição; o servidor recebe só os dígitos). */
function formatCpf(value: string): string {
  const d = value.replace(/\D/g, "").slice(0, 11);
  return d.replace(/^(\d{3})(\d)/, "$1.$2").replace(/^(\d{3})\.(\d{3})(\d)/, "$1.$2.$3").replace(/\.(\d{3})(\d{1,2})$/, ".$1-$2");
}

/**
 * Vínculos pendentes: usuários do imobdesk sem chapa no TOTVS RM. O DP informa o CPF; a Edge Function rm-funcionario
 * procura no RM (API.RH.FUNCIONARIO) e grava o vínculo — vinculado, pendente (CPF não encontrado) ou divergente
 * (desligado ou com mais de uma chapa ativa). Sem vínculo não há saldo de férias nem hierarquia (PRD v1).
 */
export function VinculosPendentes() {
  const item = getMenuItem("config_vinculos");
  const pending = usePendingLinks();
  const [search, setSearch] = useState("");
  const [linking, setLinking] = useState<PendingLink | null>(null);
  const term = normalizeText(useDebouncedValue(search));

  const rows = pending.data?.filter((row) => !term || normalizeText(row.name).includes(term) || normalizeText(row.email).includes(term));
  const counts = {
    total: pending.data?.length ?? 0,
    divergentes: pending.data?.filter((row) => row.status === "divergente").length ?? 0,
  };

  const columns: Column<PendingLink>[] = [
    {
      id: "user",
      header: "Usuário",
      icon: UserRound,
      cell: (row) => (
        <div className="vinculos__identity">
          <UserAvatar name={row.name} />
          <div>
            <div className="vinculos__name">{row.name}</div>
            <div className="vinculos__email">{row.email}</div>
          </div>
        </div>
      ),
    },
    {
      id: "status",
      header: "Situação",
      icon: CircleDot,
      cell: (row) => (
        <div className="vinculos__status">
          <StatusBadge variant={STATUS[row.status].variant}>{STATUS[row.status].label}</StatusBadge>
          {row.reason && <small>{row.reason}</small>}
        </div>
      ),
    },
    { id: "cpf", header: "Último CPF", icon: IdCard, cell: (row) => <span className="mono vinculos__muted">{row.cpfMasked ?? "—"}</span> },
    { id: "updated", header: "Atualizado", icon: Clock, cell: (row) => <span className="vinculos__muted">{formatDateTime(row.updatedAt)}</span> },
    {
      id: "actions",
      header: "Ações",
      width: "150px",
      align: "right",
      cell: (row) => (
        <button type="button" className="btn btn--primary vinculos__action" onClick={() => setLinking(row)}>
          <Link2 size={16} aria-hidden="true" />
          Vincular
        </button>
      ),
    },
  ];

  return (
    <>
      <Breadcrumb items={configBreadcrumb(item.label)} />
      <PageHeader title={item.label} description={item.description} />

      <Notice icon={Info}>
        Todo colaborador precisa estar ligado a um funcionário do RM (coligada + chapa) pelo CPF. Sem isso, ele não vê saldo
        de férias e as aprovações não acham o gestor.
      </Notice>

      <section className="card vinculos" aria-labelledby="vinculos-title">
        <header className="vinculos__header">
          <div>
            <h2 id="vinculos-title">
              {counts.total} {counts.total === 1 ? "usuário sem chapa" : "usuários sem chapa"}
            </h2>
            <p>{counts.divergentes > 0 ? `${counts.divergentes} com divergência no RM: o DP precisa corrigir o cadastro lá.` : "Nenhuma divergência no RM."}</p>
          </div>
          <div className="vinculos__search">
            <label htmlFor="vinculos-search" className="visually-hidden">
              Buscar por nome ou e-mail
            </label>
            <Search size={16} aria-hidden="true" />
            <input
              id="vinculos-search"
              type="search"
              className="input input--sm"
              placeholder="Buscar por nome ou e-mail"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
        </header>

        <DataTable
          caption="Usuários sem chapa no TOTVS RM"
          columns={columns}
          rows={rows}
          rowKey={(row) => row.userId}
          isLoading={pending.isPending}
          isFetching={pending.isFetching}
          isError={pending.isError}
          onRetry={() => void pending.refetch()}
          emptyState={
            term ? (
              <EmptyState icon={Search} title="Nenhum usuário encontrado" description="Ajuste a busca." />
            ) : (
              <EmptyState icon={UserCheck} title="Todos vinculados" description="Todos os usuários ativos têm chapa no TOTVS RM." />
            )
          }
        />
      </section>

      <LinkSheet row={linking} onClose={() => setLinking(null)} />
    </>
  );
}

function LinkSheet({ row, onClose }: { row: PendingLink | null; onClose: () => void }) {
  const returnFocus = useReturnFocus();
  return (
    <Dialog.Root open={row !== null} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="sheet" {...returnFocus}>
          {row && <LinkForm key={row.userId} row={row} onClose={onClose} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function LinkForm({ row, onClose }: { row: PendingLink; onClose: () => void }) {
  const ids = useId();
  const link = useLinkUser();
  const [cpf, setCpf] = useState("");
  const [error, setError] = useState<string | null>(null);
  const digits = cpf.replace(/\D/g, "");

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (digits.length !== 11) {
      setError("Informe os 11 dígitos do CPF.");
      return;
    }
    try {
      const result = await link.mutateAsync({ userId: row.userId, cpf: digits });
      if (result.status === "vinculado") {
        toast.success(`${row.name} vinculado à chapa ${result.chapa}`);
        onClose();
      } else {
        // O vínculo foi gravado como pendente/divergente: fica na lista com o motivo.
        setError(result.reason ?? (result.status === "pendente" ? "CPF não encontrado no TOTVS RM." : "Divergência no cadastro do RM."));
      }
    } catch (err) {
      setError(err instanceof ServiceError ? err.message : "Não foi possível consultar o RM. Tente novamente.");
    }
  };

  return (
    <form className="sheet__form" onSubmit={onSubmit} noValidate>
      <header className="sheet__header">
        <div>
          <Dialog.Title className="sheet__title">Vincular ao TOTVS RM</Dialog.Title>
          <Dialog.Description className="sheet__description">
            {row.name} · {row.email}
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
          <label className="field__label" htmlFor={`${ids}-cpf`}>
            CPF do funcionário
          </label>
          <input
            id={`${ids}-cpf`}
            className="input mono"
            inputMode="numeric"
            autoComplete="off"
            placeholder="000.000.000-00"
            value={formatCpf(cpf)}
            aria-invalid={error ? "true" : undefined}
            aria-describedby={`${ids}-help`}
            onChange={(event) => setCpf(event.target.value)}
            autoFocus
          />
          <span id={`${ids}-help`} className={error ? "field__error" : "field__help"} role={error ? "alert" : undefined}>
            {error ?? "O RM é consultado pela API.RH.FUNCIONARIO. O CPF fica gravado só no vínculo e aparece mascarado nas listas."}
          </span>
        </div>

        <p className="sheet__notice">
          <Info size={16} aria-hidden="true" />
          Encontrado e ativo no RM, o usuário ganha o papel Colaborador. A operação fica registrada na auditoria.
        </p>
      </div>

      <footer className="sheet__footer">
        <Dialog.Close asChild>
          <button type="button" className="btn btn--outline">
            Cancelar
          </button>
        </Dialog.Close>
        <button type="submit" className="btn btn--primary" disabled={link.isPending}>
          {link.isPending ? "Consultando o RM…" : "Procurar e vincular"}
        </button>
      </footer>
    </form>
  );
}
