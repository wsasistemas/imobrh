import { Panel, PanelHeader } from "./Panel";

export interface TeamLoad {
  name: string;
  total: number;
  late: number;
  unassigned: number;
  /** Token da cor da barra (ex.: "--ds-team-sistemas"). */
  colorToken: `--ds-${string}`;
}

interface TeamDistributionProps {
  teams: readonly TeamLoad[];
  /** Backlog do recorte inteiro (base da largura das barras). */
  grandTotal: number;
  onSelect: (team: string) => void;
}

export function TeamDistribution({ teams, grandTotal, onSelect }: TeamDistributionProps) {
  return (
    <Panel aria-labelledby="ds-teams-title">
      <PanelHeader title="Distribuição da equipe" titleId="ds-teams-title" subtitle="Backlog do recorte atual · selecione para filtrar a fila" />
      <div className="ds-teams">
        {teams.map((team) => (
          <button key={team.name} type="button" className="ds-team" onClick={() => onSelect(team.name)}>
            <div className="ds-row">
              <div>
                <strong>
                  {team.name} <span className="ds-team__arrow">↗</span>
                </strong>
                <div className="ds-team__counts">
                  {team.late} vencidos · {team.unassigned} sem responsável
                </div>
              </div>
              <span className="ds-team__num">{team.total}</span>
            </div>
            <div className="ds-track">
              <div
                className="ds-fill"
                style={{ width: `${grandTotal ? (team.total / grandTotal) * 100 : 0}%`, background: `var(${team.colorToken})` }}
              />
            </div>
          </button>
        ))}
      </div>
    </Panel>
  );
}
