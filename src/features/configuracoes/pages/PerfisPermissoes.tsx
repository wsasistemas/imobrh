import { Lock, Plus, Search, SearchX } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Breadcrumb } from "../../../components/Breadcrumb";
import { ADMIN_ROLE, SUPER_ADMIN_ROLE, type RoleKey } from "../../../config/app";
import {
  getMenuItem,
  getPermission,
  menuGroups,
  menuItemsByGroup,
  permissionChildrenOf,
  type MenuGroup,
  type PermissionEntry,
  type PermissionId,
} from "../../../config/menuRegistry";
import { normalizeText } from "../../../utils/text";
import { configBreadcrumb } from "../components/configBreadcrumb";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { PageHeader } from "../components/PageHeader";
import { PermissionRow } from "../components/PermissionRow";
import { useAccess } from "../access/useAccess";
import { useRolePermissions, useSaveRolePermissions } from "../hooks/usePermissions";
import { useDeleteRole, useRoles } from "../hooks/useRoles";
import { RoleActionsMenu } from "../roles/RoleActionsMenu";
import { RoleSheet, type RoleSheetState } from "../roles/RoleSheet";
import { ServiceError, type PermissionChange, type PermissionRules, type RoleSummary } from "../services/types";
import "./PerfisPermissoes.css";

const GROUPS: MenuGroup[] = ["principal", "configuracoes", "treinamento"];

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

interface MatrixRow {
  entry: PermissionEntry;
  depth: number;
}

/** Linhas do grupo na ordem da matriz: cada item seguido das suas seções e ações (recursivo). */
function rowsOf(group: MenuGroup): MatrixRow[] {
  const expand = (entry: PermissionEntry, depth: number): MatrixRow[] => [
    { entry, depth },
    ...permissionChildrenOf(entry.id).flatMap((child) => expand(child, depth + 1)),
  ];
  return menuItemsByGroup(group).flatMap((item) => expand(getPermission(item.id), 0));
}

export function PerfisPermissoes() {
  const page = getMenuItem("manage_permissions");
  const { canManageRoles } = useAccess();
  const roles = useRoles();
  const [selectedKey, setSelectedKey] = useState<RoleKey | null>(null);
  const [pendingRole, setPendingRole] = useState<RoleKey | null>(null);
  const [draft, setDraft] = useState<PermissionRules>({});
  const [filter, setFilter] = useState("");
  const [roleSheet, setRoleSheet] = useState<RoleSheetState | null>(null);
  const [roleToDelete, setRoleToDelete] = useState<RoleSummary | null>(null);
  const deleteRole = useDeleteRole();

  // Perfil exibido: o escolhido, se ainda existir; senão, o primeiro editável da lista.
  const summary =
    roles.data?.find((role) => role.key === selectedKey) ?? roles.data?.find((role) => !role.locked) ?? roles.data?.[0];
  const selected = summary?.key;
  const selectedLabel = summary?.label ?? "";
  const rules = useRolePermissions(selected);
  const save = useSaveRolePermissions();
  const roleLocked = selected === SUPER_ADMIN_ROLE;
  const baseline = (id: PermissionId) => rules.data?.[id] === true;

  // As regras abaixo recebem o rascunho para o "Liberar todos" poder encadear pai e ação num passo só.
  const checkedIn = (state: PermissionRules, item: PermissionEntry): boolean => {
    if (item.alwaysVisible || roleLocked) return true;
    if (item.superAdminOnly) return false;
    if (item.adminOnly) return selected === ADMIN_ROLE;
    // Ação vale só com o item pai liberado.
    if (item.kind === "action" && item.parent && !checkedIn(state, getPermission(item.parent))) return false;
    return state[item.id] ?? baseline(item.id);
  };
  const blockedByParent = (state: PermissionRules, item: PermissionEntry): PermissionEntry | null => {
    if (roleLocked || item.kind !== "action" || !item.parent) return null;
    const parent = getPermission(item.parent);
    return checkedIn(state, parent) ? null : parent;
  };
  const lockedIn = (state: PermissionRules, item: PermissionEntry) =>
    roleLocked || Boolean(item.alwaysVisible) || Boolean(item.superAdminOnly) || Boolean(item.adminOnly) || blockedByParent(state, item) !== null;

  const checkedOf = (item: PermissionEntry) => checkedIn(draft, item);
  const isItemLocked = (item: PermissionEntry) => lockedIn(draft, item);

  const changes: PermissionChange[] = GROUPS.flatMap(rowsOf).flatMap(({ entry }) => {
    const enabled = draft[entry.id];
    return enabled === undefined ? [] : [{ id: entry.id, enabled }];
  });

  const setItem = (id: PermissionId, next: boolean) => {
    setDraft((current) => {
      const updated = { ...current };
      // Voltou ao valor salvo: deixa de ser alteração.
      if (next === baseline(id)) delete updated[id];
      else updated[id] = next;
      return updated;
    });
  };

  const releaseAll = (group: MenuGroup) => {
    setDraft((current) => {
      const updated = { ...current };
      // Pai vem antes dos filhos na lista: ao chegar na ação, o pai já está liberado no rascunho.
      for (const { entry } of rowsOf(group)) {
        if (lockedIn(updated, entry) || checkedIn(updated, entry)) continue;
        if (baseline(entry.id)) delete updated[entry.id];
        else updated[entry.id] = true;
      }
      return updated;
    });
  };

  // Regra 7: trocar de perfil com alterações pendentes pede confirmação.
  const selectRole = (role: RoleKey) => {
    if (role === selected) return;
    if (changes.length > 0) {
      setPendingRole(role);
      return;
    }
    setSelectedKey(role);
  };

  const confirmRoleSwitch = () => {
    if (!pendingRole) return;
    setDraft({});
    setSelectedKey(pendingRole);
    setPendingRole(null);
  };

  const handleSave = () => {
    if (!selected) return;
    save.mutate(
      { role: selected, changes },
      {
        onSuccess: () => {
          setDraft({});
          toast.success(`Permissões do perfil ${selectedLabel} salvas`);
        },
        onError: (error) =>
          toast.error(error instanceof ServiceError ? error.message : "Não foi possível salvar as permissões."),
      },
    );
  };

  const term = normalizeText(filter);
  const matches = ({ entry }: MatrixRow) =>
    !term || normalizeText(entry.label).includes(term) || normalizeText(entry.id).includes(term);
  const visibleGroups = GROUPS.map((group) => ({ group, rows: rowsOf(group).filter(matches) })).filter(
    (entry) => entry.rows.length > 0,
  );

  const connected = summary?.connectedCount ?? 0;

  const handleDeleteRole = () => {
    if (!roleToDelete) return;
    const { key, label } = roleToDelete;
    deleteRole.mutate(key, {
      onSuccess: () => {
        toast.success(`Perfil ${label} excluído`);
        if (key === selected) {
          setDraft({});
          setSelectedKey(null);
        }
        setRoleToDelete(null);
      },
      onError: (error) =>
        toast.error(error instanceof ServiceError ? error.message : "Não foi possível excluir o perfil."),
    });
  };

  return (
    <>
      <Breadcrumb items={configBreadcrumb(page.label)} />
      <PageHeader title={page.label} description={page.description} />

      <div className="perms">
        {/* ---------- Lista de perfis ---------- */}
        <aside className="card perms__roles" aria-label="Perfis de acesso">
          <p className="section-title perms__roles-title">Perfis</p>
          {roles.isPending ? (
            <div className="perms__roles-loading">
              {Array.from({ length: 5 }, (_, index) => (
                <div key={index} className="skeleton" style={{ height: 44 }} />
              ))}
            </div>
          ) : roles.isError ? (
            <ErrorState bare message="Não foi possível carregar os perfis." onRetry={() => void roles.refetch()} />
          ) : (
            <ul className="perms__role-list">
              {roles.data.map((role) => (
                <li key={role.key} className="perms__role-item">
                  <button
                    type="button"
                    className={`perms__role${role.key === selected ? " perms__role--active" : ""}`}
                    aria-current={role.key === selected ? "true" : undefined}
                    onClick={() => selectRole(role.key)}
                  >
                    <span className="perms__role-name">
                      {role.label}
                      {role.locked && <Lock size={13} aria-label="Não editável" />}
                    </span>
                    <span className="perms__role-meta">
                      {role.locked ? "Acesso total, não editável" : plural(role.userCount, "usuário", "usuários")}
                    </span>
                  </button>
                  {role.manageable ? (
                    <RoleActionsMenu
                      role={role}
                      onEdit={() => setRoleSheet({ mode: "edit", role })}
                      onDelete={() => setRoleToDelete(role)}
                    />
                  ) : (
                    !role.locked && (
                      <span className="perms__role-protected" title="Você não pode alterar este perfil">
                        <Lock size={14} aria-label="Você não pode alterar este perfil" />
                      </span>
                    )
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="perms__new-role">
            <button
              type="button"
              className="btn btn--outline"
              disabled={!canManageRoles || !roles.data}
              aria-describedby={canManageRoles ? undefined : "perms-new-role-help"}
              onClick={() => setRoleSheet({ mode: "create" })}
            >
              <Plus size={16} aria-hidden="true" />
              Novo perfil
            </button>
            {!canManageRoles && (
              <span id="perms-new-role-help" className="field__help">
                Somente Super admin e Admin cadastram perfis.
              </span>
            )}
          </div>
        </aside>

        {/* ---------- Matriz de permissões ---------- */}
        <section className="card perms__matrix" aria-labelledby="perms-role-title">
          <header className="perms__matrix-header">
            <div>
              <h2 id="perms-role-title">{selectedLabel}</h2>
              <p>
                {roleLocked
                  ? "Super admin tem acesso total a todos os menus. Este perfil não é editável."
                  : `${plural(summary?.userCount ?? 0, "usuário", "usuários")} com este perfil. Menus sem regra ficam negados.`}
              </p>
            </div>
            <div className="perms__filter">
              <label htmlFor="perms-filter" className="visually-hidden">
                Filtrar menus
              </label>
              <Search size={16} aria-hidden="true" />
              <input
                id="perms-filter"
                type="search"
                className="input input--sm"
                placeholder="Filtrar menus"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
            </div>
          </header>

          {rules.isPending ? (
            <div className="perms__matrix-loading">
              {Array.from({ length: 6 }, (_, index) => (
                <div key={index} className="skeleton" style={{ height: 40 }} />
              ))}
            </div>
          ) : rules.isError ? (
            <ErrorState bare message="Não foi possível carregar as permissões do perfil." onRetry={() => void rules.refetch()} />
          ) : visibleGroups.length === 0 ? (
            <EmptyState icon={SearchX} title="Nenhum menu encontrado" description="Nenhum menu corresponde ao filtro." />
          ) : (
            visibleGroups.map(({ group, rows }) => {
              const all = rowsOf(group).map((row) => row.entry);
              const released = all.filter(checkedOf).length;
              // Um item negado com ação dentro também conta: liberar o pai destrava a ação no mesmo passo.
              const canReleaseAll = all.some((item) => !isItemLocked(item) && !checkedOf(item));
              return (
                <div key={group} className="perms__group">
                  <div className="perms__group-header">
                    <h3 className="section-title">{menuGroups[group].label}</h3>
                    <span className="perms__group-count">
                      {released} de {all.length} liberados
                    </span>
                    <button
                      type="button"
                      className="perms__release-all"
                      disabled={!canReleaseAll}
                      onClick={() => releaseAll(group)}
                    >
                      Liberar todos
                    </button>
                  </div>
                  <ul>
                    {rows.map(({ entry, depth }) => (
                      <PermissionRow
                        key={entry.id}
                        item={entry}
                        depth={depth}
                        checked={checkedOf(entry)}
                        locked={isItemLocked(entry)}
                        requires={blockedByParent(draft, entry)?.label}
                        changed={draft[entry.id] !== undefined}
                        noRule={rules.data[entry.id] === undefined}
                        onChange={(next) => setItem(entry.id, next)}
                      />
                    ))}
                  </ul>
                </div>
              );
            })
          )}
        </section>
      </div>

      {/* Regra 7: barra fixa com o lote pendente */}
      {changes.length > 0 && (
        <div className="save-bar" role="region" aria-label="Alterações não salvas">
          <span>
            <strong>{plural(changes.length, "alteração não salva", "alterações não salvas")}</strong> · valem na hora para{" "}
            {connected === 1 ? "o 1 usuário conectado" : `os ${connected} usuários conectados`}
          </span>
          <div className="save-bar__actions">
            <button type="button" className="btn btn--outline" disabled={save.isPending} onClick={() => setDraft({})}>
              Descartar
            </button>
            <button type="button" className="btn btn--primary" disabled={save.isPending} onClick={handleSave}>
              {save.isPending ? "Salvando…" : "Salvar"}
            </button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={pendingRole !== null}
        onOpenChange={(open) => !open && setPendingRole(null)}
        tone="warning"
        title="Descartar alterações?"
        description={`Você tem ${plural(changes.length, "alteração não salva", "alterações não salvas")} no perfil ${selectedLabel}. Trocar de perfil descarta essas alterações.`}
        confirmLabel="Descartar e trocar"
        isPending={false}
        onConfirm={confirmRoleSwitch}
      />

      {roles.data && (
        <RoleSheet
          state={roleSheet}
          roles={roles.data}
          onClose={() => setRoleSheet(null)}
          onCreated={(role) => selectRole(role.key)}
        />
      )}

      <ConfirmDialog
        open={roleToDelete !== null}
        onOpenChange={(open) => !open && setRoleToDelete(null)}
        tone="danger"
        title={`Excluir o perfil ${roleToDelete?.label ?? ""}?`}
        description="O perfil e as permissões dele são removidos. Esta ação não pode ser desfeita."
        confirmLabel="Excluir perfil"
        isPending={deleteRole.isPending}
        onConfirm={handleDeleteRole}
      />
    </>
  );
}
