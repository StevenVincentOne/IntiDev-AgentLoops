import { ProjectConfig, TicketKind } from "./types";

const SEQ_PAD = 6;

/** Zero-pad a ticket sequence number to the canonical width. */
export function padSeq(seq: number): string {
  return String(seq).padStart(SEQ_PAD, "0");
}

/** The canonical key for a ticket is always `ISSUE-NNNNNN`, regardless of queue. */
export function canonicalKey(seq: number): string {
  return `ISSUE-${padSeq(seq)}`;
}

/**
 * Resolve the single queue-alias prefix for a ticket from its kind and source.
 *
 * Ported from Inti's `TicketAliases` (USER → DEV → ISSUE precedence): a queue
 * matches when the ticket's `source` is in `queue.sources` OR its `kind` is in
 * `queue.kinds`. Queues are tried in config order, so the source override (e.g.
 * `user_report` → USER) wins for any kind. Falls back to the `default` queue.
 */
export function resolveQueuePrefix(
  input: { kind: string; source?: string },
  config: ProjectConfig,
): string {
  const source = input.source ?? "";
  for (const queue of config.queues) {
    if (queue.sources?.includes(source)) return queue.prefix;
    if (queue.kinds?.includes(input.kind as TicketKind)) return queue.prefix;
  }
  const fallback = config.queues.find((queue) => queue.default);
  return fallback?.prefix ?? "ISSUE";
}

/**
 * Build the user-facing alias key(s) for a ticket. Currently a single queue
 * alias; returned as an array to keep the `Ticket.aliases` shape stable.
 */
export function deriveAliases(
  input: { kind: string; source?: string },
  seq: number,
  config: ProjectConfig,
): string[] {
  return [`${resolveQueuePrefix(input, config)}-${padSeq(seq)}`];
}
