import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../src/config";
import { AgentLoopStore } from "../src/store";
import {
  serializeState,
  deserializeRows,
  PostgresStateBackend,
  TICKET_SCHEMA_SQL,
} from "../src/postgres";
import { LoopState } from "../src/types";

function sampleState(): LoopState {
  const ts = "2026-01-01T00:00:00.000Z";
  return {
    version: 1,
    project: "Sample",
    createdAt: ts,
    updatedAt: ts,
    nextTicketSeq: 2,
    nextPatternSeq: 1,
    patterns: [
      {
        id: "PATTERN-000001",
        family: "f",
        title: "Recurring f",
        status: "active",
        createdAt: ts,
        updatedAt: ts,
        ticketIds: ["ISSUE-000001", "ISSUE-000002"],
      },
    ],
    tickets: [
      {
        id: "ISSUE-000001",
        family: "f",
        kind: "bug",
        source: "smoke",
        title: "t1",
        summary: "s1",
        severity: "high",
        confidence: "high",
        status: "resolved",
        createdAt: ts,
        updatedAt: ts,
        startedAt: ts,
        resolvedAt: ts,
        aliases: ["ISSUE-000001"],
        tags: ["a", "b"],
        notes: [{ id: "n1", type: "triage", body: "note", author: "x", createdAt: ts }],
        handoffText: "h",
        guardStatus: "guard_added",
        guardSummary: "g",
        patternId: "PATTERN-000001",
        verification: "v",
        reproducible: true,
        resolutionSummary: "r",
      },
      {
        id: "ISSUE-000002",
        family: "f",
        kind: "user_feedback",
        source: "user_report",
        title: "t2",
        summary: "s2",
        severity: "medium",
        confidence: "medium",
        status: "triaged",
        createdAt: ts,
        updatedAt: ts,
        aliases: ["USER-000002"],
        tags: [],
        notes: [],
        reproducible: true,
        patternId: "PATTERN-000001",
      },
    ],
  };
}

test("serializeState/deserializeRows round-trips the ledger", () => {
  const state = sampleState();
  const restored = deserializeRows(serializeState(state));
  assert.deepEqual(JSON.parse(JSON.stringify(restored)), JSON.parse(JSON.stringify(state)));
});

test("TICKET_SCHEMA_SQL defines the public ticket_* tables", () => {
  for (const table of [
    "loop_meta",
    "ticket_patterns",
    "tickets",
    "ticket_aliases",
    "ticket_tags",
    "ticket_notes",
    "ticket_pattern_links",
  ]) {
    assert.ok(TICKET_SCHEMA_SQL.includes(table), `schema should define ${table}`);
  }
});

const DB = process.env.DATABASE_URL;

test("PostgresStateBackend round-trips a ledger through a real database", { skip: !DB }, async () => {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: DB });
  const drop =
    "DROP TABLE IF EXISTS ticket_pattern_links, ticket_notes, ticket_tags, ticket_aliases, tickets, ticket_patterns, loop_meta";
  try {
    await pool.query(drop);

    const writer = new AgentLoopStore("", { ...DEFAULT_CONFIG }, { backend: new PostgresStateBackend(pool) });
    await writer.createTicket({
      kind: "bug",
      source: "smoke",
      family: "export_pipeline",
      title: "Export times out",
      summary: "smoke timeout",
      tags: ["export", "timeout"],
    });
    await writer.createTicket({
      kind: "user_feedback",
      source: "user_report",
      family: "export_pipeline",
      title: "Export fails",
      summary: "user report",
      tags: ["export"],
    });
    await writer.createTicket({
      kind: "feature",
      source: "agent",
      family: "export_pipeline",
      title: "Stream export",
      summary: "streaming",
      tags: ["export"],
    });
    await writer.resolveTicket({
      id: "ISSUE-000001",
      summary: "added timeout guard",
      verification: "smoke green",
      guardStatus: "guard_added",
    });

    // A fresh store + fresh backend must reconstruct everything from the DB.
    const reader = new AgentLoopStore("", { ...DEFAULT_CONFIG }, { backend: new PostgresStateBackend(pool) });
    const summary = await reader.summary();
    assert.equal(summary.totalTickets, 3);
    assert.equal(summary.resolvedTickets, 1);

    const issue = await reader.showTicket("ISSUE-000001");
    assert.equal(issue?.status, "resolved");
    assert.equal(issue?.resolutionSummary, "added timeout guard");
    assert.equal(issue?.verification, "smoke green");
    assert.equal(issue?.guardStatus, "guard_added");
    assert.deepEqual(issue?.tags, ["export", "timeout"]);

    assert.equal((await reader.showTicket("USER-000002"))?.aliases[0], "USER-000002");

    const convergence = await reader.sourceConvergence();
    assert.equal(convergence.summary.convergedPatterns, 1);
    assert.equal(convergence.patterns[0].sourceCount, 3);

    const related = await reader.related("ISSUE-000001");
    assert.ok(related.related.length >= 1);
  } finally {
    await pool.query(drop).catch(() => {});
    await pool.end();
  }
});
