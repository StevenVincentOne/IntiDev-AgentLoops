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

export type NoteType =
  | "hypothesis"
  | "related_history"
  | "prior_fix"
  | "triage"
  | "investigation"
  | "external";

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
  /** Optional overrides for prior-art relatedness scoring. Core defaults apply when omitted. */
  priorArt?: {
    weights?: Partial<{
      family: number;
      pattern: number;
      tag: number;
      kind: number;
      textOverlap: number;
    }>;
    minScore?: number;
  };
  /** Optional config-driven redaction. Library users can also inject a TicketRedactor directly. */
  redaction?: {
    patterns?: RedactionRule[];
  };
  /**
   * Optional storage selection for the CLI/MCP. Prefer the `DATABASE_URL`
   * environment variable for the connection string (it takes precedence) so
   * secrets stay out of committed config.
   */
  storage?: {
    databaseUrl?: string;
  };
  /**
   * Optional GitHub Issues sync. Tickets remain the richer agent-memory layer;
   * sync mirrors a ticket onto a linked Issue (title/body/labels) and imports
   * new Issue comments back as ticket notes. Off unless `repo` is set.
   */
  github?: {
    /** "owner/repo" of the GitHub repository to sync with. */
    repo?: string;
    /** Name of the environment variable holding the access token. Defaults to GITHUB_TOKEN. */
    tokenEnv?: string;
    /** Override the label mirrored for a given queue/kind/severity/status value. */
    labels?: {
      queue?: Record<string, string>;
      kind?: Record<string, string>;
      severity?: Record<string, string>;
      status?: Record<string, string>;
    };
  };
}

/** Context passed to a redactor so host implementations can vary behavior by field/ticket. */
export interface RedactionContext {
  field: string;
  ticketKind?: string;
  source?: string;
}

/**
 * Host-pluggable redaction hook. Core ships a no-op default and a config-driven
 * pattern redactor; host apps own real PII/secret scrubbing.
 */
export interface TicketRedactor {
  redactText(value: string, context: RedactionContext): string;
  redactJson(value: unknown, context: RedactionContext): unknown;
}

/** A single config-driven redaction rule (regex → replacement). */
export interface RedactionRule {
  name?: string;
  /** Regular-expression source. */
  pattern: string;
  /** Regex flags; defaults to "g". */
  flags?: string;
  /** Replacement string; defaults to "[redacted]". */
  replacement?: string;
}

export interface TicketNote {
  id: string;
  type: NoteType;
  body: string;
  author?: string;
  createdAt: string;
}

/** Sync state for a ticket linked to a GitHub Issue. */
export interface TicketGithubLink {
  /** Canonical web URL of the linked issue, e.g. https://github.com/owner/repo/issues/42. */
  issueUrl: string;
  issueNumber: number;
  /** ISO timestamp of the last successful sync. */
  lastSyncedAt?: string;
  /** Id of the most recent Issue comment imported as a ticket note (dedupes re-imports). */
  lastSyncedCommentId?: number;
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
  github?: TicketGithubLink;
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
