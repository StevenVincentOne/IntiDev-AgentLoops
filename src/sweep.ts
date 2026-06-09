/**
 * Symptom-family sweep — a deterministic, agent-facing workflow stage between
 * investigation and resolution.
 *
 * Problem: an agent can correctly fix a seed ticket but stop at one sub-root-cause
 * without asking where else the same visible symptom appears in open tickets, resolved
 * prior art, or related patterns. The fix boundary is then narrower than it could have
 * been, or the same symptom reopens from an adjacent ticket the agent never looked at.
 *
 * Solution: `sweepTicket` is a read-only, pure function that takes the seed ticket,
 * all open/resolved tickets, and all patterns; searches by symptom tokens; classifies
 * candidates into "likely same symptom" vs "adjacent / different root cause" buckets;
 * and emits `rootCauseBuckets` that prompt the agent to decide — without ever deciding
 * for them. The result is a flow regulator, not a brittle rules engine.
 *
 * Generalization notes:
 * - Uses `tokenize`/`jaccard` from `prior-art.ts` (same scoring as `relatedTickets`).
 * - No Reader/parser-specific vocabulary. The `likelySameSymptom` cut uses Jaccard
 *   token-overlap (same heuristic as near-duplicate detection) plus a tag-signal boost.
 * - `documentScan` guidance is always `"not_run"` — the open-source layer has no
 *   artifact-storage backend; project-specific scan helpers can extend this.
 */

import { Pattern, Ticket, TicketSweepCandidate, TicketSweepResult } from "./types";
import { tokenize, jaccard } from "./prior-art";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Tokens too generic to be useful symptom signals. */
const LOW_SIGNAL_TOKENS = new Set([
  "the", "a", "an", "in", "on", "at", "of", "to", "is", "was", "are", "be",
  "has", "had", "have", "not", "and", "or", "with", "for", "but", "by", "from",
  "when", "that", "this", "it", "its", "if", "as", "up", "do", "did", "does",
  "will", "would", "could", "should", "may", "can", "agent", "ticket", "issue",
]);

/** Jaccard threshold above which a candidate is classified as "likely same symptom". */
const SAME_SYMPTOM_JACCARD_THRESHOLD = 0.25;

/** Jaccard threshold above which a candidate is considered related at all. */
const ADJACENT_JACCARD_THRESHOLD = 0.10;

const TERMINAL_STATUSES = new Set(["resolved", "deferred"]);

// ── Helpers ───────────────────────────────────────────────────────────────────

function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

function symptomTokens(ticket: Ticket): Set<string> {
  const text = [ticket.title, ticket.summary, ...(ticket.tags ?? [])].join(" ");
  const all = tokenize(text);
  const filtered = new Set<string>();
  for (const token of all) {
    if (!LOW_SIGNAL_TOKENS.has(token) && token.length >= 3) filtered.add(token);
  }
  return filtered;
}

function sweepScore(seedTokens: Set<string>, candidate: Ticket, sharedTags: string[]): number {
  const candidateTokens = symptomTokens(candidate);
  const jac = jaccard(seedTokens, candidateTokens);
  let score = jac * 100;
  // Tag overlap is a strong symptom signal.
  score += sharedTags.length * 8;
  // Same family: modest boost.
  return score;
}

function sharedTagsBetween(a: Ticket, b: Ticket): string[] {
  if (!a.tags || !b.tags) return [];
  const aSet = new Set(a.tags);
  return b.tags.filter((tag) => aSet.has(tag));
}

function candidateFromTicket(
  seed: Ticket,
  candidate: Ticket,
  seedTokens: Set<string>,
): TicketSweepCandidate | null {
  if (candidate.id === seed.id) return null;
  const shared = sharedTagsBetween(seed, candidate);
  const score = sweepScore(seedTokens, candidate, shared);
  if (score < ADJACENT_JACCARD_THRESHOLD * 100 && shared.length === 0) return null;
  const reasons: string[] = [];
  if (shared.length > 0) reasons.push(`shared tags: ${shared.slice(0, 4).join(", ")}`);
  if (candidate.family === seed.family) reasons.push("same family");
  if (score >= SAME_SYMPTOM_JACCARD_THRESHOLD * 100) reasons.push("high token overlap");
  return {
    id: candidate.id,
    title: candidate.title,
    status: candidate.status,
    family: candidate.family,
    score,
    reasons,
    resolutionSummary: candidate.resolutionSummary,
    guardStatus: candidate.guardStatus,
    priorArtTrust: candidate.priorArtTrust?.level,
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

export interface SweepOptions {
  /** Max candidates per bucket. Default 20. */
  candidateLimit?: number;
  /** Max historical prior-art entries. Default 15. */
  priorArtLimit?: number;
  /** Max pattern matches. Default 10. */
  patternLimit?: number;
}

/**
 * Pure, read-only symptom-family sweep for `seed`.
 *
 * Searches all open and resolved tickets in `allTickets` (and all `allPatterns`)
 * for candidates that share symptom tokens with the seed, classifies them into
 * "likely same symptom" vs "adjacent/different root cause" vs "historical prior
 * art" buckets, and emits `rootCauseBuckets` as prompts for agent classification.
 *
 * This function NEVER decides which bucket a candidate belongs in — it surfaces
 * evidence and prompts the agent to decide.
 */
export function sweepTicket(
  seed: Ticket,
  allTickets: Ticket[],
  allPatterns: Pattern[],
  options: SweepOptions = {},
): TicketSweepResult {
  const candidateLimit = Math.max(1, options.candidateLimit ?? 20);
  const priorArtLimit = Math.max(1, options.priorArtLimit ?? 15);
  const patternLimit = Math.max(1, options.patternLimit ?? 10);

  const seedTokens = symptomTokens(seed);

  // Score all other tickets.
  const scored: TicketSweepCandidate[] = [];
  for (const t of allTickets) {
    const c = candidateFromTicket(seed, t, seedTokens);
    if (c) scored.push(c);
  }
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  // Classify: open tickets above same-symptom threshold → likelySameSymptom.
  const likelySameSymptom = scored
    .filter((c) => !isTerminal(c.status) && c.score >= SAME_SYMPTOM_JACCARD_THRESHOLD * 100)
    .slice(0, candidateLimit);

  const likelyIds = new Set(likelySameSymptom.map((c) => c.id));

  // Open tickets with lower overlap → adjacent.
  const adjacentOrDifferentRoot = scored
    .filter((c) => !isTerminal(c.status) && !likelyIds.has(c.id))
    .slice(0, candidateLimit);

  // Terminal (resolved/deferred) → historical prior art.
  const historicalPriorArt = scored
    .filter((c) => isTerminal(c.status))
    .slice(0, priorArtLimit);

  // Pattern matches by token overlap.
  const patternMatches = allPatterns
    .map((pattern) => {
      const patternTokens = tokenize(`${pattern.title} ${pattern.summary ?? ""} ${pattern.family}`);
      const overlap = jaccard(seedTokens, patternTokens);
      return { patternId: pattern.id, title: pattern.title, status: pattern.status, score: Math.round(overlap * 100) };
    })
    .filter((m) => m.score >= 5)
    .sort((a, b) => b.score - a.score || a.patternId.localeCompare(b.patternId))
    .slice(0, patternLimit);

  // Root-cause bucket prompts.
  const symptomLabel = seed.title;
  const seedBucketTicketIds = [seed.id, ...likelySameSymptom.map((c) => c.id)];
  const rootCauseBuckets: TicketSweepResult["rootCauseBuckets"] = [
    {
      label: `${symptomLabel} / seed root-cause bucket`,
      confidence: likelySameSymptom.length > 0 ? "medium" : "low",
      coveredByCurrentFix: "agent_must_decide",
      ticketIds: seedBucketTicketIds.slice(0, 8),
      guidance:
        "Decide which of these tickets are actually covered by your root-cause trace and " +
        "verification evidence. Do not include candidates just because the visible symptom " +
        "looks similar — they may have different underlying causes.",
    },
  ];
  if (adjacentOrDifferentRoot.length > 0) {
    rootCauseBuckets.push({
      label: `${symptomLabel} / adjacent or different-root-cause bucket`,
      confidence: "medium",
      coveredByCurrentFix: "agent_must_decide",
      ticketIds: adjacentOrDifferentRoot.slice(0, 12).map((c) => c.id),
      guidance:
        "Keep these open unless the implementation and verification explicitly exercise " +
        "their root cause. Consider creating or updating a Pattern if this bucket is " +
        "a coherent recurring problem.",
    });
  }

  return {
    seed: { id: seed.id, title: seed.title, status: seed.status, family: seed.family },
    symptomSignature: {
      label: symptomLabel,
      tokens: [...seedTokens].slice(0, 20),
    },
    candidates: {
      likelySameSymptom,
      adjacentOrDifferentRoot,
      historicalPriorArt,
      patternMatches,
    },
    rootCauseBuckets,
    recommendedActions: [
      "Classify likely same-symptom candidates as same root cause, adjacent/different root cause, unrelated, or ambiguous before closure.",
      "If a narrow fix is correct, resolve only tickets in the covered root-cause bucket and note adjacent buckets left open.",
      "If multiple tickets share the same root cause, create or update a Pattern before resolving them together.",
      "Persist sibling decisions with: agentloop classify-siblings <seed> --same-root ... --adjacent ...",
    ],
  };
}
