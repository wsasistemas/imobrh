import { ChangeOwnPasswordDialog } from "../../auth/ChangeOwnPasswordDialog";
import * as Tabs from "@radix-ui/react-tabs";
import { CircleDot, KeyRound, Lock, MonitorSmartphone, Plus, Search, Shield, UserRound, Users as UsersIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Breadcrumb } from "../../../components/Breadcrumb";
import { SUPER_ADMIN_ROLE, type RoleKey } from "../../../config/app";
import { getMenuItem } from "../../../config/menuRegistry";
import { useDebouncedValue } from "../../../hooks/useDebouncedValue";
import { useAccess } from "../access/useAccess";
import { configBreadcrumb } from "../components/configBreadcrumb";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DataTable, type Column } from "../components/DataTable";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { Pagination } from "../components/Pagination";
import { StatusBadge } from "../components/StatusBadge";
import { UserAvatar } from "../components/UserAvatar";
import { useRoles } from "../hooks/useRoles";
import {
  useDeleteUser,
  useSendPasswordReset,
  useSetPasswordChangeRequired,
  useSetUserActive,
  useUsers,
} from "../hooks/useUsers";
import { ServiceError, type User, type UserTab } from "../services/types";
import { UserActionsMenu } from "../users/UserActionsMenu";
import { formatLastAccess, RoleBadge, UserStatusBadge } from "../users/userDisplay";
import { TempPasswordDialog } from "../users/TempPasswordDialog";
import { UserSheet, type UserSheetState } from "../users/UserSheet";
import "./Usuarios.css";

const TABS: { value: UserTab; label: string }[] = [
  { value: "all", label: "Todos" },
  { value: "active", label: "Ativos" },
  { value: "inactive", label: "Inativos" },
  { value: "pending", label: "Convites pendentes" },
];

type PendingConfirm = { kind: "deactivate" | "delete"; user: User } | null;

function errorMessage(error: unknown): string {
  return error instanceof ServiceError ? error.message : "Não foi possível concluir a ação. Tente novamente.";
}

/** `nav`: barra de seções (Usuários | Equipes), montada em UsuariosSecoes. */
export function Usuarios({ nav }: { nav?: ReactNode } = {}) {
  const item = getMenuItem("manage_users");
  const { user: me, role: myRole } = useAccess();

  const [tab, setTab] = useState<UserTab>("all");
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<RoleKey | "all">("all");
  const [page, setPage] = useState(1);
  const [sheet, setSheet] = useState<UserSheetState | null>(null);
  const [confirm, setConfirm] = useState<PendingConfirm>(null);
  const [tempPasswordFor, setTempPasswordFor] = useState<User | null>(null);

  const debouncedSearch = useDebouncedValue(search);
  const users = useUsers({ tab, search: debouncedSearch, role: roleFilter, page });
  const roles = useRoles();
  const setActive = useSetUserActive();
  const deleteUser = useDeleteUser();
  const sendReset = useSendPasswordReset();
  const requireChange = useSetPasswordChangeRequired();

  const data = users.data;
  const hasFilters = debouncedSearch.trim() !== "" || roleFilter !== "all";

  // Se a página atual ficou vazia (ex.: após excluir o último da página), volta uma.
  useEffect(() => {
    if (data && data.items.length === 0 && page > 1) setPage(page - 1);
  }, [data, page]);

  const clearFilters = () => {
    setSearch("");
    setRoleFilter("all");
    setPage(1);
  };

  const handleSendReset = (user: User) => {
    sendReset.mutate(user.id, {
      onSuccess: () => toast.success(`Link de redefinição enviado para ${user.email}`),
      onError: (error) => toast.error(errorMessage(error)),
    });
  };

  const handleRemoveRequirement = (user: User) => {
    requireChange.mutate(
      { id: user.id, required: false },
      {
        onSuccess: () => toast.success(`Exigência de troca de senha removida de ${user.name}`),
        onError: (error) => toast.error(errorMessage(error)),
      },
    );
  };

  const handleReactivate = (user: User) => {
    setActive.mutate(
      { id: user.id, active: true },
      {
        onSuccess: () => toast.success(`Conta de ${user.name} reativada`),
        onError: (error) => toast.error(errorMessage(error)),
      },
    );
  };

  const handleConfirm = () => {
    if (!confirm) return;
    const { kind, user } = confirm;
    const options = {
      onSuccess: () => {
        toast.success(
          kind === "delete" ? `Conta de ${user.name} excluída` : `Conta de ${user.name} inativada e sessões encerradas`,
        );
        setConfirm(null);
      },
      onError: (error: unknown) => toast.error(errorMessage(error)),
    };
    if (kind === "delete") deleteUser.mutate(user.id, options);
    else setActive.mutate({ id: user.id, active: false }, options);
  };

  const columns: Column<User>[] = [
    {
      id: "user",
      header: "Usuário",
      icon: UserRound,
      cell: (row) => (
        <div className="users__identity">
          <UserAvatar name={row.name} />
          <div>
            <div className="users__name">
              {row.name}
              {row.isOwner && <StatusBadge variant="danger">Proprietário</StatusBadge>}
              {row.id === me?.id && <StatusBadge variant="info">Você</StatusBadge>}
            </div>
            <div className="users__email">{row.email}</div>
          </div>
        </div>
      ),
    },
    { id: "role", header: "Perfil", icon: Shield, cell: (row) => <RoleBadge role={row.role} label={row.roleLabel} /> },
    { id: "status", header: "Status", icon: CircleDot, cell: (row) => <UserStatusBadge status={row.status} /> },
    {
      id: "lastAccess",
      header: "Último acesso",
      icon: MonitorSmartphone,
      cell: (row) => <span className="users__muted">{formatLastAccess(row.lastAccessAt)}</span>,
    },
    {
      id: "password",
      header: "Senha",
      icon: KeyRound,
      cell: (row) =>
        row.mustChangePassword ? (
          <StatusBadge variant="warning">Troca exigida</StatusBadge>
        ) : (
          <span className="users__muted">Em dia</span>
        ),
    },
    {
      id: "actions",
      header: "Ações",
      width: "120px",
      align: "right",
      cell: (row) => {
        // Regra 5: ninguém age sobre a própria conta por aqui.
        if (row.id === me?.id) {
          return (
            <ChangeOwnPasswordDialog
              trigger={
                <button type="button" className="btn btn--outline btn--sm-users" title="Sua conta: altere a sua senha">
                  Alterar senha
                </button>
              }
            />
          );
        }
        // Conta proprietária: ninguém mexe. Regra 4: super admin só é gerenciado por outro super admin.
        if (row.isOwner || (row.role === SUPER_ADMIN_ROLE && myRole !== SUPER_ADMIN_ROLE)) {
          return (
            <span className="users__protected">
              <Lock size={14} aria-hidden="true" />
              Protegido
            </span>
          );
        }
        return (
          <UserActionsMenu
            user={row}
            onEdit={() => setSheet({ mode: "edit", user: row })}
            onSendReset={() => handleSendReset(row)}
            onChangePassword={() => setTempPasswordFor(row)}
            onRemovePasswordChange={() => handleRemoveRequirement(row)}
            onDeactivate={() => setConfirm({ kind: "deactivate", user: row })}
            onReactivate={() => handleReactivate(row)}
            onDelete={() => setConfirm({ kind: "delete", user: row })}
          />
        );
      },
    },
  ];

  const emptyState = hasFilters ? (
    <EmptyState
      icon={Search}
      title="Nenhum usuário encontrado"
      description="Ajuste a busca ou o filtro de perfil."
      action={
        <button type="button" className="btn btn--outline" onClick={clearFilters}>
          Limpar filtros
        </button>
      }
    />
  ) : (
    <EmptyState icon={UsersIcon} title="Nenhum usuário nesta aba" description="Quando houver usuários aqui, eles aparecem nesta lista." />
  );

  return (
    <>
      <Breadcrumb items={configBreadcrumb(item.label)} />
      <PageHeader
        title={item.label}
        description={item.description}
        actions={
          <button type="button" className="btn btn--primary" onClick={() => setSheet({ mode: "create" })}>
            <Plus size={16} aria-hidden="true" />
            Novo usuário
          </button>
        }
      />

      {nav}

      <Tabs.Root
        className="card users"
        value={tab}
        onValueChange={(value) => {
          setTab(value as UserTab);
          setPage(1);
        }}
      >
        <Tabs.List className="tabs" aria-label="Filtrar usuários por situação">
          {TABS.map((entry) => (
            <Tabs.Trigger key={entry.value} value={entry.value} className="tabs__trigger">
              {entry.label}
              <span className="tabs__count">{data?.counts[entry.value] ?? "–"}</span>
            </Tabs.Trigger>
          ))}
        </Tabs.List>

        <div className="users__toolbar">
          <div className="users__search">
            <label htmlFor="users-search" className="visually-hidden">
              Buscar por nome ou e-mail
            </label>
            <Search size={16} aria-hidden="true" />
            <input
              id="users-search"
              type="search"
              className="input input--sm"
              placeholder="Buscar por nome ou e-mail"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
            />
          </div>
          <div className="users__filter">
            <label htmlFor="users-role" className="users__filter-label">
              <UserRound size={16} aria-hidden="true" />
              Perfil
            </label>
            <select
              id="users-role"
              className="input input--sm"
              value={roleFilter}
              onChange={(event) => {
                setRoleFilter(event.target.value);
                setPage(1);
              }}
            >
              <option value="all">Todos os perfis</option>
              {roles.data?.map((role) => (
                <option key={role.key} value={role.key}>
                  {role.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <Tabs.Content value={tab} tabIndex={-1}>
          <DataTable
            caption="Usuários do sistema"
            columns={columns}
            rows={data?.items}
            rowKey={(row) => row.id}
            isLoading={users.isPending}
            isFetching={users.isFetching}
            isError={users.isError}
            onRetry={() => void users.refetch()}
            emptyState={emptyState}
          />
          {data && data.total > 0 && (
            <Pagination page={data.page} pageSize={data.pageSize} total={data.total} noun="usuários" onPageChange={setPage} />
          )}
        </Tabs.Content>
      </Tabs.Root>

      <UserSheet state={sheet} onClose={() => setSheet(null)} />
      <TempPasswordDialog user={tempPasswordFor} onClose={() => setTempPasswordFor(null)} />

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
        tone={confirm?.kind === "delete" ? "danger" : "warning"}
        title={
          confirm?.kind === "delete" ? `Excluir ${confirm.user.name}?` : `Inativar ${confirm?.user.name ?? ""}?`
        }
        description={
          confirm?.kind === "delete"
            ? "A pessoa perde o acesso ao portal. A conta de login não é apagada e continua valendo nos outros sistemas."
            : "O acesso ao portal é bloqueado na hora. A conta de login continua valendo nos outros sistemas. Você pode reativar depois."
        }
        confirmLabel={confirm?.kind === "delete" ? "Excluir usuário" : "Inativar e encerrar sessões"}
        isPending={setActive.isPending || deleteUser.isPending}
        onConfirm={handleConfirm}
      />
    </>
  );
}
