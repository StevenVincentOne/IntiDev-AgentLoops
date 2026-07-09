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

/**
 * Optional reporter self-assessment captured at intake time: "what do you
 * already believe about this ticket's novelty/relatedness?" ("History
 * context" in Inti's intake form). Purely informational on its own — but
 * AgentLoops auto-surfaces `related`/`nearDuplicates` candidates at creation
 * time when a hint suggests the reporter believes prior art may exist (see
 * `PRIOR_ART_HINT_AUTO_SURFACE` in prior-art.ts), turning a self-report into
 * an actionable check rather than just a label.
 */
export type PriorArtHint =
  | "new"
  | "previously_ticketed"
  | "existing_pattern"
  | "adjacent_issues";

/**
 * How broad a fix is being claimed in a `VerificationBrief`: a single ticket,
 * a computed Group, a tracked Pattern, or a cascade across linked tickets.
 * Group/Pattern/cascade claims face stricter guardrails than single-ticket
 * ones — see `verification.ts`.
 */
export type VerificationClaimScope = "single_ticket" | "group" | "pattern" | "cascade";

/**
 * A structured account of what was verified before claiming a fix is proven,
 * required for "evidence-sensitive" tickets/Patterns before they can be
 * resolved with high confidence (see `ProjectConfig.verification` and
 * `verification.ts`). Generalized from Inti's Reader-specific document
 * verification brief: deterministic rules check that the brief is present,
 * internally coherent, and names the right scope; the agent supplies the
 * actual judgment about whether the evidence proves the claim
 * (`agentJudgment`/`reason`) — rules keep the evidence honest, the agent
 * decides whether it is sufficient. Raw commands/logs are not enough by
 * themselves: an agent must state what was verified, what scope was claimed,
 * what coverage was achieved, and why that evidence is sufficient.
 */
export interface VerificationBrief {
  /** How broad the fix is being claimed to be. */
  claimScope: VerificationClaimScope;
  /** Known affected artifact/entity ids (document ids, record ids, routes, etc.) the fix claims to cover. */
  affectedArtifactIds?: string[];
  /** Where the issue was reported/reproduced — pages, routes, sections, screenshots, stack traces, etc. */
  reportedLocations?: string[];
  /** What was actually done to verify, e.g. "targeted reupload", "full reprocess", "current-code replay", "unit test", "browser inspection". */
  verificationPerformed: string[];
  /** How much of the claimed scope the verification covered, in prose, e.g. "all reported instances in targeted page ranges". */
  coverage: string;
  /** The agent's sufficiency judgment — the part deterministic rules cannot supply (e.g. "sufficient"). */
  agentJudgment: string;
  /** Why this evidence proves the claimed fix scope. */
  reason: string;
}

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
 * evaluated in order (first match wins); within each queue, a `kind` match is
 * checked before `source`. A queue with only `sources` configured therefore acts
 * as a source fallback when kind does not match.
 */
export interface QueueConfig {
  /** Alias prefix, e.g. "USER", "DEV", "ISSUE". */
  prefix: string;
  /** Ticket kinds routed to this queue. */
  kinds?: TicketKind[];
  /** Sources routed to this queue when this queue's kind does not match. */
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
  /** Optional overrides for the durable, decaying prior-art relationship graph. */
  priorArtGraph?: {
    /** Minimum deterministic score for a ticket pair to become/stay an edge. Default 1. */
    minScore?: number;
    /** Days for a dormant edge's strength to halve. Default 14. */
    decayHalfLifeDays?: number;
    /** Edges decayed below this strength are dropped on refresh. Default 0.05. */
    pruneBelowStrength?: number;
  };
  /** Optional config-driven redaction. Library users can also inject a TicketRedactor directly. */
  redaction?: {
    patterns?: RedactionRule[];
  };
  /**
   * Optional overrides for the Ticket Groups report — broad, low-investment
   * triage clusters of open work, distinct from (and feeding into) Patterns.
   * Ships with generic, zero-config bases (family, tag, auto-detected shared
   * keywords); `customRules` is the path to project-specific clustering
   * vocabulary (e.g. a known error-code list, or an embedded correlation key)
   * without AgentLoops core needing to understand the domain.
   */
  ticketGroups?: {
    /** Minimum members for a cluster to surface as a group. Default 2. */
    minSize?: number;
    /** Maximum groups returned. Default 10. */
    limit?: number;
    /** Project-defined clustering rules — see `TicketGroupCustomRule`. */
    customRules?: TicketGroupCustomRule[];
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
   * Optional config for the Root Cause Certificate requirement.
   *
   * When `meaningfulKinds` (default `["bug","incident","user_feedback"]`) is
   * matched by the ticket's `kind`, resolving with any summary requires an
   * `evidence.rootCauseCertificate` — a compact structured statement of the
   * symptom, code-level root cause, earliest failure stage, source-level fix
   * rationale, failed contract/invariant, files changed, guard decision, and
   * regression risk. Deterministic rules check the certificate is present and
   * that required fields are not TODO-placeholders; the agent remains
   * responsible for the diagnosis being architecturally correct.
   *
   * Set `meaningfulKinds: []` to opt out entirely.
   */
  rootCause?: {
    /** Ticket kinds that require a certificate. Defaults to `["bug","incident","user_feedback"]`. */
    meaningfulKinds?: TicketKind[];
    /** Minimum character length for a text field to be considered "actionable". Default 20. */
    minFieldLength?: number;
  };
  /**
   * Optional config defining "artifact/output-sensitive" domains — ticket
   * families/kinds whose resolutions are easy to mark fixed on weak evidence
   * (e.g. a document/export/render pipeline whose output quality is hard to
   * eyeball from logs alone — the kind of domain where Inti found tickets and
   * Patterns being closed on a single narrow replay that proved far less than
   * it was treated as proving). When a resolution matches a configured
   * sensitive family + kind, `resolveTicket` (and Pattern/Group cascade
   * resolution) require a structured `VerificationBrief` and apply the rules
   * in `verification.ts` as guardrails — deterministic checks that the right
   * *shape* of evidence is present, while the agent supplies the actual
   * sufficiency *judgment* (`agentJudgment`/`reason`).
   *
   * Entirely opt-in and domain-agnostic: nothing here hardcodes a particular
   * project's artifact vocabulary (e.g. no "Reader"/"document" names baked
   * in). Ships with no sensitive domains configured, so every ticket keeps
   * the lightweight resolution path until a host project opts in by setting
   * `sensitiveFamilyPatterns`.
   */
  verification?: {
    /** Regex sources matched against `Ticket.family` marking a domain as evidence-sensitive. Empty/absent disables the whole feature. */
    sensitiveFamilyPatterns?: string[];
    /** Ticket kinds that require a brief when resolved in a sensitive family. Defaults to `["bug", "incident"]`. */
    sensitiveKinds?: TicketKind[];
    /**
     * Single-capture-group regex extracting "known affected artifact/entity
     * ids" from a ticket's title/summary/tags (e.g. a document id, order id,
     * route, correlation key) — generalizes Inti's `correlation_key`-derived
     * document-id checks without inventing a new structured Ticket field.
     * Omit if the domain has no such concept; rule 4 then never applies.
     */
    artifactIdPattern?: string;
    /** Regex sources recognizing "fresh"/end-to-end verification language (reuploads, full reprocesses, post-ingest scans, live/browser checks) — required for recurrences and Group/Pattern/cascade claims. Generic defaults apply when omitted. */
    freshVerificationPatterns?: string[];
    /** Regex sources recognizing replay/local/unit-only verification language — sufficient only for narrow, non-recurring single-ticket fixes that name the affected id (rule 7). Generic defaults apply when omitted. */
    replayVerificationPatterns?: string[];
    /** Regex sources recognizing "broad coverage" language ("all reported instances", "every linked ticket", "full export") — required when resolving a Group/Pattern/cascade across multiple sensitive tickets. Generic defaults apply when omitted. */
    broadCoveragePatterns?: string[];
    /** Values accepted for `verificationBrief.agentJudgment` as an explicit sufficiency call. Defaults to `["sufficient", "verified", "proven"]`. */
    sufficientJudgments?: string[];
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

/**
 * A project-defined extension rule for the Ticket Groups report — the
 * customization path that lets a host project express its own recurring-
 * symptom vocabulary or embedded correlation keys without AgentLoops core
 * needing to know what they mean.
 *
 * - `"keyword"`: does `pattern` match the ticket's text? If so, every matching
 *   ticket joins one shared bucket named `name` (e.g. a known error code).
 * - `"correlation"`: `pattern` must contain exactly one capture group; the
 *   captured text becomes the bucket key, so tickets are grouped by whatever
 *   value they share (e.g. a document id, a release tag, a customer id)
 *   rather than by the rule itself.
 */
export interface TicketGroupCustomRule {
  /** Stable identifier; appears in the resulting group's key as `custom:<name>` (or `custom:<name>:<captured>`). */
  name: string;
  /** Human label for groups this rule produces, e.g. "Known error code" or "Document". */
  label: string;
  kind: "keyword" | "correlation";
  /** Regex source. "correlation" rules must include exactly one capture group. */
  pattern: string;
  /** Regex flags; defaults to "i". */
  flags?: string;
  /** Ticket text fields to search, in order. Defaults to title + summary + handoffText. */
  fields?: Array<"title" | "summary" | "handoffText">;
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

/**
 * A non-destructive trust overlay applied to a resolved ticket that was
 * resolved before the current verification workflow stabilised (or that has
 * evidence of inadequate verification). Surfaces in `related` and prior-art
 * output so agents see the warning when they are about to reuse the history
 * as settled proof.
 *
 * Levels:
 * - `trusted`     — no concerns; full reuse confidence (default / implicit)
 * - `provisional` — resolved in a weak-evidence era; treat as hypothesis,
 *                   verify independently before reusing
 * - `suspect`     — specific evidence of inadequate or wrong verification
 * - `deprecated`  — should no longer guide future fixes at all
 */
export type PriorArtTrustLevel = "trusted" | "provisional" | "suspect" | "deprecated";

export interface PriorArtTrust {
  level: PriorArtTrustLevel;
  /** Human/agent summary of why this level was applied. */
  auditStatus?: string;
  /** The cutoff date used during the audit, if applied via `prior-art-audit`. */
  cutoffDate?: string;
  /** Machine-readable reasons surfaced during the audit. */
  reasons?: string[];
}

/**
 * A structured root-cause statement required when resolving a meaningful
 * fixed bug, incident, or user-feedback ticket. The point is NOT to make the
 * ledger know the root cause — it is to force the agent to make an explicit
 * architectural claim before resolution. Deterministic rules check the
 * certificate is present and non-placeholder; the agent remains responsible
 * for the diagnosis being correct.
 *
 * Generated scaffold: `agentloop evidence-draft <id> --evidence-only`
 */
export interface RootCauseCertificate {
  /** The visible failure symptom as experienced by a user or detector. */
  symptom: string;
  /** The code-level or architecture-level root cause — not just a restatement of the symptom. */
  rootCause: string;
  /** The earliest stage where correct data became incorrect or unavailable. */
  earliestFailureStage: string;
  /** Why the fix is at the earliest responsible layer, or why a downstream fix was chosen. */
  whySourceLevelFixOrWhyNot: string;
  /** The contract or invariant that failed (e.g. "list marker removal must not corrupt inline emphasis"). */
  affectedContractOrInvariant: string;
  /** Source files changed, or `["none: <reason>"]` if no files changed. */
  filesChanged: string[];
  /** Guard decision — names the guard added/existing/waived/deferred and why it catches recurrence. */
  guardDecision: string;
  /** Regression risk: `low | medium | high | critical | none`. */
  regressionRisk: string;
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
  /** Concrete command/test that serves as a regression guard, e.g. `npm test -- --grep "list rendering"`. */
  guardCommand?: string;
  /** Artifact path (test file, smoke spec, detector config) referenced by the guard. */
  guardArtifactRef?: string;
  /** Stable detector/key that should catch recurrence (e.g. a telemetry rule name, CI check id). */
  guardDetectorKey?: string;
  /** Reporter's self-assessed "history context" at intake time, if provided. */
  priorArtHint?: PriorArtHint;
  /** Non-destructive trust overlay — surfaces in prior-art/related output to warn agents about weak historical verification. */
  priorArtTrust?: PriorArtTrust;
  patternId?: string;
  verification?: string;
  reproducible?: boolean;
  resolutionSummary?: string;
  /**
   * Structured verification evidence supplied at resolution time for
   * evidence-sensitive tickets (see `ProjectConfig.verification`). Persisted
   * alongside `resolutionSummary`/`verification` so the brief that justified
   * closing the ticket remains auditable later — e.g. when `workflow_audit`
   * or a future agent re-examines whether a resolution actually held up.
   */
  verificationBrief?: VerificationBrief;
  /**
   * Structured root-cause statement, required for meaningful fixed
   * bugs/incidents/user-feedback (see `ProjectConfig.rootCause`). Persisted
   * alongside the resolution so the architectural claim behind the fix is
   * auditable later. Generated scaffold: `agentloop evidence-draft <id>`.
   */
  rootCauseCertificate?: RootCauseCertificate;
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
  /**
   * Optional free-text description, mirroring `Ticket.summary`/`resolutionSummary`.
   * Populated (and refreshed) by `promote-group` with human-readable provenance —
   * e.g. which computed Ticket Group it was promoted from, its basis, and any
   * candidate splits — kept as prose rather than a structured metadata blob so
   * it stays consistent with the rest of the schema's "thin but readable" style.
   */
  summary?: string;
}

/**
 * A durable, decaying edge between two tickets in the prior-art relationship
 * graph. Unlike `relatedTickets()` (which scores relatedness fresh on every
 * call), edges persist across runs: `refreshPriorArtGraph` recomputes the
 * deterministic score for every ticket pair, reinforces edges that still
 * qualify (bumping `lastSeenAt`/`score`), and lets edges that no longer
 * qualify fade — `strength` decays toward zero the longer `lastSeenAt` ages,
 * so stale connections quietly lose weight instead of vanishing outright or
 * staying permanently pinned at their peak score.
 */
export interface PriorArtEdge {
  id: string;
  /** Canonical pair, ticketIds[0] < ticketIds[1] (string compare) so each pair has exactly one edge. */
  ticketIds: [string, string];
  /** Most recent deterministic relatedness score for this pair (same signals as `relatedTickets`). */
  score: number;
  /** Most recent evidence for the edge, e.g. ["family", "tag:export", "text:0.42"]. */
  signals: string[];
  /** Decayed durability, recomputed at query time from `score`/`lastSeenAt`/now. Persisted as of the last refresh. */
  strength: number;
  firstSeenAt: string;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface LoopState {
  version: number;
  project: string;
  createdAt: string;
  updatedAt: string;
  nextTicketSeq: number;
  nextPatternSeq: number;
  nextPriorArtEdgeSeq: number;
  tickets: Ticket[];
  patterns: Pattern[];
  priorArtEdges: PriorArtEdge[];
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
  /** Reporter's self-assessed "history context" at intake time, if provided. */
  priorArtHint?: PriorArtHint;
}

export interface ResolveInput {
  id: string;
  summary: string;
  verification?: string;
  guardStatus?: GuardStatus;
  guardSummary?: string;
  /**
   * Structured verification evidence — required (and checked by
   * `assertVerificationBriefForResolution`) when the ticket falls in a
   * configured evidence-sensitive domain/kind (`ProjectConfig.verification`).
   * Optional for every other ticket, which keeps the lightweight resolution
   * path lightweight.
   */
  verificationBrief?: VerificationBrief;
  /**
   * Structured root-cause statement — required (and checked by
   * `assertRootCauseCertificateForResolution`) when resolving a meaningful
   * fixed bug, incident, or user-feedback ticket (see `ProjectConfig.rootCause`).
   * Generate a scaffold with `agentloop evidence-draft <id> --evidence-only`.
   */
  rootCauseCertificate?: RootCauseCertificate;
  /** Concrete command/test serving as a regression guard (e.g. `npm test -- --grep "..."`) — surfaced in `resolve-draft` output. */
  guardCommand?: string;
  /** Artifact path (test file, smoke spec) referenced by the guard. */
  guardArtifactRef?: string;
  /** Stable detector/rule key that would catch recurrence. */
  guardDetectorKey?: string;
}

// ── Classify-siblings ─────────────────────────────────────────────────────────

/** Categories used to persist sibling ticket classifications from sweep/expansion review. */
export type SiblingClassification = "same_root" | "adjacent" | "unverified" | "unrelated";

export interface ClassifySiblingsInput {
  /** The seed ticket (the one under investigation). */
  seedId: string;
  /** Tickets classified as same root cause / accepted bucket. */
  sameRoot?: string[];
  /** Tickets classified as adjacent or different root cause. */
  adjacent?: string[];
  /** Tickets whose coverage is unverified / artifacts unavailable. */
  unverified?: string[];
  /** Tickets classified as unrelated. */
  unrelated?: string[];
  /** Human or agent reason for the classification. */
  reason?: string;
  /** If true, create a durable same-root prior-art link for `sameRoot` tickets. */
  linkSameRoot?: boolean;
}

export interface ClassifySiblingsResult {
  seedId: string;
  classified: Array<{ ticketId: string; category: SiblingClassification }>;
  linkedSameRoot: boolean;
}

// ── Ticket sweep ──────────────────────────────────────────────────────────────

export interface TicketSweepCandidate {
  id: string;
  title: string;
  status: string;
  family: string;
  score: number;
  reasons: string[];
  resolutionSummary?: string;
  guardStatus?: string;
  priorArtTrust?: PriorArtTrustLevel;
}

export interface TicketSweepRootCauseBucket {
  label: string;
  confidence: "low" | "medium" | "high";
  /** Always `"agent_must_decide"` — the sweep surfaces candidates, not verdicts. */
  coveredByCurrentFix: "agent_must_decide";
  ticketIds: string[];
  guidance: string;
}

export interface TicketSweepResult {
  seed: { id: string; title: string; status: string; family: string };
  symptomSignature: { label: string; tokens: string[] };
  candidates: {
    likelySameSymptom: TicketSweepCandidate[];
    adjacentOrDifferentRoot: TicketSweepCandidate[];
    historicalPriorArt: TicketSweepCandidate[];
    patternMatches: Array<{ patternId: string; title: string; status: string; score: number }>;
  };
  rootCauseBuckets: TicketSweepRootCauseBucket[];
  recommendedActions: string[];
}

// ── Prior-art audit ───────────────────────────────────────────────────────────

export interface PriorArtAuditOptions {
  /** ISO date — tickets resolved on or before this date are included. Default: current date. */
  cutoffDate?: string;
  family?: string;
  limit?: number;
  /** If true, write the trust level to `Ticket.priorArtTrust` and persist. */
  apply?: boolean;
  /** If true and `apply`, also add a triage note explaining the trust level. */
  addNote?: boolean;
  /** Trust level to apply. Default `provisional`. */
  trustLevel?: PriorArtTrustLevel;
  /** If true, overwrite an existing trust level even if it is already at or above the requested level. */
  overwrite?: boolean;
}

export interface PriorArtAuditRow {
  ticketId: string;
  title: string;
  family: string;
  kind: string;
  status: string;
  resolvedAt: string | null;
  hasVerification: boolean;
  hasGuard: boolean;
  hasResolutionSummary: boolean;
  activeSameFamilyCount: number;
  existingTrust: PriorArtTrustLevel | null;
  recommendedTrust: PriorArtTrustLevel;
  reasons: string[];
  applied?: boolean;
  noteCreated?: boolean;
}

export interface PriorArtAuditResult {
  cutoffDate: string;
  count: number;
  byRecommendedTrust: Record<string, number>;
  applied: number;
  rows: PriorArtAuditRow[];
}
