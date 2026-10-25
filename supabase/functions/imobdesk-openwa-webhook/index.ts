// Webhook do OpenWA (opção A do atendimento). Chamado pelo OpenWA, sem JWT: a autenticação é a assinatura
// X-OpenWA-Signature (HMAC-SHA256 do corpo bruto com o segredo do Vault, cadastrado pela ação openwa_webhook).
//   privado com o número do sistema → at_whatsapp_receber (identificação, fila, ticket, repasse)
//   grupo interno de atendentes     → at_grupo_receber (resposta citando o pedido vai ao colaborador)
//   digitada no celular do número   → at_whatsapp_propria (resposta do atendente; "RESOLVIDO" encerra resolvendo)
// Depois envia na hora o que ficou pendente (resposta automática, repasse). Idempotente pelo idempotencyKey.
// Multiempresa: a empresa sai da sessão do OpenWA (o número dela em Setores e números); sem empresa, só log.

import { despachar } from "../_shared/atendimento/despacho.ts";
import { clienteDaEmpresa, clienteServico, empresaPor } from "../_shared/empresa.ts";
import { assinaturaValida, baixarMidiaOpenwa, bytesDeBase64, caminhoMidia, lerEventoOpenwa } from "../_shared/atendimento/openwa.ts";

const BUCKET = "imobdesk-atendimento-whatsapp";
const MIDIA_MAX = 15 * 1_048_576;

const resposta = (status: number, corpo: Record<string, unknown>) =>
  new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return resposta(405, { erro: "Método não suportado." });
  if (!Deno.env.get("SUPABASE_URL") || !Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")) {
    return resposta(500, { erro: "Função sem configuração do Supabase." });
  }
  type Credencial = { url: string | null; chave: string | null; webhook_segredo: string | null };

  // Corpo bruto ANTES do JSON.parse: a assinatura é sobre os bytes recebidos. O segredo é um só para o app.
  const bruto = await req.text();
  const geral = await clienteServico().rpc("at_ler_credencial_openwa");
  const segredo = (geral.data as Credencial[] | null)?.[0]?.webhook_segredo ?? "";
  if (!(await assinaturaValida(segredo, bruto, req.headers.get("x-openwa-signature")))) return resposta(401, { erro: "Assinatura inválida." });

  let envelope: unknown;
  try {
    envelope = JSON.parse(bruto);
  } catch {
    return resposta(400, { erro: "Corpo inválido." });
  }
  const ev = lerEventoOpenwa(envelope);
  const e = envelope as Record<string, unknown>;

  const empresaId = ev.sessao ? await empresaPor("empresa_por_sessao_openwa", { p_sessao: ev.sessao }) : null;
  if (!empresaId) {
    console.log(JSON.stringify({ evento: "openwa.webhook_sem_empresa", sessao: ev.sessao ?? null }));
    return resposta(200, { ok: true, ignorado: "Sessão sem empresa no Imobdesk." });
  }
  const db = clienteDaEmpresa(empresaId);
  const cred = await db.rpc("at_ler_credencial_openwa");
  const credLinha = (cred.data as Credencial[] | null)?.[0];

  // Chave geral desligada pelo administrador da empresa: não grava nem processa nada (200 para o OpenWA não reenviar).
  const ligado = await db.rpc("at_openwa_ligado");
  if (ligado.data === false) return resposta(200, { ok: true, ignorado: "WhatsApp OpenWA desligado" });

  const ins = await db
    .from("at_eventos_openwa")
    .insert({ chave: ev.chave, evento: String(e.event ?? "?"), sessao: ev.sessao, payload: envelope as Record<string, unknown> })
    .select("id")
    .single();
  // 23505 = o OpenWA reenviou o mesmo evento (retry): já foi tratado.
  if (ins.error?.code === "23505") return resposta(200, { ok: true, duplicado: true });
  if (ins.error) {
    console.error(JSON.stringify({ evento: "openwa.webhook_falhou", erro: ins.error.message }));
    return resposta(500, { erro: "Falha ao gravar o evento." });
  }

  let resultado: unknown = { estado: "ignorado", motivo: ev.tipo === "ignorado" ? ev.motivo : null };
  try {
    if (ev.tipo === "privada") {
      // Print/arquivo: guarda no Storage (veio em base64 no webhook ou baixa pela API do OpenWA).
      let arquivo: Record<string, unknown> | null = null;
      if (ev.midia) {
        arquivo = { nome: ev.midia.nome ?? `[${ev.midia.tipo}]`, mime: ev.midia.mime };
        try {
          const bytes = ev.midia.data
            ? bytesDeBase64(ev.midia.data)
            : await baixarMidiaOpenwa(fetch, credLinha?.url ?? "", credLinha?.chave ?? "", ev.sessao, ev.midia.chatId, ev.externoId, MIDIA_MAX);
          if (bytes.byteLength > MIDIA_MAX) throw new Error("arquivo maior que 15 MB");
          const path = caminhoMidia(ev.sessao, ev.externoId, ev.midia.mime);
          const up = await db.storage.from(BUCKET).upload(path, bytes, { contentType: ev.midia.mime, upsert: true });
          if (up.error) throw new Error(up.error.message);
          arquivo = { ...arquivo, bucket: BUCKET, path, tamanho: bytes.byteLength };
        } catch (err) {
          arquivo = { ...arquivo, erro: String(err instanceof Error ? err.message : err).slice(0, 200) };
        }
      }
      const r = await db.rpc("at_whatsapp_receber", {
        p: {
          canal: "openwa",
          sessao: ev.sessao,
          de: ev.de,
          nome: ev.nome,
          texto: ev.texto,
          tipo: ev.midia?.tipo ?? "texto",
          arquivo,
          externoId: ev.externoId,
        },
      });
      if (r.error) throw new Error(r.error.message);
      resultado = r.data;
      const conversaId = (r.data as { conversaId?: number } | null)?.conversaId ?? null;
      if (conversaId) await despachar(db, { conversaId, limite: 10 });
    } else if (ev.tipo === "grupo") {
      const r = await db.rpc("at_grupo_receber", {
        p: { sessao: ev.sessao, grupo: ev.grupo, autor: ev.autor, texto: ev.texto, citadoId: ev.citadoId, externoId: ev.externoId },
      });
      if (r.error) throw new Error(r.error.message);
      resultado = r.data;
      // Resposta ao colaborador + confirmação/dica no grupo (a dica não tem conversa).
      await despachar(db, { limite: 10 });
    } else if (ev.tipo === "propria") {
      const r = await db.rpc("at_whatsapp_propria", { p: { sessao: ev.sessao, para: ev.para, texto: ev.texto, externoId: ev.externoId } });
      if (r.error) throw new Error(r.error.message);
      resultado = r.data;
      const conversaId = (r.data as { conversaId?: number } | null)?.conversaId ?? null;
      if (conversaId) await despachar(db, { conversaId, limite: 10 });
    }
  } catch (err) {
    resultado = { estado: "erro", erro: String(err instanceof Error ? err.message : err).slice(0, 500) };
    console.error(JSON.stringify({ evento: "openwa.processar_falhou", ...(resultado as Record<string, unknown>) }));
  }
  // Evento que não é atendimento (ex.: conversa pessoal do dono do número) não guarda o conteúdo.
  const ignorado = ev.tipo === "ignorado" || ["ignorado", "eco"].includes(String((resultado as { estado?: string } | null)?.estado ?? ""));
  await db.from("at_eventos_openwa").update({ resultado, ...(ignorado ? { payload: {} } : {}) }).eq("id", ins.data.id);
  return resposta(200, { ok: true });
});
