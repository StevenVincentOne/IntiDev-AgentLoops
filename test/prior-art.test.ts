import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { AgentLoopStore } from "../src/store";
import { seedConvergenceDemo } from "../scripts/demo-seed";

async function withSeededStore<T>(run: (store: AgentLoopStore) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(join(tmpdir(), "agentloops-priorart-"));
  try {
    await seedConvergenceDemo(dir);
    const store = new AgentLoopStore(dir, { ...DEFAULT_CONFIG });
    await store.ensureInitialized();
    return await run(store);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("related ranks tickets that share family, pattern, and tags", async () => {
  await withSeededStore(async (store) => {
    // An unrelated ticket (different family/kind/tags/text) should not surface.
    await store.createTicket({
      kind: "tech_debt",
      source: "manual_admin",
      family: "billing",
      title: "Refactor invoice rounding",
      summary: "Decimal drift in monthly invoice totals",
      tags: ["invoice"],
    });

    const report = await store.related("ISSUE-000001");
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.ticket.id, "ISSUE-000001");

    // The two demo siblings are related; the billing ticket is not.
    assert.deepEqual(
      report.related.map((r) => r.id).sort(),
      ["ISSUE-000002", "ISSUE-000003"],
    );
    for (const rel of report.related) {
      assert.ok(rel.score > 0);
      assert.ok(rel.signals.includes("family"));
      assert.ok(rel.signals.includes("pattern"));
      assert.ok(rel.signals.includes("tag:export"));
    }
  });
});

test("related honors aliases, minScore, and limit", async () => {
  await withSeededStore(async (store) => {
    // Alias resolves to the canonical ticket.
    const viaAlias = await store.related("USER-000002");
    assert.equal(viaAlias.ticket.id, "ISSUE-000002");
    assert.deepEqual(
      viaAlias.related.map((r) => r.id).sort(),
      ["ISSUE-000001", "ISSUE-000003"],
    );

    // An unreachable score yields nothing.
    const strict = await store.related("ISSUE-000001", { minScore: 999 });
    assert.equal(strict.related.length, 0);

    // limit caps the result set.
    const limited = await store.related("ISSUE-000001", { limit: 1 });
    assert.equal(limited.related.length, 1);

    await assert.rejects(() => store.related("ISSUE-999999"), /Not found/);
  });
});
