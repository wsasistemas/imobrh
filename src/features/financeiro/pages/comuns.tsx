import { Lock } from "lucide-react";
import { useEffect, useState } from "react";

// Pedaços comuns aos formulários e às visões das solicitações (reembolso, fundo fixo e adiantamento).

/** Valor em reais digitado com vírgula: guarda o texto enquanto a pessoa digita e entrega o número. Fora do foco, acompanha o valor externo. */
export function CampoValor({ id, rotulo, valor, onChange }: { id?: string; rotulo: string; valor: number | null; onChange: (v: number | null) => void }) {
  const fmt = (v: number | null) => (v == null ? "" : v.toFixed(2).replace(".", ","));
  const [texto, setTexto] = useState(fmt(valor));
  const [foco, setFoco] = useState(false);
  useEffect(() => {
    if (!foco) setTexto(fmt(valor));
  }, [valor, foco]);
  return (
    <input id={id} className="input sf-num" inputMode="decimal" aria-label={id ? undefined : rotulo} value={texto}
      onFocus={() => setFoco(true)}
      onChange={(e) => {
        const t = e.target.value.replace(/[^\d,.]/g, "");
        setTexto(t);
        const n = Number(t.replace(/\./g, "").replace(",", "."));
        onChange(t === "" || Number.isNaN(n) ? null : n);
      }}
      onBlur={() => setFoco(false)} />
  );
}

export function Regra({ cod, texto, tom, res }: { cod: string; texto: string; tom: "ok" | "aviso" | "erro"; res: string }) {
  return (
    <li>
      <span className="sf-regras__cod">{cod}</span>
      <span>{texto}</span>
      <span className={`sf-chip sf-chip--${tom}`}>{res}</span>
    </li>
  );
}

export function Ro({ rotulo, valor, trava }: { rotulo: string; valor: string; trava?: boolean }) {
  return (
    <div className="field">
      <span className="field__label">{rotulo}</span>
      <span className="sf-ro">
        {valor}
        {trava && <Lock size={12} aria-label="Somente leitura" className="sf-ro__trava" />}
      </span>
    </div>
  );
}

/** Abre o anexo no visualizador do sistema (imagem ou PDF, sem nova aba). */
export { abrirAnexo } from "../components/VisualizadorAnexo";
