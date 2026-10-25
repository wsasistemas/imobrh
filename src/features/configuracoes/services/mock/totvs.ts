import type { TotvsService } from "../contracts";
import { ServiceError, type AuditValues, type TotvsConnectionView } from "../types";
import { db } from "./db";
import { delay, recordAudit, requirePermission } from "./runtime";

const TARGET = "totvs_rm";

function toView(): TotvsConnectionView {
  const record = db.totvs;
  return {
    url: record.url,
    user: record.user,
    active: record.active,
    passwordMasked: record.password ? "••••••••" : null,
    passwordSetAt: record.passwordSetAt,
    passwordSetBy: record.passwordSetBy,
    lastTest: record.lastTest ? { ...record.lastTest } : null,
  };
}

export const mockTotvsService: TotvsService = {
  async getConnection() {
    await delay();
    requirePermission("configure_integrations");
    return toView();
  },

  async saveConnection(input) {
    await delay();
    const actor = requirePermission("configure_integrations");
    const record = db.totvs;
    const url = input.url.trim().replace(/\/+$/, "");
    const user = input.user.trim();
    // Mesmas validações da RPC salvar_conexao_totvs.
    if (!/^https?:\/\/[^\s/]+/i.test(url)) {
      throw new ServiceError("INVALID_INPUT", "Informe a URL completa, começando com http:// ou https://.", "url");
    }
    if (!user) throw new ServiceError("INVALID_INPUT", "Informe o usuário de integração.", "user");
    if (!input.password && !record.password) {
      throw new ServiceError("INVALID_INPUT", "Informe a senha da integração.", "password");
    }

    if (input.password) {
      record.password = input.password;
      record.passwordSetAt = new Date().toISOString();
      record.passwordSetBy = actor.name;
      recordAudit({ module: "integracoes", action: "secret", description: "Senha da API TOTVS RM substituída", targetKey: TARGET });
    }

    const before: AuditValues = {};
    const after: AuditValues = {};
    if (url !== record.url) [before.url, after.url, record.url] = [record.url, url, url];
    if (user !== record.user) [before.user, after.user, record.user] = [record.user, user, user];
    if (input.active !== record.active) [before.active, after.active, record.active] = [record.active, input.active, input.active];
    if (Object.keys(after).length > 0) {
      recordAudit({ module: "integracoes", action: "config", description: "Conexão TOTVS RM alterada", before, after, targetKey: TARGET });
    }
    return toView();
  },

  async testConnection(proposalId) {
    await delay();
    requirePermission("configure_integrations");
    const record = db.totvs;
    if (!record.url || !record.user || !record.password) {
      throw new ServiceError("INTEGRATION_NOT_CONFIGURED", "Conexão TOTVS RM sem URL, usuário ou senha salvos.");
    }
    if (!record.active) throw new ServiceError("INTEGRATION_INACTIVE", "A integração TOTVS RM está desativada.");
    // Sem servidor real no modo demonstração: o teste sempre informa isso.
    record.lastTest = {
      at: new Date().toISOString(),
      ok: false,
      message: "Modo demonstração: não há conexão real com o TOTVS RM.",
      proposalId,
    };
    recordAudit({ module: "integracoes", action: "test", description: "Falha no teste de conexão TOTVS RM", targetKey: TARGET });
    return { ...record.lastTest };
  },
};
