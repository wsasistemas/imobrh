import { Check } from "lucide-react";
import type { ReactNode } from "react";

// ApprovalTimeline (CONTEXTO.md, seção 7): verde = concluído, borda laranja = etapa atual, tracejado = não exigido, cinza = futuro.

export type EstadoEtapa = "feito" | "atual" | "nao_exigido" | "futuro" | "devolvido";

export interface EtapaTimeline {
  chave: string;
  titulo: string;
  detalhe?: ReactNode;
  estado: EstadoEtapa;
  comentario?: string | null;
}

export function ApprovalTimeline({ etapas }: { etapas: EtapaTimeline[] }) {
  return (
    <ol className="sf-tl">
      {etapas.map((e, i) => (
        <li key={e.chave} className={`sf-tl__item sf-tl__item--${e.estado}`} aria-current={e.estado === "atual" ? "step" : undefined}>
          <span className="sf-tl__m" aria-hidden="true">{e.estado === "feito" ? <Check size={14} /> : i + 1}</span>
          <div>
            <div className="sf-tl__t">{e.titulo}</div>
            {e.detalhe && <div className="sf-tl__d">{e.detalhe}</div>}
            {e.estado === "nao_exigido" && !e.detalhe && <div className="sf-tl__d">Não exigido para este valor</div>}
            {e.comentario && <div className="sf-tl__q">{e.comentario}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}
