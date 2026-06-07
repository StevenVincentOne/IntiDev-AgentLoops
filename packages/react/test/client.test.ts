import test from "node:test";
import assert from "node:assert/strict";
import { fetchPatterns, fetchSummary, fetchTickets } from "../src/client";
import { AgentLoopSummary, Pattern, Ticket } from "../src/types";

const SUMMARY: AgentLoopSummary = {
  project: "demo",
  totalTickets: 3,
  activeTickets: 1,
  triagedTickets: 1,
  resolvedTickets: 1,
  reopenedTickets: 0,
  deferredTickets: 0,
  openPatterns: 1,
  stalledPatterns: 0,
  resolvedPatterns: 0,
};

const TICKETS: Ticket[] = [
  {
    id: "ISSUE-000001",
    family: "export_pipeline",
    kind: "bug",
    source: "smoke",
    title: "Export crashes on large batches",
    summary: "The export pipeline throws on batches over 500 rows.",
    severity: "high",
    confidence: "high",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    aliases: ["ISSUE-000001"],
    tags: [],
  },
];

const PATTERNS: Pattern[] = [
  {
    id: "PATTERN-000001",
    family: "export_pipeline",
    title: "Recurring export_pipeline issues",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ticketIds: ["ISSUE-000001"],
  },
];

/** A deterministic fake `fetch` that records requested URLs and serves canned JSON. */
function fakeFetch(routes: Record<string, unknown>, status = 200): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const path = url.replace(/^https?:\/\/[^/]*/, "");
    const body = routes[path];
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "Error",
      json: async () => body,
    } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

test("fetchSummary/fetchTickets/fetchPatterns hit the expected paths and parse JSON", async () => {
  const { fetchImpl, calls } = fakeFetch({
    "/api/summary": SUMMARY,
    "/api/tickets": TICKETS,
    "/api/patterns": PATTERNS,
  });

  assert.deepEqual(await fetchSummary({ fetchImpl }), SUMMARY);
  assert.deepEqual(await fetchTickets({ fetchImpl }), TICKETS);
  assert.deepEqual(await fetchPatterns({ fetchImpl }), PATTERNS);
  assert.deepEqual(calls, ["/api/summary", "/api/tickets", "/api/patterns"]);
});

test("baseUrl is prefixed onto the request path", async () => {
  const { fetchImpl, calls } = fakeFetch({ "/api/summary": SUMMARY });
  await fetchSummary({ fetchImpl, baseUrl: "http://localhost:4319" });
  assert.deepEqual(calls, ["http://localhost:4319/api/summary"]);
});

test("a non-OK response is surfaced as a thrown Error naming the path and status", async () => {
  const { fetchImpl } = fakeFetch({ "/api/tickets": [] }, 500);
  await assert.rejects(() => fetchTickets({ fetchImpl }), /\/api\/tickets.*500/);
});
