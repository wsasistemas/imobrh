import { Panel, PanelHeader } from "./Panel";

export interface InboundPoint {
  hour: number;
  today: number;
  yesterday: number;
}

interface InboundChartProps {
  subtitle: string;
  data: readonly InboundPoint[];
  /** Topo da escala (tickets por hora). */
  max: number;
}

/** Barras pareadas hoje × ontem por hora, com linhas de grade. */
export function InboundChart({ subtitle, data, max }: InboundChartProps) {
  const today = data.reduce((sum, p) => sum + p.today, 0);
  const yesterday = data.reduce((sum, p) => sum + p.yesterday, 0);
  const delta = today - yesterday;
  const height = (n: number) => `${max ? (n / max) * 100 : 0}%`;

  return (
    <Panel aria-labelledby="ds-inbound-title">
      <PanelHeader
        title="Ritmo de entrada"
        titleId="ds-inbound-title"
        subtitle={subtitle}
        aside={
          <div className="ds-legend">
            <span>
              <i className="ds-dot" />
              Hoje
            </span>
            <span>
              <i className="ds-dot ds-dot--yesterday" />
              Ontem
            </span>
          </div>
        }
      />
      <div className="ds-chart">
        <div className="ds-bars" role="img" aria-label={`Entradas por hora. Hoje: ${today} tickets. Ontem: ${yesterday} tickets.`}>
          {data.map((p) => (
            <div key={p.hour} className="ds-barpair" title={`${p.hour}h: hoje ${p.today}, ontem ${p.yesterday}`}>
              <i style={{ height: height(p.today) }} />
              <i style={{ height: height(p.yesterday) }} />
            </div>
          ))}
        </div>
        <div className="ds-hours" aria-hidden="true">
          {data.map((p) => (
            <span key={p.hour}>{p.hour}h</span>
          ))}
        </div>
        <p className="ds-subtitle" style={{ marginTop: 12 }}>
          {today} hoje · {yesterday} ontem &nbsp;{" "}
          <strong className="ds-chart__delta">
            {delta >= 0 ? "+" : "−"}
            {Math.abs(delta)} tickets
          </strong>{" "}
          · escala: 0 a {max} por hora
        </p>
      </div>
    </Panel>
  );
}
