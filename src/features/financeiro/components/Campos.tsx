import { Sparkles } from "lucide-react";
import type { ReactNode } from "react";

// FormSection, Field e OcrField (CONTEXTO.md, seção 7). O OcrField usa os tokens --info-* (campo copiado do comprovante).

/** Card numerado do formulário ("1. Dados do solicitante"), grid de campos com mínimo de 200 px. */
export function FormSection({ numero, titulo, extra, children }: { numero?: number; titulo: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <section className="card sf-secao" aria-label={titulo}>
      <h2 className="sf-secao__t">
        {numero != null && <span className="sf-secao__n">{numero}</span>}
        {titulo}
        {extra && <small>{extra}</small>}
      </h2>
      {children}
    </section>
  );
}

export function Field({ id, rotulo, ajuda, erro, children }: { id: string; rotulo: string; ajuda?: ReactNode; erro?: string | null; children: ReactNode }) {
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>{rotulo}</label>
      {children}
      {erro ? <span className="field__error" role="alert">{erro}</span> : ajuda ? <span className="field__help">{ajuda}</span> : null}
    </div>
  );
}

/** Campo que a leitura copiou: azul, com "copiado · legibilidade NN%". Abaixo do limiar, fica vazio para preencher à mão. */
export function OcrField({ id, rotulo, legibilidade, limiar = 0.8, children }: { id: string; rotulo: string; legibilidade: number | null; limiar?: number; children: ReactNode }) {
  const copiado = legibilidade != null && legibilidade >= limiar;
  return (
    <div className={`field ${copiado ? "sf-ocr" : legibilidade != null ? "sf-ocr sf-ocr--vazio" : ""}`}>
      <label className="field__label" htmlFor={id}>{rotulo}</label>
      {children}
      {legibilidade != null && (
        <span className="sf-ocr__tag">
          <Sparkles size={12} aria-hidden="true" />
          {copiado ? `copiado · legibilidade ${Math.round(legibilidade * 100)}%` : `legibilidade ${Math.round(legibilidade * 100)}% · não copiado`}
        </span>
      )}
    </div>
  );
}
