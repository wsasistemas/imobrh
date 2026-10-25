import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";

// PDF desenhado dentro do sistema (pdf.js em <canvas>), sem iframe nem nova aba: a CSP do portal tem frame-src e
// object-src 'none'. A biblioteca só é carregada quando há PDF na tela. O worker vem do próprio portal (script-src 'self')
// e o eval fica desligado (sem 'unsafe-eval').

const MAX_PAGINAS = 20;

async function carregar(url: string): Promise<PDFDocumentProxy> {
  const pdfjs = await import("pdfjs-dist");
  const worker = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = worker;
  // Baixa aqui (fetch) e entrega os bytes: vale para URL assinada do Storage e para blob: do modo simulado.
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  return pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise;
}

function Pagina({ doc, numero, largura, zoom, giro }: { doc: PDFDocumentProxy; numero: number; largura: number; zoom: number; giro: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let vivo = true;
    let tarefa: { cancel: () => void } | null = null;
    void (async () => {
      const pagina = await doc.getPage(numero);
      if (!vivo || !ref.current) return;
      const base = pagina.getViewport({ scale: 1, rotation: (pagina.rotate + giro) % 360 });
      const escala = (largura / base.width) * zoom;
      const vp = pagina.getViewport({ scale: escala, rotation: (pagina.rotate + giro) % 360 });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const c = ref.current;
      c.width = Math.floor(vp.width * dpr);
      c.height = Math.floor(vp.height * dpr);
      c.style.width = `${Math.floor(vp.width)}px`;
      c.style.height = `${Math.floor(vp.height)}px`;
      const ctx = c.getContext("2d");
      if (!ctx) return;
      const render = pagina.render({ canvasContext: ctx, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined });
      tarefa = render;
      await render.promise.catch(() => undefined);
    })();
    return () => {
      vivo = false;
      tarefa?.cancel();
    };
  }, [doc, numero, largura, zoom, giro]);
  return <canvas ref={ref} className="sf-pdf__pagina" aria-label={`Página ${numero}`} />;
}

/** Todas as páginas do PDF (até 20), ajustadas à largura do palco, com zoom e giro do visualizador. */
export function PdfPaginas({ url, zoom = 1, giro = 0, nome }: { url: string; zoom?: number; giro?: number; nome: string }) {
  const caixa = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [erro, setErro] = useState(false);
  const [largura, setLargura] = useState(0);

  useEffect(() => {
    let vivo = true;
    let aberto: PDFDocumentProxy | null = null;
    setDoc(null);
    setErro(false);
    carregar(url).then(
      (d) => {
        aberto = d;
        if (vivo) setDoc(d);
        else void d.destroy();
      },
      () => vivo && setErro(true),
    );
    return () => {
      vivo = false;
      void aberto?.destroy();
    };
  }, [url]);

  useEffect(() => {
    const el = caixa.current;
    if (!el) return;
    const medir = () => setLargura(Math.max(200, el.clientWidth - 24));
    medir();
    const ro = new ResizeObserver(medir);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const total = doc?.numPages ?? 0;
  return (
    <div className="sf-pdf" ref={caixa}>
      {erro ? (
        <span className="sf-viewer__msg">Não foi possível mostrar este PDF. Use o botão de abrir em nova aba.</span>
      ) : !doc || !largura ? (
        <span className="sf-viewer__msg">Carregando o PDF…</span>
      ) : (
        <>
          {Array.from({ length: Math.min(total, MAX_PAGINAS) }, (_, i) => (
            <Pagina key={i} doc={doc} numero={i + 1} largura={largura} zoom={zoom} giro={giro} />
          ))}
          {total > 1 && <span className="sf-pdf__info">{nome} · {total} páginas{total > MAX_PAGINAS ? ` (mostrando ${MAX_PAGINAS})` : ""}</span>}
        </>
      )}
    </div>
  );
}
