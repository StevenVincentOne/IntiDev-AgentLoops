import { GuardStatus, Pattern, ProjectConfig, ResolveInput, Ticket, TicketKind, VerificationBrief } from "./types";

/**
 * Verification-brief guardrails (ported concept from Inti's Reader
 * artifact-verification contract, generalized for an open-source Tickets
 * system).
 *
 * The problem this solves: deterministic resolver rules can accept weak
 * evidence too early — e.g. cascade-resolving a multi-ticket Pattern from a
 * single current-code replay of one page/region proves only a narrow case,
 * but a rule that just checks "was something verified?" will treat that as
 * sufficient to close the whole Pattern.
 *
 * The fix is *not* to make the rules smarter judges — it's to keep them as
 * guardrails that ensure the right *shape* of evidence is present (a
 * structured brief naming scope, affected ids, methods, and coverage), while
 * leaving the actual sufficiency *judgment* to the agent
 * (`verificationBrief.agentJudgment`/`reason`). Rules keep the evidence
 * honest; the agent decides whether the evidence actually proves the claim.
 *
 * Domain vocabulary is entirely config-driven (`ProjectConfig.verification`)
 * — nothing here hardcodes a particular project's artifact names. A host
 * project that never configures `verification.sensitiveFamilyPatterns` sees
 * no change: every ticket keeps the lightweight resolution path.
 */

/** How broad a fix is being claimed: one ticket, a triage Group, a Pattern, or a cascade across linked tickets. */
export type VerificationClaimScope = "single_ticket" | "group" | "pattern" | "cascade";

const CASCADE_SCOPES: ReadonlySet<VerificationClaimScope> = new Set(["group", "pattern", "cascade"]);

/** Ticket kinds that require a brief in a sensitive family when `verification.sensitiveKinds` is not configured. */
export const DEFAULT_SENSITIVE_KINDS: TicketKind[] = ["bug", "incident"];

/** Values accepted for `verificationBrief.agentJudgment` when `verification.sufficientJudgments` is not configured. */
export const DEFAULT_SUFFICIENT_JUDGMENTS = ["sufficient", "verified", "proven"];

/** Minimum substantive length for `verificationBrief.reason` — long enough to rule out placeholders like "fixed". */
export const MIN_VERIFICATION_REASON_LENGTH = 20;

/**
 * Default "fresh / end-to-end" verification vocabulary: evidence that
 * exercises the changed code path against live or freshly produced output,
 * as opposed to a cached/local replay. Generic stand-ins for Inti's
 * Reader-specific "reupload"/"post-ingest scan"/etc. — override via
 * `verification.freshVerificationPatterns` to match a project's real tooling.
 */
export const DEFAULT_FRESH_VERIFICATION_PATTERNS = [
  "re-?upload",
  "full reprocess",
  "reprocess",
  "post-ingest scan",
  "fresh (run|build|deploy|process|ingest)",
  "end-to-end",
  "browser inspection",
  "live (run|check|test|smoke)",
  "registered smoke",
  "smoke test",
];

/**
 * Default replay/local/unit verification vocabulary — useful for diagnosis
 * and for closing a single narrow ticket (see rule 7), but not enough on its
 * own for recurrences or cascades. Override via `verification.replayVerificationPatterns`.
 */
export const DEFAULT_REPLAY_VERIFICATION_PATTERNS = [
  "current-code replay",
  "\\breplay\\b",
  "unit test",
  "local (run|check|test)",
  "\\bfixture\\b",
  "cached artifact",
];

/**
 * Default "broad coverage" vocabulary required when a brief claims a
 * Group/Pattern/cascade scope — narrow per-instance language should not be
 * enough to close many tickets at once. Override via `verification.broadCoveragePatterns`.
 */
export const DEFAULT_BROAD_COVERAGE_PATTERNS = [
  "all reported instances",
  "every linked ticket",
  "all linked tickets",
  "full (export|document|workflow|artifact|run|pipeline)",
  "all affected",
  "across all",
  "\\bentire\\b",
  "complete coverage",
  "affected ranges?",
];

function compilePatterns(sources: string[] | undefined, fallback: string[]): RegExp[] {
  const list = sources && sources.length > 0 ? sources : fallback;
  const compiled: RegExp[] = [];
  for (const source of list) {
    try {
      compiled.push(new RegExp(source, "i"));
    } catch {
      // Skip invalid project-supplied regex rather than failing resolution outright.
    }
  }
  return compiled;
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  if (!text) return false;
  return patterns.some((pattern) => pattern.test(text));
}

/** True when `family` matches one of the project's configured evidence-sensitive domain patterns. */
export function isSensitiveFamily(family: string, config: ProjectConfig): boolean {
  const sources = config.verification?.sensitiveFamilyPatterns;
  if (!sources || sources.length === 0) return false;
  return compilePatterns(sources, []).some((pattern) => pattern.test(family));
}

/**
 * Gate: does resolving this ticket require a structured `verificationBrief`?
 * True only when the project has opted into evidence-sensitive domains
 * (`verification.sensitiveFamilyPatterns`), the ticket's family matches one,
 * and its kind is in the configured (or default) sensitive-kinds list.
 *
 * AgentLoops' `resolveTicket` is single-path — every resolution claims
 * "fixed and verified" (there is no separate `wont_fix`/`duplicate` outcome
 * the way Inti has `resolutionType`), so unlike Inti's gate this does not
 * need to branch on resolution type/verification status: reaching this gate
 * at all means the agent is claiming the fix is proven.
 */
export function requiresVerificationBrief(ticket: Ticket, config: ProjectConfig): boolean {
  if (!isSensitiveFamily(ticket.family, config)) return false;
  const sensitiveKinds = config.verification?.sensitiveKinds ?? DEFAULT_SENSITIVE_KINDS;
  return sensitiveKinds.includes(ticket.kind);
}

/**
 * "Known affected artifact/entity ids" extracted from the ticket's own text
 * via a single-capture-group regex (`verification.artifactIdPattern`) —
 * generalizes Inti's `correlation_key`/`metadata_json` document-id derivation
 * without inventing new structured Ticket fields. A project with no such
 * concept (no `artifactIdPattern` configured) simply never trips rule 4.
 */
export function extractKnownArtifactIds(ticket: Ticket, config: ProjectConfig): string[] {
  const source = config.verification?.artifactIdPattern;
  if (!source) return [];
  let pattern: RegExp;
  try {
    pattern = new RegExp(source, "gi");
  } catch {
    return [];
  }
  const ids = new Set<string>();
  const haystacks = [ticket.title, ticket.summary, ...(ticket.tags ?? [])];
  for (const text of haystacks) {
    if (!text) continue;
    for (const match of text.matchAll(pattern)) {
      const id = (match[1] ?? match[0])?.trim();
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

/**
 * Recurrence/prior-work signal — reuses the *existing* `Ticket.priorArtHint`
 * primitive rather than inventing new "history signal" schema. Maps directly
 * onto Inti's `clusterCarriesPriorWorkCue` (which checks `historySignals` for
 * `previously_ticketed`/`existing_pattern`): AgentLoops already records the
 * same two states as `PriorArtHint` values.
 */
export function carriesPriorWorkCue(ticket: Ticket): boolean {
  return ticket.priorArtHint === "previously_ticketed" || ticket.priorArtHint === "existing_pattern";
}

function judgmentText(brief: VerificationBrief): string {
  return (brief.agentJudgment ?? "").trim().toLowerCase();
}

/** True when `verificationBrief.agentJudgment` is one of the project's configured (or default) sufficiency values. */
export function isSufficientJudgment(brief: VerificationBrief, config: ProjectConfig): boolean {
  const allowed = (config.verification?.sufficientJudgments ?? DEFAULT_SUFFICIENT_JUDGMENTS).map((value) =>
    value.trim().toLowerCase(),
  );
  return allowed.includes(judgmentText(brief));
}

function evidenceText(input: Pick<ResolveInput, "summary" | "verification">, brief: VerificationBrief): string {
  return [
    input.summary,
    input.verification,
    brief.coverage,
    brief.reason,
    ...(brief.reportedLocations ?? []),
    ...(brief.affectedArtifactIds ?? []),
  ]
    .filter((part): part is string => Boolean(part && part.trim().length > 0))
    .join("\n");
}

/** Options that escalate the brief requirements beyond what the brief itself claims — used by Pattern/Group cascade resolution. */
export interface VerificationAssertionOptions {
  /**
   * Force the "fresh / end-to-end evidence" requirement (rule 5) regardless
   * of the brief's own claim scope or the ticket's `priorArtHint`. Set this
   * when cascading a resolution across multiple linked evidence-sensitive
   * tickets — mirrors Inti's `patternResolutionRequiresFreshDocumentProcessing`
   * (escalated whenever ≥ 2 linked clusters require artifact verification),
   * which is exactly the guardrail the originating bug was missing.
   */
  requireFreshVerification?: boolean;
  /** Force the "broad coverage language" requirement (rule 6) regardless of claim scope. */
  requireBroadCoverage?: boolean;
}

/**
 * The core guardrail: asserts that a resolution of an evidence-sensitive
 * ticket carries a structured, internally-coherent `verificationBrief`.
 * Throws a descriptive `Error` (caught and surfaced by the CLI/MCP layers)
 * when a rule is violated; does nothing for tickets outside a configured
 * sensitive domain/kind (the lightweight path stays lightweight).
 *
 * Implements the seven generalized rules from the verification-workflow
 * design (in order):
 *   1. Sensitive-domain + sensitive-kind resolutions require a brief.
 *   2. `agentJudgment` must be an explicit sufficiency value — the one part
 *      these deterministic rules cannot supply themselves.
 *   3. `reason` must be substantive, not a placeholder.
 *   4. Known affected artifact/entity ids must be named in the brief/evidence.
 *   5. Recurrences (`priorArtHint`) and Group/Pattern/cascade claims require
 *      fresh/end-to-end evidence, not replay-only/unit-only proof.
 *   6. Group/Pattern/cascade claims require broad-coverage language.
 *   7. Replay/local/unit evidence may close only a narrow `single_ticket`
 *      claim that names the affected id and carries no recurrence cue.
 */
export function assertVerificationBriefForResolution(
  ticket: Ticket,
  input: Pick<ResolveInput, "summary" | "verification" | "verificationBrief">,
  config: ProjectConfig,
  options: VerificationAssertionOptions = {},
): void {
  if (!requiresVerificationBrief(ticket, config)) return;

  const brief = input.verificationBrief;
  if (!brief) {
    throw new Error(
      `${ticket.id}: resolving a "${ticket.family}" ${ticket.kind} requires a structured verificationBrief ` +
        `(claimScope, verificationPerformed, coverage, agentJudgment, reason) — raw commands/logs are not enough ` +
        `by themselves to close an evidence-sensitive ticket. See docs/agent-integration.md.`,
    );
  }

  // Rule 2 — the agent must explicitly state the evidence is sufficient; deterministic
  // rules cannot supply this judgment, only check that it was made.
  if (!isSufficientJudgment(brief, config)) {
    const allowed = config.verification?.sufficientJudgments ?? DEFAULT_SUFFICIENT_JUDGMENTS;
    throw new Error(
      `${ticket.id}: verificationBrief.agentJudgment must be an explicit sufficiency call (one of: ${allowed.join(", ")}) ` +
        `— state plainly whether the evidence proves the claimed fix scope.`,
    );
  }

  // Rule 3 — a meaningful reason, not "fixed"/"should work now".
  if (!brief.reason || brief.reason.trim().length < MIN_VERIFICATION_REASON_LENGTH) {
    throw new Error(
      `${ticket.id}: verificationBrief.reason must explain *why* this evidence covers the claimed fix scope ` +
        `(at least ${MIN_VERIFICATION_REASON_LENGTH} characters — placeholders like "fixed" or "should work now" are not a reason).`,
    );
  }

  const text = evidenceText(input, brief);

  // Rule 4 — known affected ids must be checkable in the brief/evidence.
  const knownIds = extractKnownArtifactIds(ticket, config);
  if (knownIds.length > 0) {
    const named = knownIds.every(
      (id) => (brief.affectedArtifactIds ?? []).includes(id) || text.includes(id),
    );
    if (!named) {
      throw new Error(
        `${ticket.id}: this ticket names known affected artifact/entity id(s) (${knownIds.join(", ")}) — ` +
          `verificationBrief.affectedArtifactIds (or the evidence text) must name them so the claim is checkable, ` +
          `not just asserted.`,
      );
    }
  }

  const freshPatterns = compilePatterns(
    config.verification?.freshVerificationPatterns,
    DEFAULT_FRESH_VERIFICATION_PATTERNS,
  );
  const replayPatterns = compilePatterns(
    config.verification?.replayVerificationPatterns,
    DEFAULT_REPLAY_VERIFICATION_PATTERNS,
  );
  const methodsText = (brief.verificationPerformed ?? []).join("\n");
  const hasFresh = matchesAny(methodsText, freshPatterns) || matchesAny(text, freshPatterns);
  const hasReplaySignal = matchesAny(methodsText, replayPatterns) || matchesAny(text, replayPatterns);
  const replayOnly = hasReplaySignal && !hasFresh;

  const priorWorkCue = carriesPriorWorkCue(ticket);
  const cascadeScope = CASCADE_SCOPES.has(brief.claimScope);
  const requireFresh = options.requireFreshVerification === true || priorWorkCue || cascadeScope;

  // Rule 5 — recurrences and Group/Pattern/cascade claims need fresh/end-to-end
  // evidence; this is precisely the guardrail the originating bug lacked
  // (a single-page replay was accepted as proof for a multi-ticket Pattern).
  if (requireFresh && !hasFresh) {
    const why = priorWorkCue
      ? `this ticket carries a prior-work cue (priorArtHint: "${ticket.priorArtHint}")`
      : `this resolution claims a "${brief.claimScope}" scope spanning multiple tickets`;
    throw new Error(
      `${ticket.id}: ${why} — replay-only/unit-only evidence is not enough here. ` +
        `verificationBrief.verificationPerformed must include a fresh or end-to-end method ` +
        `(e.g. a targeted reupload, full reprocess, post-ingest scan, or live/browser check), ` +
        `not just a cached replay or unit test.`,
    );
  }

  // Rule 6 — Group/Pattern/cascade claims need broad-coverage language: a
  // narrow "this one instance" coverage statement should not close many tickets.
  const broadPatterns = compilePatterns(config.verification?.broadCoveragePatterns, DEFAULT_BROAD_COVERAGE_PATTERNS);
  const requireBroad = options.requireBroadCoverage === true || cascadeScope;
  if (requireBroad && !matchesAny(brief.coverage ?? "", broadPatterns) && !matchesAny(text, broadPatterns)) {
    throw new Error(
      `${ticket.id}: resolving a "${brief.claimScope}" scope requires broad-coverage language in ` +
        `verificationBrief.coverage (e.g. "all reported instances", "every linked ticket", "full <artifact/workflow>") ` +
        `— narrow, single-instance coverage cannot justify closing multiple tickets at once.`,
    );
  }

  // Rule 7 — replay/local/unit evidence may close only a narrow, non-recurring,
  // named-id single-ticket claim; everything else needs fresh/end-to-end proof.
  if (replayOnly && (cascadeScope || priorWorkCue || brief.claimScope !== "single_ticket" || knownIds.length === 0)) {
    throw new Error(
      `${ticket.id}: replay/local/unit verification can support diagnosis, but it can only close a narrow ` +
        `single-ticket fix when the claim scope is "single_ticket", the ticket carries no recurrence/prior-work cue, ` +
        `and the affected artifact/entity id is named — use fresh or end-to-end verification for this resolution instead.`,
    );
  }
}

/**
 * Input for cascading a Pattern resolution to its not-yet-resolved linked
 * tickets — the multi-ticket counterpart to `ResolveInput` (see
 * `AgentLoopStore.cascadeResolvePattern`). One resolution narrative and one
 * `verificationBrief` apply to every linked ticket, exactly as Inti's
 * `resolve-pattern --resolve-linked` applies a single evidence bundle across
 * a cluster of linked tickets.
 */
export interface CascadeResolveInput {
  /** Pattern id (e.g. `PATTERN-000007`) to resolve and cascade. */
  patternId: string;
  summary: string;
  verification?: string;
  guardStatus?: GuardStatus;
  guardSummary?: string;
  /**
   * Required (and checked against the *strictest* applicable rules — see
   * `escalatedVerification` on the result) when ≥ 1 linked ticket falls in a
   * configured evidence-sensitive domain/kind.
   */
  verificationBrief?: VerificationBrief;
}

export interface CascadeResolveResult {
  pattern: Pattern;
  /** Linked tickets resolved by this cascade. */
  resolvedTickets: Ticket[];
  /** Linked tickets that were already resolved before the cascade ran — left untouched. */
  alreadyResolvedTickets: Ticket[];
  /**
   * True when ≥ 2 linked tickets required a verification brief, which
   * escalates the fresh-evidence (rule 5) and broad-coverage (rule 6)
   * requirements for *every* sensitive linked ticket regardless of the
   * brief's own claimed scope — mirrors Inti's
   * `patternResolutionRequiresFreshDocumentProcessing` and is precisely the
   * guardrail the originating bug lacked (a single narrow replay was treated
   * as sufficient to cascade-close a multi-ticket Pattern).
   */
  escalatedVerification: boolean;
}

/**
 * Computes the assertion options for cascading a Pattern resolution across
 * `linkedTickets`: counts how many require a verification brief and, when
 * more than one does, escalates fresh-evidence + broad-coverage requirements
 * for all of them — "Pattern/group cascade resolution should require
 * stronger coverage than single-ticket resolution."
 */
export function planCascadeVerification(
  linkedTickets: Ticket[],
  config: ProjectConfig,
): { sensitiveCount: number; escalate: boolean; optionsFor: (ticket: Ticket) => VerificationAssertionOptions } {
  const sensitiveCount = linkedTickets.filter((ticket) => requiresVerificationBrief(ticket, config)).length;
  const escalate = sensitiveCount > 1;
  return {
    sensitiveCount,
    escalate,
    optionsFor: () => ({ requireFreshVerification: escalate, requireBroadCoverage: escalate }),
  };
}
