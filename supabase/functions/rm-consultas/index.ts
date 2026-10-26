// rm-consultas — teste de uma Consulta SQL do catálogo (tela Integração TOTVS RM › Consultas SQL).
//
// POST { queryId, parameters? }: roda a consulta direto no RM (sem cache), grava o resultado do teste e devolve
// contagem, colunas e prévia de 5 linhas. A prévia não é gravada em lugar nenhum. Quem pode: configure_integrations.
import { contextoDoUsuario, exigirPermissao } from "../_shared/contexto.ts";
import { deRpc, ErroRh, lerEntrada, ok, servir } from "../_shared/http.ts";
import { chamarConsulta, modoRm } from "../_shared/rm/cliente.ts";
import { lerParametros } from "../_shared/rm/nucleo.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

servir(["POST"], async (req) => {
  const ctx = await contextoDoUsuario(req);
  await exigirPermissao(ctx, "configure_integrations");
  const entrada = await lerEntrada(req);
  const id = String(entrada.queryId ?? "");
  if (!UUID.test(id)) throw new ErroRh("VALIDACAO", "Consulta inválida.", { queryId: "obrigatório" });

  let parametros: Record<string, string>;
  try {
    parametros = lerParametros(typeof entrada.parameters === "string" ? entrada.parameters : "");
  } catch (error) {
    throw new ErroRh("VALIDACAO", (error as Error).message, { parameters: (error as Error).message });
  }

  const codigo = await ctx.db.rpc("obter_consulta_para_teste", { p_id: id });
  if (codigo.error) throw deRpc(codigo.error);
  if (!codigo.data) throw new ErroRh("VALIDACAO", "Consulta não encontrada.");

  let resultado: { ok: boolean; url: string; status: number; linhas: Record<string, unknown>[]; mensagem: string };
  try {
    const lido = await chamarConsulta(ctx.db, ctx.empresaId, codigo.data as string, parametros);
    const n = lido.linhas.length;
    resultado = {
      ok: true,
      url: lido.url,
      status: lido.status,
      linhas: lido.linhas,
      mensagem: `${lido.mock ? "Modo mock: " : "Consulta OK: "}${n === 0 ? "sem registros para os parâmetros informados." : `${n} ${n === 1 ? "registro" : "registros"}.`}`,
    };
  } catch (error) {
    if (!(error instanceof ErroRh) || error.code !== "RM_INDISPONIVEL") throw error;
    resultado = { ok: false, url: "", status: 0, linhas: [], mensagem: error.message };
  }

  const gravado = await ctx.db.rpc("registrar_teste_consulta_sql", {
    p_ator: ctx.usuario.id,
    p_id: id,
    p_ok: resultado.ok,
    p_mensagem: resultado.mensagem,
  });
  if (gravado.error) throw deRpc(gravado.error);

  const colunas = [...new Set(resultado.linhas.slice(0, 50).flatMap((linha) => Object.keys(linha)))];
  return ok({
    ...(gravado.data as Record<string, unknown>),
    url: resultado.url,
    status: resultado.status,
    rowCount: resultado.linhas.length,
    truncated: false,
    columns: colunas,
    preview: resultado.linhas.slice(0, 5),
    modo: modoRm(),
  });
});
