import { Pattern, PatternStatus, Ticket, TicketStatus } from "./types";

export const WORKFLOW_AUDIT_SCHEMA_VERSION = 1 as const;

/** Ticket statuses that represent ongoing work (not yet closed out). */
const ACTIVE_TICKET_STATUSES = new Set<TicketStatus>(["triaged", "active", "reopened"]);

/** Pattern statuses that represent ongoing work (mirror of the ticket set, for patterns). */
const ACTIVE_PATTERN_STATUSES = new Set<PatternStatus>(["open", "active", "reopened"]);

function isActiveTicketStatus(status: TicketStatus): boolean {
  return ACTIVE_TICKET_STATUSES.has(status);
}

export interface WorkflowAuditOptions {
  /** Restrict the audit to a single family. */
  family?: string;
}

export interface WorkflowAuditTicketRef {
  id: string;
  alias: string;
  status: TicketStatus;
  kind: string;
  source: string;
}

export interface WorkflowAuditPatternEntry {
  id: string;
  family: string;
  title: string;
  status: PatternStatus;
  /** Total tickets linked to this pattern. */
  linkedTicketCount: number;
  /** Linked tickets still in an active status (triaged/active/reopened). */
  activeLinkedTicketCount: number;
  /** The tickets that triggered this entry's inclusion (a relevant subset, not always all members). */
  tickets: WorkflowAuditTicketRef[];
}

export interface WorkflowAuditReport {
  schemaVersion: typeof WORKFLOW_AUDIT_SCHEMA_VERSION;
  generatedAt: string;
  filters: { family: string | null };
  summary: {
    totalPatterns: number;
    /** Resolved patterns that still have one or more active linked tickets — likely closed too early. */
    resolvedWithActiveTickets: number;
    /** Subset of the above where a linked ticket has specifically reopened — a stronger signal. */
    resolvedWithReopenedTickets: number;
    /** Open/active/reopened patterns whose linked tickets are all closed out — likely stale and ready to resolve. */
    activeWithNoActiveTickets: number;
  };
  resolvedPatternsWithActiveTickets: WorkflowAuditPatternEntry[];
  resolvedPatternsWithReopenedTickets: WorkflowAuditPatternEntry[];
  activePatternsWithNoActiveTickets: WorkflowAuditPatternEntry[];
}

function ticketRef(ticket: Ticket): WorkflowAuditTicketRef {
  return {
    id: ticket.id,
    alias: ticket.aliases[0] ?? ticket.id,
    status: ticket.status,
    kind: ticket.kind,
    source: ticket.source,
  };
}

function entryFor(pattern: Pattern, members: Ticket[], activeCount: number, highlighted: Ticket[]): WorkflowAuditPatternEntry {
  return {
    id: pattern.id,
    family: pattern.family,
    title: pattern.title,
    status: pattern.status,
    linkedTicketCount: members.length,
    activeLinkedTicketCount: activeCount,
    tickets: highlighted.map(ticketRef),
  };
}

const byPatternId = (a: WorkflowAuditPatternEntry, b: WorkflowAuditPatternEntry) => a.id.localeCompare(b.id);

/**
 * Workflow consistency audit (ported concept from Inti's resolution-workflow
 * audit): surface Patterns whose status disagrees with the status of their
 * linked tickets. AgentLoops auto-creates and escalates Patterns as tickets
 * converge, but never auto-resolves or auto-reopens them — so a Pattern can
 * silently drift out of sync with its members. This audit makes that drift
 * visible without requiring any schema change:
 *
 *   - A *resolved* Pattern with active (or, worse, reopened) linked tickets
 *     was likely closed too early.
 *   - An *open/active/reopened* Pattern whose linked tickets are all closed
 *     out is likely stale and ready to resolve.
 *
 * Pure and deterministic apart from `generatedAt`.
 */
export function workflowAuditReport(
  tickets: Ticket[],
  patterns: Pattern[],
  options: WorkflowAuditOptions = {},
): WorkflowAuditReport {
  const familyFilter = options.family;
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  const scoped = patterns.filter((pattern) => !familyFilter || pattern.family === familyFilter);

  const resolvedWithActiveTickets: WorkflowAuditPatternEntry[] = [];
  const resolvedWithReopenedTickets: WorkflowAuditPatternEntry[] = [];
  const activeWithNoActiveTickets: WorkflowAuditPatternEntry[] = [];

  for (const pattern of scoped) {
    const members = pattern.ticketIds
      .map((id) => byId.get(id))
      .filter((ticket): ticket is Ticket => Boolean(ticket));
    if (members.length === 0) continue;

    const activeMembers = members.filter((ticket) => isActiveTicketStatus(ticket.status));
    const reopenedMembers = activeMembers.filter((ticket) => ticket.status === "reopened");

    if (pattern.status === "resolved" && activeMembers.length > 0) {
      resolvedWithActiveTickets.push(entryFor(pattern, members, activeMembers.length, activeMembers));
      if (reopenedMembers.length > 0) {
        resolvedWithReopenedTickets.push(entryFor(pattern, members, activeMembers.length, reopenedMembers));
      }
    }

    if (ACTIVE_PATTERN_STATUSES.has(pattern.status) && activeMembers.length === 0) {
      activeWithNoActiveTickets.push(entryFor(pattern, members, 0, members));
    }
  }

  resolvedWithActiveTickets.sort(byPatternId);
  resolvedWithReopenedTickets.sort(byPatternId);
  activeWithNoActiveTickets.sort(byPatternId);

  return {
    schemaVersion: WORKFLOW_AUDIT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    filters: { family: familyFilter ?? null },
    summary: {
      totalPatterns: scoped.length,
      resolvedWithActiveTickets: resolvedWithActiveTickets.length,
      resolvedWithReopenedTickets: resolvedWithReopenedTickets.length,
      activeWithNoActiveTickets: activeWithNoActiveTickets.length,
    },
    resolvedPatternsWithActiveTickets: resolvedWithActiveTickets,
    resolvedPatternsWithReopenedTickets: resolvedWithReopenedTickets,
    activePatternsWithNoActiveTickets: activeWithNoActiveTickets,
  };
}
