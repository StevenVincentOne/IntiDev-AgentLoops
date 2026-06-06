export type TicketKind =
  | "bug"
  | "feature"
  | "user_feedback"
  | "investigation"
  | "incident"
  | "tech_debt"
  | "task";

export type TicketStatus = "triaged" | "active" | "resolved" | "reopened" | "deferred";
export type PatternStatus = "open" | "active" | "resolved" | "reopened";

export type Severity = "low" | "medium" | "high" | "critical";

export type Confidence = "low" | "medium" | "high";

export type GuardStatus = "guard_added" | "guard_existing" | "guard_waived" | "guard_deferred" | "none";

export type NoteType = "hypothesis" | "related_history" | "prior_fix" | "triage" | "investigation";

export interface KindConfig {
  kind: TicketKind;
  defaultSeverity: Severity;
  requiredFields?: string[];
}

/**
 * A queue routes tickets to a single user-facing alias prefix. Queues are
 * evaluated in order (first match wins); a `source` match takes the precedence
 * of the queue it belongs to, so e.g. a `user_report`-sourced bug routes to the
 * USER queue rather than ISSUE.
 */
export interface QueueConfig {
  /** Alias prefix, e.g. "USER", "DEV", "ISSUE". */
  prefix: string;
  /** Ticket kinds routed to this queue. */
  kinds?: TicketKind[];
  /** Sources routed to this queue, overriding kind routing. */
  sources?: string[];
  /** Fallback queue when nothing else matches. Exactly one queue should set this. */
  default?: boolean;
}

export interface ProjectConfig {
  projectName: string;
  description: string;
  defaultKind: TicketKind;
  ticketKinds: KindConfig[];
  queues: QueueConfig[];
  sources: string[];
  patterns: {
    autoCreateByFamily: boolean;
    defaultFamily: string;
  };
}

export interface TicketNote {
  id: string;
  type: NoteType;
  body: string;
  author?: string;
  createdAt: string;
}

export interface Ticket {
  id: string;
  family: string;
  kind: TicketKind;
  source: string;
  title: string;
  summary: string;
  severity: Severity;
  confidence: Confidence;
  status: TicketStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  resolvedAt?: string;
  aliases: string[];
  tags: string[];
  notes: TicketNote[];
  handoffText?: string;
  guardStatus?: GuardStatus;
  guardSummary?: string;
  patternId?: string;
  verification?: string;
  reproducible?: boolean;
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

export interface LoopState {
  version: number;
  project: string;
  createdAt: string;
  updatedAt: string;
  nextTicketSeq: number;
  nextPatternSeq: number;
  tickets: Ticket[];
  patterns: Pattern[];
}

export interface CreateTicketInput {
  title: string;
  summary: string;
  family: string;
  kind: TicketKind;
  source: string;
  severity?: Severity;
  confidence?: Confidence;
  tags?: string[];
  handoffText?: string;
}

export interface ResolveInput {
  id: string;
  summary: string;
  verification?: string;
  guardStatus?: GuardStatus;
  guardSummary?: string;
}
