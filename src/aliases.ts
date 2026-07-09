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
 * Queue resolution applies configured queue order and prioritizes each queue's
 * kind match over source match. This intentionally keeps `kind` as the primary
 * routing signal while still supporting explicit `source`-based routing where
 * configured and no kind match exists for that queue. Falls back to the
 * `default` queue when no match is found.
 */
export function resolveQueuePrefix(
  input: { kind: string; source?: string },
  config: ProjectConfig,
): string {
  const source = input.source ?? "";
  for (const queue of config.queues) {
    if (queue.kinds?.includes(input.kind as TicketKind)) return queue.prefix;
    if (queue.sources?.includes(source)) return queue.prefix;
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
