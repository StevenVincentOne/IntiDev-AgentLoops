import { ProjectConfig, Ticket } from "./types";
import { resolveQueuePrefix } from "./aliases";

export const GUARD_GAP_SCHEMA_VERSION = 1 as const;

/** Guard statuses that count as an active regression guard. */
const ACTIVE_GUARD = new Set(["guard_added", "guard_existing"]);

/** Queue prefixes that are expected to carry a regression guard once resolved. */
export const DEFAULT_GUARD_QUEUES = ["ISSUE", "USER"];

export type GuardGapReason = "missing" | "deferred" | "waived";

export interface GuardGapOptions {
  /** Restrict to a single family. */
  family?: string;
  /** Treat intentionally waived guards as gaps too. Default false. */
  includeWaived?: boolean;
  /** Consider every resolved ticket, not just guard-relevant queues. Default false. */
  allKinds?: boolean;
  /** Queue prefixes that expect a guard. Default ISSUE, USER. */
  guardQueues?: string[];
}

export interface GuardGap {
  id: string;
  alias: string;
  kind: string;
  source: string;
  family: string;
  guardStatus: string;
  reason: GuardGapReason;
  resolutionSummary?: string;
}

export interface GuardGapReport {
  schemaVersion: typeof GUARD_GAP_SCHEMA_VERSION;
  generatedAt: string;
  filters: { family: string | null; includeWaived: boolean; allKinds: boolean };
  summary: {
    /** Resolved tickets considered (after queue/family scoping). */
    resolvedConsidered: number;
    guarded: number;
    gaps: number;
    missing: number;
    deferred: number;
    waived: number;
  };
  gaps: GuardGap[];
}

const REASON_ORDER: Record<GuardGapReason, number> = { missing: 0, deferred: 1, waived: 2 };

/**
 * Guard-gap report (ported concept from Inti's guard audit): resolved tickets
 * that should carry a regression guard but do not. By default only tickets in
 * guard-relevant queues (ISSUE, USER — defects and user reports) are considered;
 * `allKinds` widens it to every resolved ticket.
 *
 * Pure and deterministic apart from `generatedAt`.
 */
export function guardGapReport(
  tickets: Ticket[],
  config: ProjectConfig,
  options: GuardGapOptions = {},
): GuardGapReport {
  const family = options.family;
  const includeWaived = options.includeWaived ?? false;
  const allKinds = options.allKinds ?? false;
  const guardQueues = new Set(
    (options.guardQueues ?? DEFAULT_GUARD_QUEUES).map((prefix) => prefix.toUpperCase()),
  );

  const relevant = tickets.filter((ticket) => {
    if (ticket.status !== "resolved") return false;
    if (family && ticket.family !== family) return false;
    if (allKinds) return true;
    return guardQueues.has(resolveQueuePrefix({ kind: ticket.kind, source: ticket.source }, config));
  });

  let guarded = 0;
  let missing = 0;
  let deferred = 0;
  let waived = 0;
  const gaps: GuardGap[] = [];

  for (const ticket of relevant) {
    const guardStatus = ticket.guardStatus ?? "none";
    if (ACTIVE_GUARD.has(guardStatus)) {
      guarded += 1;
      continue;
    }
    let reason: GuardGapReason;
    if (guardStatus === "guard_deferred") {
      reason = "deferred";
      deferred += 1;
    } else if (guardStatus === "guard_waived") {
      reason = "waived";
      waived += 1;
      if (!includeWaived) continue;
    } else {
      reason = "missing";
      missing += 1;
    }
    gaps.push({
      id: ticket.id,
      alias: ticket.aliases[0] ?? ticket.id,
      kind: ticket.kind,
      source: ticket.source,
      family: ticket.family,
      guardStatus,
      reason,
      resolutionSummary: ticket.resolutionSummary,
    });
  }

  gaps.sort(
    (a, b) => REASON_ORDER[a.reason] - REASON_ORDER[b.reason] || a.id.localeCompare(b.id),
  );

  return {
    schemaVersion: GUARD_GAP_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    filters: { family: family ?? null, includeWaived, allKinds },
    summary: {
      resolvedConsidered: relevant.length,
      guarded,
      gaps: gaps.length,
      missing,
      deferred,
      waived,
    },
    gaps,
  };
}
