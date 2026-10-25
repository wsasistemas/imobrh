import { useQuery } from "@tanstack/react-query";
import { FileText, Paperclip, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { supabase } from "../../lib/supabase";
import { solicitanteApi, MAX_ANEXOS, type Anexo } from "./service";

// Anexos do App do solicitante: cada arquivo sobe na hora para a pasta do usuário (bucket privado "imobdesk-solicitante"); o banco só
// aceita no chamado o que está nessa pasta. Remover antes de enviar apaga o arquivo do Storage.

interface Item {
  id: string;
  nome: string;
  preview: string | null;
  estado: "enviando" | "ok" | "erro";
  anexo?: Anexo;
}

export function useAnexos(usuarioId: string, desligado: boolean) {
  const [itens, setItens] = useState<Item[]>([]);
  const previews = useRef<string[]>([]);

  useEffect(
    () => () => {
      for (const url of previews.current) URL.revokeObjectURL(url);
    },
    [],
  );

  const adicionar = (lista: FileList | null) => {
    if (!lista || desligado) return;
    const arquivos = Array.from(lista);
    const vagas = MAX_ANEXOS - itens.length;
    if (arquivos.length > vagas) toast.error(`Envie no máximo ${MAX_ANEXOS} arquivos por mensagem.`);
    for (const file of arquivos.slice(0, Math.max(vagas, 0))) {
      const id = `${Date.now()}-${Math.random()}`;
      const preview = file.type.startsWith("image/") ? URL.createObjectURL(file) : null;
      if (preview) previews.current.push(preview);
      setItens((x) => [...x, { id, nome: file.name, preview, estado: "enviando" }]);
      solicitanteApi
        .enviarArquivo(usuarioId, file)
        .then((anexo) => setItens((x) => x.map((i) => (i.id === id ? { ...i, estado: "ok", anexo } : i))))
        .catch((e: Error) => {
          toast.error(e.message);
          setItens((x) => x.filter((i) => i.id !== id));
        });
    }
  };

  const remover = (id: string) => {
    const item = itens.find((i) => i.id === id);
    if (item?.anexo?.path) void solicitanteApi.removerArquivo(item.anexo.path);
    setItens((x) => x.filter((i) => i.id !== id));
  };

  return {
    itens,
    adicionar,
    remover,
    limpar: () => setItens([]),
    enviando: itens.some((i) => i.estado === "enviando"),
    anexos: itens.flatMap((i) => (i.anexo ? [i.anexo] : [])),
  };
}

export function Miniaturas({ itens, onRemover }: { itens: Item[]; onRemover: (id: string) => void }) {
  if (itens.length === 0) return null;
  return (
    <ul className="cd-anexos" aria-label="Arquivos anexados" style={{ listStyle: "none", padding: 0, margin: "10px 0 0" }}>
      {itens.map((i) => (
        <li key={i.id} className={`cd-mini${i.estado === "enviando" ? " cd-mini--enviando" : ""}`} title={i.nome}>
          {i.preview ? <img src={i.preview} alt={i.nome} /> : <span>{i.nome.split(".").pop()?.toUpperCase().slice(0, 4) ?? "ARQ"}</span>}
          <button type="button" className="cd-mini__x" aria-label={`Remover ${i.nome}`} onClick={() => onRemover(i.id)}>
            <X size={12} aria-hidden="true" />
          </button>
        </li>
      ))}
    </ul>
  );
}

async function linkAssinado(a: Anexo): Promise<string | null> {
  if (a.url) return a.url;
  if (!a.path) return null;
  const { data, error } = await supabase.storage.from(a.bucket ?? "imobdesk-solicitante").createSignedUrl(a.path, 300);
  return error ? null : data.signedUrl;
}

/** Anexo dentro da mensagem: imagem em miniatura; outros arquivos como botão que abre. */
export function AnexoNaMensagem({ a }: { a: Anexo }) {
  const imagem = (a.mime ?? "").startsWith("image/");
  const link = useQuery({ queryKey: ["cd", "arquivo", a.bucket, a.path], queryFn: () => linkAssinado(a), enabled: imagem && Boolean(a.path || a.url), staleTime: 240_000 });
  const abrir = async () => {
    const url = await linkAssinado(a);
    if (url) window.open(url, "_blank", "noopener,noreferrer");
    else toast.error("Não foi possível abrir o arquivo.");
  };
  if (imagem && link.data) {
    return (
      <a href={link.data} target="_blank" rel="noreferrer noopener">
        <img className="cd-msg__img" src={link.data} alt={a.nome ?? "Imagem anexada"} loading="lazy" />
      </a>
    );
  }
  return (
    <button type="button" className="cd-msg__arq" onClick={() => void abrir()}>
      {a.mime === "application/pdf" ? <FileText size={14} aria-hidden="true" /> : <Paperclip size={14} aria-hidden="true" />}
      {a.nome ?? "arquivo"}
    </button>
  );
}
