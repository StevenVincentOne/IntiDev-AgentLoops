import { Pattern, PatternStatus, Ticket, TicketStatus } from "./types";

export const SOURCE_CONVERGENCE_SCHEMA_VERSION = 1 as const;
export const DEFAULT_MIN_SOURCES = 2;

export interface SourceConvergenceOptions {
  /** Minimum distinct sources for a pattern to count as converged. Default 2. */
  minSources?: number;
  /** Restrict the audit to a single family. */
  family?: string;
  /** Include non-converged patterns in `patterns` too. Default false. */
  includeAll?: boolean;
}

export interface ConvergenceTicketRef {
  id: string;
  alias: string;
  source: string;
  kind: string;
  status: TicketStatus;
}

export interface ConvergencePattern {
  id: string;
  family: string;
  title: string;
  status: PatternStatus;
  ticketCount: number;
  /** Number of distinct sources among the pattern's tickets. */
  sourceCount: number;
  /** Count of tickets per source. */
  sources: Record<string, number>;
  converged: boolean;
  tickets: ConvergenceTicketRef[];
}

export interface SourceConvergenceReport {
  schemaVersion: typeof SOURCE_CONVERGENCE_SCHEMA_VERSION;
  generatedAt: string;
  filters: { family: string | null; minSources: number };
  summary: {
    totalPatterns: number;
    convergedPatterns: number;
    /** Highest distinct-source count across the analyzed patterns. */
    maxSourceConvergence: number;
  };
  patterns: ConvergencePattern[];
}

/**
 * Source-convergence audit (ported concept from Inti's ledger): surface the
 * Patterns whose member tickets were reported through **multiple distinct
 * sources**. A pattern corroborated by, say, a smoke run + a user report + an
 * agent is far higher-signal than a single-source cluster.
 *
 * Pure and deterministic apart from `generatedAt`. Patterns are returned sorted
 * by source diversity (then ticket count, then id) so output is stable.
 */
export function sourceConvergenceReport(
  tickets: Ticket[],
  patterns: Pattern[],
  options: SourceConvergenceOptions = {},
): SourceConvergenceReport {
  const minSources = Math.max(1, Math.trunc(options.minSources ?? DEFAULT_MIN_SOURCES));
  const familyFilter = options.family;
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));

  const scoped = patterns.filter((pattern) => !familyFilter || pattern.family === familyFilter);

  const analyzed: ConvergencePattern[] = scoped.map((pattern) => {
    const members = pattern.ticketIds
      .map((id) => byId.get(id))
      .filter((ticket): ticket is Ticket => Boolean(ticket));
    const sources: Record<string, number> = {};
    for (const ticket of members) {
      sources[ticket.source] = (sources[ticket.source] ?? 0) + 1;
    }
    const sourceCount = Object.keys(sources).length;
    return {
      id: pattern.id,
      family: pattern.family,
      title: pattern.title,
      status: pattern.status,
      ticketCount: members.length,
      sourceCount,
      sources,
      converged: sourceCount >= minSources,
      tickets: members.map((ticket) => ({
        id: ticket.id,
        alias: ticket.aliases[0] ?? ticket.id,
        source: ticket.source,
        kind: ticket.kind,
        status: ticket.status,
      })),
    };
  });

  const converged = analyzed.filter((pattern) => pattern.converged);
  const visible = (options.includeAll ? analyzed : converged).sort(
    (a, b) =>
      b.sourceCount - a.sourceCount ||
      b.ticketCount - a.ticketCount ||
      a.id.localeCompare(b.id),
  );

  return {
    schemaVersion: SOURCE_CONVERGENCE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    filters: { family: familyFilter ?? null, minSources },
    summary: {
      totalPatterns: analyzed.length,
      convergedPatterns: converged.length,
      maxSourceConvergence: analyzed.reduce((max, pattern) => Math.max(max, pattern.sourceCount), 0),
    },
    patterns: visible,
  };
}
