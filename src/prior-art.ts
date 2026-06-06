import { Ticket } from "./types";

export const PRIOR_ART_SCHEMA_VERSION = 1 as const;

/**
 * Weights for the deterministic relatedness signals. Fixed defaults live in core
 * (keeping behavior deterministic per the extraction principles) but a project
 * can override any of them via `config.priorArt.weights`.
 */
export interface PriorArtWeights {
  /** Same family. */
  family: number;
  /** Belongs to the same Pattern. */
  pattern: number;
  /** Per shared tag. */
  tag: number;
  /** Same ticket kind. */
  kind: number;
  /** Multiplied by the title/summary token overlap (Jaccard, 0..1). */
  textOverlap: number;
}

export const DEFAULT_PRIOR_ART_WEIGHTS: PriorArtWeights = {
  family: 3,
  pattern: 3,
  tag: 2,
  kind: 1,
  textOverlap: 4,
};

export interface PriorArtOptions {
  weights?: Partial<PriorArtWeights>;
  /** Minimum score for a candidate to be considered related. Default 1. */
  minScore?: number;
  /** Maximum related tickets to return. Default 10. */
  limit?: number;
}

export interface RelatedTicket {
  id: string;
  alias: string;
  kind: string;
  source: string;
  family: string;
  status: string;
  title: string;
  score: number;
  /** Human-readable evidence for the edge, e.g. ["family", "tag:export", "text:0.42"]. */
  signals: string[];
}

export interface PriorArtReport {
  schemaVersion: typeof PRIOR_ART_SCHEMA_VERSION;
  generatedAt: string;
  ticket: { id: string; alias: string; family: string; kind: string; title: string };
  weights: PriorArtWeights;
  filters: { minScore: number; limit: number };
  related: RelatedTicket[];
}

const STOP_TOKEN_MIN_LENGTH = 3;

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= STOP_TOKEN_MIN_LENGTH),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Prior-art lookup (ported concept from Inti's relationship graph): rank the
 * tickets most related to `targetId` using deterministic signals — shared
 * family, shared Pattern, shared tags, same kind, and title/summary token
 * overlap — each contributing a configurable weight.
 *
 * Pure and deterministic apart from `generatedAt`.
 */
export function relatedTickets(
  targetId: string,
  tickets: Ticket[],
  options: PriorArtOptions = {},
): PriorArtReport {
  const weights: PriorArtWeights = { ...DEFAULT_PRIOR_ART_WEIGHTS, ...options.weights };
  const minScore = options.minScore ?? 1;
  const limit = options.limit ?? 10;

  const target = tickets.find((ticket) => ticket.id === targetId);
  if (!target) {
    throw new Error(`Not found: ${targetId}`);
  }
  const targetTokens = tokenize(`${target.title} ${target.summary}`);
  const targetTags = new Set(target.tags);

  const related: RelatedTicket[] = [];
  for (const candidate of tickets) {
    if (candidate.id === target.id) continue;
    let score = 0;
    const signals: string[] = [];

    if (weights.family && candidate.family === target.family) {
      score += weights.family;
      signals.push("family");
    }
    if (weights.pattern && candidate.patternId && candidate.patternId === target.patternId) {
      score += weights.pattern;
      signals.push("pattern");
    }
    if (weights.tag) {
      for (const tag of candidate.tags) {
        if (targetTags.has(tag)) {
          score += weights.tag;
          signals.push(`tag:${tag}`);
        }
      }
    }
    if (weights.kind && candidate.kind === target.kind) {
      score += weights.kind;
      signals.push("kind");
    }
    if (weights.textOverlap) {
      const overlap = jaccard(targetTokens, tokenize(`${candidate.title} ${candidate.summary}`));
      if (overlap > 0) {
        score += weights.textOverlap * overlap;
        signals.push(`text:${overlap.toFixed(2)}`);
      }
    }

    if (score >= minScore) {
      related.push({
        id: candidate.id,
        alias: candidate.aliases[0] ?? candidate.id,
        kind: candidate.kind,
        source: candidate.source,
        family: candidate.family,
        status: candidate.status,
        title: candidate.title,
        score: round(score),
        signals,
      });
    }
  }

  related.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  return {
    schemaVersion: PRIOR_ART_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    ticket: {
      id: target.id,
      alias: target.aliases[0] ?? target.id,
      family: target.family,
      kind: target.kind,
      title: target.title,
    },
    weights,
    filters: { minScore, limit },
    related: related.slice(0, limit),
  };
}
