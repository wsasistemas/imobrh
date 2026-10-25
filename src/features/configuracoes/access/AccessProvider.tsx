import { useQuery } from "@tanstack/react-query";
import { useMemo, type ReactNode } from "react";
import {
  menuItemsByGroup,
  resolvePermissionForPath,
  routeChildrenOf,
  type MenuItemId,
  type PermissionId,
} from "../../../config/menuRegistry";
import { queryKeys } from "../hooks/queryKeys";
import { useAuthSession } from "../../auth/useAuthSession";
import { openwaService } from "../../atendimento/services/openwa";
import { permissionsService } from "../services";
import { ServiceError } from "../services/types";
import { AccessContext, type AccessContextValue } from "./AccessContext";

/** Telas que dependem do WhatsApp (ficam ocultas quando o recurso está desligado). */
const OCULTOS_SEM_WHATSAPP = new Set<PermissionId>(["gestao_atendimento_central", "gestao_chamados_monitor"]);

export function AccessProvider({ children }: { children: ReactNode }) {
  const { status, email } = useAuthSession();
  // A chave leva o e-mail: trocar de conta nunca reaproveita o acesso da anterior.
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: [...queryKeys.access, email],
    queryFn: () => permissionsService.getEffectiveAccess(),
    enabled: status === "signedIn",
  });

  // Recurso desligado esconde as telas dele, sem mexer nas permissões do perfil: sem WhatsApp em uso (OpenWA desligado
  // e nenhum número Zenvia), Conversas e Monitor de atendimento somem do menu, das seções e das rotas. Erro na consulta
  // não esconde nada.
  const whatsapp = useQuery({
    queryKey: ["recursos", "whatsapp", email],
    queryFn: () => openwaService.whatsappDisponivel(),
    enabled: status === "signedIn",
    staleTime: 60_000,
  });
  const semWhatsapp = whatsapp.data === false;

  const value = useMemo<AccessContextValue>(() => {
    // As permissões já chegam decididas pelo serviço (policy.ts); aqui só se consulta.
    const hasPermission = (id: PermissionId) => data?.permissions[id] === true && !(semWhatsapp && OCULTOS_SEM_WHATSAPP.has(id));
    // Um item com seções abre para quem tiver o item ou qualquer uma das seções.
    const canOpen = (id: MenuItemId) => hasPermission(id) || routeChildrenOf(id).some((section) => hasPermission(section.id));
    const hasAnyInGroup: AccessContextValue["hasAnyInGroup"] = (group) =>
      menuItemsByGroup(group).some((item) => canOpen(item.id));

    return {
      user: data?.user ?? null,
      role: data?.role ?? null,
      roleLabel: data?.roleLabel ?? "Sem perfil",
      isSuperAdmin: data?.isSuperAdmin ?? false,
      canManageRoles: data?.canManageRoles ?? false,
      permissions: data?.permissions ?? null,
      mustChangePassword: data?.mustChangePassword ?? false,
      isLoading: isPending,
      isError,
      errorCode: error instanceof ServiceError ? error.code : null,
      refetch: () => void refetch(),
      hasPermission,
      canOpen,
      hasAnyInGroup,
      canAccessPath: (pathname) => {
        const requirement = resolvePermissionForPath(pathname);
        if (requirement.type === "permission") return hasPermission(requirement.id);
        if (requirement.type === "anyOf") return requirement.ids.some(hasPermission);
        if (requirement.type === "anyInGroup") return hasAnyInGroup(requirement.group);
        return true;
      },
    };
  }, [data, isPending, isError, error, refetch, semWhatsapp]);

  return <AccessContext.Provider value={value}>{children}</AccessContext.Provider>;
}
