// Acesso ao TOTVS RM (consultaSQLServer/RealizaConsulta) para as Edge Functions do Imobdesk.
//
// A credencial vem do banco (imobdesk.ler_credencial_totvs, só service_role): URL e usuário da
// integration_settings (aba TOTVS RM) e a senha do Vault. Ela nunca é logada nem devolvida ao navegador.
//
// Sintaxe (conferida no RM em 2026-09-27):
//   <URL da aba TOTVS RM>/<código>/0/X[?parameters=NOME=valor;NOME2=valor]
//   http://204.199.32.54:8051/api/framework/v1/consultaSQLServer/RealizaConsulta/API.00.07.003/0/X?parameters=CODEMPREENDIMENTO=229
// Consulta que exige parâmetro e é chamada sem ele: HTTP 404 com {"code":"FE011",...}.
import { type AdminClient, fromRpcError, PortalError } from "./portal.ts";

const CONSULTA_PATH = "/api/framework/v1/consultaSQLServer/RealizaConsulta";

export interface TotvsCredential {
  url: string;
  user: string;
  password: string;
}

/** Credencial da conexão ativa. Sem configuração completa ou inativa: erro de regra. */
export async function loadTotvsCredential(admin: AdminClient): Promise<TotvsCredential> {
  const { data, error } = await admin.rpc("ler_credencial_totvs");
  if (error) throw fromRpcError(error);
  const row = (data as { url: string; usuario: string; senha: string | null; ativo: boolean }[] | null)?.[0];
  if (!row || !row.url || !row.usuario || !row.senha) {
    throw new PortalError("INTEGRATION_NOT_CONFIGURED", "Conexão TOTVS RM sem URL, usuário ou senha salvos.");
  }
  if (!row.ativo) throw new PortalError("INTEGRATION_INACTIVE", "A integração TOTVS RM está desativada.");
  return { url: row.url, user: row.usuario, password: row.senha };
}

/**
 * Base das consultas a partir da URL salva na aba TOTVS RM. A URL completa (…/RealizaConsulta) é usada
 * como está (sem barra final); se vier só o host, acrescenta o caminho padrão do consultaSQLServer.
 */
export function consultaBase(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl.trim());
  } catch {
    throw new PortalError("INVALID_INPUT", "URL da API TOTVS RM inválida. Confira a aba TOTVS RM.", 400, "url");
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  const at = path.toLowerCase().indexOf("/realizaconsulta");
  const basePath = at >= 0 ? path.slice(0, at + "/realizaconsulta".length) : CONSULTA_PATH;
  return `${parsed.origin}${basePath}`;
}

/**
 * URL completa da consulta. Código simples ("API.00.07.003") ganha o sufixo padrão /0/X (coligada 0,
 * sistema X). Código que já traz o próprio caminho ("API.00.03.001/0/F") é usado como está.
 * Parâmetros vão como no Postman do RM: ?parameters=NOME=valor;NOME2=valor.
 */
export function consultaUrl(baseUrl: string, code: string, parameters?: Record<string, string>): string {
  const segments = code.trim().replace(/\/+$/, "").split("/").filter(Boolean);
  const path = segments.length > 1 ? segments.map(encodeURIComponent).join("/") : `${encodeURIComponent(segments[0] ?? "")}/0/X`;
  const query = parameters && Object.keys(parameters).length > 0
    ? `?parameters=${Object.entries(parameters).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join(";")}`
    : "";
  return `${consultaBase(baseUrl)}/${path}${query}`;
}

function basicAuth(credential: TotvsCredential): string {
  const bytes = new TextEncoder().encode(`${credential.user}:${credential.password}`);
  return `Basic ${btoa(String.fromCharCode(...bytes))}`;
}

export type PreviewResult =
  | { ok: true; url: string; status: number; rowCount: number; truncated: boolean; columns: string[]; preview: Record<string, unknown>[] }
  | { ok: false; url: string; status: number; message: string; timedOut?: boolean };

/**
 * GET numa consulta do RM com leitura limitada: lê no máximo `maxBytes` da resposta. Respostas grandes
 * (a API.00.02.001 devolve ~24 MB) estouram a CPU da Edge Function se forem interpretadas inteiras;
 * aqui o corte é feito no último objeto completo e a contagem vira "mais de N".
 * Nunca refaz a chamada sozinha: abortar o fetch não cancela o SQL no servidor RM.
 */
export async function fetchConsultaPreview(
  credential: TotvsCredential,
  code: string,
  parameters: Record<string, string> | undefined,
  { timeoutMs = 60_000, maxBytes = 1_000_000, previewRows = 5 } = {},
): Promise<PreviewResult> {
  const url = consultaUrl(credential.url, code, parameters);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Authorization: basicAuth(credential), Accept: "application/json, text/plain, */*" },
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text();
      return { ok: false, url, status: response.status, message: describeRmError(response.status, body, code) };
    }

    // Leitura em pedaços até o limite; guarda os pedaços e junta uma vez só no fim.
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    const reader = response.body?.getReader();
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.byteLength;
        if (total >= maxBytes) {
          truncated = true;
          await reader.cancel();
          break;
        }
      }
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let text = new TextDecoder().decode(bytes).trim();

    if (truncated) {
      // Fecha o array no último objeto completo ("}," entre registros).
      const cut = text.lastIndexOf("},");
      if (!text.startsWith("[") || cut < 0) {
        return { ok: false, url, status: response.status, message: "Resposta grande demais para pré-visualizar." };
      }
      text = `${text.slice(0, cut + 1)}]`;
    }

    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : [];
    } catch {
      return { ok: false, url, status: response.status, message: "O TOTVS RM respondeu em um formato inesperado (não é JSON)." };
    }
    const rows = (Array.isArray(parsed) ? parsed : [parsed]).filter(
      (row): row is Record<string, unknown> => typeof row === "object" && row !== null && !Array.isArray(row),
    );
    const columns = [...new Set(rows.slice(0, 50).flatMap((row) => Object.keys(row)))];
    return { ok: true, url, status: response.status, rowCount: rows.length, truncated, columns, preview: rows.slice(0, previewRows) };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return { ok: false, url, status: 0, timedOut: true, message: `O TOTVS RM não respondeu em ${Math.round(timeoutMs / 1000)} segundos.` };
    }
    return { ok: false, url, status: 0, message: "Não foi possível conectar ao TOTVS RM. Confira a URL e se o servidor está acessível." };
  } finally {
    clearTimeout(timer);
  }
}

export type RawResult =
  | { ok: true; url: string; status: number; text: string }
  | { ok: false; url: string; status: number; message: string; timedOut?: boolean };

/** GET com a resposta em texto, sem interpretar (respostas pequenas: consultas por empreendimento). */
export async function fetchConsultaTexto(
  credential: TotvsCredential,
  code: string,
  parameters: Record<string, string> | undefined,
  timeoutMs = 60_000,
): Promise<RawResult> {
  const url = consultaUrl(credential.url, code, parameters);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Authorization: basicAuth(credential), Accept: "application/json, text/plain, */*" },
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) return { ok: false, url, status: response.status, message: describeRmError(response.status, text, code) };
    return { ok: true, url, status: response.status, text };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return { ok: false, url, status: 0, timedOut: true, message: `O TOTVS RM não respondeu em ${Math.round(timeoutMs / 1000)} segundos.` };
    }
    return { ok: false, url, status: 0, message: "Não foi possível conectar ao TOTVS RM. Confira a URL e se o servidor está acessível." };
  } finally {
    clearTimeout(timer);
  }
}

const SEPARADOR = [0x7d, 0x2c, 0x7b]; // "},{" entre registros do array JSON do RM

function ultimoSeparador(bytes: Uint8Array, desde: number): number {
  for (let i = bytes.length - 3; i >= desde; i--) {
    if (bytes[i] === SEPARADOR[0] && bytes[i + 1] === SEPARADOR[1] && bytes[i + 2] === SEPARADOR[2]) return i;
  }
  return -1;
}

function juntar(chunks: Uint8Array[], total: number): Uint8Array {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export type StreamResult =
  | { ok: true; url: string; status: number; bytes: number; lotes: number }
  | { ok: false; url: string; status: number; message: string; timedOut?: boolean; bytes: number; lotes: number };

/**
 * GET em consulta grande, entregando a resposta em lotes de ~`loteBytes` como texto de array JSON
 * ("[{...},{...}]"). Nada é interpretado aqui (o parse de 18–24 MB estoura a CPU da Edge Function):
 * os bytes são cortados no último "},{" do buffer e o banco faz o parse.
 * `onLote` devolve false quando o lote não era JSON válido (o corte caiu dentro de um texto): o lote
 * volta para o buffer e o próximo corte é procurado mais adiante.
 */
export async function fetchConsultaEmLotes(
  credential: TotvsCredential,
  code: string,
  parameters: Record<string, string> | undefined,
  onLote: (lote: string) => Promise<boolean>,
  { timeoutMs = 330_000, loteBytes = 1_000_000 } = {},
): Promise<StreamResult> {
  const url = consultaUrl(credential.url, code, parameters);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const decoder = new TextDecoder();
  let bytesLidos = 0;
  let lotes = 0;
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Authorization: basicAuth(credential), Accept: "application/json, text/plain, */*" },
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text();
      return { ok: false, url, status: response.status, message: describeRmError(response.status, body, code), bytes: 0, lotes: 0 };
    }
    const reader = response.body?.getReader();
    if (!reader) return { ok: true, url, status: response.status, bytes: 0, lotes: 0 };

    let chunks: Uint8Array[] = [];
    let pendente = 0;
    let inicioArray = true;
    let minimoCorte = 0; // após um lote inválido, só aceita corte além deste ponto

    const enviar = async (bytes: Uint8Array, fim: boolean): Promise<Uint8Array> => {
      // bytes começa em "{" (ou "[{" no primeiro pedaço). Devolve o que sobrou para o próximo lote.
      let inicio = 0;
      if (inicioArray) {
        while (inicio < bytes.length && bytes[inicio] !== 0x5b && bytes[inicio] !== 0x7b) inicio++;
        if (bytes[inicio] === 0x5b) inicio++;
      }
      if (fim) {
        let final = bytes.length;
        while (final > inicio && (bytes[final - 1] === 0x5d || bytes[final - 1] <= 0x20)) final--;
        if (final <= inicio) return new Uint8Array(0);
        const texto = `[${decoder.decode(bytes.subarray(inicio, final))}]`;
        if (!(await onLote(texto))) throw new Error("Resposta do RM não é um JSON válido.");
        lotes++;
        inicioArray = false;
        return new Uint8Array(0);
      }
      const corte = ultimoSeparador(bytes, Math.max(inicio, minimoCorte));
      if (corte < 0) return bytes; // ainda sem separador: espera mais bytes
      const texto = `[${decoder.decode(bytes.subarray(inicio, corte + 1))}]`;
      if (await onLote(texto)) {
        lotes++;
        inicioArray = false;
        minimoCorte = 0;
        return bytes.subarray(corte + 2); // começa no "{" do próximo registro
      }
      minimoCorte = corte + 3; // o "},{" estava dentro de um texto: corta mais adiante
      return bytes;
    };

    while (true) {
      const { done, value } = await reader.read();
      if (value) {
        chunks.push(value);
        pendente += value.byteLength;
        bytesLidos += value.byteLength;
      }
      if (done || pendente >= loteBytes) {
        const buffer = juntar(chunks, pendente);
        const resto = await enviar(buffer, done);
        chunks = resto.byteLength > 0 ? [resto] : [];
        pendente = resto.byteLength;
        if (done) break;
      }
    }
    return { ok: true, url, status: response.status, bytes: bytesLidos, lotes };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return { ok: false, url, status: 0, timedOut: true, message: `O TOTVS RM não terminou de responder em ${Math.round(timeoutMs / 1000)} segundos.`, bytes: bytesLidos, lotes };
    }
    controller.abort(); // falha ao gravar (ou job cancelado): para de receber a resposta
    const message = error instanceof Error ? error.message : "Falha na leitura da resposta do TOTVS RM.";
    return { ok: false, url, status: 0, message, bytes: bytesLidos, lotes };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Mensagem legível do erro do RM. O RM responde {"code","message"} e a message traz, depois de "SQL:",
 * o texto do SQL da consulta: esse trecho nunca é repassado.
 */
function describeRmError(status: number, body: string, code: string): string {
  let rmCode = "";
  let rmMessage = "";
  try {
    const parsed = JSON.parse(body) as { code?: unknown; message?: unknown };
    rmCode = typeof parsed.code === "string" ? parsed.code : "";
    rmMessage = typeof parsed.message === "string"
      ? parsed.message.split(/\r?\n\s*\r?\nSQL:|\r?\nSQL:|SQL:/)[0].trim().replace(/\.+$/, "")
      : "";
  } catch {
    // corpo não é JSON
  }
  if (rmCode === "FE011") {
    return `FE011: ${rmMessage || "quantidade de parâmetros não corresponde ao esperado"}. A consulta ${code} exige parâmetros diferentes dos enviados (ex.: CODEMPREENDIMENTO=229).`;
  }
  if (status === 401) return "Usuário ou senha recusados pelo TOTVS RM. Confira a aba TOTVS RM.";
  if (rmMessage) return `${rmCode ? `${rmCode}: ` : ""}${rmMessage.slice(0, 300)}.`;
  if (status === 404) return `Consulta ${code} não encontrada no TOTVS RM. Confira o código e a URL.`;
  return `O TOTVS RM respondeu com erro (HTTP ${status}).`;
}
