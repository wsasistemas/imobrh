import type { IntegrationsService } from "../contracts";
import { ServiceError, type IntegrationKey, type IntegrationView } from "../types";
import { db, type IntegrationRecord } from "./db";
import { delay, recordAudit, requirePermission } from "./runtime";

/** Mostra só o prefixo do segredo, ex.: "re_••••". */
function maskSecret(secret: string | null): string | null {
  if (!secret) return null;
  return `${secret.slice(0, 3)}••••`;
}

function toView(record: IntegrationRecord): IntegrationView {
  return {
    key: record.key,
    name: record.name,
    description: record.description,
    active: record.active,
    sender: record.sender,
    sendAuthEmails: record.sendAuthEmails,
    secretMasked: maskSecret(record.secret),
    secretSetAt: record.secretSetAt,
    secretSetBy: record.secretSetBy,
    lastTest: record.lastTest ? { ...record.lastTest } : null,
  };
}

function findIntegration(key: IntegrationKey): IntegrationRecord {
  const record = db.integrations[key];
  if (!record) throw new ServiceError("NOT_FOUND", "Integração não encontrada.");
  return record;
}

export const mockIntegrationsService: IntegrationsService = {
  async get(key) {
    await delay();
    requirePermission("configure_integrations");
    return toView(findIntegration(key));
  },

  async update(key, fields) {
    await delay();
    requirePermission("configure_integrations");
    const record = findIntegration(key);

    const before: Record<string, string | boolean> = {};
    const after: Record<string, string | boolean> = {};
    if (fields.sender !== undefined && fields.sender.trim() !== record.sender) {
      before.sender = record.sender;
      after.sender = fields.sender.trim();
      record.sender = fields.sender.trim();
    }
    if (fields.sendAuthEmails !== undefined && fields.sendAuthEmails !== record.sendAuthEmails) {
      before.sendAuthEmails = record.sendAuthEmails;
      after.sendAuthEmails = fields.sendAuthEmails;
      record.sendAuthEmails = fields.sendAuthEmails;
    }
    if (fields.active !== undefined && fields.active !== record.active) {
      before.active = record.active;
      after.active = fields.active;
      record.active = fields.active;
    }

    if (Object.keys(after).length > 0) {
      recordAudit({
        module: "integracoes",
        action: "config",
        description: "Configuração da integração alterada",
        before,
        after,
        targetKey: key,
      });
    }
    return toView(record);
  },

  async replaceSecret(key, secret) {
    await delay();
    const actor = requirePermission("configure_integrations");
    const record = findIntegration(key);
    if (!secret.trim()) throw new ServiceError("INVALID_PASSWORD", "Informe a nova chave.", "secret");

    record.secret = secret.trim();
    record.secretSetAt = new Date().toISOString();
    record.secretSetBy = actor.name;
    // O valor da chave nunca vai para a auditoria.
    recordAudit({ module: "integracoes", action: "secret", description: "Chave de API substituída", targetKey: key });
    return toView(record);
  },

  async test(key) {
    await delay();
    const actor = requirePermission("configure_integrations");
    const record = findIntegration(key);
    const ok = record.active && record.secret !== null;
    record.lastTest = {
      at: new Date().toISOString(),
      ok,
      message: ok ? `E-mail de teste entregue para ${actor.email}.` : "Integração inativa ou sem chave configurada.",
    };
    recordAudit({
      module: "integracoes",
      action: "test",
      description: ok ? "E-mail de teste enviado com sucesso" : "Falha no envio do e-mail de teste",
      targetKey: key,
    });
    return { ...record.lastTest };
  },

  async history(key) {
    await delay();
    requirePermission("configure_integrations");
    return db.audit.filter((entry) => entry.targetKey === key).map((entry) => ({ ...entry }));
  },
};
