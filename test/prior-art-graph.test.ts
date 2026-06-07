import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { AgentLoopStore } from "../src/store";
import { seedConvergenceDemo } from "../scripts/demo-seed";
import {
  decayedStrength,
  refreshPriorArtGraph,
  priorArtGraphForTicket,
} from "../src/prior-art-graph";
import { PriorArtEdge, Ticket } from "../src/types";

async function withSeededStore<T>(run: (store: AgentLoopStore) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(join(tmpdir(), "agentloops-prior-art-graph-"));
  try {
    await seedConvergenceDemo(dir);
    const store = new AgentLoopStore(dir, { ...DEFAULT_CONFIG });
    await store.ensureInitialized();
    return await run(store);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function allocateIdFrom(prefix: string): () => string {
  let seq = 0;
  return () => `${prefix}-${String(++seq).padStart(6, "0")}`;
}

const NOW_1 = "2026-01-01T00:00:00.000Z";
const NOW_PLUS_7 = "2026-01-08T00:00:00.000Z";
const NOW_PLUS_14 = "2026-01-15T00:00:00.000Z"; // exactly one default half-life later
const NOW_PLUS_140 = "2026-05-21T00:00:00.000Z"; // exactly ten default half-lives later

test("decayedStrength halves every half-life and never looks backwards", () => {
  const edge = { score: 10, lastSeenAt: NOW_1 };

  assert.equal(decayedStrength(edge, NOW_1, 14), 10); // no elapsed time, no decay
  assert.equal(decayedStrength(edge, NOW_PLUS_14, 14), 5); // exactly one half-life
  assert.equal(
    Math.round(decayedStrength(edge, NOW_PLUS_140, 14) * 1e6) / 1e6,
    Math.round((10 * Math.pow(0.5, 10)) * 1e6) / 1e6,
  ); // ten half-lives

  // `asOf` before `lastSeenAt` is treated as zero elapsed time (no time travel).
  assert.equal(decayedStrength(edge, "2025-12-25T00:00:00.000Z", 14), 10);

  // A non-positive half-life disables decay entirely.
  assert.equal(decayedStrength(edge, NOW_PLUS_140, 0), 10);
});

test("refreshPriorArtGraph scores every pair deterministically and creates edges for the demo seed", async () => {
  await withSeededStore(async (store) => {
    const tickets: Ticket[] = await store.listTickets({ status: "all" });
    assert.equal(tickets.length, 3);

    const { edges, summary } = refreshPriorArtGraph(tickets, [], allocateIdFrom("EDGE"), {
      minScore: 1,
      now: NOW_1,
    });

    // 3 tickets -> C(3,2) = 3 unordered pairs; the demo seed's three tickets
    // all share family + pattern + an "export" tag, so every pair clears the
    // default minScore and becomes a brand-new edge.
    assert.deepEqual(summary, {
      ticketsConsidered: 3,
      pairsScored: 3,
      edgesReinforced: 0,
      edgesCreated: 3,
      edgesDecayedOnly: 0,
      edgesPruned: 0,
      totalEdges: 3,
    });

    // ISSUE-000001 / ISSUE-000002 (USER-000002): family (3) + pattern (3) +
    // shared "export" tag (2) + text overlap (0.29166... * 4 = 1.1666...)
    // -> 9.1666... rounds to 9.167. The underlying ~0.29 overlap is the same
    // value asserted in near-duplicates.test.ts (same tokenize/jaccard
    // machinery, same demo corpus); the score itself is computed from the
    // unrounded overlap, while the recorded signal is its 2-decimal display.
    const pair = edges.find(
      (e) => e.ticketIds[0] === "ISSUE-000001" && e.ticketIds[1] === "ISSUE-000002",
    );
    assert.ok(pair, "expected an edge between ISSUE-000001 and ISSUE-000002");
    assert.equal(pair?.score, 9.167);
    assert.deepEqual(pair?.signals, ["family", "pattern", "tag:export", "text:0.29"]);
    assert.equal(pair?.strength, 9.167);
    assert.equal(pair?.firstSeenAt, NOW_1);
    assert.equal(pair?.lastSeenAt, NOW_1);
    assert.equal(pair?.id, "EDGE-000001");

    // Edges are returned strongest-first.
    for (let i = 1; i < edges.length; i += 1) {
      assert.ok(edges[i - 1].strength >= edges[i].strength);
    }
  });
});

test("refreshPriorArtGraph reinforces edges that keep qualifying on a later refresh", async () => {
  await withSeededStore(async (store) => {
    const tickets: Ticket[] = await store.listTickets({ status: "all" });
    const allocate = allocateIdFrom("EDGE");

    const first = refreshPriorArtGraph(tickets, [], allocate, { minScore: 1, now: NOW_1 });
    assert.equal(first.summary.edgesCreated, 3);

    const second = refreshPriorArtGraph(tickets, first.edges, allocate, {
      minScore: 1,
      now: NOW_PLUS_7,
    });

    // Same pairs, same scores -> every edge is reinforced in place, none
    // created or merely decayed.
    assert.deepEqual(
      { ...second.summary },
      {
        ticketsConsidered: 3,
        pairsScored: 3,
        edgesReinforced: 3,
        edgesCreated: 0,
        edgesDecayedOnly: 0,
        edgesPruned: 0,
        totalEdges: 3,
      },
    );

    const pair = second.edges.find(
      (e) => e.ticketIds[0] === "ISSUE-000001" && e.ticketIds[1] === "ISSUE-000002",
    );
    // Reinforcement keeps the edge's identity and `firstSeenAt`, but bumps
    // `lastSeenAt`/`updatedAt` and resets `strength` back up to the fresh score.
    assert.equal(pair?.id, "EDGE-000001");
    assert.equal(pair?.firstSeenAt, NOW_1);
    assert.equal(pair?.lastSeenAt, NOW_PLUS_7);
    assert.equal(pair?.score, 9.167);
    assert.equal(pair?.strength, 9.167);
  });
});

test("refreshPriorArtGraph fades edges that stop qualifying, then prunes them once they cross the floor", async () => {
  await withSeededStore(async (store) => {
    const tickets: Ticket[] = await store.listTickets({ status: "all" });
    const allocate = allocateIdFrom("EDGE");

    const created = refreshPriorArtGraph(tickets, [], allocate, { minScore: 1, now: NOW_1 });
    assert.equal(created.summary.totalEdges, 3);
    const maxScore = Math.max(...created.edges.map((e) => e.score));

    // Raise `minScore` far above anything the demo corpus can score: every
    // pair stops "qualifying", so existing edges are neither reinforced nor
    // recreated -- they can only decay in place.
    const decayedOnly = refreshPriorArtGraph(tickets, created.edges, allocate, {
      minScore: maxScore + 100,
      decayHalfLifeDays: 14,
      now: NOW_PLUS_14, // exactly one half-life after NOW_1
    });

    assert.deepEqual(
      { ...decayedOnly.summary },
      {
        ticketsConsidered: 3,
        pairsScored: 3,
        edgesReinforced: 0,
        edgesCreated: 0,
        edgesDecayedOnly: 3,
        edgesPruned: 0,
        totalEdges: 3,
      },
    );
    for (const edge of decayedOnly.edges) {
      const original = created.edges.find((e) => e.id === edge.id);
      assert.ok(original);
      // Exactly one half-life elapsed -> strength is precisely halved, and
      // `lastSeenAt`/`firstSeenAt` are untouched (no fresh evidence arrived).
      assert.equal(edge.strength, Math.round(original!.score * 0.5 * 1000) / 1000);
      assert.equal(edge.lastSeenAt, NOW_1);
      assert.equal(edge.firstSeenAt, NOW_1);
      assert.equal(edge.updatedAt, NOW_PLUS_14);
    }

    // Ten half-lives after the original sighting, every edge has decayed to
    // roughly score/1024 -- below the default 0.05 floor for this corpus -- so
    // a further refresh prunes all of them.
    const pruned = refreshPriorArtGraph(tickets, decayedOnly.edges, allocate, {
      minScore: maxScore + 100,
      decayHalfLifeDays: 14,
      now: NOW_PLUS_140,
    });
    assert.deepEqual(
      { ...pruned.summary },
      {
        ticketsConsidered: 3,
        pairsScored: 3,
        edgesReinforced: 0,
        edgesCreated: 0,
        edgesDecayedOnly: 0,
        edgesPruned: 3,
        totalEdges: 0,
      },
    );
    assert.deepEqual(pruned.edges, []);
  });
});

test("priorArtGraphForTicket reports a target's edges with strength decayed at query time", () => {
  const tickets: Ticket[] = [
    {
      id: "ISSUE-000001",
      family: "f",
      kind: "bug",
      source: "smoke",
      title: "Target ticket",
      summary: "the ticket we're querying prior art for",
      severity: "high",
      confidence: "high",
      status: "active",
      createdAt: NOW_1,
      updatedAt: NOW_1,
      aliases: ["ISSUE-000001"],
      tags: [],
      notes: [],
      reproducible: true,
    },
    {
      id: "ISSUE-000002",
      family: "f",
      kind: "bug",
      source: "smoke",
      title: "Strongly related ticket",
      summary: "closely overlapping wording",
      severity: "high",
      confidence: "high",
      status: "active",
      createdAt: NOW_1,
      updatedAt: NOW_1,
      aliases: ["ISSUE-000002"],
      tags: [],
      notes: [],
      reproducible: true,
    },
    {
      id: "ISSUE-000003",
      family: "f",
      kind: "bug",
      source: "smoke",
      title: "Weakly related ticket",
      summary: "barely overlapping wording",
      severity: "low",
      confidence: "low",
      status: "active",
      createdAt: NOW_1,
      updatedAt: NOW_1,
      aliases: ["ISSUE-000003"],
      tags: [],
      notes: [],
      reproducible: true,
    },
    {
      id: "ISSUE-000004",
      family: "other",
      kind: "feature",
      source: "agent",
      title: "Unrelated ticket",
      summary: "nothing to do with the target",
      severity: "low",
      confidence: "low",
      status: "active",
      createdAt: NOW_1,
      updatedAt: NOW_1,
      aliases: ["ISSUE-000004"],
      tags: [],
      notes: [],
      reproducible: true,
    },
  ];

  const edges: PriorArtEdge[] = [
    {
      id: "EDGE-000001",
      ticketIds: ["ISSUE-000001", "ISSUE-000002"],
      score: 10,
      signals: ["family", "text:0.80"],
      strength: 10,
      firstSeenAt: NOW_1,
      lastSeenAt: NOW_1,
      createdAt: NOW_1,
      updatedAt: NOW_1,
    },
    {
      id: "EDGE-000002",
      ticketIds: ["ISSUE-000001", "ISSUE-000003"],
      score: 4,
      signals: ["family"],
      strength: 4,
      firstSeenAt: NOW_1,
      lastSeenAt: NOW_1,
      createdAt: NOW_1,
      updatedAt: NOW_1,
    },
    {
      id: "EDGE-000003",
      ticketIds: ["ISSUE-000002", "ISSUE-000004"],
      score: 8,
      signals: ["kind"],
      strength: 8,
      firstSeenAt: NOW_1,
      lastSeenAt: NOW_1,
      createdAt: NOW_1,
      updatedAt: NOW_1,
    },
  ];

  // Querying exactly one half-life after `lastSeenAt`: both of the target's
  // edges have their `score` halved into `strength` -- decay is computed at
  // *query* time, not frozen at the last refresh.
  const report = priorArtGraphForTicket("ISSUE-000001", tickets, edges, {
    decayHalfLifeDays: 14,
    now: NOW_PLUS_14,
  });

  assert.equal(report.schemaVersion, 1);
  assert.equal(report.ticket.id, "ISSUE-000001");
  assert.deepEqual(report.filters, { decayHalfLifeDays: 14, minStrength: 0, limit: 10 });

  // Only edges touching the target are reported (not EDGE-000003), strongest
  // decayed-strength first.
  assert.equal(report.edges.length, 2);
  assert.deepEqual(
    report.edges.map((e) => e.ticket.id),
    ["ISSUE-000002", "ISSUE-000003"],
  );
  assert.equal(report.edges[0].edgeId, "EDGE-000001");
  assert.equal(report.edges[0].score, 10);
  assert.equal(report.edges[0].strength, 5); // 10 * 0.5^(14/14)
  assert.equal(report.edges[1].edgeId, "EDGE-000002");
  assert.equal(report.edges[1].score, 4);
  assert.equal(report.edges[1].strength, 2); // 4 * 0.5^(14/14)

  // `minStrength` filters by the *decayed* strength, not the raw score.
  const filtered = priorArtGraphForTicket("ISSUE-000001", tickets, edges, {
    decayHalfLifeDays: 14,
    minStrength: 3,
    now: NOW_PLUS_14,
  });
  assert.deepEqual(
    filtered.edges.map((e) => e.ticket.id),
    ["ISSUE-000002"],
  );

  // `limit` caps the result count after sorting.
  const limited = priorArtGraphForTicket("ISSUE-000001", tickets, edges, {
    decayHalfLifeDays: 14,
    limit: 1,
    now: NOW_PLUS_14,
  });
  assert.equal(limited.edges.length, 1);
  assert.equal(limited.edges[0].ticket.id, "ISSUE-000002");

  assert.throws(
    () => priorArtGraphForTicket("ISSUE-999999", tickets, edges, { now: NOW_PLUS_14 }),
    /Not found/,
  );
});

test("store.refreshPriorArtGraph persists durable edges that survive reload, and store.priorArtGraph queries them with decay applied", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "agentloops-prior-art-graph-store-"));
  try {
    await seedConvergenceDemo(dir);

    const writer = new AgentLoopStore(dir, { ...DEFAULT_CONFIG });
    await writer.ensureInitialized();

    // `store.refreshPriorArtGraph` doesn't accept a test-only `now` override
    // (that knob exists on the pure functions for deterministic unit tests
    // only) -- it stamps edges with the real wall clock, same as every other
    // write path in the store.
    const summary = await writer.refreshPriorArtGraph({ minScore: 1 });
    assert.equal(summary.edgesCreated, 3);
    assert.equal(summary.totalEdges, 3);

    // A fresh store instance over the same directory must reload the
    // persisted edges from disk (mirroring the Postgres round-trip pattern).
    const reader = new AgentLoopStore(dir, { ...DEFAULT_CONFIG });
    await reader.ensureInitialized();

    const graph = await reader.priorArtGraph("ISSUE-000001", {});
    assert.equal(graph.schemaVersion, 1);
    assert.equal(graph.ticket.id, "ISSUE-000001");
    assert.ok(graph.edges.length >= 1);

    for (const entry of graph.edges) {
      // Some real time has elapsed since the refresh stamped `lastSeenAt`, so
      // query-time decay must have nudged strength down from (or held it at,
      // in the limit of zero elapsed time) the persisted score -- never above.
      assert.ok(entry.strength > 0);
      assert.ok(entry.strength <= entry.score);
    }

    // Resolves by alias too, same as `related`.
    const byAlias = await reader.priorArtGraph("USER-000002", {});
    assert.equal(byAlias.ticket.id, "ISSUE-000002");

    await assert.rejects(() => reader.priorArtGraph("NOPE-9", {}), /Not found/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
