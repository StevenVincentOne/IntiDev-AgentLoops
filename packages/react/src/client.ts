import { AgentLoopSummary, Pattern, Ticket } from "./types";

export interface AgentLoopClientOptions {
  /** Base URL of a running `agentloop serve` instance, e.g. "http://localhost:4319". Defaults to "" (same origin). */
  baseUrl?: string;
  /** Injectable fetch, e.g. for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

async function getJson<T>(path: string, options: AgentLoopClientOptions): Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${options.baseUrl ?? ""}${path}`;
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`AgentLoops API request to ${path} failed: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

export function fetchSummary(options: AgentLoopClientOptions = {}): Promise<AgentLoopSummary> {
  return getJson<AgentLoopSummary>("/api/summary", options);
}

export function fetchTickets(options: AgentLoopClientOptions = {}): Promise<Ticket[]> {
  return getJson<Ticket[]>("/api/tickets", options);
}

export function fetchPatterns(options: AgentLoopClientOptions = {}): Promise<Pattern[]> {
  return getJson<Pattern[]>("/api/patterns", options);
}
