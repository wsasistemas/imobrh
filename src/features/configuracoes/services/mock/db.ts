import { set } from "date-fns";
import type { RoleKey } from "../../../../config/app";
import type { AuditEntry, IntegrationKey, IntegrationTestResult, PermissionRules, TotvsTestResult, User } from "../types";

// Estado em memória do mock. Só existe o usuário proprietário; os demais são cadastrados
// pela tela de Usuários. Recarregar a página volta tudo ao estado inicial.

export interface UserRecord extends Omit<User, "roleLabel"> {
  /** Senha temporária vigente; usada para impedir que a nova senha seja igual. */
  tempPassword: string | null;
}

/** Dono do portal: sempre Super admin, não pode ser inativado, excluído nem rebaixado. */
export const OWNER_EMAIL = "wagner.antunes@exemplo.com.br";

export interface SessionRecord {
  id: string;
  userId: string;
  device: string;
  location: string;
  startedAt: string;
  lastActivityAt: string;
}

export interface IntegrationRecord {
  key: IntegrationKey;
  name: string;
  description: string;
  active: boolean;
  sender: string;
  sendAuthEmails: boolean;
  secret: string | null;
  secretSetAt: string | null;
  secretSetBy: string | null;
  lastTest: IntegrationTestResult | null;
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

export interface RoleRecord {
  key: RoleKey;
  label: string;
  description: string;
}

function todayAt(hours: number, minutes: number): string {
  return set(new Date(), { hours, minutes, seconds: 0, milliseconds: 0 }).toISOString();
}

function dateAt(day: number, month: number, hours: number, minutes: number): string {
  return new Date(2026, month - 1, day, hours, minutes).toISOString();
}

const users: UserRecord[] = [
  {
    id: "u-wagner",
    name: "Wagner Antunes",
    email: OWNER_EMAIL,
    role: "super_admin",
    isOwner: true,
    status: "active",
    lastAccessAt: todayAt(8, 30),
    mustChangePassword: false,
    tempPassword: null,
  },
  // Equipe da Gestão de Atendimento no modo simulado (setores em features/atendimento/services/mock.ts).
  {
    id: "u-ana",
    name: "Ana Lima",
    email: "ana.lima@exemplo.com.br",
    role: "operador",
    isOwner: false,
    status: "active",
    lastAccessAt: todayAt(8, 0),
    mustChangePassword: false,
    tempPassword: null,
  },
  {
    id: "u-bruno",
    name: "Bruno Rocha",
    email: "bruno.rocha@exemplo.com.br",
    role: "operador",
    isOwner: false,
    status: "active",
    lastAccessAt: todayAt(8, 0),
    mustChangePassword: false,
    tempPassword: null,
  },
  {
    id: "u-carla",
    name: "Carla Mendes",
    email: "carla.mendes@exemplo.com.br",
    role: "operador",
    isOwner: false,
    status: "active",
    lastAccessAt: todayAt(8, 0),
    mustChangePassword: false,
    tempPassword: null,
  },
  {
    id: "u-marcos",
    name: "Marcos Prado",
    email: "marcos.prado@exemplo.com.br",
    role: "ti",
    isOwner: false,
    status: "active",
    lastAccessAt: todayAt(8, 0),
    mustChangePassword: false,
    tempPassword: null,
  },
  {
    id: "u-fernanda",
    name: "Fernanda Dias",
    email: "fernanda.dias@exemplo.com.br",
    role: "financeiro",
    isOwner: false,
    status: "active",
    lastAccessAt: todayAt(8, 0),
    mustChangePassword: false,
    tempPassword: null,
  },
  {
    id: "u-gustavo",
    name: "Gustavo Reis",
    email: "gustavo.reis@exemplo.com.br",
    role: "operador",
    isOwner: false,
    status: "active",
    lastAccessAt: todayAt(8, 0),
    mustChangePassword: false,
    tempPassword: null,
  },
  {
    id: "u-paula",
    name: "Paula Nunes",
    email: "paula.nunes@exemplo.com.br",
    role: "ti",
    isOwner: false,
    status: "active",
    lastAccessAt: todayAt(8, 0),
    mustChangePassword: false,
    tempPassword: null,
  },
  {
    id: "u-helena",
    name: "Helena Costa",
    email: "helena.costa@exemplo.com.br",
    role: "operador",
    isOwner: false,
    status: "active",
    lastAccessAt: todayAt(8, 0),
    mustChangePassword: false,
    tempPassword: null,
  },
  {
    id: "u-renato",
    name: "Renato Lopes",
    email: "renato.lopes@exemplo.com.br",
    role: "ti",
    isOwner: false,
    status: "active",
    lastAccessAt: todayAt(8, 0),
    mustChangePassword: false,
    tempPassword: null,
  },
];

// Hierarquia de perfis, do mais alto para o mais baixo (a posição na lista é o nível).
const roles: RoleRecord[] = [
  { key: "super_admin", label: "Super admin", description: "Acesso total ao sistema." },
  { key: "admin", label: "Admin", description: "Administra usuários, perfis e permissões." },
  { key: "ti", label: "TI", description: "Suporte técnico, auditoria e sessões." },
  { key: "financeiro", label: "Financeiro", description: "Equipe financeira." },
  { key: "operador", label: "Operador", description: "Operação do dia a dia." },
];

// Configurações negadas explicitamente.
const CONFIG_DENIED: PermissionRules = {
  manage_users: false,
  manage_permissions: false,
  view_audit_logs: false,
  manage_sessions: false,
};

// Super admin não tem regras: tem acesso total.
const rolePermissions: Record<RoleKey, PermissionRules> = {
  // Modo simulado: admin = supervisão geral; ti = gestor de setor; financeiro e operador = atendentes.
  admin: {
    gestao_atendimento: true,
    gestao_atendimento_central: true,
    gestao_atendimento_fila: true,
    gestao_atendimento_setores: true,
    gestao_atendimento_emails: true,
    gestao_atendimento_monitor: true,
    gestao_atendimento_supervisao: true,
    gestao_atendimento_openwa: true,
    gestao_chamados_monitor: true,
    gestao_chamados: true,
    gestao_chamados_visao_geral: true,
    gestao_chamados_tickets: true,
    gestao_chamados_gerencial: true,
    manage_users: true,
    manage_users_equipes: true,
    manage_pessoas: true,
    manage_permissions: true,
    view_audit_logs: true,
    manage_sessions: true,
    sf_conferencia: true,
  },
  ti: {
    ...CONFIG_DENIED,
    gestao_atendimento_central: true,
    gestao_atendimento_fila: true,
    gestao_atendimento_emails: true,
    gestao_atendimento_monitor: true,
    gestao_chamados: true,
    gestao_chamados_visao_geral: true,
    gestao_chamados_tickets: true,
    gestao_chamados_monitor: true,
    gestao_chamados_gerencial: true,
    view_audit_logs: true,
    manage_sessions: true,
  },
  financeiro: { ...CONFIG_DENIED, gestao_atendimento_central: true, sf_conferencia: true },
  // Operador = agente (vai ser renomeado): atende chamados, então vê Gestão de Chamados e o resumo na Página Inicial.
  operador: { ...CONFIG_DENIED, gestao_atendimento_central: true, gestao_chamados: true, gestao_chamados_visao_geral: true, gestao_chamados_tickets: true },
};

const integrations: Record<IntegrationKey, IntegrationRecord> = {
  resend: {
    key: "resend",
    name: "E-mail transacional",
    description: "Resend · convites, redefinição de senha e avisos do sistema.",
    active: true,
    sender: "Imobdesk <nao-responda@exemplo.com.br>",
    sendAuthEmails: true,
    // Valor fictício do mock; nunca sai da camada de serviço.
    secret: "re_mock_chave_ficticia",
    secretSetAt: dateAt(12, 9, 11, 30),
    secretSetBy: "Wagner Antunes",
    lastTest: { at: dateAt(25, 9, 14, 10), ok: true, message: "E-mail de teste entregue." },
  },
};

const audit: AuditEntry[] = [
  {
    id: "a-4",
    at: todayAt(9, 20),
    actorId: "u-wagner",
    actorName: "Wagner Antunes",
    module: "permissoes",
    action: "permission",
    description: "Perfil Operador: Módulo 2 liberado",
    origin: "Portal web",
    before: { enabled: false },
    after: { enabled: true },
  },
  {
    id: "a-3",
    at: todayAt(8, 55),
    actorId: null,
    actorName: "Sistema",
    module: "autenticacao",
    action: "login_denied",
    description: "Login negado para fornecedor@gmail.com: domínio não autorizado",
    origin: "Tela de login",
  },
  {
    id: "a-2",
    at: dateAt(25, 9, 14, 10),
    actorId: "u-wagner",
    actorName: "Wagner Antunes",
    module: "integracoes",
    action: "test",
    description: "E-mail de teste enviado com sucesso",
    origin: "Portal web",
    targetKey: "resend",
  },
  {
    id: "a-1",
    at: dateAt(12, 9, 11, 30),
    actorId: "u-wagner",
    actorName: "Wagner Antunes",
    module: "integracoes",
    action: "secret",
    description: "Chave de API substituída",
    origin: "Portal web",
    targetKey: "resend",
  },
];

const sessions: SessionRecord[] = [
  {
    id: "s-wagner",
    userId: "u-wagner",
    device: "Chrome · Windows",
    location: "São Paulo, SP",
    startedAt: todayAt(8, 30),
    lastActivityAt: new Date().toISOString(),
  },
];

export const db = {
  /** E-mail da sessão real do Supabase Auth (null = ninguém logado). */
  sessionEmail: null as string | null,
  /** Usuário do portal ligado à sessão; o seletor "Ver como" troca este valor. */
  currentUserId: null as string | null,
  users,
  roles,
  rolePermissions,
  integrations,
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
