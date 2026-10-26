// rm-token — token do TOTVS RM (POST /api/connect/token com o usuário de integração guardado no Vault).
//
// Duas formas de chamar, nenhuma expõe credencial ao navegador:
//  * service_role (outra Edge Function ou job do projeto), com o cabeçalho x-empresa-id: devolve o token e a validade.
//    As funções do ImobRH usam _shared/rm/cliente.ts direto; esta rota serve a jobs e integrações do próprio backend;
//  * usuário do Console com o menu Integração TOTVS RM (action "testar"): pede um token novo para conferir URL, usuário
//    e senha, grava o resultado e devolve só ok/mensagem — o token não sai da função.
import { clienteDaEmpresa, contextoDoUsuario, ehServiceRole, exigirPermissao } from "../_shared/contexto.ts";
import { deRpc, ErroRh, lerEntrada, ok, servir } from "../_shared/http.ts";
import { modoRm, obterToken } from "../_shared/rm/cliente.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

servir(["POST"], async (req) => {
  if (ehServiceRole(req)) {
    const empresaId = req.headers.get("x-empresa-id") ?? "";
    if (!UUID.test(empresaId)) throw new ErroRh("VALIDACAO", "Informe a empresa no cabeçalho x-empresa-id.", { "x-empresa-id": "obrigatório" });
    const token = await obterToken(clienteDaEmpresa(empresaId), empresaId);
    return ok({ access_token: token.token, expira_em: new Date(token.expiraEm).toISOString(), modo: modoRm() });
  }

  const ctx = await contextoDoUsuario(req);
  await exigirPermissao(ctx, "configure_integrations");
  const entrada = await lerEntrada(req);
  if ((entrada.action ?? "testar") !== "testar") throw new ErroRh("VALIDACAO", "Ação inválida.", { action: "use testar" });

  let sucesso = true;
  let mensagem: string;
  try {
    const token = await obterToken(ctx.db, ctx.empresaId, true);
    mensagem = token.mock
      ? "Modo mock (RM_MODO=mock): token simulado. Mude para RM_MODO=real para testar o RM de verdade."
      : `Conexão OK: o TOTVS RM aceitou o usuário de integração (token válido até ${new Date(token.expiraEm).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo" })}).`;
  } catch (error) {
    if (!(error instanceof ErroRh) || (error.code !== "RM_INDISPONIVEL" && error.code !== "VALIDACAO")) throw error;
    sucesso = false;
    mensagem = error.message;
  }

  const gravado = await ctx.db.rpc("registrar_teste_totvs", { p_ator: ctx.usuario.id, p_ok: sucesso, p_mensagem: mensagem });
  if (gravado.error) throw deRpc(gravado.error);
  return ok({ ...(gravado.data as Record<string, unknown>), modo: modoRm() });
});
