import { Ticket } from "./types";

export const KNOWLEDGE_SCHEMA_VERSION = 1 as const;

function hasText(value?: string): boolean {
  return Boolean(value && value.trim());
}

// ---------------------------------------------------------------------------
// Resolution knowledge: searchable "how this class of problem was fixed" memory
// mined from resolved tickets.
// ---------------------------------------------------------------------------

export interface KnowledgeEntry {
  id: string;
  alias: string;
  kind: string;
  source: string;
  family: string;
  severity: string;
  tags: string[];
  title: string;
  /** The original symptom (ticket summary). */
  problem: string;
  /** How it was fixed (ticket resolutionSummary). */
  resolution: string;
  verification?: string;
  /** True when both a resolution and a verification record are present. */
  verified: boolean;
  guardStatus?: string;
  guardSummary?: string;
  resolvedAt?: string;
}

export interface KnowledgeSearchOptions {
  family?: string;
  kind?: string;
  source?: string;
  tag?: string;
  /** Free-text query; every whitespace-separated term must appear. */
  query?: string;
  limit?: number;
}

export interface ResolutionKnowledgeReport {
  schemaVersion: typeof KNOWLEDGE_SCHEMA_VERSION;
  generatedAt: string;
  filters: {
    family: string | null;
    kind: string | null;
    source: string | null;
    tag: string | null;
    query: string | null;
  };
  summary: {
    /** Resolved tickets that carry a resolution summary (the corpus size). */
    resolvedWithKnowledge: number;
    /** Of those, how many also have verification evidence. */
    verified: number;
    /** Entries returned after filters (before any limit). */
    matched: number;
  };
  entries: KnowledgeEntry[];
}

function toEntry(ticket: Ticket): KnowledgeEntry {
  return {
    id: ticket.id,
    alias: ticket.aliases[0] ?? ticket.id,
    kind: ticket.kind,
    source: ticket.source,
    family: ticket.family,
    severity: ticket.severity,
    tags: ticket.tags,
    title: ticket.title,
    problem: ticket.summary,
    resolution: ticket.resolutionSummary ?? "",
    verification: ticket.verification,
    verified: hasText(ticket.resolutionSummary) && hasText(ticket.verification),
    guardStatus: ticket.guardStatus,
    guardSummary: ticket.guardSummary,
    resolvedAt: ticket.resolvedAt,
  };
}

function matchesQuery(entry: KnowledgeEntry, query: string): boolean {
  const haystack = [entry.title, entry.problem, entry.resolution, entry.tags.join(" ")]
    .join(" ")
    .toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => haystack.includes(term));
}

/**
 * Resolution-knowledge corpus (ported concept from Inti's resolution knowledge):
 * the reusable record of how each resolved ticket was fixed, so an agent facing
 * a new ticket can retrieve prior art by family/kind/source/tag/free text.
 *
 * Pure and deterministic apart from `generatedAt`. Newest resolutions first.
 */
export function resolutionKnowledge(
  tickets: Ticket[],
  options: KnowledgeSearchOptions = {},
): ResolutionKnowledgeReport {
  const corpus = tickets
    .filter((ticket) => ticket.status === "resolved" && hasText(ticket.resolutionSummary))
    .map(toEntry);

  let entries = corpus;
  if (options.family) entries = entries.filter((entry) => entry.family === options.family);
  if (options.kind) entries = entries.filter((entry) => entry.kind === options.kind);
  if (options.source) entries = entries.filter((entry) => entry.source === options.source);
  if (options.tag) entries = entries.filter((entry) => entry.tags.includes(options.tag as string));
  if (hasText(options.query)) {
    entries = entries.filter((entry) => matchesQuery(entry, options.query as string));
  }

  entries = [...entries].sort(
    (a, b) => (b.resolvedAt ?? "").localeCompare(a.resolvedAt ?? "") || a.id.localeCompare(b.id),
  );
  const matched = entries.length;
  if (typeof options.limit === "number" && options.limit >= 0) {
    entries = entries.slice(0, options.limit);
  }

  return {
    schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    filters: {
      family: options.family ?? null,
      kind: options.kind ?? null,
      source: options.source ?? null,
      tag: options.tag ?? null,
      query: hasText(options.query) ? (options.query as string) : null,
    },
    summary: {
      resolvedWithKnowledge: corpus.length,
      verified: corpus.filter((entry) => entry.verified).length,
      matched,
    },
    entries,
  };
}

// ---------------------------------------------------------------------------
// Knowledge gaps: resolved tickets whose knowledge is incomplete for reuse.
// ---------------------------------------------------------------------------

export type KnowledgeGapReason = "no_resolution" | "unverified";

export interface KnowledgeGapsOptions {
  family?: string;
  severity?: string;
  source?: string;
}

export interface KnowledgeGap {
  id: string;
  alias: string;
  kind: string;
  source: string;
  family: string;
  severity: string;
  title: string;
  reason: KnowledgeGapReason;
  resolvedAt?: string;
}

export interface KnowledgeGapsReport {
  schemaVersion: typeof KNOWLEDGE_SCHEMA_VERSION;
  generatedAt: string;
  filters: { family: string | null; severity: string | null; source: string | null };
  summary: {
    resolved: number;
    complete: number;
    gaps: number;
    noResolution: number;
    unverified: number;
  };
  gaps: KnowledgeGap[];
}

/**
 * Resolved tickets whose knowledge is incomplete for reuse: missing a resolution
 * summary, or resolved without verification evidence. The contracts doc's
 * `knowledge-gaps` cleanup backlog, scoped by family/severity/source.
 *
 * Pure and deterministic apart from `generatedAt`.
 */
export function knowledgeGaps(
  tickets: Ticket[],
  options: KnowledgeGapsOptions = {},
): KnowledgeGapsReport {
  const resolved = tickets.filter((ticket) => {
    if (ticket.status !== "resolved") return false;
    if (options.family && ticket.family !== options.family) return false;
    if (options.severity && ticket.severity !== options.severity) return false;
    if (options.source && ticket.source !== options.source) return false;
    return true;
  });

  let complete = 0;
  let noResolution = 0;
  let unverified = 0;
  const gaps: KnowledgeGap[] = [];

  for (const ticket of resolved) {
    const resolution = hasText(ticket.resolutionSummary);
    const verification = hasText(ticket.verification);
    if (resolution && verification) {
      complete += 1;
      continue;
    }
    const reason: KnowledgeGapReason = resolution ? "unverified" : "no_resolution";
    if (reason === "unverified") unverified += 1;
    else noResolution += 1;
    gaps.push({
      id: ticket.id,
      alias: ticket.aliases[0] ?? ticket.id,
      kind: ticket.kind,
      source: ticket.source,
      family: ticket.family,
      severity: ticket.severity,
      title: ticket.title,
      reason,
      resolvedAt: ticket.resolvedAt,
    });
  }

  gaps.sort((a, b) => {
    if (a.reason !== b.reason) return a.reason === "no_resolution" ? -1 : 1;
    return a.id.localeCompare(b.id);
  });

  return {
    schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    filters: {
      family: options.family ?? null,
      severity: options.severity ?? null,
      source: options.source ?? null,
    },
    summary: {
      resolved: resolved.length,
      complete,
      gaps: gaps.length,
      noResolution,
      unverified,
    },
    gaps,
  };
}
