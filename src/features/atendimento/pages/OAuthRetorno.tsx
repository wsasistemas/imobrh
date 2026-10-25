import { CheckCircle2, CircleAlert } from "lucide-react";
import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router";

export interface MensagemOAuth {
  tipo: "google-oauth";
  status: "ok" | "erro";
  conta: number;
  email: string | null;
  msg: string | null;
}

/**
 * Fim do "Autorizar com Gmail". O Google volta para a Edge Function, que redireciona para cá com o resultado.
 * Esta janela (aberta pela tela da conta) avisa quem a abriu e se fecha.
 */
export function OAuthRetorno() {
  const [q] = useSearchParams();
  const ok = q.get("status") === "ok";
  const msg = q.get("msg");
  const email = q.get("email");
  // Uma mensagem só, mesmo com o efeito rodando duas vezes (StrictMode em desenvolvimento).
  const enviado = useRef(false);

  useEffect(() => {
    const dados: MensagemOAuth = { tipo: "google-oauth", status: ok ? "ok" : "erro", conta: Number(q.get("conta") ?? 0), email, msg };
    if (window.opener && !window.opener.closed) {
      if (!enviado.current) window.opener.postMessage(dados, window.location.origin);
      enviado.current = true;
      if (ok) {
        const t = window.setTimeout(() => window.close(), 1500);
        return () => window.clearTimeout(t);
      }
    }
    return undefined;
  }, [ok, email, msg, q]);

  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24, background: "var(--page)" }}>
      <section className="card" style={{ maxWidth: 460, padding: 28, display: "grid", gap: 12, textAlign: "center", justifyItems: "center" }}>
        {ok ? <CheckCircle2 size={40} color="var(--success-fg)" aria-hidden="true" /> : <CircleAlert size={40} color="var(--danger-fg)" aria-hidden="true" />}
        <h1 style={{ margin: 0, fontSize: 20 }}>{ok ? "Conta autorizada" : "Não foi possível autorizar"}</h1>
        <p style={{ margin: 0, color: "var(--muted)" }}>
          {ok ? `O portal já pode ler e enviar e-mails como ${email ?? "esta conta"}. Esta janela fecha sozinha.` : (msg ?? "O Google não concluiu a autorização.")}
        </p>
        <button type="button" className="btn btn--outline" onClick={() => window.close()}>Fechar janela</button>
      </section>
    </main>
  );
}
