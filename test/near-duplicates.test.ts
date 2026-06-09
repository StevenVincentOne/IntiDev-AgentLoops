import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { AgentLoopStore } from "../src/store";
import { seedConvergenceDemo } from "../scripts/demo-seed";
import { MINIMAL_ROOT_CAUSE_CERT } from "./helpers";

async function withSeededStore<T>(run: (store: AgentLoopStore) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(join(tmpdir(), "agentloops-near-duplicates-"));
  try {
    await seedConvergenceDemo(dir);
    const store = new AgentLoopStore(dir, { ...DEFAULT_CONFIG });
    await store.ensureInitialized();
    return await run(store);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("nearDuplicates finds nothing among the demo seed at the default threshold", async () => {
  await withSeededStore(async (store) => {
    // The seeded tickets describe related-but-distinct angles on the same
    // problem (smoke/user/agent loops) — related enough to converge into a
    // pattern, but their title/summary overlap (~0.29 at most) sits below the
    // default 0.5 near-duplicate gate. No false positives.
    const report = await store.nearDuplicates();
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.summary.ticketsConsidered, 3);
    assert.equal(report.summary.pairsFlagged, 0);
    assert.deepEqual(report.pairs, []);
    assert.equal(report.filters.minTextOverlap, 0.5);
  });
});

test("nearDuplicates flags a pair reported with near-identical wording", async () => {
  await withSeededStore(async (store) => {
    const wording = {
      title: "Login page crashes when clicking submit",
      summary: "Clicking submit on the login page crashes the app for every user.",
    };

    await store.createTicket({
      kind: "bug",
      source: "smoke",
      family: "auth_session",
      title: wording.title,
      summary: wording.summary,
      severity: "high",
      confidence: "high",
      tags: ["auth", "crash"],
    });
    await store.createTicket({
      kind: "user_feedback",
      source: "user_report",
      family: "auth_session",
      title: wording.title,
      summary: wording.summary,
      severity: "high",
      confidence: "medium",
      tags: ["auth", "user"],
    });

    const report = await store.nearDuplicates();
    assert.equal(report.summary.pairsFlagged, 1);
    const [pair] = report.pairs;
    assert.equal(pair.textOverlap, 1);
    assert.deepEqual(pair.signals, ["text:1.00", "family", "tag:auth"]);
    assert.equal(pair.a.id, "ISSUE-000004"); // smoke-sourced bug, lower id
    assert.equal(pair.b.id, "ISSUE-000005"); // user-report, same family
    assert.equal(pair.a.title, wording.title);
    assert.equal(pair.b.title, wording.title);
  });
});

test("nearDuplicates surfaces softer overlap once minTextOverlap is lowered", async () => {
  await withSeededStore(async (store) => {
    // ISSUE-000001 ("Export smoke test times out...") and USER-000002 ("Export
    // fails for long reports...") overlap at ~0.29 — below the default gate,
    // but a clear near-duplicate once the threshold is relaxed.
    const report = await store.nearDuplicates({ minTextOverlap: 0.2 });
    assert.equal(report.summary.pairsFlagged, 1);
    const [pair] = report.pairs;
    assert.equal(pair.textOverlap, 0.29);
    assert.equal(pair.a.id, "ISSUE-000001");
    assert.equal(pair.b.id, "ISSUE-000002");
    assert.deepEqual(pair.signals, ["text:0.29", "family", "tag:export"]);
    assert.equal(report.filters.minTextOverlap, 0.2);
  });
});

test("nearDuplicates respects the family filter and excludes resolved work by default", async () => {
  await withSeededStore(async (store) => {
    const wording = {
      title: "Export retries hang the worker queue",
      summary: "Retrying a failed export hangs the background worker queue indefinitely.",
    };
    const a = await store.createTicket({
      kind: "bug",
      source: "smoke",
      family: "queue_worker",
      title: wording.title,
      summary: wording.summary,
      severity: "high",
      confidence: "high",
      tags: ["queue"],
    });
    await store.createTicket({
      kind: "bug",
      source: "user_report",
      family: "queue_worker",
      title: wording.title,
      summary: wording.summary,
      severity: "high",
      confidence: "medium",
      tags: ["queue"],
    });

    const scoped = await store.nearDuplicates({ family: "queue_worker" });
    assert.equal(scoped.summary.ticketsConsidered, 2);
    assert.equal(scoped.summary.pairsFlagged, 1);
    assert.equal(scoped.filters.family, "queue_worker");

    const elsewhere = await store.nearDuplicates({ family: "export_pipeline" });
    assert.equal(elsewhere.summary.pairsFlagged, 0);

    // Resolve one side of the duplicate pair: by default it drops out of scope.
    await store.resolveTicket({ id: a.id, summary: "fixed the retry loop", rootCauseCertificate: MINIMAL_ROOT_CAUSE_CERT });
    const afterResolve = await store.nearDuplicates({ family: "queue_worker" });
    assert.equal(afterResolve.summary.ticketsConsidered, 1);
    assert.equal(afterResolve.summary.pairsFlagged, 0);

    // `includeResolved` brings it back into scope.
    const widened = await store.nearDuplicates({ family: "queue_worker", includeResolved: true });
    assert.equal(widened.summary.ticketsConsidered, 2);
    assert.equal(widened.summary.pairsFlagged, 1);
    assert.equal(widened.filters.includeResolved, true);
  });
});
