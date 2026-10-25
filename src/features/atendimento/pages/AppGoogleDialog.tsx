import * as Dialog from "@radix-ui/react-dialog";
import { CheckCircle2, CircleAlert, Copy, KeyRound, X } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { edgeFunction } from "../../../config/app";
import { formatDateTime } from "../../../utils/dates";
import { ServiceError } from "../../configuracoes/services/types";
import { useAppGoogle, useSalvarAppGoogle } from "../hooks/useAtendimento";
import "./Atendimento.css";

/**
 * Central Email › Aplicativo do Google (super admin, uma vez). O ID do cliente e a chave secreta do aplicativo OAuth
 * do portal ficam no banco: a chave vai para o cofre (Vault) e nunca volta para a tela. Com ele salvo, cada conta
 * Google é vinculada pelo botão "Autorizar com Gmail".
 */
export function AppGoogleDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="card em-dlg">
          <div className="em-dlg__head">
            <span className="em-dlg__ic" aria-hidden="true"><KeyRound size={18} /></span>
            <div>
              <Dialog.Title>Aplicativo do Google</Dialog.Title>
              <Dialog.Description>Configurado uma vez. Depois, cada conta é vinculada no botão Autorizar com Gmail.</Dialog.Description>
            </div>
            <Dialog.Close className="icon-btn" aria-label="Fechar"><X size={16} /></Dialog.Close>
          </div>
          {open && <Form onDone={() => onOpenChange(false)} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Form({ onDone }: { onDone: () => void }) {
  const ids = useId();
  const app = useAppGoogle();
  const salvar = useSalvarAppGoogle();
  const [clientId, setClientId] = useState("");
  const [segredo, setSegredo] = useState("");
  const [erro, setErro] = useState<{ campo?: string; mensagem: string } | null>(null);
  const base = String(import.meta.env.VITE_SUPABASE_URL ?? "").replace(/\/+$/, "");
  const redirect = `${base || "https://<projeto>.supabase.co"}/functions/v1/${edgeFunction("google-oauth")}`;
  const configurado = !!app.data?.clientId;

  return (
    <form
      className="em-dlg__corpo"
      autoComplete="off"
      onSubmit={(e) => {
        e.preventDefault();
        setErro(null);
        salvar.mutate(
          { clientId: clientId.trim() || app.data?.clientId || "", clientSecret: segredo },
          {
            onSuccess: () => {
              toast.success("Aplicativo do Google salvo. A chave ficou guardada no cofre.");
              onDone();
            },
            onError: (er) => setErro(er instanceof ServiceError ? { campo: er.field, mensagem: er.message } : { mensagem: "Não foi possível salvar." }),
          },
        );
      }}
    >
      <span className="em-st-linha">
        {configurado ? <CheckCircle2 size={16} color="var(--success-fg)" aria-hidden="true" /> : <CircleAlert size={16} color="var(--warning-fg, #c2410c)" aria-hidden="true" />}
        <span>
          {app.isPending
            ? "Carregando…"
            : configurado
              ? <>Configurado: <b>{app.data?.clientId}</b>{app.data?.definidoEm ? ` em ${formatDateTime(app.data.definidoEm)}` : ""}. A chave secreta está guardada e não aparece de novo.</>
              : "Ainda não configurado."}
        </span>
      </span>

      <details className="em-dlg__ti">
        <summary>Como a TI obtém o ID e a chave (Google Cloud Console, uma vez)</summary>
        <ol>
          <li>APIs e serviços › ative a <b>Gmail API</b>.</li>
          <li>Tela de consentimento OAuth › tipo de usuário <b>Interno</b>. Nome: "Imobdesk".</li>
          <li>
            Credenciais › Criar credenciais › <b>ID do cliente OAuth</b> › <b>Aplicativo da Web</b>. Em URIs de redirecionamento autorizados, cole:
            <Copiar texto={redirect} />
          </li>
          <li>Copie o <b>ID do cliente</b> e a <b>Chave secreta</b> e cole abaixo.</li>
        </ol>
      </details>

      <Campo id={`${ids}-cid`} rotulo="ID do cliente" erro={erro?.campo === "clientId" ? erro.mensagem : null}>
        <input
          id={`${ids}-cid`}
          name="google_oauth_client_id"
          className="input"
          autoComplete="off"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          placeholder={app.data?.clientId ?? "000000000000-xxxxxxxx.apps.googleusercontent.com"}
        />
      </Campo>
      <Campo id={`${ids}-sec`} rotulo="Chave secreta do cliente" erro={erro?.campo === "clientSecret" ? erro.mensagem : null} ajuda="Fica oculta e guardada no cofre do banco; não aparece de novo.">
        <input
          id={`${ids}-sec`}
          name="google_oauth_client_secret"
          className="input"
          type="password"
          autoComplete="new-password"
          data-1p-ignore
          data-lpignore="true"
          value={segredo}
          onChange={(e) => setSegredo(e.target.value)}
          placeholder={configurado ? "Guardada. Digite só se for trocar." : "GOCSPX-…"}
        />
      </Campo>
      {erro && !erro.campo && <p className="field__error" role="alert">{erro.mensagem}</p>}

      <div className="em-dlg__acoes">
        <Dialog.Close asChild><button type="button" className="btn btn--outline">Cancelar</button></Dialog.Close>
        <button type="submit" className="btn btn--primary" disabled={salvar.isPending || (!clientId.trim() && !segredo)}>
          {salvar.isPending ? "Salvando…" : "Salvar"}
        </button>
      </div>
    </form>
  );
}

function Campo({ id, rotulo, erro, ajuda, children }: { id: string; rotulo: string; erro: string | null; ajuda?: string; children: ReactNode }) {
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>{rotulo}</label>
      {children}
      {erro && <span className="field__error" role="alert">{erro}</span>}
      {ajuda && <span className="field__help">{ajuda}</span>}
    </div>
  );
}

function Copiar({ texto }: { texto: string }) {
  return (
    <span className="em-copiar">
      <code>{texto}</code>
      <button type="button" className="btn btn--outline btn--sm" onClick={() => void navigator.clipboard.writeText(texto).then(() => toast.success("Copiado"))}>
        <Copy size={14} aria-hidden="true" />
        Copiar
      </button>
    </span>
  );
}
