import { Ticket, TicketStatus } from "./types";
import { jaccard, tokenize } from "./prior-art";

export const NEAR_DUPLICATE_SCHEMA_VERSION = 1 as const;

/** Statuses considered "open work" — where a missed duplicate wastes effort twice. */
const OPEN_TICKET_STATUSES = new Set<TicketStatus>(["triaged", "active", "reopened", "deferred"]);

/** Default minimum title/summary token-overlap (Jaccard, 0..1) to flag a pair. */
export const DEFAULT_NEAR_DUPLICATE_MIN_OVERLAP = 0.5;

/** Default cap on the number of pairs returned. */
export const DEFAULT_NEAR_DUPLICATE_LIMIT = 20;

export interface NearDuplicateOptions {
  /** Restrict to a single family. */
  family?: string;
  /** Minimum title/summary token-overlap (Jaccard, 0..1) for a pair to be flagged. Default 0.5. */
  minTextOverlap?: number;
  /** Consider resolved tickets too, not just open work. Default false. */
  includeResolved?: boolean;
  /** Maximum pairs to return. Default 20. */
  limit?: number;
}

export interface NearDuplicateMember {
  id: string;
  alias: string;
  kind: string;
  source: string;
  family: string;
  status: string;
  title: string;
}

export interface NearDuplicatePair {
  /** Title/summary token-overlap (Jaccard, 0..1), rounded to 2 decimals. */
  textOverlap: number;
  /** Human-readable evidence for the pairing, e.g. ["text:0.67", "family", "tag:export"]. */
  signals: string[];
  a: NearDuplicateMember;
  b: NearDuplicateMember;
}

export interface NearDuplicateReport {
  schemaVersion: typeof NEAR_DUPLICATE_SCHEMA_VERSION;
  generatedAt: string;
  filters: { family: string | null; minTextOverlap: number; includeResolved: boolean; limit: number };
  summary: {
    /** Tickets considered (after status/family scoping). */
    ticketsConsidered: number;
    pairsFlagged: number;
  };
  pairs: NearDuplicatePair[];
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function toMember(ticket: Ticket): NearDuplicateMember {
  return {
    id: ticket.id,
    alias: ticket.aliases[0] ?? ticket.id,
    kind: ticket.kind,
    source: ticket.source,
    family: ticket.family,
    status: ticket.status,
    title: ticket.title,
  };
}

/**
 * Near-duplicate ticket audit (ported concept from Inti's intake-time
 * `scoreNearDuplicateCandidate`): flags pairs of tickets whose titles and
 * summaries overlap heavily — a likely sign the same problem was reported
 * twice (e.g. once by a smoke run, once by a user) before convergence had a
 * chance to merge them into a shared Pattern.
 *
 * Inti's scorer leans on a correlation-key/fingerprint system AgentLoops
 * doesn't have, so this report is reframed around the one deterministic
 * signal that travels well without it: title/summary token overlap (the same
 * `tokenize`/`jaccard` primitives `prior-art.ts` already uses for relatedness
 * scoring). Same-family and shared-tag matches are recorded as supporting
 * `signals` but do not gate inclusion — text overlap is the duplicate signal;
 * the rest is corroborating evidence for a human to weigh.
 *
 * By default only "open work" tickets are compared (triaged/active/reopened/
 * deferred) — that's where a missed duplicate costs double effort; resolved
 * tickets can be included via `includeResolved` for historical audits.
 *
 * Pure and deterministic apart from `generatedAt`.
 */
export function nearDuplicateReport(
  tickets: Ticket[],
  options: NearDuplicateOptions = {},
): NearDuplicateReport {
  const family = options.family;
  const minTextOverlap = options.minTextOverlap ?? DEFAULT_NEAR_DUPLICATE_MIN_OVERLAP;
  const includeResolved = options.includeResolved ?? false;
  const limit = options.limit ?? DEFAULT_NEAR_DUPLICATE_LIMIT;

  const scoped = tickets
    .filter((ticket) => (family ? ticket.family === family : true))
    .filter((ticket) => includeResolved || OPEN_TICKET_STATUSES.has(ticket.status))
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id));

  const tokensById = new Map<string, Set<string>>();
  for (const ticket of scoped) {
    tokensById.set(ticket.id, tokenize(`${ticket.title} ${ticket.summary}`));
  }

  const pairs: NearDuplicatePair[] = [];
  for (let i = 0; i < scoped.length; i += 1) {
    for (let j = i + 1; j < scoped.length; j += 1) {
      const a = scoped[i];
      const b = scoped[j];
      const overlap = jaccard(tokensById.get(a.id)!, tokensById.get(b.id)!);
      if (overlap < minTextOverlap) continue;

      const signals: string[] = [`text:${overlap.toFixed(2)}`];
      if (a.family === b.family) signals.push("family");
      if (a.kind === b.kind) signals.push("kind");
      const aTags = new Set(a.tags);
      for (const tag of b.tags) {
        if (aTags.has(tag)) signals.push(`tag:${tag}`);
      }

      pairs.push({
        textOverlap: round(overlap),
        signals,
        a: toMember(a),
        b: toMember(b),
      });
    }
  }

  pairs.sort(
    (x, y) =>
      y.textOverlap - x.textOverlap ||
      x.a.id.localeCompare(y.a.id) ||
      x.b.id.localeCompare(y.b.id),
  );

  return {
    schemaVersion: NEAR_DUPLICATE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    filters: { family: family ?? null, minTextOverlap, includeResolved, limit },
    summary: {
      ticketsConsidered: scoped.length,
      pairsFlagged: pairs.length,
    },
    pairs: pairs.slice(0, limit),
  };
}
