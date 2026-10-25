import type { ReactNode } from "react";
import { Panel, PanelHeader } from "./Panel";
import { Pill } from "./Pill";

export interface SlaMetric {
  label: string;
  /** Percentual cumprido (0–100). */
  percent: number;
  tone: "success" | "warning" | "danger";
}

interface SlaHealthProps {
  period: string;
  metrics: readonly SlaMetric[];
  note?: ReactNode;
}

export function SlaHealth({ period, metrics, note }: SlaHealthProps) {
  return (
    <Panel padded aria-labelledby="ds-sla-title">
      <PanelHeader inset={false} title="Saúde do SLA" titleId="ds-sla-title" aside={<Pill tone="green">{period}</Pill>} />
      <div className="ds-sla-pair">
        {metrics.map((metric) => (
          <div key={metric.label}>
            <strong className={`ds-tone-${metric.tone}`}>{metric.percent}%</strong>
            <span className="ds-small ds-muted">{metric.label}</span>
          </div>
        ))}
      </div>
      {note && (
        <p className="ds-subtitle" style={{ marginTop: 11 }}>
          {note}
        </p>
      )}
    </Panel>
  );
}
