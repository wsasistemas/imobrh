import { APP_NAME, APP_SCHEMA, SUPER_ADMIN_ROLE } from "../../../../config/app";
import type { AppAccessService } from "../contracts";
import { ServiceError, type AppAccessApp } from "../types";
import { db } from "./db";
import { currentActor, delay, recordAudit } from "./runtime";

// Estado em memória: os schemas expostos hoje no Supabase da WSA e a permissão de cada login.
type MockApp = Omit<AppAccessApp, "totalLogins" | "allowedCount">;

/** Existe no banco, mas não está exposto na API (como o cobranca hoje). */
const NOT_EXPOSED: MockApp = {
  schema: "cobranca",
  name: "Cobrança",
  url: null,
  controlActive: false,
  newLoginsDefault: "bloqueado",
  configured: false,
  exposed: false,
  inCatalog: false,
  lastCheckAt: null,
};

const SEED: [string, string, string | null][] = [
  [APP_SCHEMA, APP_NAME, null],
  ["comercial", "Gestão Comercial", "comercial.suaempresa.com.br"],
  ["contratos", "Contratos", null],
  ["gestao_financeira", "Gestão Financeira", null],
  ["atendimento", "Atendimento", null],
  ["public", "Portal WSA", null],
  ["rh", "RH", null],
  ["portal_dp", "Portal DP", null],
];

const apps: MockApp[] = SEED.map(([schema, name, url]) => ({
  schema,
  name,
  url,
  controlActive: false,
  newLoginsDefault: "bloqueado",
  configured: false,
  exposed: true,
  inCatalog: true,
  lastCheckAt: schema === APP_SCHEMA || schema === "comercial" ? new Date().toISOString() : null,
}));

/** schema → (userId → pode entrar). */
const permissions = new Map<string, Map<string, boolean>>();

function requireSuperAdmin() {
  const actor = currentActor();
  if (actor.role !== SUPER_ADMIN_ROLE) {
    throw new ServiceError("FORBIDDEN", "Somente super admin pode gerenciar as permissões por aplicativo.");
  }
  return actor;
}

function findApp(schema: string): MockApp {
  const app = apps.find((entry) => entry.schema === schema);
  if (!app) throw new ServiceError("NOT_FOUND", "Aplicativo não encontrado.");
  return app;
}

/** Perfil do cadastro automático por aplicativo (mesma tabela da migration 20260929120000). */
const DEFAULT_PROFILE: Record<string, string> = {
  [APP_SCHEMA]: "operador",
  comercial: "Comercial",
  contratos: "Analista",
  gestao_financeira: "operador",
  atendimento: "operadora",
  public: "usuario",
  portal_dp: "analista",
};

/** Perfis de cada aplicativo no mock, do mais amplo para o mais simples. */
const PROFILES: Record<string, { value: string; label: string }[]> = {
  [APP_SCHEMA]: [
    { value: "super_admin", label: "Super admin" },
    { value: "admin", label: "Admin" },
    { value: "ti", label: "TI" },
    { value: "financeiro", label: "Financeiro" },
    { value: "operador", label: "Operador" },
  ],
  comercial: [
    { value: "super_admin", label: "Super admin" },
    { value: "admin", label: "Admin" },
    { value: "financeiro", label: "Comercial" },
  ],
  contratos: [
    { value: "Super Admin", label: "Super Admin" },
    { value: "Admin", label: "Admin" },
    { value: "Analista", label: "Analista" },
  ],
};

/** Perfil escolhido na tela ("Perfil ao liberar") por aplicativo. */
const releaseChoice = new Map<string, string>();

const releaseProfileOf = (schema: string) => releaseChoice.get(schema) ?? DEFAULT_PROFILE[schema] ?? null;
const labelOf = (schema: string, value: string | null) =>
  value ? (PROFILES[schema]?.find((profile) => profile.value === value)?.label ?? value) : null;

/** Cadastrados por aplicativo além deste (onde todos os usuários do portal estão). */
const registrations = new Map<string, Set<string>>();

const isRegistered = (schema: string, userId: string) =>
  schema === APP_SCHEMA ? db.users.some((user) => user.id === userId) : (registrations.get(schema)?.has(userId) ?? false);

const hasSuffix = (email: string) => email.includes("+") || !email.toLowerCase().endsWith("@exemplo.com.br");

function canEnter(app: MockApp, userId: string): boolean {
  if (db.users.some((user) => user.id === userId && user.isOwner)) return true;
  if (!app.controlActive) return true;
  const explicit = permissions.get(app.schema)?.get(userId);
  return explicit ?? app.newLoginsDefault === "liberado";
}

export const mockAppAccessService: AppAccessService = {
  async listApps() {
    await delay();
    requireSuperAdmin();
    return [
      ...apps.map((app) => ({
        ...app,
        defaultProfile: labelOf(app.schema, releaseProfileOf(app.schema)),
        releaseProfile: releaseProfileOf(app.schema),
        profiles: PROFILES[app.schema] ?? [],
        dataSchema: app.dataSchema ?? app.schema,
        protected: app.controlActive && !app.manual && app.schema !== "public",
        totalLogins: db.users.length,
        allowedCount: db.users.filter((user) => canEnter(app, user.id)).length,
      })),
      { ...NOT_EXPOSED, totalLogins: db.users.length, allowedCount: 0 },
    ];
  },

  async listUsers(schema) {
    await delay();
    requireSuperAdmin();
    const app = findApp(schema);
    return db.users
      .map((user) => ({
        id: user.id,
        name: user.name,
        email: user.email,
        lastSignInAt: user.lastAccessAt,
        registered: isRegistered(schema, user.id),
        owner: user.isOwner,
        suffix: hasSuffix(user.email),
        canEnter: canEnter(app, user.id),
      }))
      .sort((a, b) => Number(b.owner) - Number(a.owner) || a.name.localeCompare(b.name, "pt-BR"));
  },

  async saveApp(schema, input) {
    await delay();
    requireSuperAdmin();
    const app = findApp(schema);
    if (input.name.trim().length < 2) throw new ServiceError("INVALID_INPUT", "Informe o nome do aplicativo.", "name");
    const before = { name: app.name, url: app.url, newLoginsDefault: app.newLoginsDefault };
    app.name = input.name.trim();
    app.url = input.url.trim() || null;
    app.newLoginsDefault = input.newLoginsDefault;
    app.configured = true;
    if (input.releaseProfile) releaseChoice.set(schema, input.releaseProfile);
    else releaseChoice.delete(schema);
    recordAudit({
      module: "permissoes",
      action: "config",
      description: `Aplicativo ${app.name} (${schema}) atualizado`,
      before,
      after: { name: app.name, url: app.url, newLoginsDefault: app.newLoginsDefault },
    });
  },

  async addApp(input) {
    await delay();
    requireSuperAdmin();
    const key = input.key.trim().toLowerCase();
    if (!/^[a-z_][a-z0-9_]{1,40}$/.test(key)) {
      throw new ServiceError("INVALID_INPUT", "Chave inválida: use letras minúsculas, números e _ (ex.: financeiro).", "key");
    }
    if (apps.some((app) => app.schema === key)) throw new ServiceError("INVALID_INPUT", "Já existe um aplicativo com esta chave.", "key");
    if (input.name.trim().length < 2) throw new ServiceError("INVALID_INPUT", "Informe o nome do aplicativo.", "name");
    apps.push({
      schema: key,
      name: input.name.trim(),
      url: input.url.trim() || null,
      controlActive: false,
      newLoginsDefault: "bloqueado",
      configured: true,
      exposed: true,
      inCatalog: true,
      manual: true,
      dataSchema: input.dataSchema,
      lastCheckAt: null,
    });
    recordAudit({ module: "permissoes", action: "create", description: `Aplicativo ${input.name} adicionado (chave ${key}, dados em ${input.dataSchema})` });
  },

  async setControl(schema, active) {
    await delay();
    requireSuperAdmin();
    const app = findApp(schema);
    if (app.controlActive === active) return;
    let allowed = 0;
    let blocked = 0;
    if (active) {
      // Carga inicial: quem já tem cadastro no aplicativo entra liberado; os demais, bloqueados.
      const rows = permissions.get(schema) ?? new Map<string, boolean>();
      for (const user of db.users) {
        if (rows.has(user.id)) continue;
        const registered = isRegistered(schema, user.id);
        rows.set(user.id, registered);
        if (registered) allowed += 1;
        else blocked += 1;
      }
      permissions.set(schema, rows);
    }
    app.controlActive = active;
    app.configured = true;
    recordAudit({
      module: "permissoes",
      action: "config",
      description: active
        ? `Controle de acesso ligado em ${app.name} (${allowed} liberados e ${blocked} bloqueados na carga inicial)`
        : `Controle de acesso desligado em ${app.name}: todos os logins entram`,
      before: { controlActive: !active },
      after: { controlActive: active },
    });
  },

  async setPermission(schema, userIds, allow) {
    await delay();
    requireSuperAdmin();
    const app = findApp(schema);
    if (userIds.length === 0) throw new ServiceError("INVALID_INPUT", "Selecione pelo menos um usuário.");
    const rows = permissions.get(schema) ?? new Map<string, boolean>();
    let changed = 0;
    for (const id of userIds) {
      const user = db.users.find((entry) => entry.id === id);
      if (!user || user.isOwner || rows.get(id) === allow) continue;
      rows.set(id, allow);
      changed += 1;
    }
    permissions.set(schema, rows);
    if (changed > 0) {
      recordAudit({
        module: "permissoes",
        action: "permission",
        description: `${app.name}: ${allow ? "liberado para" : "bloqueado para"} ${changed === 1 ? "1 login" : `${changed} logins`}`,
        after: { canEnter: allow, count: changed },
      });
    }
    // Ao liberar: cadastro no aplicativo com o perfil mais simples (só @exemplo.com.br sem sufixo).
    const profile = labelOf(schema, releaseProfileOf(schema));
    let created = 0;
    let skippedSuffix = 0;
    if (allow && profile) {
      const set = registrations.get(schema) ?? new Set<string>();
      for (const id of userIds) {
        const user = db.users.find((entry) => entry.id === id);
        if (!user || user.isOwner || isRegistered(schema, id)) continue;
        if (hasSuffix(user.email)) {
          skippedSuffix += 1;
          continue;
        }
        set.add(id);
        created += 1;
      }
      registrations.set(schema, set);
      if (created > 0) {
        recordAudit({
          module: "permissoes",
          action: "create",
          description: `${app.name}: ${created} cadastrado(s) como ${profile}`,
          after: { created, profile },
        });
      }
    }
    return { changed, created, reactivated: 0, skippedSuffix, profile };
  },

  async canAccessCurrentApp() {
    return canEnter(findApp(APP_SCHEMA), currentActor().id);
  },
};
