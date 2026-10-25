import type { Json } from "../../../../lib/database.types";
import { AUDIT_ACTION_LABELS, AUDIT_MODULE_LABELS } from "../labels";
import type { AuditAction, AuditEntry, AuditModule, AuditValues, IntegrationTestResult, User, UserStatus } from "../types";

// Conversão das linhas do schema do aplicativo para os tipos das telas.

export const USUARIO_COLUMNS =
  "id, email, nome, perfil_key, status, is_owner, must_change_password, last_access_at, perfis(label)";

interface UsuarioRow {
  id: string;
  email: string;
  nome: string;
  perfil_key: string | null;
  status: string;
  is_owner: boolean;
  must_change_password: boolean;
  last_access_at: string | null;
  perfis: { label: string } | null;
}

function toUserStatus(status: string): UserStatus {
  return status === "active" || status === "inactive" ? status : "pending";
}

export function toUser(row: UsuarioRow): User {
  return {
    id: row.id,
    name: row.nome,
    email: row.email,
    role: row.perfil_key,
    roleLabel: row.perfis?.label ?? null,
    isOwner: row.is_owner,
    status: toUserStatus(row.status),
    lastAccessAt: row.last_access_at,
    mustChangePassword: row.must_change_password,
  };
}

// ---------- Auditoria ----------

export const AUDIT_MODULES = Object.keys(AUDIT_MODULE_LABELS) as AuditModule[];
export const AUDIT_ACTIONS = Object.keys(AUDIT_ACTION_LABELS) as AuditAction[];

export const AUDIT_COLUMNS =
  "id, created_at, user_id, ator_nome, user_email, menu_module, action_type, description, origem, old_values, new_values, entity_id";

interface AuditRow {
  id: string;
  created_at: string | null;
  user_id: string | null;
  ator_nome: string | null;
  user_email: string | null;
  menu_module: string | null;
  action_type: string | null;
  description: string | null;
  origem: string;
  old_values: Json | null;
  new_values: Json | null;
  entity_id: string | null;
}

function isModule(value: string | null): value is AuditModule {
  return value !== null && (AUDIT_MODULES as string[]).includes(value);
}

function isAction(value: string | null): value is AuditAction {
  return value !== null && (AUDIT_ACTIONS as string[]).includes(value);
}

/** jsonb → pares simples; valores aninhados viram texto para o bloco ANTES/DEPOIS. */
function toAuditValues(value: Json | null): AuditValues | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).map(([key, item]): [string, string | number | boolean | null] => [
    key,
    item === undefined || item === null
      ? null
      : typeof item === "object"
        ? JSON.stringify(item)
        : item,
  ]);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** Linhas de outros sistemas/legado (módulo ou ação fora da lista do portal) ficam de fora. */
export function toAuditEntry(row: AuditRow): AuditEntry | null {
  if (!isModule(row.menu_module) || !isAction(row.action_type)) return null;
  return {
    id: row.id,
    at: row.created_at ?? new Date(0).toISOString(),
    actorId: row.user_id,
    actorName: row.ator_nome ?? row.user_email ?? "Sistema",
    module: row.menu_module,
    action: row.action_type,
    description: row.description ?? "",
    origin: row.origem,
    before: toAuditValues(row.old_values),
    after: toAuditValues(row.new_values),
    targetKey: row.entity_id ?? undefined,
  };
}

// ---------- Integração e sessões ----------

export function toTestResult(value: Json | null): IntegrationTestResult | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const { at, ok, message } = value;
  if (typeof at !== "string" || typeof ok !== "boolean" || typeof message !== "string") return null;
  return { at, ok, message };
}

/** "Chrome · Windows" a partir do user agent da sessão. */
export function describeDevice(userAgent: string | null): string {
  if (!userAgent) return "Dispositivo desconhecido";
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /OPR\//.test(userAgent)
      ? "Opera"
      : /Chrome\//.test(userAgent)
        ? "Chrome"
        : /Firefox\//.test(userAgent)
          ? "Firefox"
          : /Safari\//.test(userAgent)
            ? "Safari"
            : null;
  const system = /iPhone/.test(userAgent)
    ? "iPhone"
    : /iPad/.test(userAgent)
      ? "iPad"
      : /Android/.test(userAgent)
        ? "Android"
        : /Windows/.test(userAgent)
          ? "Windows"
          : /Mac OS X/.test(userAgent)
            ? "macOS"
            : /Linux/.test(userAgent)
              ? "Linux"
              : null;
  if (!browser) return userAgent.slice(0, 40);
  return system ? `${browser} · ${system}` : browser;
}
