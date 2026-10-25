import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ServiceError } from "../../configuracoes/services/types";
import { solicitacoesService, type Anexo } from "../solicitacoes";
import { ReceiptViewer } from "./ReceiptViewer";

// Visualizador em janela dentro do sistema: imagem ou PDF (pdf.js), sem abrir nova aba. Montado uma vez nas telas das
// Solicitações Financeiras; abrirAnexo() pede a abertura por evento. Sem o visualizador montado (ex.: App do solicitante),
// abrirAnexo() cai na nova aba.

const EVENTO = "sf:abrir-anexo";
let montados = 0;

/** Abre o anexo no visualizador do sistema (ou em nova aba, se ele não estiver na tela). */
export async function abrirAnexo(a: Pick<Anexo, "path" | "nome" | "mime"> & Partial<Anexo>) {
  if (montados > 0) {
    window.dispatchEvent(new CustomEvent(EVENTO, { detail: { path: a.path, nome: a.nome, mime: a.mime } }));
    return;
  }
  try {
    window.open(await solicitacoesService.urlAnexo(a.path), "_blank", "noopener");
  } catch (e) {
    toast.error(e instanceof ServiceError ? e.message : "Não foi possível abrir o arquivo.");
  }
}

export function VisualizadorAnexo() {
  const [atual, setAtual] = useState<Pick<Anexo, "path" | "nome" | "mime"> | null>(null);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    montados++;
    const ouvir = (e: Event) => setAtual((e as CustomEvent<Pick<Anexo, "path" | "nome" | "mime">>).detail);
    window.addEventListener(EVENTO, ouvir);
    return () => {
      montados--;
      window.removeEventListener(EVENTO, ouvir);
    };
  }, []);

  useEffect(() => {
    if (!atual) return;
    let vivo = true;
    setUrl(null);
    solicitacoesService.urlAnexo(atual.path).then(
      (u) => vivo && setUrl(u),
      (e) => {
        toast.error(e instanceof ServiceError ? e.message : "Não foi possível abrir o arquivo.");
        if (vivo) setAtual(null);
      },
    );
    return () => {
      vivo = false;
    };
  }, [atual]);

  return (
    <Dialog.Root open={!!atual} onOpenChange={(v) => !v && setAtual(null)}>
      <Dialog.Portal>
        <Dialog.Overlay className="sf-modal__fundo" />
        <Dialog.Content className="sf-visual" aria-describedby={undefined}>
          <Dialog.Title className="sr-only">{atual?.nome ?? "Arquivo"}</Dialog.Title>
          <Dialog.Close asChild>
            <button type="button" className="sf-visual__fechar" aria-label="Fechar"><X size={18} aria-hidden="true" /></button>
          </Dialog.Close>
          {atual && <ReceiptViewer key={atual.path} url={url} mime={atual.mime} nome={atual.nome} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
