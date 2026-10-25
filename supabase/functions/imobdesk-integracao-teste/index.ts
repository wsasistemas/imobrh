// Edge Function: envia o e-mail de teste da integração (Resend) para o próprio super admin.
// A chave de API é lida do Vault aqui dentro e nunca volta para o navegador.
import { errorResponse, fromRpcError, json, PortalError, portalContext, readJson, corsHeaders } from "../_shared/portal.ts";

interface Body {
  key: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ code: "INVALID_INPUT", message: "Método não suportado." }, 405);

  try {
    const { caller, admin } = await portalContext(req);
    const { key } = await readJson<Body>(req);
    if (key !== "resend") throw new PortalError("NOT_FOUND", "Integração não encontrada.", 404);

    const perfil = await admin.rpc("perfil_de", { p_usuario: caller.id });
    if (perfil.error) throw fromRpcError(perfil.error);
    if (perfil.data !== "super_admin") {
      throw new PortalError("FORBIDDEN", "Somente super admin pode configurar integrações.", 403);
    }

    const integration = await admin.from("integracoes").select("ativo, remetente").eq("key", key).single();
    if (integration.error) throw new PortalError("NOT_FOUND", "Integração não encontrada.", 404);
    const secret = await admin.rpc("ler_segredo_integracao", { p_key: key });
    if (secret.error) throw fromRpcError(secret.error);

    let ok = false;
    let message: string;
    if (!integration.data.ativo || !secret.data) {
      message = "Integração inativa ou sem chave configurada.";
    } else {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${secret.data}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: integration.data.remetente,
          to: [caller.email],
          subject: "Teste de e-mail do Imobdesk",
          text: "Este é um e-mail de teste da integração do Imobdesk. Se chegou, está tudo certo.",
        }),
      });
      ok = response.ok;
      message = ok
        ? `E-mail de teste entregue para ${caller.email}.`
        : `O Resend recusou o envio (HTTP ${response.status}). Confira a chave e o remetente.`;
    }

    const result = await admin.rpc("registrar_teste_integracao", { p_ator: caller.id, p_key: key, p_ok: ok, p_mensagem: message });
    if (result.error) throw fromRpcError(result.error);
    return json(result.data);
  } catch (error) {
    return errorResponse(error);
  }
});
