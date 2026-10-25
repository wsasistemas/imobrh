import { Sparkles } from "lucide-react";
import { Panel, PanelHeader } from "./Panel";

export type TriageTone = "ai" | "rule" | "triage-ai";

export interface TriageBar {
  label: string;
  value: number;
  tone: TriageTone;
}

interface TriagePanelProps {
  subtitle: string;
  /** Classificados automaticamente. */
  automatic: number;
  total: number;
  bars: readonly TriageBar[];
  /** Linha abaixo das barras (ex.: "3 encaminhados para triagem manual."). */
  note?: string;
  review?: { title: string; text: string; onClick: () => void };
}

const FILL: Record<TriageTone, string> = {
  ai: "var(--ds-ai)",
  rule: "var(--ds-triage-rule)",
  "triage-ai": "var(--ds-triage-ai)",
};

export function TriagePanel({ subtitle, automatic, total, bars, note, review }: TriagePanelProps) {
  return (
    <Panel padded aria-labelledby="ds-triage-title">
      <PanelHeader
        inset={false}
        title="Triagem inteligente"
        titleId="ds-triage-title"
        subtitle={subtitle}
        aside={
          <span className="ds-aiicon" aria-hidden="true">
            <Sparkles size={18} strokeWidth={1.6} />
          </span>
        }
      />
      <div className="ds-ai-total">
        <strong>
          {automatic}
          <span className="ds-ai-total__of">/{total}</span>
        </strong>
        <span className="ds-ai-total__label">classificados automaticamente</span>
      </div>
      {bars.map((bar) => (
        <div key={bar.label} className="ds-barrow">
          <div className="ds-row">
            <span>{bar.label}</span>
            <strong>{bar.value}</strong>
          </div>
          <div className="ds-track">
            <div className="ds-fill" style={{ width: `${total ? (bar.value / total) * 100 : 0}%`, background: FILL[bar.tone] }} />
          </div>
        </div>
      ))}
      {note && (
        <p className="ds-subtitle" style={{ marginTop: 12 }}>
          {note}
        </p>
      )}
      {review && (
        <button type="button" className="ds-review" onClick={review.onClick}>
          <strong>{review.title} →</strong>
          {review.text}
        </button>
      )}
    </Panel>
  );
}
