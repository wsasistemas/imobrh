// API do Gmail com OAuth2 por conta ("Autorizar com Gmail", como a Movidesk). Cada caixa é autorizada por quem
// tem a senha dela; o refresh token fica no Vault e vale para ler e para enviar (escopo https://mail.google.com/).
// O aplicativo OAuth do portal (ID do cliente + chave secreta) é cadastrado uma vez pelo super admin em
// Central Email › Opções › Aplicativo do Google: o ID fica em at_config e a chave no Vault (lidos só pelo servidor,
// at_google_oauth_ler). Os secrets GOOGLE_OAUTH_CLIENT_ID/SECRET valem só como reserva. Só HTTPS.

import type { Passo } from "./conexao.ts";
import { base64url } from "./mime.ts";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

type Fetch = typeof fetch;

/** Reserva: aplicativo OAuth nos secrets da função. null = não configurado ali. */
export function appGoogle(env: (k: string) => string | undefined = (k) => (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env.get(k)): { clientId: string; clientSecret: string } | null {
  const clientId = env("GOOGLE_OAUTH_CLIENT_ID")?.trim();
  const clientSecret = env("GOOGLE_OAUTH_CLIENT_SECRET")?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export const APP_GOOGLE_AUSENTE = "O Aplicativo do Google ainda não foi configurado: Central Email › Opções › Aplicativo do Google (chaves).";

/** Aplicativo OAuth do portal: o cadastrado na Central Email (banco + Vault) e, na falta dele, os secrets. */
export async function appGoogleDe(ler: () => Promise<{ client_id: string | null; client_secret: string | null } | null | undefined>): Promise<{ clientId: string; clientSecret: string } | null> {
  const l = await ler();
  if (l?.client_id && l.client_secret) return { clientId: l.client_id, clientSecret: l.client_secret };
  return appGoogle();
}

/** Erro do Google em português, com a causa mais comum de cada código. */
export function erroGoogle(status: number, corpo: string): string {
  let msg = corpo.slice(0, 200);
  try {
    const j = JSON.parse(corpo) as { error?: string | { message?: string }; error_description?: string };
    msg = typeof j.error === "string" ? `${j.error}${j.error_description ? `: ${j.error_description}` : ""}` : (j.error?.message ?? msg);
  } catch {
    /* não-JSON */
  }
  if (/invalid_client|unauthorized_client/i.test(msg)) {
    return "O Google recusou o aplicativo do portal: confira o ID do cliente e a chave secreta nos secrets das Edge Functions.";
  }
  if (/invalid_grant/i.test(msg)) return `O Google recusou a autorização: clique em Reautorizar com Gmail (${msg}).`;
  return `Google respondeu ${status}: ${msg}`;
}

/** Pasta: "INBOX" e marcadores do sistema usam o próprio id; marcador criado pelo usuário é buscado pelo nome. */
async function rotulo(f: Fetch, token: string, pasta: string): Promise<{ total: number; naoLidas: number }> {
  const h = { Authorization: `Bearer ${token}` };
  let id = pasta.toUpperCase() === "INBOX" ? "INBOX" : pasta;
  if (id !== "INBOX") {
    const lista = await f(`${GMAIL}/labels`, { headers: h, signal: AbortSignal.timeout(15_000) });
    if (!lista.ok) throw new Error(erroGoogle(lista.status, await lista.text()));
    const achado = ((await lista.json()) as { labels?: { id: string; name: string }[] }).labels?.find((l) => l.name.toLowerCase() === pasta.toLowerCase());
    if (!achado) throw new Error(`Pasta "${pasta}" não existe nesta caixa.`);
    id = achado.id;
  }
  const r = await f(`${GMAIL}/labels/${encodeURIComponent(id)}`, { headers: h, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(erroGoogle(r.status, await r.text()));
  const j = (await r.json()) as { messagesTotal?: number; messagesUnread?: number };
  return { total: j.messagesTotal ?? 0, naoLidas: j.messagesUnread ?? 0 };
}

/** threadId: conversa do Gmail da caixa (a resposta fica junto do e-mail do cliente em "Enviados"). */
export async function enviarGmail(f: Fetch, token: string, mensagemRfc822: string, threadId?: string | null): Promise<string> {
  const r = await f(`${GMAIL}/messages/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(threadId ? { raw: base64url(mensagemRfc822), threadId } : { raw: base64url(mensagemRfc822) }),
    signal: AbortSignal.timeout(20_000),
  });
  const texto = await r.text();
  if (!r.ok) throw new Error(erroGoogle(r.status, texto));
  return (JSON.parse(texto) as { id: string }).id;
}

// ---------------------------------------------------------------- OAuth2 por conta ("Autorizar com Gmail")

export const ESCOPOS_OAUTH = ["https://mail.google.com/", "openid", "email"];

export function urlAutorizacao(p: { clientId: string; redirectUri: string; state: string; caixa: string }): string {
  const q = new URLSearchParams({
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    response_type: "code",
    scope: ESCOPOS_OAUTH.join(" "),
    access_type: "offline",
    // Sempre pede o consentimento: é o que garante o refresh_token também na reautorização.
    prompt: "consent",
    include_granted_scopes: "true",
    login_hint: p.caixa,
    state: p.state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q.toString()}`;
}

/** E-mail da conta que autorizou, lido do id_token (vem direto do Google pelo canal TLS do token). */
export function emailDoIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null;
  try {
    const corpo = idToken.split(".")[1] ?? "";
    const json = JSON.parse(atob(corpo.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(corpo.length / 4) * 4, "="))) as { email?: string };
    return json.email?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

export async function trocarCodigo(f: Fetch, p: { clientId: string; clientSecret: string; code: string; redirectUri: string }): Promise<{ refreshToken: string | null; accessToken: string; email: string | null }> {
  const r = await f("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: p.code, client_id: p.clientId, client_secret: p.clientSecret, redirect_uri: p.redirectUri }),
    signal: AbortSignal.timeout(15_000),
  });
  const texto = await r.text();
  if (!r.ok) throw new Error(erroGoogle(r.status, texto));
  const j = JSON.parse(texto) as { access_token: string; refresh_token?: string; id_token?: string };
  return { refreshToken: j.refresh_token ?? null, accessToken: j.access_token, email: emailDoIdToken(j.id_token) };
}

export async function tokenPorRefresh(f: Fetch, p: { clientId: string; clientSecret: string; refreshToken: string }): Promise<string> {
  const r = await f("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: p.refreshToken, client_id: p.clientId, client_secret: p.clientSecret }),
    signal: AbortSignal.timeout(15_000),
  });
  const texto = await r.text();
  if (!r.ok) {
    if (/invalid_grant/i.test(texto)) throw new Error("A autorização do Google expirou ou foi revogada: clique em Reautorizar com Gmail.");
    throw new Error(erroGoogle(r.status, texto));
  }
  return (JSON.parse(texto) as { access_token: string }).access_token;
}

/** Leitura da pasta e (opcional) envio de teste com o token da caixa. */
export async function testarGmailComToken(
  f: Fetch,
  obterToken: () => Promise<string>,
  conexao: { passo: string; detalhe: string },
  pasta: string,
  teste?: { mensagem: string; para: string },
): Promise<Passo[]> {
  const passos: Passo[] = [];
  let token: string;
  try {
    token = await obterToken();
    passos.push({ passo: conexao.passo, ok: true, detalhe: conexao.detalhe });
  } catch (e) {
    passos.push({ passo: conexao.passo, ok: false, detalhe: String(e instanceof Error ? e.message : e) });
    return passos;
  }
  try {
    const st = await rotulo(f, token, pasta);
    passos.push({ passo: `Leitura da pasta ${pasta}`, ok: true, detalhe: `${st.total} e-mails, ${st.naoLidas} não lidos` });
  } catch (e) {
    passos.push({ passo: `Leitura da pasta ${pasta}`, ok: false, detalhe: String(e instanceof Error ? e.message : e) });
  }
  if (teste) {
    try {
      await enviarGmail(f, token, teste.mensagem);
      passos.push({ passo: `E-mail de teste para ${teste.para}`, ok: true, detalhe: "enviado (fica em Enviados da caixa)" });
    } catch (e) {
      passos.push({ passo: `E-mail de teste para ${teste.para}`, ok: false, detalhe: String(e instanceof Error ? e.message : e) });
    }
  }
  return passos;
}
