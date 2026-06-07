import { useCallback, useEffect, useState } from "react";
import { AgentLoopClientOptions, fetchPatterns, fetchSummary, fetchTickets } from "./client";
import { AgentLoopSummary, Pattern, Ticket } from "./types";

export interface AgentLoopData {
  summary: AgentLoopSummary;
  tickets: Ticket[];
  patterns: Pattern[];
}

export interface UseAgentLoopDataResult {
  /** Last successfully loaded snapshot, or `undefined` before the first load completes. */
  data: AgentLoopData | undefined;
  /** True while a fetch (initial or refresh) is in flight. */
  loading: boolean;
  /** Set when the most recent fetch failed; cleared on the next successful fetch. */
  error: Error | undefined;
  /** Re-fetch summary, tickets, and patterns from the API. */
  refresh: () => void;
}

/**
 * Loads ticket-ledger data from a running `agentloop serve` instance's
 * read-only JSON API (`/api/summary`, `/api/tickets`, `/api/patterns`).
 * Fetches once on mount; call `refresh()` to reload (e.g. on an interval or
 * after a write elsewhere triggers a change).
 */
export function useAgentLoopData(options: AgentLoopClientOptions = {}): UseAgentLoopDataResult {
  const { baseUrl, fetchImpl } = options;
  const [data, setData] = useState<AgentLoopData | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [generation, setGeneration] = useState(0);

  const refresh = useCallback(() => setGeneration((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const clientOptions: AgentLoopClientOptions = { baseUrl, fetchImpl };

    Promise.all([fetchSummary(clientOptions), fetchTickets(clientOptions), fetchPatterns(clientOptions)])
      .then(([summary, tickets, patterns]) => {
        if (cancelled) return;
        setData({ summary, tickets, patterns });
        setError(undefined);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setError(reason instanceof Error ? reason : new Error(String(reason)));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [baseUrl, fetchImpl, generation]);

  return { data, loading, error, refresh };
}
