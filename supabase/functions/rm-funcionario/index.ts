// rm-funcionario — Consulta SQL API.RH.FUNCIONARIO (cache de 1 hora; RM_MODO=mock usa dados fictícios).
//
// Buscar (GET ou POST): { cpf } ou { chapa, coligada? }.
//   Quem pode: o menu Vínculos pendentes (config_vinculos) ou o próprio funcionário (a chapa do próprio vínculo).
// Vincular (POST { action: "vincular", usuario_id, cpf }): procura o CPF no RM e grava o vínculo do login
//   (vinculado, pendente ou divergente, com o motivo). Quem pode: config_vinculos.
import { contextoDoUsuario, exigirPermissao } from "../_shared/contexto.ts";
import { deRpc, ErroRh, lerEntrada, ok, servir } from "../_shared/http.ts";
import { cpfValido, somenteDigitos } from "../_shared/rm/nucleo.ts";
import { decidirVinculo, funcionariosPor, gravarVinculo, paraVinculoRm } from "../_shared/rm/vinculo.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function lerCpf(valor: unknown): string {
  const cpf = somenteDigitos(valor);
  if (!cpfValido(cpf)) throw new ErroRh("VALIDACAO", "CPF inválido.", { cpf: "Informe os 11 dígitos de um CPF válido." });
  return cpf;
}

servir(["GET", "POST"], async (req) => {
  const ctx = await contextoDoUsuario(req);
  const entrada = await lerEntrada(req);

  if (entrada.action === "vincular") {
    await exigirPermissao(ctx, "config_vinculos");
    const usuarioId = String(entrada.usuario_id ?? "");
    if (!UUID.test(usuarioId)) throw new ErroRh("VALIDACAO", "Usuário inválido.", { usuario_id: "obrigatório" });
    const cpf = lerCpf(entrada.cpf);
    const lido = await funcionariosPor(ctx.db, ctx.empresaId, { cpf });
    const vinculo = await gravarVinculo(ctx.db, usuarioId, decidirVinculo(cpf, lido.funcionarios), ctx.usuario.id);
    return ok({
      vinculo: paraVinculoRm(vinculo),
      motivo: typeof vinculo.motivo === "string" ? vinculo.motivo : null,
      lidoEm: lido.lidoEm,
      desatualizado: lido.desatualizado,
    });
  }

  const coligada = entrada.coligada === undefined ? 1 : Number(entrada.coligada);
  if (!Number.isInteger(coligada) || coligada < 0) throw new ErroRh("VALIDACAO", "Coligada inválida.", { coligada: "número inteiro" });
  const chapa = typeof entrada.chapa === "string" ? entrada.chapa.trim() : "";
  const cpf = entrada.cpf === undefined ? "" : lerCpf(entrada.cpf);
  if (!chapa && !cpf) throw new ErroRh("VALIDACAO", "Informe o CPF ou a chapa.", { cpf: "CPF ou chapa", chapa: "CPF ou chapa" });

  // O próprio funcionário consulta a própria chapa; o resto exige o menu Vínculos pendentes.
  const proprio = await ctx.db.from("colaborador_vinculo").select("chapa, coligada").eq("user_id", ctx.usuario.id).maybeSingle();
  if (proprio.error) throw deRpc(proprio.error);
  const ehProprio = !cpf && proprio.data?.chapa === chapa && proprio.data?.coligada === coligada;
  if (!ehProprio) await exigirPermissao(ctx, "config_vinculos");

  const lido = await funcionariosPor(ctx.db, ctx.empresaId, { cpf, chapa, coligada });
  return ok({ funcionarios: lido.funcionarios, lidoEm: lido.lidoEm, doCache: lido.doCache, desatualizado: lido.desatualizado, mock: lido.mock });
});
