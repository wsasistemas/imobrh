// Edge Function: conexão TOTVS RM do Imobdesk (somente super admin). Só leitura no ERP.
// Toda chamada usa a URL, o usuário e a senha salvos na aba TOTVS RM (ver _shared/totvs.ts).
//
// action "testar": sem proposta, chama API.00.07.003?CODEMPREENDIMENTO=0 (responde [] em ~1 s e confere
//   URL, usuário, senha e permissão). Com proposta, chama API.00.02.003?PROPOSTA_ID=<n>, que filtra pela
//   proposta. (A API.00.02.001 ignora o PROPOSTA_ID e devolve ~24 MB: não serve para teste.)
// action "testar_consulta": roda uma consulta do cadastro (aba Consultas SQL) com parâmetros opcionais
//   e devolve contagem, colunas e prévia de 5 linhas. A prévia não é gravada em lugar nenhum.
// As respostas trazem a URL chamada (sem credencial), para conferência na tela.
import { corsHeaders, errorResponse, fromRpcError, json, PortalError, portalContext, readJson } from "../_shared/portal.ts";
import { fetchConsultaPreview, loadTotvsCredential } from "../_shared/totvs.ts";

const BASIC_TEST = { code: "API.00.07.003", parameters: { CODEMPREENDIMENTO: "0" } };
const PROPOSAL_TEST_CODE = "API.00.02.003";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PARAM = /^([A-Z0-9_]{1,40})=([^;]{0,120})$/i;

type Body =
  | { action: "testar"; proposalId?: string }
  | { action: "testar_consulta"; queryId: string; parameters?: string };

/** "CODEMPREENDIMENTO=229;CODCOLIGADA=1" → { CODEMPREENDIMENTO: "229", CODCOLIGADA: "1" } */
function parseParameters(raw: string | undefined): Record<string, string> | undefined {
  const text = (raw ?? "").trim();
  if (!text) return undefined;
  const parameters: Record<string, string> = {};
  for (const part of text.split(";").map((item) => item.trim()).filter(Boolean)) {
    const match = PARAM.exec(part);
    if (!match) {
      throw new PortalError("INVALID_INPUT", `Parâmetro inválido: "${part}". Use NOME=valor, separados por ponto e vírgula.`, 400, "parameters");
    }
    parameters[match[1].toUpperCase()] = match[2].trim();
  }
  if (Object.keys(parameters).length > 10) throw new PortalError("INVALID_INPUT", "Use no máximo 10 parâmetros.", 400, "parameters");
  return parameters;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ code: "INVALID_INPUT", message: "Método não suportado." }, 405);

  try {
    const { caller, admin } = await portalContext(req);
    const perfil = await admin.rpc("perfil_de", { p_usuario: caller.id });
    if (perfil.error) throw fromRpcError(perfil.error);
    if (perfil.data !== "super_admin") {
      throw new PortalError("FORBIDDEN", "Somente super admin pode configurar integrações.", 403);
    }

    const body = await readJson<Body>(req);

    if (body.action === "testar") {
      const proposalId = (body.proposalId ?? "").trim();
      if (proposalId && !/^\d{1,12}$/.test(proposalId)) {
        throw new PortalError("INVALID_INPUT", "O número da proposta aceita só dígitos.", 400, "proposalId");
      }
      const credential = await loadTotvsCredential(admin);
      const result = proposalId
        ? await fetchConsultaPreview(credential, PROPOSAL_TEST_CODE, { PROPOSTA_ID: proposalId })
        : await fetchConsultaPreview(credential, BASIC_TEST.code, BASIC_TEST.parameters);

      let ok = result.ok;
      let message: string;
      if (!result.ok) {
        message = result.message;
      } else if (!proposalId) {
        message = "Conexão OK: URL, usuário e senha aceitos pelo TOTVS RM.";
      } else if (result.rowCount > 0) {
        message = `Conexão OK: proposta ${proposalId} encontrada (${result.rowCount} ${result.rowCount === 1 ? "linha" : "linhas"} na ${PROPOSAL_TEST_CODE}).`;
      } else {
        ok = false;
        message = `Conexão OK, mas a proposta ${proposalId} não foi encontrada no TOTVS RM.`;
      }

      const saved = await admin.rpc("registrar_teste_totvs", {
        p_ator: caller.id,
        p_ok: ok,
        p_mensagem: message,
        p_proposta: proposalId || null,
      });
      if (saved.error) throw fromRpcError(saved.error);
      return json({ ...(saved.data as Record<string, unknown>), url: result.url });
    }

    if (body.action === "testar_consulta") {
      if (!UUID.test(body.queryId ?? "")) throw new PortalError("INVALID_INPUT", "Consulta inválida.");
      const parameters = parseParameters(body.parameters);

      const code = await admin.rpc("obter_consulta_para_teste", { p_id: body.queryId });
      if (code.error) throw fromRpcError(code.error);
      if (!code.data) throw new PortalError("NOT_FOUND", "Consulta não encontrada.", 404);

      const credential = await loadTotvsCredential(admin);
      const result = await fetchConsultaPreview(credential, code.data as string, parameters);

      const message = !result.ok
        ? result.message
        : result.rowCount === 0
          ? "Consulta OK, sem registros para os parâmetros informados."
          : result.truncated
            ? `Consulta OK: mais de ${result.rowCount} registros (resposta grande, lida só em parte).`
            : `Consulta OK: ${result.rowCount} ${result.rowCount === 1 ? "registro" : "registros"}.`;

      const saved = await admin.rpc("registrar_teste_consulta_sql", {
        p_ator: caller.id,
        p_id: body.queryId,
        p_ok: result.ok,
        p_mensagem: message,
      });
      if (saved.error) throw fromRpcError(saved.error);

      return json({
        ...(saved.data as Record<string, unknown>),
        url: result.url,
        status: result.status,
        rowCount: result.ok ? result.rowCount : 0,
        truncated: result.ok ? result.truncated : false,
        columns: result.ok ? result.columns : [],
        preview: result.ok ? result.preview : [],
      });
    }

    throw new PortalError("INVALID_INPUT", "Ação inválida.");
  } catch (error) {
    return errorResponse(error);
  }
});
