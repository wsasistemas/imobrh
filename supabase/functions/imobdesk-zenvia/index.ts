// Configurações › Integrações › Zenvia WhatsApp (só super admin). Uma conta (um token no Vault) para os
// números de todos os setores. Ações:
//   testar        confere o token, os números de cada setor (pelos templates da conta) e as assinaturas
//   assinar       cria as assinaturas MESSAGE e MESSAGE_STATUS apontando para o webhook (uma para todos)
//   enviar_teste  envia um texto de teste por um número de setor
// O token nunca sai daqui. Base: Vs_PipedriveMKT app_pipedrive-atendimento (05/10/2026), sem Pipedrive.

import { corsHeaders, errorResponse, fromRpcError, json, PortalError, portalContext, type AdminClient } from "../_shared/portal.ts";
import { conferirContaZenvia, enviarTexto, listarTemplates, telefoneZenvia, ZENVIA_API } from "../_shared/atendimento/zenvia.ts";

const WEBHOOK = "imobdesk-zenvia-webhook";

interface Assinatura {
  id?: string;
  eventType?: string;
  webhook?: { url?: string };
  status?: string;
}

async function exigirSuperAdmin(req: Request): Promise<AdminClient> {
  const { caller, admin } = await portalContext(req);
  const perfil = await admin.rpc("perfil_de", { p_usuario: caller.id });
  if (perfil.error) throw fromRpcError(perfil.error);
  if (perfil.data !== "super_admin") throw new PortalError("FORBIDDEN", "Só o super admin altera a conexão do WhatsApp.", 403);
  return admin;
}

async function credenciais(db: AdminClient): Promise<{ token: string; webhookChave: string | null }> {
  const { data, error } = await db.rpc("at_ler_credencial_zenvia");
  if (error) throw fromRpcError(error);
  const linha = (data as { token: string | null; webhook_chave: string | null }[] | null)?.[0];
  if (!linha?.token) throw new PortalError("INVALID_INPUT", "Salve o token da API Zenvia antes.");
  return { token: linha.token, webhookChave: linha.webhook_chave };
}

async function assinaturas(token: string): Promise<Assinatura[]> {
  try {
    const r = await fetch(`${ZENVIA_API}/subscriptions`, { headers: { "X-API-Token": token }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) return [];
    const corpo = await r.json();
    return Array.isArray(corpo) ? (corpo as Assinatura[]) : [];
  } catch {
    return [];
  }
}

const urlWebhook = () => `${Deno.env.get("SUPABASE_URL")}/functions/v1/${WEBHOOK}`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ code: "INVALID_INPUT", message: "Método não suportado." }, 405);
  try {
    const db = await exigirSuperAdmin(req);
    const corpo = (await req.json().catch(() => ({}))) as { acao?: string; numeroId?: number; telefone?: string };
    const acao = String(corpo.acao ?? "");
    const cred = await credenciais(db);

    if (acao === "testar") {
      const t = await listarTemplates(fetch, cred.token);
      const subs = await assinaturas(cred.token);
      const em = new Date().toISOString();
      const numeros = await db.from("at_numeros").select("id, numero").eq("ativo", true);
      if (numeros.error) throw fromRpcError(numeros.error);
      // Cada número precisa aparecer como remetente nos templates da conta deste token.
      for (const n of numeros.data ?? []) {
        const erro = t.ok ? conferirContaZenvia(t.templates, n.numero) : (t.erro ?? "Token recusado.");
        const naConta = t.ok && erro === null;
        const r = await db.from("at_numeros").update({ verificacao: { em, naConta, erro } }).eq("id", n.id);
        if (r.error) throw fromRpcError(r.error);
      }
      const verificacao = {
        em,
        tokenOk: t.ok,
        erroToken: t.erro,
        modelos: t.templates.length,
        assinaturaMensagem: subs.some((s) => s.eventType === "MESSAGE" && s.webhook?.url === urlWebhook()),
        assinaturaStatus: subs.some((s) => s.eventType === "MESSAGE_STATUS" && s.webhook?.url === urlWebhook()),
      };
      const r = await db.from("at_config").update({ verificacao }).eq("id", true);
      if (r.error) throw fromRpcError(r.error);
      return json(verificacao);
    }

    if (acao === "assinar") {
      if (!cred.webhookChave) throw new PortalError("INTERNAL", "Chave do webhook ausente no Vault.", 500);
      const url = urlWebhook();
      const existentes = await assinaturas(cred.token);
      const criadas: string[] = [];
      for (const [eventType, criteria] of [
        ["MESSAGE", { channel: "whatsapp", direction: "IN" }],
        ["MESSAGE_STATUS", { channel: "whatsapp" }],
      ] as const) {
        if (existentes.some((s) => s.eventType === eventType && s.webhook?.url === url)) continue;
        const r = await fetch(`${ZENVIA_API}/subscriptions`, {
          method: "POST",
          headers: { "X-API-Token": cred.token, "Content-Type": "application/json" },
          body: JSON.stringify({ eventType, webhook: { url, headers: { "x-atendimento-chave": cred.webhookChave } }, criteria }),
          signal: AbortSignal.timeout(20_000),
        });
        if (!r.ok) throw new PortalError("INTERNAL", `A Zenvia recusou a assinatura ${eventType}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`, 502);
        criadas.push(eventType);
      }
      return json({ criadas, url });
    }

    if (acao === "enviar_teste") {
      const numero = await db.from("at_numeros").select("numero, ativo").eq("id", Number(corpo.numeroId ?? 0)).maybeSingle();
      if (numero.error) throw fromRpcError(numero.error);
      if (!numero.data?.ativo) throw new PortalError("INVALID_INPUT", "Escolha um número ativo de um setor.");
      const para = telefoneZenvia(String(corpo.telefone ?? ""));
      if (!/^\d{12,13}$/.test(para)) throw new PortalError("INVALID_INPUT", "Telefone inválido (com DDD).");
      const r = await enviarTexto(fetch, cred.token, numero.data.numero, para, "Teste do Imobdesk. Se chegou, a conexão com a Zenvia está funcionando. ✅");
      return json({ ok: r.ok, zenviaId: r.zenviaId, erro: r.erro, aviso: "A entrega só é confirmada pelo status que a Zenvia devolve no webhook." });
    }

    throw new PortalError("INVALID_INPUT", `Ação inválida: ${acao}`);
  } catch (error) {
    return errorResponse(error);
  }
});
