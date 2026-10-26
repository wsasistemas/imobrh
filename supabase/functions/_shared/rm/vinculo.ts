// Vínculo login ↔ funcionário do RM: busca por CPF ou chapa, decisão do status e gravação (rh-me e rm-funcionario).
import type { RmFuncionario, RmHierarquia, VinculoRm } from "../contrato.ts";
import type { Db } from "../contexto.ts";
import { deRpc } from "../http.ts";
import { consultar, modoRm, type ResultadoConsulta } from "./cliente.ts";
import { somenteDigitos } from "./nucleo.ts";

/** Situação de desligado no RM (PFUNC.CODSITUACAO). */
export const SITUACAO_DESLIGADO = "D";

export async function funcionariosPor(
  db: Db,
  empresaId: string,
  filtro: { cpf?: string; chapa?: string; coligada?: number },
  extrasMock: RmFuncionario[] = [],
): Promise<ResultadoConsulta & { funcionarios: RmFuncionario[] }> {
  const resultado = await consultar(db, empresaId, "API.RH.FUNCIONARIO", {
    CODCOLIGADA: String(filtro.coligada ?? 1),
    CPF: somenteDigitos(filtro.cpf ?? ""),
    CHAPA: (filtro.chapa ?? "").trim(),
  }, extrasMock);
  return { ...resultado, funcionarios: resultado.linhas as unknown as RmFuncionario[] };
}

export async function hierarquia(db: Db, empresaId: string, coligada = 1, secao = ""): Promise<RmHierarquia[]> {
  const resultado = await consultar(db, empresaId, "API.RH.HIERARQUIA", { CODCOLIGADA: String(coligada), CODSECAO: secao });
  return resultado.linhas as unknown as RmHierarquia[];
}

/** Dados para app_imobrh.registrar_vinculo a partir do resultado da busca por CPF. */
export function decidirVinculo(cpf: string, encontrados: RmFuncionario[]): Record<string, unknown> {
  const ativos = encontrados.filter((f) => f.CODSITUACAO !== SITUACAO_DESLIGADO);
  const fonte = modoRm() === "mock" ? "mock" : "rm";
  if (encontrados.length === 0) {
    return { cpf, status: "pendente", motivo: "CPF não encontrado no TOTVS RM.", fonte };
  }
  if (ativos.length === 0) {
    return { cpf, status: "divergente", motivo: "Funcionário desligado no TOTVS RM.", fonte };
  }
  if (ativos.length > 1) {
    return { cpf, status: "divergente", motivo: `CPF com ${ativos.length} chapas ativas no RM: o DP precisa corrigir o cadastro.`, fonte };
  }
  return dadosDoFuncionario(ativos[0], fonte);
}

export function dadosDoFuncionario(f: RmFuncionario, fonte: "rm" | "mock"): Record<string, unknown> {
  return {
    cpf: somenteDigitos(f.CPF),
    coligada: f.CODCOLIGADA,
    chapa: f.CHAPA,
    nome: f.NOME,
    situacao: f.SITUACAO,
    secao_codigo: f.CODSECAO,
    secao_nome: f.SECAO,
    funcao: f.FUNCAO,
    data_admissao: f.DATAADMISSAO?.slice(0, 10) ?? null,
    gestor_chapa: f.CHAPA_GESTOR,
    fonte,
  };
}

export async function gravarVinculo(db: Db, usuarioId: string, dados: Record<string, unknown>, ator?: string) {
  const { data, error } = await db.rpc("registrar_vinculo", { p_usuario: usuarioId, p_dados: dados, p_ator: ator ?? null });
  if (error) throw deRpc(error);
  return data as Record<string, unknown>;
}

/** Linha de app_imobrh.colaborador_vinculo → formato da API. */
export function paraVinculoRm(linha: Record<string, unknown> | null): VinculoRm | null {
  if (!linha) return null;
  const texto = (campo: string) => (typeof linha[campo] === "string" ? (linha[campo] as string) : null);
  return {
    status: (texto("status") ?? "pendente") as VinculoRm["status"],
    coligada: typeof linha.coligada === "number" ? linha.coligada : null,
    chapa: texto("chapa"),
    nome: texto("nome"),
    situacao: texto("situacao"),
    secao: { codigo: texto("secao_codigo"), nome: texto("secao_nome") },
    funcao: texto("funcao"),
    gestorChapa: texto("gestor_chapa"),
    mock: linha.fonte === "mock",
  };
}
