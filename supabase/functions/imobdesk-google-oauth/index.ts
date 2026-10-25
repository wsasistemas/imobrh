// Retorno do "Autorizar com Gmail" (OAuth2 por conta, como a Movidesk). O Google redireciona o navegador para cá
// com ?code&state. Sem JWT (é o Google que chama): a segurança é o `state` de uso único criado pela ação
// oauth_iniciar de imobdesk-email, que guarda a conta, quem pediu e para onde voltar.
//
// Edge Function não serve HTML no domínio do Supabase: no fim, redireciona para a rota /oauth/google do portal,
// que avisa a janela que abriu a autorização e se fecha.

import { clienteDaEmpresa, empresaPor } from "../_shared/empresa.ts";
import { APP_GOOGLE_AUSENTE, appGoogleDe, testarGmailComToken, trocarCodigo } from "../_shared/email/gmail.ts";

const texto = (status: number, msg: string) => new Response(msg, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });

Deno.serve(async (req) => {
  if (req.method !== "GET") return texto(405, "Método não suportado.");
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return texto(500, "Função sem configuração do Supabase.");

  const q = new URL(req.url).searchParams;
  const state = q.get("state") ?? "";
  if (!/^[a-f0-9]{64}$/.test(state)) return texto(400, "Link inválido. Volte ao portal e clique em Autorizar com Gmail de novo.");
  // O state foi criado na empresa de quem pediu a autorização: o resto acontece nela.
  const empresaId = await empresaPor("empresa_por_estado_oauth", { p_state: state }).catch(() => null);
  if (!empresaId) return texto(400, "Este link expirou ou já foi usado. Volte ao portal e clique em Autorizar com Gmail de novo.");
  const db = clienteDaEmpresa(empresaId);
  const est = await db.rpc("at_email_oauth_estado_consumir", { p_state: state });
  const e = (est.data as { conta_id: number; usuario_id: string; retorno: string; email: string }[] | null)?.[0];
  if (est.error || !e) return texto(400, "Este link expirou ou já foi usado. Volte ao portal e clique em Autorizar com Gmail de novo.");

  const voltar = (params: Record<string, string>) =>
    new Response(null, { status: 302, headers: { Location: `${e.retorno}/oauth/google?${new URLSearchParams({ conta: String(e.conta_id), ...params }).toString()}` } });

  if (q.get("error")) {
    return voltar({ status: "erro", msg: q.get("error") === "access_denied" ? "A autorização foi cancelada no Google." : `O Google recusou: ${q.get("error")}` });
  }
  const code = q.get("code");
  if (!code) return voltar({ status: "erro", msg: "O Google não devolveu o código de autorização." });

  try {
    const app = await appGoogleDe(async () => {
      const r = await db.rpc("at_google_oauth_ler");
      return (r.data as { client_id: string | null; client_secret: string | null }[] | null)?.[0];
    });
    if (!app) return voltar({ status: "erro", msg: APP_GOOGLE_AUSENTE });
    const redirectUri = `${url}/functions/v1/imobdesk-google-oauth`;
    const t = await trocarCodigo(fetch, { ...app, code, redirectUri });
    if (!t.email) return voltar({ status: "erro", msg: "O Google não informou qual conta autorizou." });
    // Quem autoriza precisa entrar com a própria caixa da conta (não com o e-mail pessoal).
    if (t.email !== e.email.toLowerCase()) {
      return voltar({ status: "erro", msg: `Você entrou no Google como ${t.email}, mas a conta é ${e.email}. Saia e entre com ${e.email}.` });
    }
    if (!t.refreshToken) return voltar({ status: "erro", msg: "O Google não devolveu o token de acesso contínuo. Tente de novo." });

    const g = await db.rpc("at_email_oauth_gravar", { p_conta: e.conta_id, p_refresh: t.refreshToken, p_email: t.email, p_usuario: e.usuario_id });
    if (g.error) return voltar({ status: "erro", msg: g.error.message });

    // Já testa a caixa com o token que acabou de chegar.
    const conta = await db.from("at_email_contas").select("pasta").eq("id", e.conta_id).maybeSingle();
    const passos = await testarGmailComToken(fetch, async () => t.accessToken, { passo: "Autorização do Google (OAuth)", detalhe: `autorizado como ${t.email}` }, conta.data?.pasta ?? "INBOX");
    const ok = passos.every((p) => p.ok);
    await db
      .from("at_email_contas")
      .update({ verificacao: { em: new Date().toISOString(), ok, passos }, status: ok ? "conectado" : "falha", ultimo_erro: ok ? null : (passos.find((p) => !p.ok)?.detalhe ?? null) })
      .eq("id", e.conta_id);
    return voltar({ status: ok ? "ok" : "erro", email: t.email, ...(ok ? {} : { msg: passos.find((p) => !p.ok)?.detalhe ?? "Falha ao ler a caixa." }) });
  } catch (err) {
    console.error(JSON.stringify({ evento: "atendimento.google_oauth_falhou", conta: e.conta_id, erro: String(err).slice(0, 300) }));
    return voltar({ status: "erro", msg: String(err instanceof Error ? err.message : err).slice(0, 300) });
  }
});
