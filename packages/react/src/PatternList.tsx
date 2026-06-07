import * as React from "react";
import { Pattern } from "./types";

export interface PatternListProps {
  patterns: Pattern[];
  /** Extra class names appended to the root element. */
  className?: string;
  /** Called when a pattern is clicked; omit to render a plain (non-interactive) list. */
  onSelectPattern?: (pattern: Pattern) => void;
}

/** Renders a list of patterns (id, status, family, title, ticket count). Bring your own CSS via the `agentloops-*` class names. */
export function PatternList({ patterns, className, onSelectPattern }: PatternListProps): React.JSX.Element {
  if (patterns.length === 0) {
    return <p className={["agentloops-empty", className].filter(Boolean).join(" ")}>No patterns.</p>;
  }

  return (
    <ul className={["agentloops-pattern-list", className].filter(Boolean).join(" ")}>
      {patterns.map((pattern) => (
        <li
          key={pattern.id}
          className={onSelectPattern ? "agentloops-pattern-row agentloops-clickable" : "agentloops-pattern-row"}
          onClick={onSelectPattern ? () => onSelectPattern(pattern) : undefined}
        >
          <span className="agentloops-mono">{pattern.id}</span>{" "}
          <span className={`agentloops-badge agentloops-status-${pattern.status}`}>{pattern.status}</span>{" "}
          <span className="agentloops-pattern-family">{pattern.family}</span>{" — "}
          <span className="agentloops-pattern-title">{pattern.title}</span>{" "}
          <span className="agentloops-pattern-count">({pattern.ticketIds.length} tickets)</span>
        </li>
      ))}
    </ul>
  );
}
