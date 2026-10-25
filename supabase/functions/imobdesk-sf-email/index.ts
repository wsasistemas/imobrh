// Solicitações Financeiras (Fase 3): envia os e-mails da fila sf_email_fila (aprovação pendente, devolução, conferência,
// lembretes e vencimentos). Chamada pelo pg_cron a cada 5 min (job imobdesk-sf-email), sem JWT: a autenticação
// é o cabeçalho x-atendimento-chave (mesma chave do Vault do e-mail dos tickets).
//
// Remetente: a conta padrão (Gmail autorizado) do setor marcado como financeiro em Setores e números › Central Email.
// Sem conta configurada, os e-mails continuam na fila (o aviso no sino do portal já foi dado) até a conta existir.
// Link no texto: caminhos "/financeiro/..." ganham o endereço do portal quando a variável PORTAL_URL estiver definida.

import { clienteServico, paraCadaEmpresa } from "../_shared/empresa.ts";
import { corsHeaders, errorResponse, fromRpcError, json, PortalError, type AdminClient } from "../_shared/portal.ts";
import { APP_GOOGLE_AUSENTE, appGoogleDe, enviarGmail, tokenPorRefresh } from "../_shared/email/gmail.ts";
import { montarMensagem, novoMessageId } from "../_shared/email/mime.ts";

interface Fila {
  conta: { id: number; email: string; remetente: string } | null;
  itens: { id: number; para: string; assunto: string; texto: string }[];
}

/** Compara sem atalho (tempo constante para tamanhos iguais). */
function iguais(a: string, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  let dif = 0;
  for (let i = 0; i < a.length; i++) dif |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return dif === 0;
}

const msg = (e: unknown) => String(e instanceof Error ? e.message : e);

async function token(db: AdminClient, contaId: number): Promise<string> {
  const app = await appGoogleDe(async () => {
    const { data, error } = await db.rpc("at_google_oauth_ler");
    if (error) throw fromRpcError(error);
    return (data as { client_id: string | null; client_secret: string | null }[] | null)?.[0];
  });
  if (!app) throw new PortalError("INTEGRATION_NOT_CONFIGURED", APP_GOOGLE_AUSENTE);
  const refresh = await db.rpc("at_email_oauth_token", { p_conta: contaId });
  if (refresh.error) throw fromRpcError(refresh.error);
  if (!refresh.data) throw new Error("A caixa do Financeiro ainda não foi autorizada (Central Email › Autorizar com Gmail).");
  return tokenPorRefresh(fetch, { ...app, refreshToken: refresh.data as string });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ code: "INVALID_INPUT", message: "Método não suportado." }, 405);
  try {
    const chave = await clienteServico().rpc("at_email_cron_chave");
    if (!iguais(req.headers.get("x-atendimento-chave") ?? "", (chave.data as string | null) ?? "")) {
      throw new PortalError("FORBIDDEN", "Chamada não autorizada.", 403);
    }
    // Cada empresa envia a própria fila pela caixa do Financeiro dela.
    return json(await paraCadaEmpresa((db) => enviarFila(db)));
  } catch (error) {
    return errorResponse(error);
  }
});

async function enviarFila(db: AdminClient) {
  const { data, error } = await db.rpc("sf_email_para_enviar", { p_limite: 30 });
  if (error) throw fromRpcError(error);
  const fila = data as Fila;
  if (!fila.itens.length) return { enviados: 0, falhas: 0 };
  if (!fila.conta) {
    console.log(JSON.stringify({ evento: "sf.email.sem_conta", pendentes: fila.itens.length }));
    return { enviados: 0, falhas: 0, pendentes: fila.itens.length, aviso: "Sem conta de e-mail no setor financeiro." };
  }

  const portal = (Deno.env.get("PORTAL_URL") ?? "").replace(/\/+$/, "");
  const acesso = await token(db, fila.conta.id);
  const resumo = { enviados: 0, falhas: 0 };
  for (const x of fila.itens) {
    let ok = false;
    let erro: string | null = null;
    try {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x.para)) throw new Error("E-mail do destinatário inválido.");
      const texto = portal ? x.texto.replace(/(^|\s)(\/financeiro\/\S+)/g, (_m, a: string, c: string) => `${a}${portal}${c}`) : x.texto;
      const raw = montarMensagem({
        de: fila.conta.email,
        deNome: fila.conta.remetente,
        para: [x.para],
        assunto: x.assunto,
        texto,
        messageId: novoMessageId(fila.conta.email.split("@")[1] ?? "imobsystems.com.br"),
      });
      await enviarGmail(fetch, acesso, raw);
      ok = true;
      resumo.enviados++;
    } catch (e) {
      erro = msg(e);
      resumo.falhas++;
    }
    const r = await db.rpc("sf_email_resultado", { p_id: x.id, p_ok: ok, p_erro: erro });
    if (r.error) console.error(JSON.stringify({ evento: "sf.email.resultado_falhou", id: x.id, erro: r.error.message }));
  }
  console.log(JSON.stringify({ evento: "sf.email.ciclo", ...resumo }));
  return resumo;
}
