import * as React from "react";
import { Ticket } from "./types";

export interface TicketListProps {
  tickets: Ticket[];
  /** Extra class names appended to the root element. */
  className?: string;
  /** Called when a row is clicked; omit to render a plain (non-interactive) table. */
  onSelectTicket?: (ticket: Ticket) => void;
}

/** Renders a table of tickets (alias, kind, status, family, source, title). Bring your own CSS via the `agentloops-*` class names. */
export function TicketList({ tickets, className, onSelectTicket }: TicketListProps): React.JSX.Element {
  if (tickets.length === 0) {
    return <p className={["agentloops-empty", className].filter(Boolean).join(" ")}>No tickets.</p>;
  }

  return (
    <table className={["agentloops-ticket-list", className].filter(Boolean).join(" ")}>
      <thead>
        <tr>
          <th>Alias</th>
          <th>Kind</th>
          <th>Status</th>
          <th>Family</th>
          <th>Source</th>
          <th>Title</th>
        </tr>
      </thead>
      <tbody>
        {tickets.map((ticket) => (
          <tr
            key={ticket.id}
            className={onSelectTicket ? "agentloops-ticket-row agentloops-clickable" : "agentloops-ticket-row"}
            onClick={onSelectTicket ? () => onSelectTicket(ticket) : undefined}
          >
            <td className="agentloops-mono">{ticket.aliases[0] ?? ticket.id}</td>
            <td>{ticket.kind}</td>
            <td>
              <span className={`agentloops-badge agentloops-status-${ticket.status}`}>{ticket.status}</span>
            </td>
            <td>{ticket.family}</td>
            <td>{ticket.source}</td>
            <td>{ticket.title || "(untitled)"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
