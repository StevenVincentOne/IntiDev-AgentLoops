import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { AgentLoopStore } from "../src/store";
import { seedConvergenceDemo } from "../scripts/demo-seed";

async function withSeededStore<T>(run: (store: AgentLoopStore) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(join(tmpdir(), "agentloops-knowledge-"));
  try {
    await seedConvergenceDemo(dir);
    const store = new AgentLoopStore(dir, { ...DEFAULT_CONFIG });
    await store.ensureInitialized();
    return await run(store);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// Resolve the three demo tickets with varying knowledge completeness.
async function resolveDemo(store: AgentLoopStore): Promise<void> {
  await store.resolveTicket({
    id: "ISSUE-000001",
    summary: "Added a timeout guard around the exporter",
    verification: "export smoke green",
  });
  await store.resolveTicket({ id: "USER-000002", summary: "Documented the long-report workaround" });
  await store.resolveTicket({ id: "DEV-000003", summary: "Shipped the streaming pipeline" });
}

test("resolutionKnowledge builds a searchable corpus from resolved tickets", async () => {
  await withSeededStore(async (store) => {
    const before = await store.searchKnowledge();
    assert.equal(before.summary.resolvedWithKnowledge, 0);

    await resolveDemo(store);

    const all = await store.searchKnowledge();
    assert.equal(all.schemaVersion, 1);
    assert.equal(all.summary.resolvedWithKnowledge, 3);
    assert.equal(all.summary.verified, 1); // only ISSUE-000001 has verification
    assert.equal(all.entries.length, 3);

    // Free-text search matches the resolution text.
    const timeout = await store.searchKnowledge({ query: "timeout guard" });
    assert.equal(timeout.summary.matched, 1);
    assert.equal(timeout.entries[0].id, "ISSUE-000001");
    assert.equal(timeout.entries[0].verified, true);

    // Filter by kind.
    const features = await store.searchKnowledge({ kind: "feature" });
    assert.equal(features.entries.length, 1);
    assert.equal(features.entries[0].alias, "DEV-000003");

    // limit caps the returned entries but keeps the matched count.
    const limited = await store.searchKnowledge({ limit: 1 });
    assert.equal(limited.entries.length, 1);
    assert.equal(limited.summary.matched, 3);
  });
});

test("knowledgeGaps flags resolved tickets lacking reusable knowledge", async () => {
  await withSeededStore(async (store) => {
    await resolveDemo(store);

    const report = await store.knowledgeGaps();
    assert.equal(report.summary.resolved, 3);
    assert.equal(report.summary.complete, 1); // ISSUE-000001 has resolution + verification
    assert.equal(report.summary.unverified, 2); // USER-000002, DEV-000003
    assert.equal(report.summary.gaps, 2);
    assert.ok(report.gaps.every((gap) => gap.reason === "unverified"));

    // family filter scopes the audit (all three share export_pipeline here).
    const scoped = await store.knowledgeGaps({ family: "export_pipeline" });
    assert.equal(scoped.summary.resolved, 3);
    const none = await store.knowledgeGaps({ family: "nonexistent" });
    assert.equal(none.summary.resolved, 0);
    assert.equal(none.summary.gaps, 0);
  });
});
