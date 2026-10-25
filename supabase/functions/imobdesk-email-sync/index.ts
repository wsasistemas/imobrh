// Gestão de Atendimento › e-mail como canal de ticket (Etapa 4: F4 leitura + F5 envio).
// Chamada pelo pg_cron a cada 1 min (job imobdesk-email-1min), sem JWT: a autenticação é o cabeçalho
// x-atendimento-chave (chave no Vault). Também aceita um usuário logado da supervisão geral ("Ler agora").
//
//   {acao: "ciclo", contaId?}  lê as caixas (ou só a conta) e envia as respostas pendentes
//
// Leitura: e-mails novos da pasta desde o cursor (internalDate) ou "importar a partir de", sem repetir
// (provedor_id e Message-ID); grava em at_email_recebidos e chama ch_email_processar, que abre o ticket ou junta
// a resposta ao ticket. Envio: ações públicas pendentes dos tickets de e-mail, com [#ticket] no assunto e
// In-Reply-To/References na mesma conversa do cliente.

import { clienteServico, paraCadaEmpresa } from "../_shared/empresa.ts";
import { corsHeaders, errorResponse, fromRpcError, json, PortalError, portalContext, type AdminClient } from "../_shared/portal.ts";
import { APP_GOOGLE_AUSENTE, appGoogleDe, enviarGmail, erroGoogle, tokenPorRefresh } from "../_shared/email/gmail.ts";
import { lerMensagem, motivoIgnorar, nomeSeguro, type MensagemGmail } from "../_shared/email/leitura.ts";
import { montarMensagem, novoMessageId } from "../_shared/email/mime.ts";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const LIMITE_POR_CONTA = 30;
const ANEXO_MAX = 25 * 1024 * 1024;

interface Conta {
  id: number;
  email: string;
  oauth_email: string | null;
  pasta: string;
  ler_desde: string;
  cursor: string | null;
  marcar_lido: boolean;
  ignorar_remetentes: string[];
}

/** Compara sem atalho (tempo constante para tamanhos iguais). */
function iguais(a: string, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  let dif = 0;
  for (let i = 0; i < a.length; i++) dif |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return dif === 0;
}

const msg = (e: unknown) => String(e instanceof Error ? e.message : e);

async function gmail<T>(token: string, caminho: string, corpo?: unknown): Promise<T> {
  const r = await fetch(`${GMAIL}${caminho}`, {
    method: corpo ? "POST" : "GET",
    headers: { Authorization: `Bearer ${token}`, ...(corpo ? { "Content-Type": "application/json" } : {}) },
    body: corpo ? JSON.stringify(corpo) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const texto = await r.text();
  if (!r.ok) throw new Error(erroGoogle(r.status, texto));
  return (texto ? JSON.parse(texto) : {}) as T;
}

function bytesDe(base64url: string): Uint8Array {
  const b64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function appOAuth(db: AdminClient) {
  const app = await appGoogleDe(async () => {
    const { data, error } = await db.rpc("at_google_oauth_ler");
    if (error) throw fromRpcError(error);
    return (data as { client_id: string | null; client_secret: string | null }[] | null)?.[0];
  });
  if (!app) throw new PortalError("INTEGRATION_NOT_CONFIGURED", APP_GOOGLE_AUSENTE);
  return app;
}

async function tokenDa(db: AdminClient, app: { clientId: string; clientSecret: string }, contaId: number): Promise<string> {
  const refresh = await db.rpc("at_email_oauth_token", { p_conta: contaId });
  if (refresh.error) throw fromRpcError(refresh.error);
  if (!refresh.data) throw new Error("A caixa ainda não foi autorizada: clique em Autorizar com Gmail.");
  return tokenPorRefresh(fetch, { ...app, refreshToken: refresh.data as string });
}

/** F4: e-mails novos da conta → at_email_recebidos → ticket ou ação. */
async function lerConta(db: AdminClient, token: string, c: Conta) {
  const lerDesde = Date.parse(`${c.ler_desde}T00:00:00-03:00`);
  const desde = Math.max(lerDesde, c.cursor && /^\d+$/.test(c.cursor) ? Number(c.cursor) : 0);
  const pasta = c.pasta.toUpperCase() === "INBOX" ? "in:inbox" : `label:"${c.pasta.replace(/"/g, "")}"`;
  // 2 min de margem: o "after" do Gmail é por segundo e a ordem de chegada não é garantida.
  const q = `${pasta} after:${Math.floor(desde / 1000) - 120}`;

  const ids: string[] = [];
  let pagina: string | undefined;
  for (let i = 0; i < 4; i++) {
    const r = await gmail<{ messages?: { id: string }[]; nextPageToken?: string }>(
      token,
      `/messages?maxResults=100&q=${encodeURIComponent(q)}${pagina ? `&pageToken=${pagina}` : ""}`,
    );
    ids.push(...(r.messages ?? []).map((m) => m.id));
    pagina = r.nextPageToken;
    if (!pagina) break;
  }
  const conhecidos = new Set<string>();
  for (let i = 0; i < ids.length; i += 100) {
    const r = await db.from("at_email_recebidos").select("provedor_id").eq("conta_id", c.id).in("provedor_id", ids.slice(i, i + 100));
    if (r.error) throw new Error(r.error.message);
    for (const x of r.data ?? []) conhecidos.add(x.provedor_id as string);
  }
  // O Gmail lista do mais novo para o mais antigo: processa os mais antigos primeiro.
  const novos = ids.filter((id) => !conhecidos.has(id)).reverse().slice(0, LIMITE_POR_CONTA);

  let cursor = desde;
  let falhaMaisAntiga = Infinity;
  const resumo = { novos: novos.length, tickets: 0, respostas: 0, ignorados: 0, erros: [] as string[] };
  for (const id of novos) {
    let chegada = Infinity;
    try {
      const e = lerMensagem(await gmail<MensagemGmail>(token, `/messages/${id}?format=full`));
      chegada = e.recebidoEm.getTime();
      if (chegada < lerDesde) continue;
      const motivo = motivoIgnorar(e, { email: c.email, oauthEmail: c.oauth_email, ignorarRemetentes: c.ignorar_remetentes ?? [] });

      const anexos: Record<string, unknown>[] = [];
      if (!motivo) {
        for (const a of e.anexos.slice(0, 20)) {
          if (a.tamanho > ANEXO_MAX) {
            anexos.push({ nome: a.nome, mime: a.mime, tamanho: a.tamanho, path: null, erro: "maior que 25 MB" });
            continue;
          }
          try {
            const data = a.data ?? (await gmail<{ data: string }>(token, `/messages/${id}/attachments/${a.attachmentId}`)).data;
            const path = `${c.id}/${id}/${nomeSeguro(a.nome)}`;
            const up = await db.storage.from("imobdesk-atendimento-email").upload(path, bytesDe(data), { contentType: a.mime, upsert: true });
            if (up.error) throw new Error(up.error.message);
            anexos.push({ nome: a.nome, mime: a.mime, tamanho: a.tamanho, path });
          } catch (err) {
            anexos.push({ nome: a.nome, mime: a.mime, tamanho: a.tamanho, path: null, erro: msg(err).slice(0, 200) });
          }
        }
      }

      const ins = await db
        .from("at_email_recebidos")
        .upsert(
          {
            conta_id: c.id,
            message_id: e.messageId.slice(0, 500),
            provedor_id: id,
            thread_id: e.threadId,
            de: e.de || "desconhecido",
            de_nome: e.deNome,
            para: e.para,
            cc: e.cc,
            assunto: e.assunto.slice(0, 1000),
            texto: e.texto.slice(0, 100_000),
            html: e.html ? e.html.slice(0, 500_000) : null,
            anexos,
            in_reply_to: e.inReplyTo,
            referencias: e.referencias?.slice(0, 8000) ?? null,
            recebido_em: e.recebidoEm.toISOString(),
            estado: motivo ? "ignorado" : "pendente",
            motivo,
          },
          { onConflict: "conta_id,message_id", ignoreDuplicates: true },
        )
        .select("id");
      if (ins.error) throw new Error(ins.error.message);
      const recebido = ins.data?.[0]?.id as number | undefined;

      if (motivo) resumo.ignorados++;
      else if (recebido) {
        const p = await db.rpc("ch_email_processar", { p_recebido: recebido });
        if (p.error) throw new Error(p.error.message);
        const r = p.data as { estado: string; motivo?: string };
        if (r.estado === "ignorado") resumo.ignorados++;
        else if (r.motivo === "resposta") resumo.respostas++;
        else resumo.tickets++;
      }
      if (c.marcar_lido) await gmail(token, `/messages/${id}/modify`, { removeLabelIds: ["UNREAD"] }).catch(() => undefined);
      cursor = Math.max(cursor, chegada);
    } catch (err) {
      resumo.erros.push(`${id}: ${msg(err).slice(0, 200)}`);
      falhaMaisAntiga = Math.min(falhaMaisAntiga, chegada === Infinity ? desde : chegada);
    }
  }
  // Uma falha segura o cursor antes dela: a próxima rodada tenta de novo (os já gravados não repetem).
  if (falhaMaisAntiga !== Infinity) cursor = Math.min(cursor, falhaMaisAntiga - 1000);

  // Recebidos que ficaram pendentes (falha numa rodada anterior) são tentados de novo.
  const pend = await db.from("at_email_recebidos").select("id").eq("conta_id", c.id).eq("estado", "pendente").order("id").limit(20);
  for (const x of pend.data ?? []) {
    const p = await db.rpc("ch_email_processar", { p_recebido: x.id });
    if (p.error) resumo.erros.push(`recebido ${x.id}: ${p.error.message.slice(0, 200)}`);
  }

  const upd = await db
    .from("at_email_contas")
    .update({ ultima_leitura_em: new Date().toISOString(), cursor: String(cursor), status: "conectado", ultimo_erro: resumo.erros[0] ?? null })
    .eq("id", c.id);
  if (upd.error) throw new Error(upd.error.message);
  return resumo;
}

interface Envio {
  acaoId: number;
  ticketId: number;
  texto: string;
  html: string | null;
  assunto: string;
  para: string | null;
  cc: string[];
  contaId: number;
  contaEmail: string;
  remetente: string;
  exibirRemetente: boolean;
  responderPara: string | null;
  assinatura: string | null;
  raiz: string | null;
  ultimaRecebida: string | null;
  threadGmail: string | null;
}

const escaparHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** F5: respostas públicas pendentes dos tickets de e-mail. */
async function enviarPendentes(db: AdminClient, app: { clientId: string; clientSecret: string }, contaId?: number) {
  const { data, error } = await db.rpc("ch_email_para_enviar", { p_limite: 20 });
  if (error) throw fromRpcError(error);
  const itens = ((data ?? []) as Envio[]).filter((x) => !contaId || x.contaId === contaId);
  const tokens = new Map<number, Promise<string>>();
  const resumo = { enviados: 0, falhas: 0 };
  for (const x of itens) {
    let ok = false;
    let erro: string | null = null;
    const messageId = novoMessageId(x.contaEmail.split("@")[1] ?? "imobsystems.com.br");
    try {
      if (!x.para || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x.para)) throw new Error("O ticket não tem o e-mail do solicitante.");
      if (!tokens.has(x.contaId)) tokens.set(x.contaId, tokenDa(db, app, x.contaId));
      const token = await tokens.get(x.contaId)!;
      const base = x.assunto.replace(/\[#\d+\]\s*/g, "").replace(/^\s*((re|res|fw|fwd|enc)\s*:\s*)+/i, "").trim();
      const assinatura = x.assinatura?.trim() ? x.assinatura.trim() : "";
      const referencias = [...new Set([x.raiz, x.ultimaRecebida].filter(Boolean))].join(" ") || null;
      const raw = montarMensagem({
        de: x.contaEmail,
        deNome: x.exibirRemetente ? x.remetente : null,
        para: [x.para],
        cc: (x.cc ?? []).filter((e) => e !== x.para && e !== x.contaEmail),
        responderPara: x.responderPara,
        assunto: `Re: [#${x.ticketId}] ${base}`,
        texto: assinatura ? `${x.texto}\n\n--\n${assinatura}` : x.texto,
        html: x.html ? (assinatura ? `${x.html}<br><br>--<br>${escaparHtml(assinatura).replace(/\n/g, "<br>")}` : x.html) : null,
        inReplyTo: x.ultimaRecebida,
        referencias,
        messageId,
      });
      await enviarGmail(fetch, token, raw, x.threadGmail);
      ok = true;
      resumo.enviados++;
    } catch (err) {
      erro = msg(err);
      resumo.falhas++;
    }
    const r = await db.rpc("ch_email_envio_resultado", { p_acao: x.acaoId, p_ok: ok, p_message_id: ok ? messageId : null, p_erro: erro });
    if (r.error) console.error(JSON.stringify({ evento: "email.envio_resultado_falhou", acao: x.acaoId, erro: r.error.message }));
  }
  return resumo;
}

/** Um ciclo de leitura e envio numa empresa (db já preso a ela). */
async function ciclo(db: AdminClient, contaId?: number) {
  let consulta = db
    .from("at_email_contas")
    .select("id, email, oauth_email, pasta, ler_desde, cursor, marcar_lido, ignorar_remetentes")
    .eq("habilitada", true)
    .eq("receber_habilitado", true)
    .eq("modo", "oauth_google")
    .not("oauth_segredo_id", "is", null);
  if (contaId) consulta = consulta.eq("id", contaId);
  const contas = await consulta;
  if (contas.error) throw new Error(contas.error.message);

  const app = await appOAuth(db);
  const leitura: Record<string, unknown> = {};
  for (const c of (contas.data ?? []) as Conta[]) {
    try {
      leitura[c.email] = await lerConta(db, await tokenDa(db, app, c.id), c);
    } catch (err) {
      leitura[c.email] = { erro: msg(err) };
      await db.from("at_email_contas").update({ status: "falha", ultimo_erro: msg(err).slice(0, 1000) }).eq("id", c.id);
    }
  }
  const envio = await enviarPendentes(db, app, contaId);
  return { leitura, envio };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ code: "INVALID_INPUT", message: "Método não suportado." }, 405);
  try {
    const corpo = (await req.json().catch(() => ({}))) as { acao?: string; contaId?: number };
    if ((corpo.acao ?? "ciclo") !== "ciclo") throw new PortalError("INVALID_INPUT", `Ação inválida: ${corpo.acao}`);
    const contaId = Number(corpo.contaId ?? 0) || undefined;

    // Quem chama: o pg_cron (chave do Vault), que roda em todas as empresas, ou a supervisão geral logada
    // ("Ler agora"), só na empresa dela.
    const chave = await clienteServico().rpc("at_email_cron_chave");
    if (iguais(req.headers.get("x-atendimento-chave") ?? "", (chave.data as string | null) ?? "")) {
      const resultado = await paraCadaEmpresa((db) => ciclo(db));
      console.log(JSON.stringify({ evento: "email.ciclo", resultado }));
      return json(resultado);
    }

    const { caller, admin } = await portalContext(req);
    const [perfil, sup] = await Promise.all([
      admin.rpc("perfil_de", { p_usuario: caller.id }),
      admin.rpc("tem_permissao_de", { p_usuario: caller.id, p_permissao: "gestao_atendimento_supervisao" }),
    ]);
    if (!(perfil.data === "super_admin" || sup.data === true)) throw new PortalError("FORBIDDEN", "Só a supervisão geral lê as caixas agora.", 403);
    const resultado = await ciclo(admin, contaId);
    console.log(JSON.stringify({ evento: "email.ciclo", resultado }));
    return json(resultado);
  } catch (error) {
    return errorResponse(error);
  }
});
