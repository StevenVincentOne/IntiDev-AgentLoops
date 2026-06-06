import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { AgentLoopStore } from "../src/store";
import { seedConvergenceDemo } from "../scripts/demo-seed";

async function withSeededStore<T>(run: (store: AgentLoopStore) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(join(tmpdir(), "agentloops-conv-"));
  try {
    await seedConvergenceDemo(dir);
    const store = new AgentLoopStore(dir, { ...DEFAULT_CONFIG });
    await store.ensureInitialized();
    return await run(store);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("sourceConvergence flags patterns spanning multiple sources", async () => {
  await withSeededStore(async (store) => {
    // The demo's export_pipeline pattern has 3 sources; add a single-source
    // ticket in a different family so its pattern is NOT converged.
    await store.createTicket({
      kind: "bug",
      source: "smoke",
      family: "auth_session",
      title: "auth flake",
      summary: "intermittent login failure",
    });

    const report = await store.sourceConvergence();
    assert.equal(report.schemaVersion, 1);
    assert.match(report.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(report.filters, { family: null, minSources: 2 });

    assert.equal(report.summary.totalPatterns, 2);
    assert.equal(report.summary.convergedPatterns, 1);
    assert.equal(report.summary.maxSourceConvergence, 3);

    // Only the multi-source pattern is reported by default.
    assert.equal(report.patterns.length, 1);
    const [top] = report.patterns;
    assert.equal(top.family, "export_pipeline");
    assert.equal(top.sourceCount, 3);
    assert.equal(top.converged, true);
    assert.deepEqual(Object.keys(top.sources).sort(), ["agent", "smoke", "user_report"]);
    assert.equal(top.tickets.length, 3);
  });
});

test("sourceConvergence honors includeAll, family, and minSources", async () => {
  await withSeededStore(async (store) => {
    await store.createTicket({
      kind: "bug",
      source: "smoke",
      family: "auth_session",
      title: "auth flake",
      summary: "intermittent login failure",
    });

    // includeAll surfaces the single-source pattern too.
    const all = await store.sourceConvergence({ includeAll: true });
    assert.equal(all.patterns.length, 2);
    const authPattern = all.patterns.find((p) => p.family === "auth_session");
    assert.equal(authPattern?.converged, false);
    assert.equal(authPattern?.sourceCount, 1);

    // family filter scopes the audit.
    const scoped = await store.sourceConvergence({ family: "export_pipeline" });
    assert.equal(scoped.summary.totalPatterns, 1);
    assert.equal(scoped.patterns.length, 1);

    // Raising the bar past the max convergence yields nothing converged.
    const strict = await store.sourceConvergence({ minSources: 4 });
    assert.equal(strict.summary.convergedPatterns, 0);
    assert.equal(strict.patterns.length, 0);
  });
});
