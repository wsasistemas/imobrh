// rm-hierarquia — Consulta SQL API.RH.HIERARQUIA: chefe de cada seção, para rotear aprovações (cache de 1 hora).
//
// GET ou POST { coligada?, secao? } (secao vazia = todas). Quem pode: o menu Caixa do RH ou Vínculos pendentes.
import { contextoDoUsuario, exigirPermissao } from "../_shared/contexto.ts";
import { ErroRh, lerEntrada, ok, servir } from "../_shared/http.ts";
import { consultar } from "../_shared/rm/cliente.ts";

servir(["GET", "POST"], async (req) => {
  const ctx = await contextoDoUsuario(req);
  try {
    await exigirPermissao(ctx, "caixa_rh");
  } catch {
    await exigirPermissao(ctx, "config_vinculos");
  }
  const entrada = await lerEntrada(req);
  const coligada = entrada.coligada === undefined ? 1 : Number(entrada.coligada);
  if (!Number.isInteger(coligada) || coligada < 0) throw new ErroRh("VALIDACAO", "Coligada inválida.", { coligada: "número inteiro" });
  const secao = typeof entrada.secao === "string" ? entrada.secao.trim() : "";
  if (secao && !/^[A-Za-z0-9.\-_]{1,30}$/.test(secao)) throw new ErroRh("VALIDACAO", "Seção inválida.", { secao: "código da seção no RM" });

  const lido = await consultar(ctx.db, ctx.empresaId, "API.RH.HIERARQUIA", { CODCOLIGADA: String(coligada), CODSECAO: secao });
  return ok({ secoes: lido.linhas, lidoEm: lido.lidoEm, doCache: lido.doCache, desatualizado: lido.desatualizado, mock: lido.mock });
});
