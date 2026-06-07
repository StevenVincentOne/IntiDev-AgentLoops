import { Pattern, PatternStatus, Ticket, TicketStatus } from "./types";

export const WORKFLOW_REPAIR_SCHEMA_VERSION = 1 as const;

/** Ticket statuses that represent ongoing work (not yet closed out). Mirrors `workflow-audit.ts`. */
const ACTIVE_TICKET_STATUSES = new Set<TicketStatus>(["triaged", "active", "reopened"]);

/** Pattern statuses that represent ongoing work (mirror of the ticket set, for patterns). */
const ACTIVE_PATTERN_STATUSES = new Set<PatternStatus>(["open", "active", "reopened"]);

function isActiveTicketStatus(status: TicketStatus): boolean {
  return ACTIVE_TICKET_STATUSES.has(status);
}

export type WorkflowRepairReason = "reopened_linked_tickets" | "all_linked_tickets_closed";

export interface WorkflowRepairOptions {
  /** Restrict the plan to a single family. */
  family?: string;
}

export interface WorkflowRepairTicketRef {
  id: string;
  alias: string;
  status: TicketStatus;
  kind: string;
  source: string;
}

export interface WorkflowRepairAction {
  patternId: string;
  family: string;
  title: string;
  fromStatus: PatternStatus;
  toStatus: PatternStatus;
  reason: WorkflowRepairReason;
  linkedTicketCount: number;
  activeLinkedTicketCount: number;
  /** The tickets that justify this repair (a relevant subset, not always all members). */
  tickets: WorkflowRepairTicketRef[];
}

export interface WorkflowRepairPlan {
  schemaVersion: typeof WORKFLOW_REPAIR_SCHEMA_VERSION;
  generatedAt: string;
  filters: { family: string | null };
  summary: {
    patternsConsidered: number;
    /** Resolved-but-still-active patterns that would reopen. */
    reopens: number;
    /** Open/active/reopened-but-stale patterns that would resolve. */
    resolves: number;
    totalActions: number;
  };
  actions: WorkflowRepairAction[];
}

/**
 * The plan, plus whether it was actually applied. `workflowRepairPlan` always
 * produces a plan (it never mutates); `AgentLoopStore.repairWorkflow` is what
 * decides whether to apply it (`applied: true`, statuses flipped + persisted)
 * or merely report it (`applied: false`, e.g. `--dry-run`/preview).
 */
export interface WorkflowRepairResult extends WorkflowRepairPlan {
  applied: boolean;
}

function ticketRef(ticket: Ticket): WorkflowRepairTicketRef {
  return {
    id: ticket.id,
    alias: ticket.aliases[0] ?? ticket.id,
    status: ticket.status,
    kind: ticket.kind,
    source: ticket.source,
  };
}

const byPatternId = (a: WorkflowRepairAction, b: WorkflowRepairAction) => a.patternId.localeCompare(b.patternId);

/**
 * Plan the corrective status transitions for the drift `workflowAuditReport`
 * surfaces (ported concept from Inti's `repairIssueResolutionWorkflow`,
 * reframed without its event-replay/signature-matching machinery — AgentLoops
 * has no event log to replay, so the rule is simply "make the Pattern's status
 * agree with its linked tickets' statuses, the same drift the audit already
 * makes visible"):
 *
 *   - A *resolved* Pattern with active (especially reopened) linked tickets
 *     reopens — mirroring how a ticket itself transitions resolved -> reopened.
 *   - An *open/active/reopened* Pattern whose linked tickets are all closed
 *     out resolves — it's stale and ready to close.
 *
 * Pure and deterministic apart from `generatedAt`: this only *plans* the
 * repairs (matching what `workflowAuditReport` would currently flag) — it
 * never mutates `tickets`/`patterns`. Applying the plan is the store's job
 * (`AgentLoopStore.repairWorkflow`), so the same logic backs both a no-op
 * preview and the actual write.
 */
export function workflowRepairPlan(
  tickets: Ticket[],
  patterns: Pattern[],
  options: WorkflowRepairOptions = {},
): WorkflowRepairPlan {
  const familyFilter = options.family;
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  const scoped = patterns.filter((pattern) => !familyFilter || pattern.family === familyFilter);

  const actions: WorkflowRepairAction[] = [];

  for (const pattern of scoped) {
    const members = pattern.ticketIds
      .map((id) => byId.get(id))
      .filter((ticket): ticket is Ticket => Boolean(ticket));
    if (members.length === 0) continue;

    const activeMembers = members.filter((ticket) => isActiveTicketStatus(ticket.status));
    const reopenedMembers = activeMembers.filter((ticket) => ticket.status === "reopened");

    if (pattern.status === "resolved" && activeMembers.length > 0) {
      actions.push({
        patternId: pattern.id,
        family: pattern.family,
        title: pattern.title,
        fromStatus: pattern.status,
        toStatus: "reopened",
        reason: "reopened_linked_tickets",
        linkedTicketCount: members.length,
        activeLinkedTicketCount: activeMembers.length,
        tickets: (reopenedMembers.length > 0 ? reopenedMembers : activeMembers).map(ticketRef),
      });
      continue; // a pattern gets at most one repair per plan
    }

    if (ACTIVE_PATTERN_STATUSES.has(pattern.status) && activeMembers.length === 0 && pattern.status !== "resolved") {
      actions.push({
        patternId: pattern.id,
        family: pattern.family,
        title: pattern.title,
        fromStatus: pattern.status,
        toStatus: "resolved",
        reason: "all_linked_tickets_closed",
        linkedTicketCount: members.length,
        activeLinkedTicketCount: 0,
        tickets: members.map(ticketRef),
      });
    }
  }

  actions.sort(byPatternId);

  const reopens = actions.filter((a) => a.toStatus === "reopened").length;
  const resolves = actions.filter((a) => a.toStatus === "resolved").length;

  return {
    schemaVersion: WORKFLOW_REPAIR_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    filters: { family: familyFilter ?? null },
    summary: {
      patternsConsidered: scoped.length,
      reopens,
      resolves,
      totalActions: actions.length,
    },
    actions,
  };
}
