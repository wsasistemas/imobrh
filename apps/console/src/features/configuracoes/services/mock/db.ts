import { set } from "date-fns";
import type { RoleKey } from "../../../../config/app";
import type { AuditEntry, LinkStatus, PermissionRules, TotvsTestResult, User } from "../types";

// Estado em memória do modo simulado (VITE_DATA_SOURCE=mock ou sem Supabase no .env.local).
// Espelha o app_imobrh: logins do imobdesk, papéis do ImobRH, vínculo com o RM e a matriz de permissões.
// Recarregar a página volta tudo ao estado inicial.

export interface UserRecord extends Omit<User, "roleLabel" | "role"> {
  /** Papéis de origem RM (colaborador/gestor) não mudam pela tela de Usuários. */
  rmRoles: RoleKey[];
  cpf: string | null;
  linkReason: string | null;
  linkUpdatedAt: string;
}

/** Dono do ambiente de demonstração: Administrador. */
export const OWNER_EMAIL = "wagner.antunes@exemplo.com.br";

export interface SessionRecord {
  id: string;
  userId: string;
  device: string;
  location: string;
  startedAt: string;
  lastActivityAt: string;
}

export interface TotvsConnectionRecord {
  url: string;
  user: string;
  active: boolean;
  /** Senha fictícia do mock; nunca sai da camada de serviço. */
  password: string | null;
  passwordSetAt: string | null;
  passwordSetBy: string | null;
  lastTest: TotvsTestResult | null;
}

function todayAt(hours: number, minutes: number): string {
  return set(new Date(), { hours, minutes, seconds: 0, milliseconds: 0 }).toISOString();
}

function user(
  id: string,
  name: string,
  email: string,
  roles: RoleKey[],
  link: { status: LinkStatus; chapa?: string; cpf?: string; reason?: string },
  extra: Partial<UserRecord> = {},
): UserRecord {
  return {
    id,
    name,
    email,
    roles,
    rmRoles: roles.filter((role) => role === "colaborador" || role === "gestor"),
    isOwner: false,
    status: "active",
    lastAccessAt: todayAt(8, 0),
    mustChangePassword: false,
    linkStatus: link.status,
    chapa: link.chapa ?? null,
    cpf: link.cpf ?? null,
    linkReason: link.reason ?? null,
    linkUpdatedAt: todayAt(7, 30),
    ...extra,
  };
}

const users: UserRecord[] = [
  user("u-wagner", "Wagner Antunes", OWNER_EMAIL, ["admin"], { status: "sem_registro" }, { isOwner: true, lastAccessAt: todayAt(8, 30) }),
  user("u-ana", "Ana Paula Ribeiro", "ana.ribeiro@exemplo.com.br", ["rh_dp", "gestor", "colaborador"], { status: "vinculado", chapa: "000101", cpf: "52998224725" }),
  user("u-bruno", "Bruno Carvalho", "bruno.carvalho@exemplo.com.br", ["rh_dp_restrita", "colaborador"], { status: "vinculado", chapa: "000102", cpf: "11144477735" }),
  user("u-carla", "Carla Mendes", "carla.mendes@exemplo.com.br", ["gestor", "colaborador"], { status: "vinculado", chapa: "000201", cpf: "39053344705" }),
  user("u-eduardo", "Eduardo Lima", "eduardo.lima@exemplo.com.br", ["diretoria", "gestor", "colaborador"], { status: "vinculado", chapa: "000001", cpf: "86288366757" }),
  user("u-helena", "Helena Costa", "helena.costa@exemplo.com.br", ["compliance"], { status: "sem_registro" }),
  user("u-igor", "Igor Martins", "igor.martins@exemplo.com.br", ["recrutamento"], {
    status: "pendente",
    cpf: "15350946056",
    reason: "CPF não encontrado no TOTVS RM.",
  }),
  user("u-julia", "Júlia Freitas", "julia.freitas@exemplo.com.br", [], {
    status: "divergente",
    cpf: "93541134780",
    reason: "CPF com 2 chapas ativas no RM: o DP precisa corrigir o cadastro.",
  }),
  user("u-diego", "Diego Souza", "diego.souza@exemplo.com.br", [], { status: "sem_registro" }, { lastAccessAt: null, status: "pending" }),
];

/**
 * Matriz padrão de menus por papel: a mesma de app_imobrh.permissoes_padrao (migration 0001).
 * O Administrador tem tudo e não entra aqui.
 */
export const DEFAULT_ROLE_PERMISSIONS: Record<RoleKey, PermissionRules> = {
  rh_dp: { caixa_rh: true, meus_casos: true, prazos_legais: true, config_vinculos: true },
  rh_dp_restrita: { caixa_rh: true, meus_casos: true, prazos_legais: true },
  recrutamento: { caixa_rh: true, meus_casos: true },
  compliance: { meus_casos: true, view_audit_logs: true },
};

const audit: AuditEntry[] = [
  {
    id: "a-2",
    at: todayAt(8, 40),
    actorId: "u-wagner",
    actorName: "Wagner Antunes",
    module: "usuarios",
    action: "update",
    description: "Papéis alterados: rh_dp, gestor, colaborador",
    origin: "Console do RH",
    before: { papeis: "gestor, colaborador" },
    after: { papeis: "rh_dp, gestor, colaborador" },
  },
  {
    id: "a-1",
    at: todayAt(7, 30),
    actorId: null,
    actorName: "Sistema",
    module: "vinculos",
    action: "update",
    description: "Vínculo com o RM: pendente (CPF não encontrado no TOTVS RM)",
    origin: "Edge Function rm-funcionario",
    targetKey: "colaborador_vinculo",
  },
];

const sessions: SessionRecord[] = [
  {
    id: "s-wagner",
    userId: "u-wagner",
    device: "Chrome · Windows",
    location: "189.40.12.8",
    startedAt: todayAt(8, 30),
    lastActivityAt: new Date().toISOString(),
  },
  {
    id: "s-ana",
    userId: "u-ana",
    device: "Edge · Windows",
    location: "189.40.12.31",
    startedAt: todayAt(7, 50),
    lastActivityAt: todayAt(9, 10),
  },
];

export const db = {
  /** E-mail da sessão real do Supabase Auth (null = ninguém logado). */
  sessionEmail: null as string | null,
  /** Usuário ligado à sessão; o seletor "Ver como" troca este valor. */
  currentUserId: null as string | null,
  users,
  /** Alterações da matriz por papel (por cima de DEFAULT_ROLE_PERMISSIONS). */
  rolePermissions: {} as Record<RoleKey, PermissionRules>,
  /** Conexão TOTVS RM começa vazia, como no banco. */
  totvs: {
    url: "",
    user: "",
    active: false,
    password: null,
    passwordSetAt: null,
    passwordSetBy: null,
    lastTest: null,
  } as TotvsConnectionRecord,
  audit,
  sessions,
};
