import { edgeFunction } from "../../../../config/app";
import { supabase } from "../../../../lib/supabase";
import type { SqlQueriesService } from "../contracts";
import { ServiceError, SQL_QUERY_TYPES, type SqlQuery, type SqlQueryTestResult, type SqlQueryType } from "../types";
import { fromFunction, required, unwrap } from "./errors";
import { toTestResult } from "./mappers";

type Json = Parameters<typeof toTestResult>[0];

function isQueryType(value: unknown): value is SqlQueryType {
  return typeof value === "string" && (SQL_QUERY_TYPES as readonly string[]).includes(value);
}

function toSqlQuery(value: Json): SqlQuery | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const { id, code, name, description, type, active, order, testParams, usedBy, lastTest } = value;
  if (typeof id !== "string" || typeof code !== "string" || typeof name !== "string" || !isQueryType(type)) return null;
  return {
    id,
    code,
    name,
    description: typeof description === "string" ? description : null,
    type,
    active: active === true,
    order: typeof order === "number" ? order : 0,
    testParams: typeof testParams === "string" ? testParams : null,
    usedBy: typeof usedBy === "string" ? usedBy : null,
    lastTest: toTestResult(lastTest ?? null),
  };
}

function toPreviewRow(value: Json): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

// Tudo passa por RPC: a tabela não é legível pelo front (só super admin, via função).
export const supabaseSqlQueriesService: SqlQueriesService = {
  async list() {
    const data = required(await supabase.rpc("listar_consultas_sql"));
    if (!Array.isArray(data)) throw new ServiceError("INTERNAL", "Resposta inesperada do servidor.");
    return data.map(toSqlQuery).filter((query): query is SqlQuery => query !== null);
  },

  async save(id, input) {
    return required(
      await supabase.rpc("salvar_consulta_sql", {
        // A RPC trata id nulo como "criar"; os tipos gerados não marcam o parâmetro como opcional.
        p_id: id as string,
        p_codigo: input.code,
        p_nome: input.name,
        p_descricao: input.description,
        p_tipo: input.type,
        p_ativa: input.active,
        p_parametros_teste: input.testParams,
      }),
    );
  },

  async setActive(id, active) {
    unwrap(await supabase.rpc("definir_consulta_sql_ativa", { p_id: id, p_ativa: active }));
  },

  async move(id, direction) {
    unwrap(await supabase.rpc("mover_consulta_sql", { p_id: id, p_direcao: direction }));
  },

  async delete(id) {
    unwrap(await supabase.rpc("excluir_consulta_sql", { p_id: id }));
  },

  async test(id, parameters) {
    const { data, error } = await supabase.functions.invoke(edgeFunction("totvs"), {
      body: { action: "testar_consulta", queryId: id, parameters },
    });
    if (error) throw await fromFunction(error);
    const base = toTestResult(data as Json);
    if (!base || typeof data !== "object" || data === null) {
      throw new ServiceError("INTERNAL", "Resposta inesperada do teste da consulta.");
    }
    const body = data as Record<string, Json>;
    const result: SqlQueryTestResult = {
      ...base,
      url: typeof body.url === "string" ? body.url : "",
      status: typeof body.status === "number" ? body.status : 0,
      rowCount: typeof body.rowCount === "number" ? body.rowCount : 0,
      truncated: body.truncated === true,
      columns: Array.isArray(body.columns) ? body.columns.filter((column): column is string => typeof column === "string") : [],
      preview: Array.isArray(body.preview)
        ? body.preview.map(toPreviewRow).filter((row): row is Record<string, unknown> => row !== null)
        : [],
    };
    return result;
  },
};
