import { PAPEIS_CONSOLE, ROTULO_PAPEL, type Papel } from "@imobrh/shared";
import { SUPER_ADMIN_ROLE, type RoleKey } from "../../../../config/app";
import type { PermissionId } from "../../../../config/menuRegistry";
import { computePermissionsForRoles, principalRole } from "../../access/policy";
import { ServiceError, type AuditEntry, type PermissionRules, type User } from "../types";
import { db, DEFAULT_ROLE_PERMISSIONS, type UserRecord } from "./db";

/** Latência simulada de 300 a 600 ms. */
export function delay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 300 + Math.random() * 300));
}

export function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

/** Regras efetivas do papel: o padrão com as alterações por cima (como app_imobrh.regras_do_papel). */
export function rulesFor(role: RoleKey | null): PermissionRules {
  if (!role || role === SUPER_ADMIN_ROLE) return {};
  return { ...DEFAULT_ROLE_PERMISSIONS[role], ...db.rolePermissions[role] };
}

export function permissionsOf(record: UserRecord): Record<PermissionId, boolean> {
  return computePermissionsForRoles(record.roles, Object.fromEntries(record.roles.map((role) => [role, rulesFor(role)])));
}

export function currentActor(): UserRecord {
  if (!db.sessionEmail) throw new ServiceError("NAO_AUTENTICADO", "Sua sessão expirou. Entre novamente.");
  const actor = db.users.find((entry) => entry.id === db.currentUserId);
  if (!actor || actor.status === "inactive") {
    throw new ServiceError("NO_PORTAL_ACCESS", "Seu login não está cadastrado no imobdesk desta empresa.");
  }
  return actor;
}

/** Garante que o usuário logado tem a permissão; devolve o próprio usuário. */
export function requirePermission(id: PermissionId): UserRecord {
  const actor = currentActor();
  if (!permissionsOf(actor)[id]) throw new ServiceError("SEM_PERMISSAO", "Você não tem permissão para esta ação.");
  return actor;
}

export function isAdmin(record: UserRecord): boolean {
  return record.roles.includes(SUPER_ADMIN_ROLE);
}

export function hasConsoleRole(record: UserRecord): boolean {
  return record.roles.some((role) => PAPEIS_CONSOLE.includes(role as Papel));
}

export function roleLabelOf(key: RoleKey | null): string | null {
  return key ? (ROTULO_PAPEL[key as Papel] ?? key) : null;
}

// ---------- Auditoria e usuários ----------

type AuditInput = Pick<AuditEntry, "module" | "action" | "description" | "before" | "after" | "targetKey">;

/** Toda mutação do mock registra a própria auditoria; as telas nunca gravam. */
export function recordAudit(input: AuditInput): void {
  const actor = currentActor();
  db.audit.unshift({ ...input, id: newId("a"), at: new Date().toISOString(), actorId: actor.id, actorName: actor.name, origin: "Console do RH" });
}

export function toPublicUser(record: UserRecord): User {
  const role = principalRole(record.roles);
  return {
    id: record.id,
    name: record.name,
    email: record.email,
    role,
    roles: [...record.roles],
    roleLabel: roleLabelOf(role),
    isOwner: record.isOwner,
    status: record.status,
    lastAccessAt: record.lastAccessAt,
    mustChangePassword: false,
    linkStatus: record.linkStatus,
    chapa: record.chapa,
  };
}

export function findUser(id: string): UserRecord {
  const found = db.users.find((entry) => entry.id === id);
  if (!found) throw new ServiceError("VALIDACAO", "Usuário não encontrado.");
  return found;
}
