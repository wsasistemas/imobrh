import type { SqlQueriesService } from "../contracts";
import { ServiceError, type SqlQuery, type SqlQueryType } from "../types";
import { delay, newId, recordAudit, requirePermission } from "./runtime";

const TARGET = "consultas_sql";

// Espelho de app_imobrh.consulta_rm.usada_por: consultas das quais as Edge Functions dependem
// (não podem ser excluídas nem ter o código trocado).
const SYNC_USAGE: Record<string, string> = { "API.RH.FUNCIONARIO": "rm-funcionario", "API.RH.HIERARQUIA": "rm-hierarquia" };

const usageOf = (code: string) => SYNC_USAGE[code.split("/")[0].toUpperCase()] ?? null;
const normalize = (code: string) => code.replace(/\s/g, "").toUpperCase().replace(/\/0\/P$/, "");

// As consultas do PRD v2 (as mesmas de app_imobrh.garantir_consultas_padrao).
const SEED: [string, string, SqlQueryType][] = [
  ["API.RH.FUNCIONARIO", "Funcionário", "funcionario"],
  ["API.RH.HIERARQUIA", "Hierarquia de chefia", "hierarquia"],
  ["API.RH.FERIAS_SALDO", "Saldo de férias", "ferias"],
  ["API.RH.FERIAS_PROGRAMADAS", "Férias programadas", "ferias"],
  ["API.RH.HOLERITE", "Holerite", "holerite"],
  ["API.RH.FERIADOS", "Feriados", "feriados"],
];

// Parâmetros de teste por código.
const TEST_PARAMS: Record<string, string> = {
  "API.RH.FUNCIONARIO": "CODCOLIGADA=1;CPF=;CHAPA=",
  "API.RH.HIERARQUIA": "CODCOLIGADA=1;CODSECAO=",
  "API.RH.FERIAS_SALDO": "CODCOLIGADA=1;CHAPA=",
  "API.RH.FERIAS_PROGRAMADAS": "CODCOLIGADA=1;CODSECAO=",
  "API.RH.HOLERITE": "CODCOLIGADA=1;CHAPA=;COMPETENCIA=",
  "API.RH.FERIADOS": "CODCOLIGADA=1",
};

const queries: SqlQuery[] = SEED.map(([code, name, type], index) => ({
  id: `q-${index + 1}`,
  code,
  name,
  description: null,
  type,
  active: true,
  order: index + 1,
  testParams: TEST_PARAMS[code] ?? null,
  usedBy: usageOf(code),
  lastTest: null,
}));

function find(id: string): SqlQuery {
  const query = queries.find((entry) => entry.id === id);
  if (!query) throw new ServiceError("NOT_FOUND", "Consulta não encontrada.");
  return query;
}

export const mockSqlQueriesService: SqlQueriesService = {
  async list() {
    await delay();
    requirePermission("configure_integrations");
    return [...queries].sort((a, b) => a.order - b.order).map((query) => ({ ...query }));
  },

  async save(id, input) {
    await delay();
    requirePermission("configure_integrations");
    const code = normalize(input.code);
    if (!/^[A-Z0-9][A-Z0-9._-]{2,59}(\/[A-Z0-9?._-]+)*$/.test(code)) {
      throw new ServiceError("INVALID_INPUT", "Use o código da consulta no RM, como API.RH.FUNCIONARIO.", "code");
    }
    if (queries.some((query) => query.code.toUpperCase() === code && query.id !== id)) {
      throw new ServiceError("QUERY_EXISTS", `Já existe uma consulta com o código ${code}.`, "code");
    }
    if (id === null) {
      const created: SqlQuery = {
        id: newId("q"),
        code,
        name: input.name.trim(),
        description: input.description.trim() || null,
        type: input.type,
        active: input.active,
        order: Math.max(0, ...queries.map((query) => query.order)) + 1,
        testParams: input.testParams.trim() || null,
        usedBy: usageOf(code),
        lastTest: null,
      };
      queries.push(created);
      recordAudit({ module: "integracoes", action: "create", description: `Consulta SQL ${code} criada`, targetKey: TARGET });
      return created.id;
    }
    const query = find(id);
    if (query.usedBy && code.split("/")[0] !== query.code.split("/")[0].toUpperCase()) {
      throw new ServiceError("QUERY_IN_USE", `O código não pode mudar: a consulta é usada na ${query.usedBy.toLowerCase()}.`, "code");
    }
    Object.assign(query, {
      code,
      name: input.name.trim(),
      description: input.description.trim() || null,
      type: input.type,
      active: input.active,
      testParams: input.testParams.trim() || null,
    });
    recordAudit({ module: "integracoes", action: "update", description: `Consulta SQL ${code} alterada`, targetKey: TARGET });
    return id;
  },

  async setActive(id, active) {
    await delay();
    requirePermission("configure_integrations");
    const query = find(id);
    if (query.active === active) return;
    query.active = active;
    recordAudit({
      module: "integracoes",
      action: active ? "activate" : "deactivate",
      description: `Consulta SQL ${query.code} ${active ? "ativada" : "desativada"}`,
      targetKey: TARGET,
    });
  },

  async move(id, direction) {
    await delay();
    requirePermission("configure_integrations");
    const ordered = [...queries].sort((a, b) => a.order - b.order);
    ordered.forEach((query, index) => (query.order = index + 1));
    const index = ordered.findIndex((query) => query.id === id);
    const neighbor = ordered[direction === "up" ? index - 1 : index + 1];
    if (index < 0 || !neighbor) return;
    [ordered[index].order, neighbor.order] = [neighbor.order, ordered[index].order];
    recordAudit({ module: "integracoes", action: "config", description: `Consulta SQL ${ordered[index].code} movida`, targetKey: TARGET });
  },

  async delete(id) {
    await delay();
    requirePermission("configure_integrations");
    const query = find(id);
    if (query.usedBy) {
      throw new ServiceError("QUERY_IN_USE", `Esta consulta é usada na ${query.usedBy.toLowerCase()}. Desative em vez de excluir.`);
    }
    queries.splice(queries.indexOf(query), 1);
    recordAudit({ module: "integracoes", action: "delete", description: `Consulta SQL ${query.code} excluída`, targetKey: TARGET });
  },

  async test(id) {
    await delay();
    requirePermission("configure_integrations");
    const query = find(id);
    // Sem servidor real no modo demonstração.
    query.lastTest = { at: new Date().toISOString(), ok: false, message: "Modo demonstração: não há conexão real com o TOTVS RM." };
    return { ...query.lastTest, url: "", status: 0, rowCount: 0, truncated: false, columns: [], preview: [] };
  },
};
