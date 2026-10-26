import { createContext } from "react";
import type { RoleKey } from "../../../config/app";
import type { MenuGroup, MenuItemId, PermissionId } from "../../../config/menuRegistry";
import type { ServiceErrorCode, User } from "../services/types";

export interface AccessContextValue {
  user: User | null;
  role: RoleKey | null;
  /** Nome do perfil para exibição ("Sem perfil" quando não há). */
  roleLabel: string;
  isSuperAdmin: boolean;
  canManageRoles: boolean;
  permissions: Record<PermissionId, boolean> | null;
  mustChangePassword: boolean;
  isLoading: boolean;
  isError: boolean;
  /** Código da regra de negócio que falhou (ex.: NO_PORTAL_ACCESS). */
  errorCode: ServiceErrorCode | null;
  refetch: () => void;
  hasPermission: (id: PermissionId) => boolean;
  /** O item de menu abre para o usuário: permissão do próprio item ou de alguma seção dele. */
  canOpen: (id: MenuItemId) => boolean;
  hasAnyInGroup: (group: MenuGroup) => boolean;
  canAccessPath: (pathname: string) => boolean;
}

export const AccessContext = createContext<AccessContextValue | null>(null);
