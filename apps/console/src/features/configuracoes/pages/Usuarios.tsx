import * as Tabs from "@radix-ui/react-tabs";
import { CircleDot, IdCard, MonitorSmartphone, Search, Shield, UserRound, Users as UsersIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Breadcrumb } from "../../../components/Breadcrumb";
import type { RoleKey } from "../../../config/app";
import { getMenuItem } from "../../../config/menuRegistry";
import { useDebouncedValue } from "../../../hooks/useDebouncedValue";
import { useAccess } from "../access/useAccess";
import { configBreadcrumb } from "../components/configBreadcrumb";
import { DataTable, type Column } from "../components/DataTable";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { Pagination } from "../components/Pagination";
import { StatusBadge } from "../components/StatusBadge";
import { UserAvatar } from "../components/UserAvatar";
import { useRoles } from "../hooks/useRoles";
import { useUsers } from "../hooks/useUsers";
import type { User, UserTab } from "../services/types";
import { formatLastAccess, LinkStatusBadge, RoleBadge, UserStatusBadge } from "../users/userDisplay";
import { UserSheet } from "../users/UserSheet";
import "./Usuarios.css";

const TABS: { value: UserTab; label: string }[] = [
  { value: "all", label: "Todos" },
  { value: "active", label: "Ativos" },
  { value: "inactive", label: "Inativos" },
  { value: "pending", label: "Primeiro acesso pendente" },
];

/**
 * Usuários e papéis: os logins da empresa vêm do cadastro do imobdesk (o login é compartilhado); aqui só se
 * atribuem os papéis do ImobRH. Quem pode o quê é decidido no banco (app_imobrh.definir_papeis_usuario).
 */
export function Usuarios() {
  const item = getMenuItem("manage_users");
  const { user: me } = useAccess();

  const [tab, setTab] = useState<UserTab>("all");
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<RoleKey | "all">("all");
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<User | null>(null);

  const debouncedSearch = useDebouncedValue(search);
  const users = useUsers({ tab, search: debouncedSearch, role: roleFilter, page });
  const roles = useRoles();

  const data = users.data;
  const hasFilters = debouncedSearch.trim() !== "" || roleFilter !== "all";

  // Se a página atual ficou vazia (ex.: depois de um filtro), volta uma.
  useEffect(() => {
    if (data && data.items.length === 0 && page > 1) setPage(page - 1);
  }, [data, page]);

  const clearFilters = () => {
    setSearch("");
    setRoleFilter("all");
    setPage(1);
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
              {row.id === me?.id && <StatusBadge variant="info">Você</StatusBadge>}
            </div>
            <div className="users__email">{row.email}</div>
          </div>
        </div>
      ),
    },
    {
      id: "roles",
      header: "Papéis",
      icon: Shield,
      cell: (row) =>
        row.roles.length === 0 ? (
          <RoleBadge role={null} label={null} />
        ) : (
          <span className="users__roles">
            {row.roles.map((role) => (
              <RoleBadge key={role} role={role} label={roles.data?.find((entry) => entry.key === role)?.label ?? role} />
            ))}
          </span>
        ),
    },
    { id: "link", header: "Vínculo RM", icon: IdCard, cell: (row) => <LinkStatusBadge status={row.linkStatus} chapa={row.chapa} /> },
    { id: "status", header: "Status no imobdesk", icon: CircleDot, cell: (row) => <UserStatusBadge status={row.status} /> },
    {
      id: "lastAccess",
      header: "Último acesso",
      icon: MonitorSmartphone,
      cell: (row) => <span className="users__muted">{formatLastAccess(row.lastAccessAt)}</span>,
    },
    {
      id: "actions",
      header: "Ações",
      width: "140px",
      align: "right",
      cell: (row) => (
        <button type="button" className="btn btn--outline btn--sm-users" onClick={() => setEditing(row)}>
          Editar papéis
        </button>
      ),
    },
  ];

  const emptyState = hasFilters ? (
    <EmptyState
      icon={Search}
      title="Nenhum usuário encontrado"
      description="Ajuste a busca ou o filtro de papel."
      action={
        <button type="button" className="btn btn--outline" onClick={clearFilters}>
          Limpar filtros
        </button>
      }
    />
  ) : (
    <EmptyState icon={UsersIcon} title="Nenhum usuário nesta aba" description="Os usuários são cadastrados no imobdesk e aparecem aqui." />
  );

  return (
    <>
      <Breadcrumb items={configBreadcrumb(item.label)} />
      <PageHeader title={item.label} description={item.description} />

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
              <Shield size={16} aria-hidden="true" />
              Papel
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
              <option value="all">Todos os papéis</option>
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
            caption="Usuários do ImobRH"
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

      <UserSheet user={editing} onClose={() => setEditing(null)} />
    </>
  );
}
