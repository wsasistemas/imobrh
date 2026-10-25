import { useQuery } from "@tanstack/react-query";
import { FileText, Image as ImageIcon, Paperclip } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "../../../lib/supabase";
import { DATA_SOURCE } from "../../configuracoes/services";
import "./Atendimento.css";

// Arquivos guardados no Storage (prints do WhatsApp em imobdesk-atendimento-whatsapp, anexos de e-mail em imobdesk-atendimento-email).
// Os buckets são privados: o link é assinado na hora (5 min) e só abre para quem a policy do bucket libera.

export interface AnexoStorage {
  nome?: string | null;
  mime?: string | null;
  path?: string | null;
  bucket?: string | null;
  url?: string | null;
  tamanho?: number | null;
  erro?: string | null;
}

const BUCKET_PADRAO = "imobdesk-atendimento-email";

async function linkAssinado(a: AnexoStorage): Promise<string | null> {
  if (a.url) return a.url;
  if (!a.path || DATA_SOURCE === "mock") return null;
  const { data, error } = await supabase.storage.from(a.bucket ?? BUCKET_PADRAO).createSignedUrl(a.path, 300);
  if (error) return null;
  return data.signedUrl;
}

async function abrir(a: AnexoStorage) {
  const url = await linkAssinado(a);
  if (url) window.open(url, "_blank", "noopener,noreferrer");
  else toast.error(a.erro ? `Arquivo não guardado: ${a.erro}` : "Não foi possível abrir o arquivo.");
}

/** Miniatura do print no chat; clique abre no tamanho original. */
export function ImagemAnexo({ a }: { a: AnexoStorage }) {
  const link = useQuery({ queryKey: ["storage", a.bucket, a.path, a.url], queryFn: () => linkAssinado(a), staleTime: 240_000, enabled: Boolean(a.path || a.url) });
  if (!link.data) {
    return (
      <button type="button" className="tk-link" onClick={() => void abrir(a)} disabled={!a.path && !a.url}>
        <ImageIcon size={14} aria-hidden="true" /> {a.nome ?? "imagem"}{a.erro ? ` (${a.erro})` : ""}
      </button>
    );
  }
  return (
    <a href={link.data} target="_blank" rel="noreferrer noopener" className="anx-img">
      <img src={link.data} alt={a.nome ?? "Print enviado pelo colaborador"} loading="lazy" />
    </a>
  );
}

/** Lista de anexos de uma ação do ticket (nome + abrir). */
export function ListaAnexos({ anexos }: { anexos: unknown[] }) {
  const lista = (anexos ?? []).filter((x): x is AnexoStorage => typeof x === "object" && x !== null);
  if (lista.length === 0) return null;
  return (
    <ul className="anx-lista" aria-label="Anexos">
      {lista.map((a, i) => (
        <li key={`${a.path ?? a.nome ?? ""}-${i}`}>
          {(a.mime ?? "").startsWith("image/") && (a.path || a.url) ? (
            <ImagemAnexo a={a} />
          ) : (
            <button type="button" className="tk-link" onClick={() => void abrir(a)} disabled={!a.path && !a.url}>
              {(a.mime ?? "").startsWith("image/") ? <ImageIcon size={13} aria-hidden="true" /> : a.mime === "application/pdf" ? <FileText size={13} aria-hidden="true" /> : <Paperclip size={13} aria-hidden="true" />}{" "}
              {a.nome ?? "arquivo"}
              {a.erro ? ` (não guardado: ${a.erro})` : ""}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
