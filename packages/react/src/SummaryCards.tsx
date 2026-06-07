import * as React from "react";
import { AgentLoopSummary } from "./types";

export interface SummaryCardsProps {
  summary: AgentLoopSummary;
  /** Extra class names appended to the root element. */
  className?: string;
}

const CARD_FIELDS: Array<{ key: keyof AgentLoopSummary; label: string }> = [
  { key: "totalTickets", label: "Total" },
  { key: "activeTickets", label: "Active" },
  { key: "triagedTickets", label: "Triaged" },
  { key: "resolvedTickets", label: "Resolved" },
  { key: "reopenedTickets", label: "Reopened" },
  { key: "deferredTickets", label: "Deferred" },
  { key: "openPatterns", label: "Open patterns" },
  { key: "stalledPatterns", label: "Stalled patterns" },
];

/** Renders the loop's headline counts as a row of stat cards. Bring your own CSS via the `agentloops-*` class names. */
export function SummaryCards({ summary, className }: SummaryCardsProps): React.JSX.Element {
  return (
    <div className={["agentloops-summary-cards", className].filter(Boolean).join(" ")}>
      {CARD_FIELDS.map(({ key, label }) => (
        <div key={key} className="agentloops-summary-card">
          <div className="agentloops-summary-card-value">{summary[key]}</div>
          <div className="agentloops-summary-card-label">{label}</div>
        </div>
      ))}
    </div>
  );
}
