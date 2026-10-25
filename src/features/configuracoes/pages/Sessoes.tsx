import { CalendarSync, Info, LogIn, Monitor, MonitorOff, Network, User } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Breadcrumb } from "../../../components/Breadcrumb";
import { getMenuItem } from "../../../config/menuRegistry";
import { formatDateTime, formatRelative, isNow } from "../../../utils/dates";
import { configBreadcrumb } from "../components/configBreadcrumb";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DataTable, type Column } from "../components/DataTable";
import { EmptyState } from "../components/EmptyState";
import { Notice } from "../components/Notice";
import { PageHeader } from "../components/PageHeader";
import { StatusBadge } from "../components/StatusBadge";
import { UserAvatar } from "../components/UserAvatar";
import { useRevokeSession, useSessions } from "../hooks/useSessions";
import { ServiceError, type ActiveSession } from "../services/types";
import "./Sessoes.css";

export function Sessoes() {
  const page = getMenuItem("manage_sessions");
  const sessions = useSessions();
  const revoke = useRevokeSession();
  const [toRevoke, setToRevoke] = useState<ActiveSession | null>(null);

  const handleRevoke = () => {
    if (!toRevoke) return;
    revoke.mutate(toRevoke.id, {
      onSuccess: () => {
        toast.success(`Sessão de ${toRevoke.userName} encerrada`);
        setToRevoke(null);
      },
      onError: (error) =>
        toast.error(error instanceof ServiceError ? error.message : "Não foi possível encerrar a sessão."),
    });
  };

  const columns: Column<ActiveSession>[] = [
    {
      id: "user",
      header: "Usuário",
      icon: User,
      cell: (row) => (
        <div className="sessions__identity">
          <UserAvatar name={row.userName} />
          <div>
            <div className="sessions__name">{row.userName}</div>
            <div className="sessions__muted">{row.userEmail}</div>
          </div>
        </div>
      ),
    },
    { id: "device", header: "Dispositivo", icon: Monitor, cell: (row) => row.device },
    { id: "location", header: "IP de origem", icon: Network, cell: (row) => <span className="sessions__muted">{row.location}</span> },
    { id: "started", header: "Início", icon: LogIn, cell: (row) => <span className="sessions__nowrap">{formatDateTime(row.startedAt)}</span> },
    {
      id: "activity",
      header: "Última atividade",
      icon: CalendarSync,
      cell: (row) => (
        <span className="sessions__activity">
          {isNow(row.lastActivityAt) && <span className="sessions__online" aria-hidden="true" />}
          {formatRelative(row.lastActivityAt)}
        </span>
      ),
    },
    {
      id: "action",
      header: "Ação",
      align: "right",
      width: "170px",
      cell: (row) =>
        // Regra 11: a sessão de quem está usando o portal não tem botão.
        row.isCurrent ? (
          <StatusBadge variant="info">Sessão atual</StatusBadge>
        ) : (
          <button type="button" className="btn btn--danger-outline" onClick={() => setToRevoke(row)}>
            Encerrar sessão
          </button>
        ),
    },
  ];

  return (
    <>
      <Breadcrumb items={configBreadcrumb(page.label)} />
      <PageHeader title={page.label} description={page.description} />

      <Notice icon={Info}>
        O login é compartilhado com os outros sistemas da WSA. Encerrar uma sessão desconecta aquele acesso, que
        pode ter sido aberto em outro sistema.
      </Notice>

      <section className="card sessions" aria-label="Sessões ativas">
        <DataTable
          caption="Sessões ativas"
          columns={columns}
          rows={sessions.data}
          rowKey={(row) => row.id}
          isLoading={sessions.isPending}
          isFetching={sessions.isFetching}
          isError={sessions.isError}
          onRetry={() => void sessions.refetch()}
          skeletonRows={4}
          emptyState={
            <EmptyState icon={MonitorOff} title="Nenhuma sessão ativa" description="Quando alguém entrar no portal, a sessão aparece aqui." />
          }
        />
      </section>

      <ConfirmDialog
        open={toRevoke !== null}
        onOpenChange={(open) => !open && setToRevoke(null)}
        tone="danger"
        title={`Encerrar a sessão de ${toRevoke?.userName ?? ""}?`}
        description={`A sessão de ${toRevoke?.userName ?? ""} (${toRevoke?.device ?? ""}) termina agora. Para voltar, será preciso entrar de novo.`}
        confirmLabel="Encerrar sessão"
        isPending={revoke.isPending}
        onConfirm={handleRevoke}
      />
    </>
  );
}
