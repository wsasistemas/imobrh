import { Activity, AlertTriangle, Lightbulb, TrendingUp } from "lucide-react";
import { Link } from "react-router";
import { getMenuItem } from "../../../config/menuRegistry";
import { KpiGer, Secao } from "../componentes";
import { fmtNum } from "../graficos";
import { useVisao } from "../hooks";
import type { Insight } from "../types";

const TIPOS: Record<Insight["tipo"], { label: string; icone: typeof Lightbulb; descricao: string; tom: "vermelho" | "amarelo" | "verde" | "cinza" }> = {
  anomalia: { label: "Anomalias", icone: Activity, descricao: "Dias fora do padrão.", tom: "amarelo" },
  tendencia: { label: "Tendências", icone: TrendingUp, descricao: "Movimentos de meses seguidos.", tom: "cinza" },
  risco: { label: "Riscos", icone: AlertTriangle, descricao: "O que pode virar atraso ou meta perdida.", tom: "vermelho" },
  oportunidade: { label: "Oportunidades", icone: Lightbulb, descricao: "Onde uma ação pequena rende mais.", tom: "verde" },
};

/** Insights: identificar oportunidades (anomalias, tendências, riscos e oportunidades por regras sobre os dados). */
export function Insights() {
  const v = useVisao();
  const base = getMenuItem("gestao_chamados_gerencial").path;
  const tipos = Object.keys(TIPOS) as Insight["tipo"][];
  const conta = (t: Insight["tipo"]) => v.insights.filter((i) => i.tipo === t).length;

  return (
    <>
      <div className="ds-kpis">
        {tipos.map((t) => (
          <KpiGer key={t} label={TIPOS[t].label} valor={fmtNum(conta(t))} tom={conta(t) ? TIPOS[t].tom : "verde"} hint={TIPOS[t].descricao} />
        ))}
      </div>

      {tipos.map((tipo) => {
        const lista = v.insights.filter((i) => i.tipo === tipo);
        const T = TIPOS[tipo];
        return (
          <Secao key={tipo} titulo={T.label} subtitulo={T.descricao}>
            <div className="ger-lista">
              {lista.length === 0 && <p className="gr-vazio">Nada a destacar neste recorte.</p>}
              {lista.map((i) => (
                <div key={i.titulo} className={`ger-item ger-item--${i.tipo}`}>
                  <span className="ger-item__icone">
                    <T.icone size={16} aria-hidden="true" />
                  </span>
                  <div>
                    <b>{i.titulo}</b>
                    <p>{i.texto}</p>
                    <small>Evidência: {i.evidencia}</small>
                  </div>
                </div>
              ))}
            </div>
          </Secao>
        );
      })}

      <p className="ger-nota">
        Estes insights vêm de regras fixas sobre os números do recorte. Para causas prováveis, previsão e a decisão sugerida, use <Link to={{ pathname: `${base}/recomendacoes-ia`, search: location.search }}>Recomendações por IA</Link>.
      </p>
    </>
  );
}
