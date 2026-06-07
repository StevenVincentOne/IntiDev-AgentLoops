import { Severity, Ticket, TicketGroupCustomRule, TicketStatus } from "./types";
import { jaccard, tokenize } from "./prior-art";

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
