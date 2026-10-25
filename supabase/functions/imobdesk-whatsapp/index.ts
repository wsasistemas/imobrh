// WhatsApp do atendimento (docs/PLANO-conversas-whatsapp-openwa.md, Fases 2 e 3). verify_jwt = false, duas portas:
//   1. pg_cron (job imobdesk-whatsapp-1min): cabeçalho x-atendimento-chave (Vault) → acao "ciclo";
//   2. pessoa logada (JWT do portal):
//        despachar {conversaId?}   envia na hora o que a ação deixou pendente (qualquer usuário do portal)
//        openwa_*                  administração do OpenWA (gestão do atendimento; criar sessão/grupo, parear: supervisão geral)
//
// O banco decide tudo (at_whatsapp_ciclo, at_conversa_acao…); aqui só entra e sai: Zenvia e OpenWA.

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, errorResponse, fromRpcError, json, PortalError, portalContext, type AdminClient } from "../_shared/portal.ts";
import { despachar } from "../_shared/atendimento/despacho.ts";
import { paraCadaEmpresa } from "../_shared/empresa.ts";
import { chamarOpenwa, iguais } from "../_shared/atendimento/openwa.ts";

const WEBHOOK = "imobdesk-openwa-webhook";

function servico(): AdminClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new PortalError("INTERNAL", "Função sem configuração do Supabase.", 500);
  return createClient(url, key, { db: { schema: "imobdesk" }, auth: { persistSession: false, autoRefreshToken: false } });
}

async function openwa(db: AdminClient): Promise<{ url: string; chave: string; segredo: string }> {
  const { data, error } = await db.rpc("at_ler_credencial_openwa");
  if (error) throw fromRpcError(error);
  const l = (data as { url: string | null; chave: string | null; webhook_segredo: string | null }[] | null)?.[0];
  if (!l?.url || !l.chave) throw new PortalError("INTEGRATION_NOT_CONFIGURED", "Salve a URL e a API key do OpenWA antes.");
  return { url: l.url, chave: l.chave, segredo: l.webhook_segredo ?? "" };
}

/** Resposta do OpenWA → erro do portal (a tela mostra a mensagem). */
function exigirOk<T>(r: { ok: boolean; erro: string | null; corpo?: unknown }): T {
  if (!r.ok) throw new PortalError("INVALID_INPUT", r.erro ?? "O OpenWA recusou o pedido.", 502);
  return r.corpo as T;
}

const sessaoValida = (s: unknown) => {
  const v = String(s ?? "").trim();
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(v)) throw new PortalError("INVALID_INPUT", "Sessão inválida.", 400, "sessao");
  return encodeURIComponent(v);
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ code: "INVALID_INPUT", message: "Método não suportado." }, 405);
  try {
    const base = servico();
    const corpo = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const acao = String(corpo.acao ?? "");

    // ---------- agendador ----------
    const chaveCron = req.headers.get("x-atendimento-chave");
    if (chaveCron) {
      const { data } = await base.rpc("at_whatsapp_cron_chave");
      if (!iguais(chaveCron, (data as string | null) ?? "")) throw new PortalError("UNAUTHENTICATED", "Agendador não autorizado.", 401);
      if (acao !== "ciclo") throw new PortalError("INVALID_INPUT", `Ação inválida para o agendador: ${acao}`);
      // Uma rodada por empresa, cada uma com os próprios números, filas e credenciais.
      return json(await paraCadaEmpresa(async (db) => {
        const ciclo = await db.rpc("at_whatsapp_ciclo");
        if (ciclo.error) console.error(JSON.stringify({ evento: "whatsapp.ciclo_falhou", erro: ciclo.error.message }));
        const envio = await despachar(db, { limite: 60 });
        return { ciclo: ciclo.data ?? null, envio };
      }));
    }

    // ---------- pessoa logada (só na empresa dela) ----------
    const { caller, admin } = await portalContext(req);
    const db = admin;
    if (acao === "despachar") {
      const conversaId = corpo.conversaId ? Number(corpo.conversaId) : null;
      return json(await despachar(db, { conversaId, limite: 20 }));
    }

    if (!acao.startsWith("openwa_")) throw new PortalError("INVALID_INPUT", `Ação inválida: ${acao}`);
    const [perfil, sup] = await Promise.all([
      admin.rpc("perfil_de", { p_usuario: caller.id }),
      admin.rpc("tem_permissao_de", { p_usuario: caller.id, p_permissao: "gestao_atendimento_supervisao" }),
    ]);
    const supervisao = perfil.data === "super_admin" || sup.data === true;
    if (!supervisao && !["openwa_grupos", "openwa_membros", "openwa_status"].includes(acao)) {
      throw new PortalError("FORBIDDEN", "Só a supervisão geral configura o OpenWA.", 403);
    }
    const ow = await openwa(db);

    switch (acao) {
      case "openwa_testar": {
        const saude = await chamarOpenwa(fetch, ow.url, ow.chave, "GET", "/health/ready");
        const sessoes = await chamarOpenwa(fetch, ow.url, ow.chave, "GET", "/sessions");
        const verificacao = {
          em: new Date().toISOString(),
          ok: saude.ok && sessoes.ok,
          erro: saude.ok ? sessoes.erro : saude.erro,
          sessoes: Array.isArray(sessoes.corpo) ? (sessoes.corpo as { id: string; name?: string; status?: string; phone?: string }[]).map((s) => ({ id: s.id, nome: s.name ?? null, status: s.status ?? null, telefone: s.phone ?? null })) : [],
        };
        await db.rpc("at_openwa_verificacao_salvar", { p: verificacao });
        return json(verificacao);
      }
      case "openwa_status": {
        const s = sessaoValida(corpo.sessao);
        return json(exigirOk(await chamarOpenwa(fetch, ow.url, ow.chave, "GET", `/sessions/${s}`)));
      }
      case "openwa_criar_sessao": {
        const nome = String(corpo.nome ?? "").trim();
        if (!/^[A-Za-z0-9 _-]{2,60}$/.test(nome)) throw new PortalError("INVALID_INPUT", "Nome da sessão: 2 a 60 letras, números, espaço, _ ou -.", 400, "nome");
        return json(exigirOk(await chamarOpenwa(fetch, ow.url, ow.chave, "POST", "/sessions", { name: nome })));
      }
      case "openwa_iniciar": {
        const s = sessaoValida(corpo.sessao);
        return json(exigirOk(await chamarOpenwa(fetch, ow.url, ow.chave, "POST", `/sessions/${s}/start`, {})));
      }
      case "openwa_qr": {
        const s = sessaoValida(corpo.sessao);
        const r = await chamarOpenwa(fetch, ow.url, ow.chave, "GET", `/sessions/${s}/qr`);
        // 400 = ainda não pronto ou já pareado: a tela mostra o status.
        return json({ qr: r.ok ? ((r.corpo as { qrCode?: string })?.qrCode ?? null) : null, erro: r.ok ? null : r.erro });
      }
      case "openwa_grupos": {
        const s = sessaoValida(corpo.sessao);
        return json(exigirOk(await chamarOpenwa(fetch, ow.url, ow.chave, "GET", `/sessions/${s}/groups`)));
      }
      case "openwa_membros": {
        const s = sessaoValida(corpo.sessao);
        const g = String(corpo.grupo ?? "");
        if (!g.endsWith("@g.us")) throw new PortalError("INVALID_INPUT", "Grupo inválido.", 400, "grupo");
        const info = exigirOk<{ participants?: { id: string; number?: string; name?: string; isAdmin?: boolean }[] }>(
          await chamarOpenwa(fetch, ow.url, ow.chave, "GET", `/sessions/${s}/groups/${encodeURIComponent(g)}`),
        );
        return json((info.participants ?? []).map((p) => ({ id: p.id, numero: (p.number ?? p.id.split("@")[0] ?? "").replace(/\D/g, ""), nome: p.name ?? null, admin: Boolean(p.isAdmin) })));
      }
      case "openwa_criar_grupo": {
        // Cria o grupo interno do número com o WhatsApp de cada atendente do setor e liga ao número.
        const numeroId = Number(corpo.numeroId);
        const n = await db.from("at_numeros").select("id, numero, setor_id, openwa_sessao, canal, at_setores(nome)").eq("id", numeroId).maybeSingle();
        if (n.error || !n.data) throw new PortalError("NOT_FOUND", "Número não encontrado.", 404);
        if (n.data.canal !== "openwa" || !n.data.openwa_sessao) throw new PortalError("INVALID_INPUT", "Salve o número como OpenWA, com a sessão, antes.");
        const numeroSistema = String(n.data.numero);
        const at = await db.from("at_atendentes").select("whatsapp").eq("setor_id", n.data.setor_id).not("whatsapp", "is", null);
        if (at.error) throw fromRpcError(at.error);
        const participantes = [...new Set((at.data ?? []).map((a) => String(a.whatsapp)).filter((w) => w && w !== numeroSistema))];
        if (participantes.length === 0) throw new PortalError("INVALID_INPUT", "Preencha o WhatsApp pessoal dos atendentes do setor antes de criar o grupo.");
        const setorNome = (n.data.at_setores as unknown as { nome: string } | null)?.nome ?? "setor";
        const nome = String(corpo.nome ?? "").trim() || `Atendimento ${setorNome} · interno`;
        const tentativa = await chamarOpenwa(fetch, ow.url, ow.chave, "POST", `/sessions/${encodeURIComponent(n.data.openwa_sessao)}/groups`, { name: nome.slice(0, 100), participants: participantes });
        // Engine whatsapp-web.js não cria grupo (o WhatsApp Web tirou a função interna; só o Baileys cria): o grupo é
        // criado no celular e o portal adiciona os atendentes (openwa_adicionar_atendentes).
        if (tentativa.status === 501) {
          throw new PortalError(
            "INVALID_INPUT",
            `Esta sessão do OpenWA (engine whatsapp-web.js) não consegue criar grupos. Crie no celular do número ${n.data.numero} um grupo chamado "${nome}" (com pelo menos um atendente), clique em "Atualizar grupos", escolha o grupo em "grupo interno", salve e use "Adicionar atendentes ao grupo".`,
            400,
          );
        }
        const criado = exigirOk<{ id?: string; name?: string }>(tentativa);
        if (!criado?.id) throw new PortalError("INVALID_INPUT", "O OpenWA não devolveu o id do grupo.");
        const up = await db.from("at_numeros").update({ grupo_interno: criado.id, grupo_interno_nome: criado.name ?? nome }).eq("id", numeroId);
        if (up.error) throw fromRpcError(up.error);
        await db.from("at_repasses").insert({
          numero_id: numeroId,
          tipo: "aviso",
          texto: `👋 Grupo de atendimento do setor ${setorNome}.
Cada pedido de suporte chega aqui como 🆕 *#ticket*. Para responder ao colaborador, toque e segure o pedido e escolha *Responder*.
Escreva *RESOLVIDO* respondendo ao pedido para fechar o chamado.`,
        });
        await despachar(db, { limite: 5 });
        return json({ grupo: criado.id, nome: criado.name ?? nome, participantes: participantes.length });
      }
      case "openwa_adicionar_atendentes": {
        // Coloca no grupo interno o WhatsApp de cada atendente do setor que ainda não está nele.
        const numeroId = Number(corpo.numeroId);
        const n = await db.from("at_numeros").select("id, numero, setor_id, openwa_sessao, grupo_interno").eq("id", numeroId).maybeSingle();
        if (n.error || !n.data) throw new PortalError("NOT_FOUND", "Número não encontrado.", 404);
        if (!n.data.openwa_sessao || !n.data.grupo_interno) throw new PortalError("INVALID_INPUT", "Escolha e salve o grupo interno do número antes.");
        const sessao = encodeURIComponent(n.data.openwa_sessao);
        const grupo = encodeURIComponent(n.data.grupo_interno);
        const info = exigirOk<{ participants?: { id: string; number?: string }[] }>(await chamarOpenwa(fetch, ow.url, ow.chave, "GET", `/sessions/${sessao}/groups/${grupo}`));
        const noGrupo = new Set((info.participants ?? []).map((x) => (x.number ?? x.id.split("@")[0] ?? "").replace(/\D/g, "")));
        const at = await db.from("at_atendentes").select("whatsapp").eq("setor_id", n.data.setor_id).not("whatsapp", "is", null);
        if (at.error) throw fromRpcError(at.error);
        const numeroSistema = String(n.data.numero);
        const todos = [...new Set((at.data ?? []).map((a) => String(a.whatsapp)).filter((w) => w && w !== numeroSistema))];
        if (todos.length === 0) throw new PortalError("INVALID_INPUT", "Preencha o WhatsApp pessoal dos atendentes do setor antes.");
        const faltam = todos.filter((w) => !noGrupo.has(w));
        if (faltam.length === 0) return json({ adicionados: 0, jaEstavam: todos.length, falhas: [] });
        const r = exigirOk<{ results?: { id: string; success: boolean; message?: string }[] }>(
          await chamarOpenwa(fetch, ow.url, ow.chave, "POST", `/sessions/${sessao}/groups/${grupo}/participants`, { participants: faltam }),
        );
        const res = r?.results ?? [];
        const falhas = res.filter((x) => !x.success).map((x) => ({ numero: x.id.split("@")[0], motivo: x.message ?? "recusado" }));
        return json({ adicionados: res.filter((x) => x.success).length, jaEstavam: todos.length - faltam.length, falhas });
      }
      case "openwa_webhook": {
        // Cadastra (ou atualiza) o webhook desta sessão apontando para o portal, com o segredo do Vault.
        // message.received: o que chega; message.sent: o que o dono do número digita no próprio celular.
        const s = sessaoValida(corpo.sessao);
        const destino = `${Deno.env.get("SUPABASE_URL")}/functions/v1/${WEBHOOK}`;
        const eventos = ["message.received", "message.sent"];
        const lista = await chamarOpenwa(fetch, ow.url, ow.chave, "GET", `/sessions/${s}/webhooks`);
        const existentes = Array.isArray(lista.corpo) ? (lista.corpo as { id?: string; url?: string; events?: string[] }[]) : [];
        const atual = existentes.find((w) => w.url === destino);
        if (atual?.id) {
          if (eventos.every((x) => atual.events?.includes(x))) return json({ criado: false, url: destino });
          exigirOk(await chamarOpenwa(fetch, ow.url, ow.chave, "PUT", `/sessions/${s}/webhooks/${encodeURIComponent(atual.id)}`, { events: eventos, secret: ow.segredo }));
          return json({ criado: false, atualizado: true, url: destino });
        }
        exigirOk(await chamarOpenwa(fetch, ow.url, ow.chave, "POST", `/sessions/${s}/webhooks`, {
          url: destino,
          events: eventos,
          secret: ow.segredo,
          retryCount: 3,
        }));
        return json({ criado: true, url: destino });
      }
    }
    throw new PortalError("INVALID_INPUT", `Ação inválida: ${acao}`);
  } catch (error) {
    return errorResponse(error);
  }
});
