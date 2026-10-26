// Cliente do TOTVS RM para as Edge Functions: token, Consultas SQL com cache e o modo mock.
//
// RM_MODO (variável da Edge Function): "mock" (padrão até os SQLs existirem) ou "real".
// A credencial vem de app_imobrh.ler_credencial_rm() (só service_role): URL e usuário da tela Integração TOTVS RM e a
// senha do Vault. Nunca é logada nem devolvida ao navegador; o token do RM fica só na memória da função.
import type { ModoRm, RmFuncionario } from "../contrato.ts";
import type { Db } from "../contexto.ts";
import { deRpc, ErroRh } from "../http.ts";
import { chaveCache, consultaMock, type CredencialRm, descreverErroRm, ErroUrlRm, urlConsulta, urlToken } from "./nucleo.ts";

export function modoRm(): ModoRm {
  return (Deno.env.get("RM_MODO") ?? "mock").trim().toLowerCase() === "real" ? "real" : "mock";
}

const TIMEOUT_MS = 30_000;

async function carregarCredencial(db: Db): Promise<CredencialRm> {
  const { data, error } = await db.rpc("ler_credencial_rm");
  if (error) throw deRpc(error);
  const linha = (data as { url: string; usuario: string; senha: string | null; ativo: boolean }[] | null)?.[0];
  if (!linha || !linha.url || !linha.usuario || !linha.senha) {
    throw new ErroRh("RM_INDISPONIVEL", "Integração TOTVS RM sem URL, usuário ou senha. Configure em Integração TOTVS RM.");
  }
  if (!linha.ativo) throw new ErroRh("RM_INDISPONIVEL", "A integração TOTVS RM está desativada.");
  return { url: linha.url, usuario: linha.usuario, senha: linha.senha };
}

interface TokenRm {
  token: string;
  expiraEm: number;
}

/** Token por empresa, guardado só na memória da instância (renova 60 s antes de expirar). */
const tokens = new Map<string, TokenRm>();

async function comTempoLimite(url: string, init: RequestInit): Promise<Response> {
  const controle = new AbortController();
  const timer = setTimeout(() => controle.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controle.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ErroRh("RM_INDISPONIVEL", `O TOTVS RM não respondeu em ${TIMEOUT_MS / 1000} segundos.`);
    }
    throw new ErroRh("RM_INDISPONIVEL", "Não foi possível conectar ao TOTVS RM. Confira a URL e se o servidor está acessível.");
  } finally {
    clearTimeout(timer);
  }
}

/** POST /api/connect/token com o usuário de integração. `renovar` ignora o token em memória (teste da conexão). */
export async function obterToken(db: Db, empresaId: string, renovar = false): Promise<TokenRm & { mock: boolean }> {
  if (modoRm() === "mock") return { token: "mock", expiraEm: Date.now() + 3_600_000, mock: true };
  const guardado = tokens.get(empresaId);
  if (!renovar && guardado && guardado.expiraEm - 60_000 > Date.now()) return { ...guardado, mock: false };

  const credencial = await carregarCredencial(db);
  let url: string;
  try {
    url = urlToken(credencial.url);
  } catch (error) {
    throw new ErroRh("VALIDACAO", error instanceof ErroUrlRm ? error.message : "URL do RM inválida.", { url: "URL inválida" });
  }
  const resposta = await comTempoLimite(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ grant_type: "password", username: credencial.usuario, password: credencial.senha }),
  });
  const corpo = await resposta.text();
  if (!resposta.ok) throw new ErroRh("RM_INDISPONIVEL", descreverErroRm(resposta.status, corpo, "token"));
  let lido: { access_token?: unknown; expires_in?: unknown };
  try {
    lido = JSON.parse(corpo);
  } catch {
    throw new ErroRh("RM_INDISPONIVEL", "O TOTVS RM respondeu ao pedido de token em um formato inesperado.");
  }
  if (typeof lido.access_token !== "string" || !lido.access_token) {
    throw new ErroRh("RM_INDISPONIVEL", "O TOTVS RM não devolveu o token de acesso.");
  }
  const segundos = typeof lido.expires_in === "number" && lido.expires_in > 0 ? lido.expires_in : 300;
  const token = { token: lido.access_token, expiraEm: Date.now() + segundos * 1000 };
  tokens.set(empresaId, token);
  return { ...token, mock: false };
}

export interface ResultadoConsulta {
  linhas: Record<string, unknown>[];
  lidoEm: string;
  /** Veio do cache (dentro da validade). */
  doCache: boolean;
  /** O RM falhou e este é o último valor lido, fora da validade. */
  desatualizado: boolean;
  mock: boolean;
}

/** Chamada direta ao RM, sem cache (usada pelo teste da tela Consultas SQL). */
export async function chamarConsulta(
  db: Db,
  empresaId: string,
  codigo: string,
  parametros: Record<string, string>,
  extrasMock: RmFuncionario[] = [],
): Promise<{ url: string; status: number; linhas: Record<string, unknown>[]; mock: boolean }> {
  if (modoRm() === "mock") {
    return { url: `mock://${codigo}`, status: 200, linhas: consultaMock(codigo, parametros, extrasMock), mock: true };
  }
  const credencial = await carregarCredencial(db);
  const url = urlConsulta(credencial.url, codigo, parametros);
  let { token } = await obterToken(db, empresaId);
  let resposta = await comTempoLimite(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (resposta.status === 401) {
    // Token revogado no RM antes do prazo: renova uma vez.
    token = (await obterToken(db, empresaId, true)).token;
    resposta = await comTempoLimite(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  }
  const corpo = await resposta.text();
  if (!resposta.ok) throw new ErroRh("RM_INDISPONIVEL", descreverErroRm(resposta.status, corpo, codigo));
  let lido: unknown;
  try {
    lido = corpo.trim() ? JSON.parse(corpo) : [];
  } catch {
    throw new ErroRh("RM_INDISPONIVEL", "O TOTVS RM respondeu em um formato inesperado (não é JSON).");
  }
  const linhas = (Array.isArray(lido) ? lido : [lido]).filter(
    (linha): linha is Record<string, unknown> => typeof linha === "object" && linha !== null && !Array.isArray(linha),
  );
  return { url, status: resposta.status, linhas, mock: false };
}

/**
 * Consulta SQL do catálogo (app_imobrh.consulta_rm) com cache em app_imobrh.rm_cache pelo tempo da consulta
 * (1 hora para funcionário e hierarquia). Com o RM fora, devolve o último valor lido marcado como desatualizado.
 */
export async function consultar(
  db: Db,
  empresaId: string,
  codigo: string,
  parametros: Record<string, string>,
  extrasMock: RmFuncionario[] = [],
): Promise<ResultadoConsulta> {
  const cadastro = await db.rpc("consulta_rm_por_codigo", { p_codigo: codigo });
  if (cadastro.error) throw deRpc(cadastro.error);
  const consulta = cadastro.data as { ativa: boolean; cache_segundos: number } | null;
  if (!consulta) throw new ErroRh("ESTADO_INVALIDO", `A consulta ${codigo} não está cadastrada em Integração TOTVS RM.`);
  if (!consulta.ativa) throw new ErroRh("ESTADO_INVALIDO", `A consulta ${codigo} está desativada em Integração TOTVS RM.`);

  const modo = modoRm();
  const chave = `${modo}:${chaveCache(codigo, parametros)}`;
  if (consulta.cache_segundos > 0) {
    const emCache = await db.rpc("cache_rm_ler", { p_chave: chave });
    if (emCache.error) throw deRpc(emCache.error);
    const valor = emCache.data as { valor: Record<string, unknown>[]; lido_em: string } | null;
    if (valor) return { linhas: valor.valor, lidoEm: valor.lido_em, doCache: true, desatualizado: false, mock: modo === "mock" };
  }

  try {
    const { linhas, mock } = await chamarConsulta(db, empresaId, codigo, parametros, extrasMock);
    if (consulta.cache_segundos > 0) {
      const gravado = await db.rpc("cache_rm_gravar", { p_chave: chave, p_valor: linhas, p_segundos: consulta.cache_segundos });
      if (gravado.error) throw deRpc(gravado.error);
    }
    return { linhas, lidoEm: new Date().toISOString(), doCache: false, desatualizado: false, mock };
  } catch (error) {
    if (!(error instanceof ErroRh) || error.code !== "RM_INDISPONIVEL") throw error;
    const ultimo = await db.rpc("cache_rm_ultimo", { p_chave: chave });
    const valor = ultimo.data as { valor: Record<string, unknown>[]; lido_em: string } | null;
    if (ultimo.error || !valor) throw error;
    console.warn(JSON.stringify({ evento: "rm_indisponivel_usando_cache", codigo, lido_em: valor.lido_em }));
    return { linhas: valor.valor, lidoEm: valor.lido_em, doCache: true, desatualizado: true, mock: modo === "mock" };
  }
}
