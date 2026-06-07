/**
 * Wire types mirroring the JSON shapes served by `agentloop serve` at
 * `/api/summary`, `/api/tickets`, and `/api/patterns`. Kept independent of
 * `@stevenvincentone/intidev-agentloops` so this package stays a thin,
 * React-only client (no MCP SDK / zod in your frontend bundle).
 */

export type TicketStatus = "triaged" | "active" | "resolved" | "reopened" | "deferred";
export type PatternStatus = "open" | "active" | "resolved" | "reopened";

export interface Ticket {
  id: string;
  family: string;
  kind: string;
  source: string;
  title: string;
  summary: string;
  severity: string;
  confidence: string;
  status: TicketStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  resolvedAt?: string;
  aliases: string[];
  tags: string[];
  guardStatus?: string;
  guardSummary?: string;
  patternId?: string;
  resolutionSummary?: string;
}

export interface Pattern {
  id: string;
  family: string;
  title: string;
  status: PatternStatus;
  createdAt: string;
  updatedAt: string;
  ticketIds: string[];
}

export interface AgentLoopSummary {
  project: string;
  totalTickets: number;
  activeTickets: number;
  triagedTickets: number;
  resolvedTickets: number;
  reopenedTickets: number;
  deferredTickets: number;
  openPatterns: number;
  stalledPatterns: number;
  resolvedPatterns: number;
}
