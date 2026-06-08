import { Pattern, PatternStatus, Severity, Ticket, TicketGroupCustomRule, TicketStatus } from "./types";
import { jaccard, PriorArtReport, tokenize } from "./prior-art";
import { ResolutionKnowledgeReport } from "./knowledge";

export const TICKET_GROUPS_SCHEMA_VERSION = 1 as const;

/** Statuses considered "open work" — Groups exist to triage active problems. */
const OPEN_TICKET_STATUSES = new Set<TicketStatus>(["triaged", "active", "reopened", "deferred"]);

/** Default minimum members for a cluster to surface as a group (and for a candidate split within one). */
export const DEFAULT_TICKET_GROUP_MIN_SIZE = 2;

/** Default cap on the number of groups returned. */
export const DEFAULT_TICKET_GROUP_LIMIT = 10;

/** Default cap on candidate splits surfaced per group. */
const MAX_CANDIDATE_SPLITS = 8;

/** Default cap on member ids listed per candidate split. */
const MAX_SPLIT_TICKET_KEYS = 8;

const SEVERITY_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export type TicketGroupBasisKind = "family" | "tag" | "keyword" | "custom";

export interface TicketGroupOptions {
  /** Restrict to a single family. */
  family?: string;
  /** Minimum members for a cluster to surface as a group. Default 2 (or config override). */
  minSize?: number;
  /** Maximum groups to return. Default 10 (or config override). */
  limit?: number;
  /**
   * Project-defined extension rules (generalizes domain-specific clustering —
   * e.g. a recurring symptom-code vocabulary, or a correlation-key embedded in
   * ticket text) without AgentLoops core needing to know the domain. Usually
   * supplied via `ProjectConfig.ticketGroups.customRules`; passing here
   * overrides the config value (mainly useful for tests/tooling).
   */
   customRules?: TicketGroupCustomRule[];
}

export interface TicketGroupMember {
  id: string;
  alias: string;
  kind: string;
  source: string;
  family: string;
  status: string;
  severity: Severity;
  title: string;
}

export interface TicketGroupCandidateSplit {
  /** Stable key for the candidate sub-cluster, e.g. "tag:export" or "custom:doc_id:report-7". */
  key: string;
  /** Human-readable label for the candidate sub-cluster. */
  label: string;
  count: number;
  ticketKeys: string[];
}

export interface TicketGroup {
  /** Stable key, e.g. "family:reader_ingestion" or "custom:audit_code:untagged_visual_caption_candidate". */
  key: string;
  basis: TicketGroupBasisKind;
  title: string;
  summary: string;
  tickets: TicketGroupMember[];
  activeCount: number;
  severity: Severity;
  /** Most recent `updatedAt` (falling back to `createdAt`) among member tickets. */
  latestAt: string | null;
  /**
   * Sub-clusters within this group that share a *different* (narrower) signal
   * — candidates worth reviewing as their own, more specific Group or Pattern
   * before assuming the whole group shares one root cause.
   */
  candidateSplits: TicketGroupCandidateSplit[];
}

export interface TicketGroupsReport {
  schemaVersion: typeof TICKET_GROUPS_SCHEMA_VERSION;
  generatedAt: string;
  filters: { family: string | null; minSize: number; limit: number };
  summary: {
    /** Active tickets considered (after status/family scoping). */
    ticketsConsidered: number;
    groupsFlagged: number;
  };
  groups: TicketGroup[];
}

function toMember(ticket: Ticket): TicketGroupMember {
  return {
    id: ticket.id,
    alias: ticket.aliases[0] ?? ticket.id,
    kind: ticket.kind,
    source: ticket.source,
    family: ticket.family,
    status: ticket.status,
    severity: ticket.severity,
    title: ticket.title,
  };
}

function ticketText(ticket: Ticket, fields?: Array<"title" | "summary" | "handoffText">): string {
  const selected = fields && fields.length > 0 ? fields : (["title", "summary", "handoffText"] as const);
  return selected
    .map((field) => (field === "handoffText" ? ticket.handoffText : ticket[field]))
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n");
}

function titleCase(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function familyLabel(family: string): string {
  return titleCase(family) || family;
}

/** A single basis "hit" for one ticket: a candidate cluster key, plus the label/summary the resulting group should carry. */
interface BasisSignal {
  basis: TicketGroupBasisKind;
  /** Suffix identifying the cluster within its basis, e.g. "reader_ingestion" or "export". */
  bucket: string;
  label: string;
  summary: string;
}

function basisKey(signal: Pick<BasisSignal, "basis" | "bucket">): string {
  return `${signal.basis}:${signal.bucket}`;
}

const FAMILY_SUMMARY =
  "Tickets share a broad family. Useful for a first pass, but a shared family alone rarely proves a shared root cause — look for a narrower signal (tag, keyword, or a project-defined rule) before linking these to one Pattern.";
const TAG_SUMMARY =
  "Tickets share a tag. A reasonable triage cluster — worth reviewing together, and a candidate Pattern if a deeper signal corroborates it.";
const KEYWORD_SUMMARY =
  "Tickets share recurring, distinguishing wording in their titles/summaries. Often a sign of the same symptom reported from different angles — a good candidate for a shared Pattern once the cause is confirmed.";

/**
 * A set of recurring, distinguishing tokens that happen to be shared by
 * exactly the same subset of tickets — folded into one cluster so e.g.
 * "artifact"/"glyph"/"repeating" all matching the same two tickets surfaces
 * as one "Keyword: artifact, glyph, repeating" group rather than three
 * near-identical ones.
 */
interface KeywordCluster {
  bucket: string;
  tokens: string[];
  memberIds: Set<string>;
}

const MAX_KEYWORD_LABEL_TOKENS = 5;

function keywordLabel(tokens: string[]): string {
  const shown = tokens.slice(0, MAX_KEYWORD_LABEL_TOKENS).map(titleCase);
  const overflow = tokens.length - shown.length;
  return `Keyword: ${shown.join(", ")}${overflow > 0 ? ` (+${overflow} more)` : ""}`;
}

/**
 * Tokens shared by enough (but not all) of `tickets` to be worth clustering
 * on, folded by identical membership. This is the generic, zero-config
 * replacement for Inti's hand-maintained list of known title suffixes — it
 * adapts to whatever recurring vocabulary a project's tickets actually use.
 */
function autoKeywordClusters(tickets: Ticket[], minSize: number): KeywordCluster[] {
  const tokenMembers = new Map<string, Ticket[]>();
  for (const ticket of tickets) {
    for (const token of tokenize(`${ticket.title} ${ticket.summary}`)) {
      const list = tokenMembers.get(token) ?? [];
      list.push(ticket);
      tokenMembers.set(token, list);
    }
  }

  const bySignature = new Map<string, { tokens: Set<string>; members: Ticket[] }>();
  for (const [token, members] of tokenMembers) {
    if (members.length < minSize || members.length >= tickets.length) continue;
    const signature = members
      .map((ticket) => ticket.id)
      .sort()
      .join("|");
    const entry = bySignature.get(signature) ?? { tokens: new Set<string>(), members };
    entry.tokens.add(token);
    bySignature.set(signature, entry);
  }

  return Array.from(bySignature.values()).map((entry) => {
    const tokens = Array.from(entry.tokens).sort();
    return {
      bucket: tokens.join("+"),
      tokens,
      memberIds: new Set(entry.members.map((ticket) => ticket.id)),
    };
  });
}

/** Index clusters by ticket id so `ticketSignals` can look up "which keyword clusters is this ticket in?" in O(1). */
function indexKeywordClusters(clusters: KeywordCluster[]): Map<string, KeywordCluster[]> {
  const index = new Map<string, KeywordCluster[]>();
  for (const cluster of clusters) {
    for (const id of cluster.memberIds) {
      const list = index.get(id) ?? [];
      list.push(cluster);
      index.set(id, list);
    }
  }
  return index;
}

function customRuleSignals(ticket: Ticket, rules: TicketGroupCustomRule[]): BasisSignal[] {
  const signals: BasisSignal[] = [];
  for (const rule of rules) {
    const text = ticketText(ticket, rule.fields);
    if (!text) continue;
    const flags = rule.flags ?? "i";
    let regex: RegExp;
    try {
      regex = new RegExp(rule.pattern, flags.includes("g") ? flags : `${flags}g`);
    } catch {
      continue;
    }
    if (rule.kind === "correlation") {
      const match = regex.exec(text);
      const captured = match?.[1]?.trim();
      if (captured) {
        signals.push({
          basis: "custom",
          bucket: `${rule.name}:${captured}`,
          label: `${rule.label}: ${captured}`,
          summary: `Tickets share the same ${rule.label.toLowerCase()} ("${captured}") — a strong, concrete candidate for a shared Pattern.`,
        });
      }
    } else {
      if (regex.test(text)) {
        signals.push({
          basis: "custom",
          bucket: rule.name,
          label: rule.label,
          summary: `Tickets matched the project-defined "${rule.label}" rule — a strong candidate for a shared Pattern.`,
        });
      }
    }
  }
  return signals;
}

function ticketSignals(
  ticket: Ticket,
  rules: TicketGroupCustomRule[],
  keywordIndex: Map<string, KeywordCluster[]>,
): BasisSignal[] {
  const signals: BasisSignal[] = [];
  if (ticket.family) {
    signals.push({
      basis: "family",
      bucket: ticket.family,
      label: `Family: ${familyLabel(ticket.family)}`,
      summary: FAMILY_SUMMARY,
    });
  }
  for (const tag of ticket.tags) {
    signals.push({ basis: "tag", bucket: tag, label: `Tag: ${tag}`, summary: TAG_SUMMARY });
  }
  for (const cluster of keywordIndex.get(ticket.id) ?? []) {
    signals.push({
      basis: "keyword",
      bucket: cluster.bucket,
      label: keywordLabel(cluster.tokens),
      summary: KEYWORD_SUMMARY,
    });
  }
  signals.push(...customRuleSignals(ticket, rules));
  return signals;
}

function groupSeverity(tickets: Ticket[]): Severity {
  let worst: Severity = "low";
  for (const ticket of tickets) {
    if (SEVERITY_RANK[ticket.severity] > SEVERITY_RANK[worst]) worst = ticket.severity;
  }
  return worst;
}

function groupLatestAt(tickets: Ticket[]): string | null {
  let latest: { value: string; ms: number } | null = null;
  for (const ticket of tickets) {
    const value = ticket.updatedAt || ticket.createdAt;
    if (!value) continue;
    const ms = new Date(value).getTime() || 0;
    if (!latest || ms > latest.ms) latest = { value, ms };
  }
  return latest?.value ?? null;
}

/**
 * Sub-clusters within `members` that share a signal *other* than the group's
 * own basis key — i.e. narrower candidate splits worth reviewing as their own
 * Group/Pattern before assuming the whole cluster shares one cause.
 */
function candidateSplits(members: Ticket[], ownKey: string, rules: TicketGroupCustomRule[]): TicketGroupCandidateSplit[] {
  // Recomputed over just this group's members: a token shared by 2 of 3
  // members here might not have cleared the global threshold (or might have
  // clustered with a different membership signature globally), so the
  // narrower-signal search has to run fresh at this scope.
  const keywordIndex = indexKeywordClusters(autoKeywordClusters(members, DEFAULT_TICKET_GROUP_MIN_SIZE));
  const buckets = new Map<string, { label: string; tickets: Ticket[] }>();
  for (const ticket of members) {
    for (const signal of ticketSignals(ticket, rules, keywordIndex)) {
      const key = basisKey(signal);
      if (key === ownKey) continue;
      const entry = buckets.get(key) ?? { label: signal.label, tickets: [] };
      entry.tickets.push(ticket);
      buckets.set(key, entry);
    }
  }
  return Array.from(buckets.entries())
    .map(([key, value]) => ({
      key,
      label: value.label,
      count: value.tickets.length,
      ticketKeys: value.tickets.map((ticket) => ticket.aliases[0] ?? ticket.id).slice(0, MAX_SPLIT_TICKET_KEYS),
    }))
    .filter((split) => split.count >= DEFAULT_TICKET_GROUP_MIN_SIZE && split.count < members.length)
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, MAX_CANDIDATE_SPLITS);
}

/**
 * Ticket-Groups report (reframed from Inti's "Ticket Groups" triage panel):
 * clusters open work into broad, low-investment **Groups** — "worth reviewing
 * together," explicitly *not* resolution objects — distinct from the
 * higher-altitude **Pattern** abstraction (a curated, corroborated shared root
 * cause). Groups are the cheap front door; Patterns are what a Group earns
 * once a narrower shared signal is confirmed.
 *
 * Inti's original clustered on four bases — family, a hand-maintained list of
 * known title suffixes, a tagging-audit-code vocabulary, and document-
 * fingerprint/correlation-key parsing. The latter three are domain leakage:
 * useful at Inti, meaningless to a project with different tickets. Rather than
 * porting them verbatim, this report keeps the two bases that travel
 * (`family`, and the existing `tokenize`/`jaccard` text-overlap machinery
 * `near-duplicates.ts` already uses — generalized here into auto-detected
 * shared-keyword clusters instead of a hardcoded suffix list) and adds a
 * generic `tag` basis AgentLoops has but Inti's version didn't use.
 *
 * In place of Inti's hardcoded `audit_code`/`document` bases, this exposes a
 * **`customRules` extension point** (`ProjectConfig.ticketGroups.customRules`):
 * a small declarative rule engine — "keyword" rules (does this regex match?)
 * and "correlation" rules (what does this regex capture?) — so any project can
 * express its own recurring-symptom vocabulary or embedded correlation keys
 * without AgentLoops core ever needing to know what a "tagging audit code" or
 * a "document fingerprint" is. Inti's exact current Groups feature becomes,
 * under this design, just a config file on top of a generic engine.
 *
 * Pure and deterministic apart from `generatedAt` (and the iteration order of
 * `Map`/`Set`, which is itself deterministic for a given input).
 */
export function ticketGroupsReport(tickets: Ticket[], options: TicketGroupOptions = {}): TicketGroupsReport {
  const family = options.family;
  const minSize = options.minSize ?? DEFAULT_TICKET_GROUP_MIN_SIZE;
  const limit = options.limit ?? DEFAULT_TICKET_GROUP_LIMIT;
  const rules = options.customRules ?? [];

  const active = tickets
    .filter((ticket) => (family ? ticket.family === family : true))
    .filter((ticket) => OPEN_TICKET_STATUSES.has(ticket.status))
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id));

  const keywordIndex = indexKeywordClusters(autoKeywordClusters(active, minSize));

  const buckets = new Map<string, { signal: BasisSignal; tickets: Ticket[] }>();
  for (const ticket of active) {
    for (const signal of ticketSignals(ticket, rules, keywordIndex)) {
      const key = basisKey(signal);
      const entry = buckets.get(key) ?? { signal, tickets: [] };
      entry.tickets.push(ticket);
      buckets.set(key, entry);
    }
  }

  const groups: TicketGroup[] = Array.from(buckets.entries())
    .filter(([, entry]) => entry.tickets.length >= minSize && entry.tickets.length < active.length)
    .map(([key, entry]) => ({
      key,
      basis: entry.signal.basis,
      title: entry.signal.label,
      summary: entry.signal.summary,
      tickets: entry.tickets.map(toMember),
      activeCount: entry.tickets.length,
      severity: groupSeverity(entry.tickets),
      latestAt: groupLatestAt(entry.tickets),
      candidateSplits: candidateSplits(entry.tickets, key, rules),
    }))
    .sort(
      (a, b) =>
        SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
        b.activeCount - a.activeCount ||
        (new Date(b.latestAt ?? 0).getTime() || 0) - (new Date(a.latestAt ?? 0).getTime() || 0) ||
        a.key.localeCompare(b.key),
    );

  return {
    schemaVersion: TICKET_GROUPS_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    filters: { family: family ?? null, minSize, limit },
    summary: {
      ticketsConsidered: active.length,
      groupsFlagged: groups.length,
    },
    groups: groups.slice(0, limit),
  };
}

// ---------------------------------------------------------------------------
// Group as workbench: prior-art aggregation + Pattern-discovery hypotheses
//
// Reframed from Inti's "begin-group"/"promote-group" workflow: before fixing
// anything for a computed Group, look at it as a *workbench* -- aggregate the
// prior art its members already point at, see what Patterns already exist in
// its dominant family, and surface ranked hypotheses about whether the Group
// is a duplicate of known work, one coherent Pattern, several narrower ones,
// or just a triage convenience with no proven shared cause yet ("treat as
// workbench"). aggregateGroupPriorArt/buildGroupPatternHypotheses are pure
// report builders; AgentLoopStore.beginGroup/promoteGroup (in store.ts) wire
// them to the store's existing related/searchKnowledge/listPatterns
// primitives -- no new scoring machinery, by design.
// ---------------------------------------------------------------------------

export const BEGIN_GROUP_SCHEMA_VERSION = 1 as const;
export const PROMOTE_GROUP_SCHEMA_VERSION = 1 as const;

/** Default cap on how many group members fan out through `related`. */
export const DEFAULT_BEGIN_GROUP_TICKET_LIMIT = 30;
/** Default cap on related candidates considered per member ticket. */
export const DEFAULT_BEGIN_GROUP_RELATED_LIMIT = 10;
/** Default cap on aggregated prior-art entries returned. */
export const DEFAULT_BEGIN_GROUP_PRIOR_ART_LIMIT = 20;

/** Cross-member prior art, deduped by candidate ticket and ranked by how often (and how strongly) it recurs. */
export interface TicketGroupPriorArt {
  /** The candidate ticket's display alias, e.g. "ISSUE-000042". */
  key: string;
  title: string;
  status: string;
  family: string;
  /** Cumulative `related` score across every group member that surfaced this candidate. */
  score: number;
  /** How many distinct group members surfaced this candidate. */
  occurrenceCount: number;
  /** Aliases of the group members that surfaced this candidate. */
  sourceTicketKeys: string[];
  /** Merged, deduped relatedness signals (e.g. "family", "tag:export", "text:0.42") across all occurrences. */
  signals: string[];
  /** Carried over from the candidate's own resolution, when resolved -- reuses existing ticket fields rather than a separate knowledge join. */
  resolutionSummary?: string | null;
  guardStatus?: string | null;
}

export type PatternHypothesisConfidence = "low" | "medium" | "high";

export type PatternHypothesisRecommendation =
  | "compare_prior_art"
  | "split_group"
  | "promote_group"
  | "treat_as_workbench";

/** A ranked hypothesis about how (or whether) a Group should become -- or compare against -- a Pattern. */
export interface TicketGroupPatternHypothesis {
  title: string;
  confidence: PatternHypothesisConfidence;
  recommendation: PatternHypothesisRecommendation;
  rationale: string;
  ticketKeys: string[];
  priorArtKeys: string[];
  /** Set when the hypothesis points at an *existing* Pattern worth comparing against / reusing. */
  suggestedPatternId?: string;
  /**
   * Set when the hypothesis suggests promoting to a *new* Pattern -- a default
   * title `promote-group` can use. (Unlike Inti's deterministic `patternKey`
   * slugs, AgentLoops assigns sequential Pattern ids at creation time, so a
   * not-yet-created Pattern can only be suggested by title, not by id.)
   */
  suggestedPatternTitle?: string;
}

/**
 * Cross-member prior-art aggregation (mirrors Inti's `aggregateGroupPriorArt`,
 * adapted to AgentLoops' primitives): runs `store.related()` once per group
 * member, then folds the resulting candidates by ticket -- summing `score`,
 * counting `occurrenceCount`, and merging `signals` -- so a candidate that
 * several members independently point at rises to the top.
 *
 * Deliberately leaner than Inti's version: AgentLoops' `related()` doesn't
 * embed a `knowledge` object per candidate the way Inti's
 * `IssueRelatedKnowledgeResult` does (rootCauseSummary/fixStrategy live in the
 * separate `searchKnowledge` corpus, by design -- `related` and
 * `searchKnowledge` stay independently composable). Rather than adding an N+1
 * knowledge join here, this keeps to what `related` already returns and lets
 * the orchestration's separate `familyKnowledge` search cover "how was this
 * fixed" for the family as a whole.
 */
export function aggregateGroupPriorArt(
  reports: PriorArtReport[],
  limit: number,
): TicketGroupPriorArt[] {
  const byKey = new Map<string, TicketGroupPriorArt>();
  for (const report of reports) {
    const sourceKey = report.ticket.alias;
    for (const candidate of report.related) {
      const key = candidate.alias;
      const existing = byKey.get(key) ?? {
        key,
        title: candidate.title,
        status: candidate.status,
        family: candidate.family,
        score: 0,
        occurrenceCount: 0,
        sourceTicketKeys: [],
        signals: [],
      };
      existing.score += Number(candidate.score || 0);
      existing.occurrenceCount += 1;
      if (!existing.sourceTicketKeys.includes(sourceKey)) existing.sourceTicketKeys.push(sourceKey);
      for (const signal of candidate.signals ?? []) {
        if (signal && !existing.signals.includes(signal)) existing.signals.push(signal);
      }
      byKey.set(key, existing);
    }
  }
  return Array.from(byKey.values())
    .sort(
      (a, b) =>
        b.occurrenceCount - a.occurrenceCount || b.score - a.score || a.key.localeCompare(b.key),
    )
    .slice(0, Math.max(1, limit));
}

const HIGH_OCCURRENCE_PRIOR_ART_THRESHOLD = 2;
const MAX_HIGH_OCCURRENCE_PRIOR_ART = 5;
const MAX_GROUP_HYPOTHESES = 8;

function isTerminalPatternStatus(status: PatternStatus): boolean {
  return status === "resolved";
}

function dominantFamily(tickets: Array<{ family: string }>): string {
  const counts = new Map<string, number>();
  for (const ticket of tickets) {
    counts.set(ticket.family, (counts.get(ticket.family) ?? 0) + 1);
  }
  return (
    Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? ""
  );
}

function groupTicketsByFamily(tickets: Ticket[]): Array<{ family: string; tickets: Ticket[] }> {
  const byFamily = new Map<string, Ticket[]>();
  for (const ticket of tickets) {
    byFamily.set(ticket.family, [...(byFamily.get(ticket.family) ?? []), ticket]);
  }
  return Array.from(byFamily.entries())
    .map(([family, members]) => ({ family, tickets: members }))
    .sort((a, b) => b.tickets.length - a.tickets.length || a.family.localeCompare(b.family));
}

function memberAlias(ticket: Ticket): string {
  return ticket.aliases[0] ?? ticket.id;
}

/**
 * Ranked hypotheses about how this Group relates to the Pattern abstraction
 * (mirrors Inti's `buildGroupPatternHypotheses`, generalized to AgentLoops'
 * vocabulary -- see module doc comment). Up to 8 hypotheses across five shapes:
 *
 *  1. An existing active Pattern in the family may already cover this Group --
 *     compare before creating another one.
 *  2. A resolved (terminal) Pattern in the family may be recurring.
 *  3. Resolved prior art recurs across multiple group members -- compare it.
 *  4. Members split cleanly across >= 2 families -- likely several Patterns, not one.
 *  5. Members share recurring, distinguishing wording (reusing the same
 *     `autoKeywordClusters` machinery `ticketGroupsReport` already runs) --
 *     candidate narrower symptom-Patterns.
 *
 * Falls back to "treat as workbench" when nothing else fired, or when the
 * Group's basis is itself the least proof-bearing one (`custom` -- a
 * project-defined rule match alone, like Inti's document-identity groups,
 * doesn't prove a shared root cause).
 */
export function buildGroupPatternHypotheses(
  group: TicketGroup,
  priorArt: TicketGroupPriorArt[],
  patterns: Pattern[],
  memberTickets: Ticket[],
): TicketGroupPatternHypothesis[] {
  const hypotheses: TicketGroupPatternHypothesis[] = [];
  const ticketKeys = group.tickets.map((member) => member.alias);
  const terminalPattern = patterns.find((pattern) => isTerminalPatternStatus(pattern.status));
  const activePattern = patterns.find((pattern) => !isTerminalPatternStatus(pattern.status));
  const highOccurrencePriorArt = priorArt
    .filter((entry) => entry.occurrenceCount >= HIGH_OCCURRENCE_PRIOR_ART_THRESHOLD)
    .slice(0, MAX_HIGH_OCCURRENCE_PRIOR_ART);

  if (activePattern) {
    hypotheses.push({
      title: `Existing Pattern may already cover ${group.title}`,
      confidence: activePattern.status === "reopened" ? "high" : "medium",
      recommendation: "compare_prior_art",
      rationale: `${activePattern.id} is ${activePattern.status} in family ${activePattern.family}; compare its linked tickets before creating another Pattern.`,
      ticketKeys,
      priorArtKeys: highOccurrencePriorArt.map((entry) => entry.key),
      suggestedPatternId: activePattern.id,
    });
  } else if (terminalPattern) {
    hypotheses.push({
      title: `Possible recurrence of resolved Pattern ${terminalPattern.id}`,
      confidence: highOccurrencePriorArt.length > 0 ? "medium" : "low",
      recommendation: "compare_prior_art",
      rationale: `${terminalPattern.id} is ${terminalPattern.status}; decide whether this Group reopens it, supersedes it, or needs a narrower Pattern.`,
      ticketKeys,
      priorArtKeys: highOccurrencePriorArt.map((entry) => entry.key),
      suggestedPatternId: terminalPattern.id,
    });
  }

  if (highOccurrencePriorArt.length > 0) {
    hypotheses.push({
      title: `Resolved prior art recurs across ${highOccurrencePriorArt.length} historical match${highOccurrencePriorArt.length === 1 ? "" : "es"}`,
      confidence: highOccurrencePriorArt.some((entry) => entry.occurrenceCount >= 3) ? "high" : "medium",
      recommendation: "compare_prior_art",
      rationale: highOccurrencePriorArt
        .map(
          (entry) =>
            `${entry.key} matched ${entry.occurrenceCount} group ticket(s)${entry.resolutionSummary ? `; resolution: ${entry.resolutionSummary}` : ""}`,
        )
        .join(" "),
      ticketKeys,
      priorArtKeys: highOccurrencePriorArt.map((entry) => entry.key),
      suggestedPatternTitle: `Recurring ${group.title} tickets`,
    });
  }

  const familyGroups = groupTicketsByFamily(memberTickets).filter((entry) => entry.tickets.length >= 2);
  if (familyGroups.length > 1) {
    hypotheses.push({
      title: "Group likely contains multiple Patterns split by family",
      confidence: "medium",
      recommendation: "split_group",
      rationale: familyGroups.map((entry) => `${entry.family}: ${entry.tickets.length} ticket(s)`).join("; "),
      ticketKeys,
      priorArtKeys: highOccurrencePriorArt.map((entry) => entry.key),
    });
  }

  const keywordSplits = autoKeywordClusters(memberTickets, DEFAULT_TICKET_GROUP_MIN_SIZE)
    .map((cluster) => ({
      cluster,
      tickets: memberTickets.filter((ticket) => cluster.memberIds.has(ticket.id)),
    }))
    .filter((entry) => entry.tickets.length >= DEFAULT_TICKET_GROUP_MIN_SIZE && entry.tickets.length < memberTickets.length)
    .sort((a, b) => b.tickets.length - a.tickets.length || a.cluster.bucket.localeCompare(b.cluster.bucket));

  for (const entry of keywordSplits.slice(0, 3)) {
    const keys = entry.tickets.map(memberAlias);
    const label = keywordLabel(entry.cluster.tokens).replace(/^Keyword: /, "");
    hypotheses.push({
      title: `Candidate symptom Pattern: ${label}`,
      confidence: entry.tickets.length >= 3 ? "medium" : "low",
      recommendation: entry.tickets.length >= 3 ? "promote_group" : "compare_prior_art",
      rationale: `${entry.tickets.length} ticket(s) share recurring, distinguishing wording (${label}) -- often a sign of the same symptom reported from different angles.`,
      ticketKeys: keys,
      priorArtKeys: priorArt
        .filter((art) => art.sourceTicketKeys.some((key) => keys.includes(key)))
        .map((art) => art.key)
        .slice(0, 5),
      suggestedPatternTitle: `Recurring: ${label}`,
    });
  }

  if (hypotheses.length === 0 || group.basis === "custom") {
    hypotheses.push({
      title: `${group.title} is a Group workbench, not yet a proven Pattern`,
      confidence: "low",
      recommendation: "treat_as_workbench",
      rationale:
        group.basis === "custom"
          ? "This Group is based on a project-defined rule match (see ticketGroups.customRules) -- useful for triage batching, but a shared rule match alone does not prove a shared root cause."
          : "No strong historical or structural signal has converged yet; inspect member tickets and prior art before promoting.",
      ticketKeys,
      priorArtKeys: priorArt.slice(0, 5).map((entry) => entry.key),
    });
  }

  return hypotheses.slice(0, MAX_GROUP_HYPOTHESES);
}

/** Locate one computed Group by its `key` (exact), its bucket suffix (e.g. "export_pipeline" maps to "family:export_pipeline"), or its title -- case-insensitive. Mirrors Inti's `findCliTicketGroup`. */
export function findTicketGroup(report: TicketGroupsReport, identifier: string): TicketGroup | undefined {
  const needle = identifier.trim().toLowerCase();
  if (!needle) return undefined;
  return (
    report.groups.find((group) => group.key.toLowerCase() === needle) ??
    report.groups.find((group) => group.key.toLowerCase().endsWith(`:${needle}`)) ??
    report.groups.find((group) => group.title.toLowerCase() === needle)
  );
}

/** Compose a human-readable provenance description for a promoted Pattern's `summary` -- prose, not structured metadata (see `Pattern.summary`). */
export function composeGroupPromotionSummary(group: TicketGroup): string {
  const parts = [
    group.summary,
    `Promoted from computed Ticket Group ${group.key} (${group.tickets.length} ticket(s), basis=${group.basis}).`,
  ];
  if (group.candidateSplits.length > 0) {
    parts.push(
      `Candidate narrower splits at promotion time: ${group.candidateSplits
        .map((split) => `${split.key} (${split.count})`)
        .join(", ")}.`,
    );
  }
  return parts.filter((part) => Boolean(part && part.trim())).join(" ");
}

/** The dominant family among a Group's members -- the natural home for a Pattern discovered from it. Exported for `AgentLoopStore.beginGroup`/`promoteGroup`. */
export function ticketGroupPatternFamily(group: TicketGroup): string {
  return dominantFamily(group.tickets);
}

export interface BeginGroupOptions {
  /** Cap on how many group members fan out through `related`. Default `DEFAULT_BEGIN_GROUP_TICKET_LIMIT`. */
  ticketLimit?: number;
  /** Cap on related candidates considered per member ticket. Default `DEFAULT_BEGIN_GROUP_RELATED_LIMIT`. */
  relatedLimit?: number;
  /** Cap on aggregated prior-art / family-knowledge entries returned. Default `DEFAULT_BEGIN_GROUP_PRIOR_ART_LIMIT`. */
  priorArtLimit?: number;
}

export interface TicketGroupRelatedEntry {
  ticket: { id: string; alias: string; family: string; status: string; title: string };
  related: PriorArtReport["related"];
}

export interface BeginGroupReport {
  schemaVersion: typeof BEGIN_GROUP_SCHEMA_VERSION;
  generatedAt: string;
  group: TicketGroup;
  /** The Group's dominant member family -- where a Pattern discovered from it would naturally live. */
  patternFamily: string;
  activePatterns: Pattern[];
  historicalPatterns: Pattern[];
  priorArt: TicketGroupPriorArt[];
  familyKnowledge: ResolutionKnowledgeReport;
  relatedByTicket: TicketGroupRelatedEntry[];
  hypotheses: TicketGroupPatternHypothesis[];
  nextSteps: string[];
}

export interface PromoteGroupOptions {
  /** Override the Pattern family to promote into. Defaults to the Group's dominant member family. */
  family?: string;
  /** Override the Pattern title (defaults to `Recurring <group.title> tickets`). */
  title?: string;
  /** Override the Pattern's `summary` (defaults to a composed provenance description -- see `composeGroupPromotionSummary`). */
  summary?: string;
  /** Attribution for the linking notes recorded on newly-linked tickets. Defaults to "agent". */
  actor?: string;
}

export interface PromoteGroupResult {
  schemaVersion: typeof PROMOTE_GROUP_SCHEMA_VERSION;
  generatedAt: string;
  /** "created" when a new Pattern was made; "reused" when an existing non-resolved Pattern in the family was found and updated instead -- idempotent like `attachPattern`. */
  action: "created" | "reused";
  group: TicketGroup;
  pattern: Pattern;
  /** Aliases of group members newly linked to the Pattern by this call (already-linked members are skipped). */
  linkedTickets: string[];
}

const BEGIN_GROUP_NEXT_STEPS = [
  "Decide whether this Group is a QA/triage workbench, a recurrence of prior art, one coherent Pattern, or several narrower Patterns.",
  "If coherent, run promote-group with an explicit title/summary, then fix at the Pattern/root-cause level rather than ticket-by-ticket.",
  "If the hypotheses suggest a split, inspect the candidate splits and consider promoting narrower Patterns before implementing.",
  "Use the aggregated prior art and family knowledge to avoid repeating failed fixes or missing recurrence coverage.",
] as const;

export function beginGroupNextSteps(): string[] {
  return [...BEGIN_GROUP_NEXT_STEPS];
}
