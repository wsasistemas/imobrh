import { Inbox, Ticket, Timer, UserCheck } from "lucide-react";
import { Pill } from "./Pill";
import { slaLabel, slaTone } from "./sla";
import { ThLabel } from "./ThLabel";

export interface QueueTableRow {
  id: number;
  requester: string;
  subject: string;
  team: string;
  service: string;
  origin: string;
  owner: { name: string; initials: string } | null;
  /** Minutos até o prazo de solução; negativo = vencido. */
  dueMinutes: number;
  /** Ticket resolvido/fechado: substitui o SLA (ex.: "Fechado em 05/10, 14:00"). */
  closedLabel?: string;
}

interface QueueTableProps {
  rows: readonly QueueTableRow[];
  onOpen: (id: number) => void;
  emptyMessage?: string;
}

export function QueueTable({ rows, onOpen, emptyMessage = "Nenhum ticket encontrado. Ajuste os filtros ou a busca." }: QueueTableProps) {
  return (
    <div className="ds-tablewrap">
      <table className="ds-table">
        <thead>
          <tr>
            <th scope="col"><ThLabel icon={Ticket}>TICKET / CATEGORIA</ThLabel></th>
            <th scope="col"><ThLabel icon={Inbox}>ORIGEM</ThLabel></th>
            <th scope="col"><ThLabel icon={UserCheck}>RESPONSÁVEL</ThLabel></th>
            <th scope="col"><ThLabel icon={Timer}>SLA DE SOLUÇÃO</ThLabel></th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={4} className="ds-table__empty">
                {emptyMessage}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <div className="ds-ticket-id">
                    <span className="ds-mono">#{row.id}</span> · {row.requester}
                  </div>
                  <button type="button" className="ds-ticketbtn" onClick={() => onOpen(row.id)}>
                    {row.subject}
                  </button>
                  <div className="ds-ticket-category">
                    {row.team} › {row.service}
                  </div>
                </td>
                <td>
                  <Pill>{row.origin}</Pill>
                </td>
                <td>
                  {row.owner ? (
                    <div className="ds-owner">
                      <span className="ds-miniavatar" aria-hidden="true">
                        {row.owner.initials}
                      </span>
                      {row.owner.name}
                    </div>
                  ) : (
                    <Pill tone="amber">Não atribuído</Pill>
                  )}
                </td>
                <td>
                  {row.closedLabel ? (
                    <Pill tone="green">{row.closedLabel}</Pill>
                  ) : (
                    <Pill tone={slaTone(row.dueMinutes)}>{slaLabel(row.dueMinutes)}</Pill>
                  )}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
