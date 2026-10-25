import { useId, useState } from "react";
import { cadeiaAdiantamento, cadeiaReembolso, moeda, type EtapaCadeia } from "../cadeia";
import type { ConfigSetorFinanceiro } from "../service";

/** ApproverChainPreview: quem aprovaria um valor de exemplo, nas duas cadeias. */
export function CadeiaPrevia({ config, nomeDe }: { config: ConfigSetorFinanceiro; nomeDe: (id: string | null) => string | null }) {
  const id = useId();
  const [valor, setValor] = useState(1000);
  const linha = (titulo: string, etapas: EtapaCadeia[]) => {
    const exigidas = etapas.filter((e) => e.exigido);
    return (
      <div className="sf-previa__linha">
        <span className="field__help">{titulo}</span>
        <div className="sf-previa__cadeia">
          {exigidas.length === 0 && <span className="at-selo s-fila">Sem aprovador: configure ao menos um nível</span>}
          {exigidas.map((e) => (
            <span key={e.nivel} className="sf-chip-pessoa" title={`${e.papel} · ${e.motivo}`}>
              {nomeDe(e.aprovadorId) ?? e.papel}
            </span>
          ))}
          {exigidas.length > 0 && <span className="sf-chip-pessoa sf-chip-pessoa--fin">Financeiro</span>}
        </div>
      </div>
    );
  };
  return (
    <div className="sf-previa">
      <div className="field sf-previa__valor">
        <label className="field__label" htmlFor={id}>Valor de exemplo (R$)</label>
        <input id={id} className="input sf-num" type="number" min={0} step="0.01" value={valor} onChange={(e) => setValor(Number(e.target.value))} />
      </div>
      {linha(`Reembolso ou fundo fixo de ${moeda(valor)}`, cadeiaReembolso(config, valor))}
      {linha(`Adiantamento de ${moeda(valor)}`, cadeiaAdiantamento(config, valor))}
    </div>
  );
}
