import { ROTULO_PAPEL, type Papel } from "@imobrh/shared";
import type { RoleKey } from "../../../../config/app";
import type { Json } from "../../../../lib/database.types";
import { principalRole } from "../../access/policy";
import { AUDIT_ACTION_LABELS, AUDIT_MODULE_LABELS } from "../labels";
import type { AuditAction, AuditEntry, AuditModule, AuditValues, IntegrationTestResult, LinkStatus, User, UserStatus } from "../types";

// Conversão das respostas do app_imobrh para os tipos das telas.

export function roleLabel(key: RoleKey | null): string | null {
  return key ? (ROTULO_PAPEL[key as Papel] ?? key) : null;
}

/** Linha de app_imobrh.listar_usuarios_rh(). */
export interface UsuarioRhRow {
  id: string;
  nome: string;
  email: string;
  status: string;
  papeis: string[];
  vinculo_status: string;
  chapa: string | null;
  last_access_at: string | null;
}

function toUserStatus(status: string): UserStatus {
  return status === "active" || status === "inactive" ? status : "pending";
}

function toLinkStatus(status: string): LinkStatus {
  return status === "vinculado" || status === "pendente" || status === "divergente" ? status : "sem_registro";
}

export function toUser(row: UsuarioRhRow): User {
  const role = principalRole(row.papeis);
  return {
    id: row.id,
    name: row.nome,
    email: row.email,
    role,
    roles: row.papeis,
    roleLabel: roleLabel(role),
    isOwner: false,
    status: toUserStatus(row.status),
    lastAccessAt: row.last_access_at,
    mustChangePassword: false,
    linkStatus: toLinkStatus(row.vinculo_status),
    chapa: row.chapa,
  };
}

// ---------- Auditoria (app_imobrh.auditoria) ----------

export const AUDIT_MODULES = Object.keys(AUDIT_MODULE_LABELS) as AuditModule[];
export const AUDIT_ACTIONS = Object.keys(AUDIT_ACTION_LABELS) as AuditAction[];

export const AUDIT_COLUMNS = "id, ocorrido_em, ator_id, ator_nome, modulo, acao, descricao, origem, antes, depois, entidade";

export interface AuditRow {
  id: number;
  ocorrido_em: string;
  ator_id: string | null;
  ator_nome: string | null;
  modulo: string;
  acao: string;
  descricao: string;
  origem: string;
  antes: Json | null;
  depois: Json | null;
  entidade: string | null;
}

function isModule(value: string): value is AuditModule {
  return (AUDIT_MODULES as string[]).includes(value);
}

function isAction(value: string): value is AuditAction {
  return (AUDIT_ACTIONS as string[]).includes(value);
}

/** jsonb → pares simples; valores aninhados viram texto para o bloco ANTES/DEPOIS. */
function toAuditValues(value: Json | null): AuditValues | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).map(([key, item]): [string, string | number | boolean | null] => [
    key,
    item === undefined || item === null ? null : typeof item === "object" ? JSON.stringify(item) : item,
  ]);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

const ORIGENS: Record<string, string> = { console: "Console do RH", edge: "Edge Function" };

/** Módulo ou ação fora da lista do Console ficam de fora. */
export function toAuditEntry(row: AuditRow): AuditEntry | null {
  if (!isModule(row.modulo) || !isAction(row.acao)) return null;
  return {
    id: String(row.id),
    at: row.ocorrido_em,
    actorId: row.ator_id,
    actorName: row.ator_nome ?? "Sistema",
    module: row.modulo,
    action: row.acao,
    description: row.descricao,
    origin: ORIGENS[row.origem] ?? row.origem,
    before: toAuditValues(row.antes),
    after: toAuditValues(row.depois),
    targetKey: row.entidade ?? undefined,
  };
}

// ---------- Integração e sessões ----------

export function toTestResult(value: Json | null | undefined): IntegrationTestResult | null {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return null;
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
