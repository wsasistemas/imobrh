import {
  isAllowedLoginEmail,
  ROLE_MANAGER_ROLES,
  SUPER_ADMIN_ROLE,
  type RoleKey,
} from "../../../../config/app";
import type { PermissionId } from "../../../../config/menuRegistry";
import { isEffectivelyAllowed } from "../../access/policy";
import { ServiceError, type AuditEntry, type PermissionRules, type User } from "../types";
import { db, type RoleRecord, type UserRecord } from "./db";

/** Latência simulada de 300 a 600 ms. */
export function delay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 300 + Math.random() * 300));
}

export function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function rulesFor(role: RoleKey | null): PermissionRules {
  if (!role || role === SUPER_ADMIN_ROLE) return {};
  return db.rolePermissions[role] ?? {};
}

export function currentActor(): UserRecord {
  if (!db.sessionEmail) throw new ServiceError("NOT_FOUND", "Sua sessão expirou. Entre novamente.");
  const actor = db.users.find((user) => user.id === db.currentUserId);
  // Entrou no Supabase, mas o e-mail não está cadastrado (ou está inativo) no portal.
  if (!actor || actor.status === "inactive") {
    throw new ServiceError(
      "NO_PORTAL_ACCESS",
      actor ? "Sua conta no portal está inativa. Fale com um administrador." : "Seu e-mail ainda não está autorizado no portal. Peça a um administrador para cadastrá-lo.",
    );
  }
  return actor;
}

/** Garante que o usuário logado tem a permissão; devolve o próprio usuário. */
export function requirePermission(id: PermissionId): UserRecord {
  const actor = currentActor();
  if (!isEffectivelyAllowed(id, actor.role, rulesFor(actor.role))) {
    throw new ServiceError("FORBIDDEN", "Você não tem permissão para esta ação.");
  }
  return actor;
}

/** Aceita qualquer uma das permissões informadas. */
export function requireAnyPermission(ids: PermissionId[]): UserRecord {
  const actor = currentActor();
  if (!ids.some((id) => isEffectivelyAllowed(id, actor.role, rulesFor(actor.role)))) {
    throw new ServiceError("FORBIDDEN", "Você não tem permissão para esta ação.");
  }
  return actor;
}

// ---------- Perfis e hierarquia ----------

export function findRole(key: RoleKey): RoleRecord {
  const role = db.roles.find((entry) => entry.key === key);
  if (!role) throw new ServiceError("NOT_FOUND", "Perfil não encontrado.", "role");
  return role;
}

/** Nível do perfil: posição na hierarquia (0 = mais alto). Sem perfil = abaixo de todos. */
export function roleLevel(key: RoleKey | null): number {
  const index = key ? db.roles.findIndex((entry) => entry.key === key) : -1;
  return index === -1 ? Number.POSITIVE_INFINITY : index;
}

export function roleLabelOf(key: RoleKey | null): string | null {
  if (!key) return null;
  return db.roles.find((entry) => entry.key === key)?.label ?? null;
}

/** Regra 3: atribui-se só o próprio nível e os abaixo dele. */
export function canAssignRole(actor: UserRecord, key: RoleKey): boolean {
  return actor.role !== null && roleLevel(key) >= roleLevel(actor.role);
}

export function isRoleManager(actor: UserRecord): boolean {
  return actor.role !== null && ROLE_MANAGER_ROLES.includes(actor.role);
}

/** Super admin gerencia todos os perfis (menos o próprio Super admin); Admin, só os abaixo dele. */
export function canManageRole(actor: UserRecord, key: RoleKey): boolean {
  if (!isRoleManager(actor) || key === SUPER_ADMIN_ROLE) return false;
  if (actor.role === SUPER_ADMIN_ROLE) return true;
  return roleLevel(key) > roleLevel(actor.role);
}

/** Um perfil pode ficar logo abaixo de `key` se continuar no nível do usuário logado ou abaixo dele. */
export function canPlaceBelow(actor: UserRecord, key: RoleKey): boolean {
  return isRoleManager(actor) && roleLevel(key) >= roleLevel(actor.role);
}

export function assertRoleAllowed(actor: UserRecord, key: RoleKey): void {
  findRole(key);
  if (!canAssignRole(actor, key)) {
    throw new ServiceError("ROLE_NOT_ALLOWED", "Você só pode atribuir perfis do seu nível para baixo.", "role");
  }
}

// ---------- E-mail e conta proprietária ----------

export const INVALID_EMAIL_MESSAGE = "Informe um e-mail válido.";

/** Qualquer e-mail pode ser cadastrado; só o formato é conferido. */
export function assertAllowedEmail(email: string): void {
  if (!isAllowedLoginEmail(email)) {
    throw new ServiceError("EMAIL_INVALID", INVALID_EMAIL_MESSAGE, "email");
  }
}

/** A conta proprietária não é inativada, excluída, rebaixada nem tem o e-mail trocado. */
export function assertNotOwner(target: UserRecord): void {
  if (target.isOwner) {
    throw new ServiceError("PROTECTED_USER", "A conta proprietária do portal não pode ser alterada por aqui.");
  }
}

// ---------- Auditoria e usuários ----------

type AuditInput = Pick<AuditEntry, "module" | "action" | "description" | "before" | "after" | "targetKey">;

/** Toda mutação do mock registra a própria auditoria; as telas nunca gravam. */
export function recordAudit(input: AuditInput): void {
  const actor = currentActor();
  db.audit.unshift({
    ...input,
    id: newId("a"),
    at: new Date().toISOString(),
    actorId: actor.id,
    actorName: actor.name,
    origin: "Portal web",
  });
}

export function toPublicUser(record: UserRecord): User {
  return {
    id: record.id,
    name: record.name,
    email: record.email,
    role: record.role,
    roleLabel: roleLabelOf(record.role),
    isOwner: record.isOwner,
    status: record.status,
    lastAccessAt: record.lastAccessAt,
    mustChangePassword: record.mustChangePassword,
  };
}

export function findUser(id: string): UserRecord {
  const user = db.users.find((entry) => entry.id === id);
  if (!user) throw new ServiceError("NOT_FOUND", "Usuário não encontrado.");
  return user;
}
