import type { LucideIcon } from "lucide-react";
import {
  CalendarClock,
  ClipboardList,
  FileText,
  IdCard,
  Inbox,
  Link,
  Monitor,
  Settings,
  ShieldCheck,
  UserCheck,
  Users,
  Workflow,
} from "lucide-react";

// Fonte única de menu, rotas e permissões do Console do RH. Sidebar, guard de rotas e matriz de permissões leem
// apenas daqui: para criar um menu novo, basta adicionar uma entrada nesta lista (e a regra padrão do papel em
// app_imobrh.permissoes_padrao, se algum papel além do Administrador deve ver o menu sem configuração).
//
// Dois níveis:
// - Item com `parent` é uma SEÇÃO dentro da tela do pai (rota própria, fora da sidebar). O pai
//   aparece para quem tiver o próprio item ou qualquer seção dele.
// - Ação (`actionDefinitions`) não tem rota: libera um botão dentro de uma tela e só vale junto
//   com a permissão do pai.

export type MenuGroup = "principal" | "configuracoes";

interface MenuItemDefinition {
  /** Identificador da permissão que libera o item (o mesmo de app_imobrh.papel_permissao). */
  id: string;
  label: string;
  /** Nome só na sidebar, quando diferente do `label` (título, caminho e matriz de permissões usam o `label`). */
  menuLabel?: string;
  path: string;
  icon: LucideIcon;
  group: MenuGroup;
  /** Texto de apoio usado nos cards e cabeçalhos. */
  description?: string;
  /** Só o Administrador acessa, mesmo que o papel tenha a permissão. */
  superAdminOnly?: boolean;
  /** Regra fixa: só o Administrador (não é marcável em Permissões por papel). */
  adminOnly?: boolean;
  /** Sempre visível, sem depender de permissão. */
  alwaysVisible?: boolean;
  /** Seção dentro da tela de outro item (id do pai). */
  parent?: string;
  /** A tela tem abas internas próprias (rota "/*"), mesmo sem seções registradas. */
  subroutes?: boolean;
}

interface ActionPermissionDefinition {
  id: string;
  label: string;
  description: string;
  icon: LucideIcon;
  /** Item ao qual a ação pertence; sem ele, a ação não vale. */
  parent: string;
}

// Rotas do Console (PRD v2, seção Telas): / Caixa do RH, /prazos, /config/processos, /config/aprovacoes, /config/vinculos.
const definitions = [
  {
    id: "caixa_rh",
    label: "Caixa do RH",
    path: "/",
    icon: Inbox,
    group: "principal",
    description: "Casos das suas filas ordenados pelo próximo prazo, com a etapa atual e o prazo legal em destaque.",
  },
  {
    id: "meus_casos",
    label: "Meus casos",
    path: "/casos",
    icon: ClipboardList,
    group: "principal",
    description: "Casos em que você é o responsável pela etapa atual.",
  },
  {
    id: "prazos_legais",
    label: "Prazos legais",
    path: "/prazos",
    icon: CalendarClock,
    group: "principal",
    description: "Todas as etapas com prazo legal (CLT e eSocial) nos próximos 30 dias.",
  },
  {
    id: "config_processos",
    label: "Modelos de processo",
    path: "/config/processos",
    icon: Workflow,
    group: "configuracoes",
    description: "Etapas, responsáveis e prazos de cada serviço, editáveis sem deploy.",
  },
  {
    id: "config_aprovacoes",
    label: "Alçadas",
    path: "/config/aprovacoes",
    icon: UserCheck,
    group: "configuracoes",
    description: "Regras de aprovação por serviço: níveis, condições e quem aprova.",
  },
  {
    id: "config_vinculos",
    label: "Vínculos pendentes",
    path: "/config/vinculos",
    icon: IdCard,
    group: "configuracoes",
    description: "Usuários do imobdesk sem chapa no TOTVS RM: vincule pelo CPF.",
  },
  {
    id: "manage_users",
    label: "Usuários e papéis",
    path: "/config/usuarios",
    icon: Users,
    group: "configuracoes",
    description: "Quem usa o ImobRH e com quais papéis. As contas são as do imobdesk.",
  },
  {
    id: "manage_permissions",
    label: "Permissões por papel",
    path: "/config/permissoes",
    icon: ShieldCheck,
    group: "configuracoes",
    description: "Quais menus do Console cada papel enxerga.",
  },
  {
    id: "configure_integrations",
    label: "Integração TOTVS RM",
    path: "/config/integracoes",
    icon: Link,
    group: "configuracoes",
    description: "Conexão com o TOTVS RM (usuário de integração no Vault) e as Consultas SQL API.RH.*.",
    subroutes: true,
  },
  {
    id: "view_audit_logs",
    label: "Auditoria",
    path: "/config/auditoria",
    icon: FileText,
    group: "configuracoes",
    description: "Quem leu ou alterou o quê, com antes e depois.",
  },
  {
    id: "manage_sessions",
    label: "Sessões ativas",
    path: "/config/sessoes",
    icon: Monitor,
    group: "configuracoes",
    description: "Quem do RH está conectado agora e encerramento de sessões (o login é o do imobdesk).",
  },
] as const satisfies readonly MenuItemDefinition[];

// Nenhuma ação na Fase 0. Ao criar a primeira, troque por `[…] as const satisfies readonly ActionPermissionDefinition[]`
// e derive ActionPermissionId da lista.
const actionDefinitions: readonly (ActionPermissionDefinition & { id: never })[] = [];

type Definition = (typeof definitions)[number];

export type MenuItemId = Definition["id"];
export type ActionPermissionId = never;
export type PermissionId = MenuItemId | ActionPermissionId;
/** Itens com tela própria no roteador (sem `parent`). */
export type TopLevelMenuId = Exclude<Definition, { parent: string }>["id"];

export type MenuItem = Omit<MenuItemDefinition, "id" | "parent"> & { id: MenuItemId; parent?: MenuItemId };

/** Entrada da matriz de permissões: item de menu ou ação. */
export interface PermissionEntry {
  id: PermissionId;
  kind: "menu" | "action";
  label: string;
  description?: string;
  icon: LucideIcon;
  group: MenuGroup;
  parent?: PermissionId;
  superAdminOnly?: boolean;
  adminOnly?: boolean;
  alwaysVisible?: boolean;
}

export const menuRegistry: readonly MenuItem[] = definitions;

export const CONFIG_ROOT_PATH = "/config";

export const menuGroups: Record<MenuGroup, { label: string; icon: LucideIcon }> = {
  principal: { label: "Menu principal", icon: Inbox },
  configuracoes: { label: "Configurações", icon: Settings },
};

const itemsById = new Map<MenuItemId, MenuItem>(menuRegistry.map((item) => [item.id, item]));

export function getMenuItem(id: MenuItemId): MenuItem {
  const item = itemsById.get(id);
  if (!item) throw new Error(`Item de menu não registrado: ${id}`);
  return item;
}

/** Todas as permissões (menus e ações), cada ação com o grupo do item pai. */
export const permissionEntries: readonly PermissionEntry[] = [
  ...menuRegistry.map((item): PermissionEntry => ({ ...item, kind: "menu" })),
  ...actionDefinitions.map(
    (action): PermissionEntry => ({ ...action, parent: action.parent as PermissionId, kind: "action", group: getMenuItem(action.parent as MenuItemId).group }),
  ),
];

const entriesById = new Map<PermissionId, PermissionEntry>(permissionEntries.map((entry) => [entry.id, entry]));

export function getPermission(id: PermissionId): PermissionEntry {
  const entry = entriesById.get(id);
  if (!entry) throw new Error(`Permissão não registrada: ${id}`);
  return entry;
}

export function isPermissionId(value: string): value is PermissionId {
  return entriesById.has(value as PermissionId);
}

/** Itens de primeiro nível do grupo (sidebar, cards e matriz). */
export function menuItemsByGroup(group: MenuGroup): MenuItem[] {
  return menuRegistry.filter((item) => item.group === group && !item.parent);
}

/** Seções (com rota) dentro da tela de um item. */
export function routeChildrenOf(id: MenuItemId): MenuItem[] {
  return menuRegistry.filter((item) => item.parent === id);
}

/** Tudo o que fica aninhado sob uma permissão na matriz: seções e ações. */
export function permissionChildrenOf(id: PermissionId): PermissionEntry[] {
  return permissionEntries.filter((entry) => entry.parent === id);
}

export type RouteRequirement =
  | { type: "permission"; id: PermissionId }
  | { type: "anyOf"; ids: PermissionId[] }
  | { type: "anyInGroup"; group: MenuGroup }
  | { type: "open" };

/**
 * Descobre qual permissão protege uma rota (o caminho mais específico vence).
 * A raiz de um item com seções abre para quem tiver o item ou qualquer seção.
 * Rotas fora do registro ficam abertas (ex.: 404).
 */
export function resolvePermissionForPath(pathname: string): RouteRequirement {
  const path = pathname.replace(/\/+$/, "") || "/";
  const item = menuRegistry
    .filter((entry) => path === entry.path || path.startsWith(`${entry.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (item) {
    const sections = routeChildrenOf(item.id);
    if (path === item.path && sections.length > 0) {
      return { type: "anyOf", ids: [item.id, ...sections.map((section) => section.id)] };
    }
    return { type: "permission", id: item.id };
  }
  if (path === CONFIG_ROOT_PATH) return { type: "anyInGroup", group: "configuracoes" };
  return { type: "open" };
}
