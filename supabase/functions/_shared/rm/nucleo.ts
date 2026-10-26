// Núcleo puro do acesso ao TOTVS RM: URLs, parâmetros, mensagens de erro e o modo mock.
// Sem Deno.*, node:* ou supabase-js: roda nas Edge Functions e nos testes do Vitest (tests/rm-nucleo.test.ts).
//
// Endpoints do RM (TDN — autenticação das APIs e consultaSQLServer):
//   token:    POST <origem>/api/connect/token/  { grant_type: "password", username, password }
//   consulta: GET  <origem>/api/framework/v1/consultaSQLServer/RealizaConsulta/<código>/<coligada>/<sistema>
//             ?parameters=NOME=valor;NOME2=valor   (Authorization: Bearer <token>)
// Código sem caminho ganha /0/P (sentença global do sistema P, Folha de Pagamento). Para outro sistema ou
// coligada, cadastre o código com o caminho (ex.: API.RH.FUNCIONARIO/0/X).
import type { RmFuncionario, RmHierarquia } from "../contrato.ts";

export const CONSULTA_PATH = "/api/framework/v1/consultaSQLServer/RealizaConsulta";
export const SUFIXO_PADRAO = "0/P";

export interface CredencialRm {
  url: string;
  usuario: string;
  senha: string;
}

export class ErroUrlRm extends Error {}

/** Origem (protocolo + host + porta) da URL salva na tela Integração TOTVS RM. */
export function origemRm(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    throw new ErroUrlRm("URL da API do RM inválida. Confira a tela Integração TOTVS RM.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new ErroUrlRm("A URL do RM precisa começar com http:// ou https://.");
  return url.origin;
}

export function urlToken(baseUrl: string): string {
  return `${origemRm(baseUrl)}/api/connect/token/`;
}

/** URL da consulta. A URL salva pode ser só o host ou já trazer o caminho …/RealizaConsulta. */
export function urlConsulta(baseUrl: string, codigo: string, parametros?: Record<string, string>): string {
  const url = new URL(baseUrl.trim());
  const caminho = url.pathname.replace(/\/+$/, "");
  const posicao = caminho.toLowerCase().indexOf("/realizaconsulta");
  const base = `${origemRm(baseUrl)}${posicao >= 0 ? caminho.slice(0, posicao + "/realizaconsulta".length) : CONSULTA_PATH}`;
  const partes = codigo.trim().replace(/\/+$/, "").split("/").filter(Boolean);
  const trecho = partes.length > 1 ? partes.map(encodeURIComponent).join("/") : `${encodeURIComponent(partes[0] ?? "")}/${SUFIXO_PADRAO}`;
  const consulta = parametros && Object.keys(parametros).length > 0
    ? `?parameters=${Object.entries(parametros).map(([nome, valor]) => `${nome}=${encodeURIComponent(valor)}`).join(";")}`
    : "";
  return `${base}/${trecho}${consulta}`;
}

const PARAMETRO = /^([A-Z0-9_]{1,40})=([^;]{0,120})$/i;

/** "CODCOLIGADA=1;CPF=123" → { CODCOLIGADA: "1", CPF: "123" }. Lança Error com a mensagem para o usuário. */
export function lerParametros(texto: string | undefined | null): Record<string, string> {
  const parametros: Record<string, string> = {};
  for (const parte of (texto ?? "").split(";").map((item) => item.trim()).filter(Boolean)) {
    const casou = PARAMETRO.exec(parte);
    if (!casou) throw new Error(`Parâmetro inválido: "${parte}". Use NOME=valor, separados por ponto e vírgula.`);
    parametros[casou[1].toUpperCase()] = casou[2].trim();
  }
  if (Object.keys(parametros).length > 10) throw new Error("Use no máximo 10 parâmetros.");
  return parametros;
}

/** Chave do cache: código + parâmetros em ordem alfabética (a ordem da chamada não cria outra entrada). */
export function chaveCache(codigo: string, parametros: Record<string, string> = {}): string {
  const ordenados = Object.keys(parametros).sort().map((nome) => `${nome}=${parametros[nome]}`).join(";");
  return `consulta:${codigo.toUpperCase()}:${ordenados}`;
}

export function somenteDigitos(valor: unknown): string {
  return typeof valor === "string" || typeof valor === "number" ? String(valor).replace(/\D/g, "") : "";
}

/** CPF com 11 dígitos e dígitos verificadores válidos. */
export function cpfValido(cpf: string): boolean {
  const d = somenteDigitos(cpf);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const dv = (fim: number) => {
    let soma = 0;
    for (let i = 0; i < fim; i++) soma += Number(d[i]) * (fim + 1 - i);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  return dv(9) === Number(d[9]) && dv(10) === Number(d[10]);
}

/**
 * Mensagem legível do erro do RM. O RM responde {"code","message"} e a message traz, depois de "SQL:", o texto
 * da consulta: esse trecho nunca é repassado.
 */
export function descreverErroRm(status: number, corpo: string, codigo: string): string {
  let codigoRm = "";
  let mensagemRm = "";
  try {
    const lido = JSON.parse(corpo) as { code?: unknown; message?: unknown };
    codigoRm = typeof lido.code === "string" ? lido.code : "";
    mensagemRm = typeof lido.message === "string" ? lido.message.split(/SQL:/)[0].trim().replace(/\.+$/, "") : "";
  } catch {
    // corpo não é JSON
  }
  if (codigoRm === "FE011") return `FE011: a consulta ${codigo} exige parâmetros diferentes dos enviados.`;
  if (status === 401) return "Usuário ou senha de integração recusados pelo TOTVS RM.";
  if (mensagemRm) return `${codigoRm ? `${codigoRm}: ` : ""}${mensagemRm.slice(0, 300)}.`;
  if (status === 404) return `Consulta ${codigo} não encontrada no TOTVS RM. Confira o código e a URL.`;
  return `O TOTVS RM respondeu com erro (HTTP ${status}).`;
}

// ============================================================================================
// Modo mock (RM_MODO=mock): mesmo formato de resposta das consultas reais, com dados fictícios.
// ============================================================================================

export const FUNCIONARIOS_MOCK: RmFuncionario[] = [
  { CODCOLIGADA: 1, CHAPA: "000101", NOME: "Ana Paula Ribeiro", CPF: "52998224725", EMAIL: "ana.ribeiro@exemplo.com.br", CODSITUACAO: "A", SITUACAO: "Ativo", CODSECAO: "01.002", SECAO: "Recursos Humanos", CODFUNCAO: "0042", FUNCAO: "Coordenadora de RH", DATAADMISSAO: "2018-03-05", CHAPA_GESTOR: "000001" },
  { CODCOLIGADA: 1, CHAPA: "000102", NOME: "Bruno Carvalho", CPF: "11144477735", EMAIL: "bruno.carvalho@exemplo.com.br", CODSITUACAO: "A", SITUACAO: "Ativo", CODSECAO: "01.002", SECAO: "Recursos Humanos", CODFUNCAO: "0043", FUNCAO: "Analista de DP", DATAADMISSAO: "2021-08-16", CHAPA_GESTOR: "000101" },
  { CODCOLIGADA: 1, CHAPA: "000201", NOME: "Carla Mendes", CPF: "39053344705", EMAIL: "carla.mendes@exemplo.com.br", CODSITUACAO: "A", SITUACAO: "Ativo", CODSECAO: "01.003", SECAO: "Engenharia", CODFUNCAO: "0061", FUNCAO: "Gerente de Obras", DATAADMISSAO: "2016-01-11", CHAPA_GESTOR: "000001" },
  { CODCOLIGADA: 1, CHAPA: "000202", NOME: "Diego Souza", CPF: "71428793860", EMAIL: "diego.souza@exemplo.com.br", CODSITUACAO: "F", SITUACAO: "Férias", CODSECAO: "01.003", SECAO: "Engenharia", CODFUNCAO: "0062", FUNCAO: "Engenheiro Civil", DATAADMISSAO: "2022-04-04", CHAPA_GESTOR: "000201" },
  { CODCOLIGADA: 1, CHAPA: "000001", NOME: "Eduardo Lima", CPF: "86288366757", EMAIL: "eduardo.lima@exemplo.com.br", CODSITUACAO: "A", SITUACAO: "Ativo", CODSECAO: "01.001", SECAO: "Diretoria", CODFUNCAO: "0001", FUNCAO: "Diretor", DATAADMISSAO: "2010-02-01", CHAPA_GESTOR: null },
];

export const HIERARQUIA_MOCK: RmHierarquia[] = [
  { CODCOLIGADA: 1, CODSECAO: "01.001", SECAO: "Diretoria", CODSECAO_PAI: null, CHAPA_CHEFE: "000001", NOME_CHEFE: "Eduardo Lima" },
  { CODCOLIGADA: 1, CODSECAO: "01.002", SECAO: "Recursos Humanos", CODSECAO_PAI: "01.001", CHAPA_CHEFE: "000101", NOME_CHEFE: "Ana Paula Ribeiro" },
  { CODCOLIGADA: 1, CODSECAO: "01.003", SECAO: "Engenharia", CODSECAO_PAI: "01.001", CHAPA_CHEFE: "000201", NOME_CHEFE: "Carla Mendes" },
];

/** Gera um CPF válido determinístico a partir de um texto (o id do login). */
function cpfDe(semente: string): string {
  let h = 2166136261;
  for (const c of semente) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  const base = String(h % 1_000_000_000).padStart(9, "0");
  const digitos = base.split("").map(Number);
  for (const fim of [9, 10]) {
    let soma = 0;
    for (let i = 0; i < fim; i++) soma += digitos[i] * (fim + 1 - i);
    const resto = (soma * 10) % 11;
    digitos.push(resto === 10 ? 0 : resto);
  }
  return digitos.join("");
}

/**
 * Funcionário fictício para um login (só no modo mock): /rh/me devolve um vínculo para qualquer usuário do imobdesk.
 * Fica na seção Recursos Humanos, abaixo da Ana (chapa 000101).
 */
export function funcionarioMockPara(usuarioId: string, email: string, nome: string): RmFuncionario {
  const cpf = cpfDe(usuarioId);
  return {
    CODCOLIGADA: 1,
    CHAPA: `9${cpf.slice(0, 5)}`,
    NOME: nome,
    CPF: cpf,
    EMAIL: email,
    CODSITUACAO: "A",
    SITUACAO: "Ativo",
    CODSECAO: "01.002",
    SECAO: "Recursos Humanos",
    CODFUNCAO: "0043",
    FUNCAO: "Analista de DP",
    DATAADMISSAO: "2024-01-15",
    CHAPA_GESTOR: "000101",
  };
}

const vazioOuIgual = (filtro: string | undefined, valor: string | number | null) =>
  !filtro || filtro === "%" || String(valor ?? "") === filtro;

/** Resposta mock de uma consulta, filtrada pelos parâmetros como o SQL real (docs/consultas-rm.md). */
export function consultaMock(codigo: string, parametros: Record<string, string>, extras: RmFuncionario[] = []): Record<string, unknown>[] {
  const nome = codigo.split("/")[0].toUpperCase();
  if (nome === "API.RH.FUNCIONARIO") {
    return [...FUNCIONARIOS_MOCK, ...extras].filter((f) =>
      vazioOuIgual(parametros.CODCOLIGADA, f.CODCOLIGADA) &&
      vazioOuIgual(somenteDigitos(parametros.CPF), f.CPF) &&
      vazioOuIgual(parametros.CHAPA, f.CHAPA)
    ) as unknown as Record<string, unknown>[];
  }
  if (nome === "API.RH.HIERARQUIA") {
    return HIERARQUIA_MOCK.filter((h) => vazioOuIgual(parametros.CODCOLIGADA, h.CODCOLIGADA) && vazioOuIgual(parametros.CODSECAO, h.CODSECAO)) as unknown as Record<string, unknown>[];
  }
  return [];
}
