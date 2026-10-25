// Webhook da Zenvia (assinaturas MESSAGE e MESSAGE_STATUS), um para os números de todos os setores.
// Chamado pela Zenvia, sem JWT: a autenticação é o cabeçalho x-atendimento-chave (chave no Vault).
//
// F3 (06/10/2026): grava o evento cru em at_eventos_zenvia (idempotente por tipo + id da Zenvia) e atualiza
// o status das mensagens enviadas. Fase 2 do chat (09/10/2026): a mensagem recebida vai para at_whatsapp_receber
// (identificação, fila, ticket) e o que ficou pendente (resposta automática) sai na hora pelo despachante.
// Multiempresa: a empresa sai do número que recebeu (mensagem) ou da mensagem enviada (status); evento sem
// empresa (número que não está em nenhum setor) só vai para o log.

import { despachar } from "../_shared/atendimento/despacho.ts";
import { clienteDaEmpresa, clienteServico, empresaPor } from "../_shared/empresa.ts";
import { lerEvento } from "../_shared/atendimento/zenvia.ts";

const resposta = (status: number, corpo: Record<string, unknown>) =>
  new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json" } });

/** Compara sem atalho (tempo constante para tamanhos iguais). */
function iguais(a: string, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  let dif = 0;
  for (let i = 0; i < a.length; i++) dif |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return dif === 0;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return resposta(405, { erro: "Método não suportado." });
  if (!Deno.env.get("SUPABASE_URL") || !Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")) {
    return resposta(500, { erro: "Função sem configuração do Supabase." });
  }

  // A chave do webhook é uma só para o app; o token de cada empresa fica na configuração dela.
  const cred = await clienteServico().rpc("at_ler_credencial_zenvia");
  const chave = (cred.data as { webhook_chave: string | null }[] | null)?.[0]?.webhook_chave ?? "";
  if (!iguais(req.headers.get("x-atendimento-chave") ?? "", chave)) return resposta(401, { erro: "Chave inválida." });

  const payload = await req.json().catch(() => null);
  if (!payload || typeof payload !== "object") return resposta(400, { erro: "Corpo inválido." });
  const evento = lerEvento(payload);
  const p = payload as Record<string, unknown>;
  const m = (p.message ?? {}) as Record<string, unknown>;

  const empresaId = evento.tipo === "mensagem"
    ? await empresaPor("empresa_por_numero", { p_numero: evento.para })
    : evento.tipo === "status"
    ? await empresaPor("empresa_por_mensagem_zenvia", { p_zenvia_id: evento.zenviaId })
    : null;
  if (!empresaId) {
    console.log(JSON.stringify({ evento: "atendimento.webhook_sem_empresa", tipo: String(p.type ?? "?"), detalhe: evento.tipo }));
    return resposta(200, { ok: true, ignorado: "Evento sem empresa no Imobdesk." });
  }
  const db = clienteDaEmpresa(empresaId);

  const zenviaId = evento.tipo === "ignorado" ? (String(p.messageId ?? m.id ?? p.id ?? "") || null) : evento.zenviaId || null;
  const ins = await db.from("at_eventos_zenvia").insert({
    tipo: String(p.type ?? "?"),
    zenvia_id: zenviaId,
    para: evento.tipo === "mensagem" ? evento.para.replace(/\D/g, "") : null,
    payload,
    processado: evento.tipo !== "mensagem",
    erro: evento.tipo === "ignorado" ? evento.motivo : null,
  });
  // 23505 = a Zenvia reenviou o mesmo evento: já foi gravado.
  if (ins.error && ins.error.code !== "23505") {
    console.error(JSON.stringify({ evento: "atendimento.webhook_falhou", erro: ins.error.message }));
    return resposta(500, { erro: "Falha ao gravar o evento." });
  }

  if (evento.tipo === "status") {
    await db.from("at_mensagens").update({ status: evento.status, erro: evento.erro }).eq("zenvia_id", evento.zenviaId);
  }
  if (evento.tipo === "mensagem" && !ins.error) {
    const arquivo = evento.arquivos[0] ?? null;
    const tipo = !arquivo ? "texto" : arquivo.mime.startsWith("image/") ? "imagem" : arquivo.mime.startsWith("audio/") ? "audio" : arquivo.mime.startsWith("video/") ? "video" : "arquivo";
    const r = await db.rpc("at_whatsapp_receber", {
      p: {
        canal: "zenvia",
        para: evento.para,
        de: evento.de,
        nome: evento.nome,
        texto: evento.textos.join("\n"), // a legenda do arquivo já vem em textos
        tipo,
        arquivo: arquivo ? { nome: arquivo.nome ?? `[${tipo}]`, url: arquivo.url, mime: arquivo.mime } : null,
        externoId: evento.zenviaId,
      },
    });
    await db.from("at_eventos_zenvia").update({ processado: !r.error, erro: r.error ? r.error.message.slice(0, 500) : null })
      .eq("tipo", String(p.type ?? "?")).eq("zenvia_id", zenviaId);
    const conversaId = (r.data as { conversaId?: number } | null)?.conversaId ?? null;
    if (conversaId) {
      await despachar(db, { conversaId, limite: 10 }).catch((err) =>
        console.error(JSON.stringify({ evento: "atendimento.despacho_falhou", erro: String(err).slice(0, 300) })));
    }
  }
  return resposta(200, { ok: true, duplicado: ins.error?.code === "23505" });
});
