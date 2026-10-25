// Despachante do WhatsApp: envia o que o banco deixou pendente (at_whatsapp_reservar) pelo canal do número —
// Zenvia (API oficial) ou OpenWA (opção A: privado + grupo interno) — e devolve o resultado
// (at_whatsapp_envio_resultado). Usado pela Edge imobdesk-whatsapp (cron e "enviar agora") e pelos
// webhooks (resposta automática na hora). A reserva de 2 min no banco evita envio duplo entre chamadas.

import { enviarTexto } from "./zenvia.ts";
import { comAutor, enviarImagemOpenwa, enviarTextoOpenwa, type Fetch } from "./openwa.ts";

// deno-lint-ignore no-explicit-any
export type Db = any;

interface MensagemPendente {
  id: number;
  texto: string | null;
  autor: "atendente" | "auto" | "sistema" | "cliente";
  autorNome: string | null;
  telefone: string;
  canal: "zenvia" | "openwa";
  numero: string;
  sessao: string | null;
  setor: string | null;
}

interface RepassePendente {
  id: number;
  texto: string;
  citar: string | null;
  sessao: string | null;
  grupo: string | null;
  /** Print do pedido (Storage): vai como imagem com o texto na legenda. */
  arquivo: { bucket?: string; path?: string; mime?: string } | null;
}

interface Credenciais {
  zenviaToken: string | null;
  openwa: { url: string; chave: string } | null;
}

async function credenciais(db: Db): Promise<Credenciais> {
  const [z, o] = await Promise.all([db.rpc("at_ler_credencial_zenvia"), db.rpc("at_ler_credencial_openwa")]);
  const zr = (z.data as { token: string | null }[] | null)?.[0];
  const or = (o.data as { url: string | null; chave: string | null }[] | null)?.[0];
  return { zenviaToken: zr?.token ?? null, openwa: or?.url && or.chave ? { url: or.url, chave: or.chave } : null };
}

export interface ResumoDespacho {
  mensagens: number;
  repasses: number;
  falhas: number;
}

/** Reserva e envia até `limite` mensagens e repasses (de uma conversa, se informada). */
export async function despachar(db: Db, opcoes: { conversaId?: number | null; limite?: number; fetchImpl?: Fetch } = {}): Promise<ResumoDespacho> {
  const f = opcoes.fetchImpl ?? fetch;
  const { data, error } = await db.rpc("at_whatsapp_reservar", { p_limite: opcoes.limite ?? 30, p_conversa: opcoes.conversaId ?? null });
  if (error) throw new Error(`reservar: ${error.message}`);
  const msgs = ((data as { mensagens?: MensagemPendente[] })?.mensagens ?? []) as MensagemPendente[];
  const reps = ((data as { repasses?: RepassePendente[] })?.repasses ?? []) as RepassePendente[];
  const resumo: ResumoDespacho = { mensagens: 0, repasses: 0, falhas: 0 };
  if (msgs.length === 0 && reps.length === 0) return resumo;
  const cred = await credenciais(db);

  const resultado = async (p: Record<string, unknown>) => {
    const r = await db.rpc("at_whatsapp_envio_resultado", { p });
    if (r.error) console.error(JSON.stringify({ evento: "whatsapp.resultado_falhou", erro: r.error.message, id: p.id }));
    if (p.ok) {
      if (p.tipo === "repasse") resumo.repasses += 1;
      else resumo.mensagens += 1;
    } else resumo.falhas += 1;
  };

  for (const m of msgs) {
    const texto = (m.texto ?? "").trim();
    if (!texto) {
      await resultado({ tipo: "mensagem", id: m.id, ok: false, erro: "Mensagem sem texto (envio de arquivo pelo portal ainda não existe)." });
      continue;
    }
    if (m.canal === "openwa") {
      if (!cred.openwa || !m.sessao) {
        await resultado({ tipo: "mensagem", id: m.id, ok: false, erro: "OpenWA não configurado (URL, API key ou sessão do número)." });
        continue;
      }
      const corpo = m.autor === "atendente" ? comAutor(texto, m.autorNome, m.setor) : texto;
      const r = await enviarTextoOpenwa(f, cred.openwa.url, cred.openwa.chave, m.sessao, m.telefone, corpo);
      await resultado({ tipo: "mensagem", canal: "openwa", id: m.id, ok: r.ok, externoId: r.id, erro: r.erro });
    } else {
      if (!cred.zenviaToken) {
        await resultado({ tipo: "mensagem", id: m.id, ok: false, erro: "Zenvia não configurada (token)." });
        continue;
      }
      const r = await enviarTexto(f, cred.zenviaToken, m.numero, m.telefone, texto);
      await resultado({ tipo: "mensagem", canal: "zenvia", id: m.id, ok: r.ok, externoId: r.zenviaId, erro: r.erro });
    }
  }

  for (const x of reps) {
    if (!cred.openwa || !x.sessao || !x.grupo) {
      await resultado({ tipo: "repasse", id: x.id, ok: false, erro: "OpenWA não configurado (URL, API key, sessão ou grupo interno)." });
      continue;
    }
    let r = { ok: false, status: 0, id: null as string | null, erro: null as string | null };
    if (x.arquivo?.bucket && x.arquivo.path && (x.arquivo.mime ?? "").startsWith("image/")) {
      // Link assinado de 1 h: o OpenWA baixa a imagem do bucket privado e manda com o texto na legenda.
      const assinado = await db.storage.from(x.arquivo.bucket).createSignedUrl(x.arquivo.path, 3600);
      if (assinado.data?.signedUrl) {
        r = await enviarImagemOpenwa(f, cred.openwa.url, cred.openwa.chave, x.sessao, x.grupo, { url: assinado.data.signedUrl, mime: x.arquivo.mime! }, x.texto, x.citar);
      }
    }
    // Sem print (ou a imagem falhou): só o texto.
    if (!r.ok) r = await enviarTextoOpenwa(f, cred.openwa.url, cred.openwa.chave, x.sessao, x.grupo, x.texto, x.citar);
    // Citação que o WhatsApp não acha (mensagem antiga): manda sem citar.
    if (!r.ok && x.citar && (r.status === 400 || r.status === 404 || r.status === 501)) {
      r = await enviarTextoOpenwa(f, cred.openwa.url, cred.openwa.chave, x.sessao, x.grupo, x.texto);
    }
    await resultado({ tipo: "repasse", id: x.id, ok: r.ok, externoId: r.id, erro: r.erro });
  }
  return resumo;
}
