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
  const dir = await fs.mkdtemp(join(tmpdir(), "agentloops-guard-"));
  try {
    await seedConvergenceDemo(dir);
    const store = new AgentLoopStore(dir, { ...DEFAULT_CONFIG });
    await store.ensureInitialized();
    return await run(store);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("guardGaps reports resolved guard-relevant tickets without an active guard", async () => {
  await withSeededStore(async (store) => {
    // Nothing resolved yet -> no gaps.
    const empty = await store.guardGaps();
    assert.equal(empty.summary.resolvedConsidered, 0);
    assert.equal(empty.summary.gaps, 0);

    // ISSUE (bug) resolved with no guard -> missing gap.
    await store.resolveTicket({ id: "ISSUE-000001", summary: "patched", guardStatus: "none", rootCauseCertificate: MINIMAL_ROOT_CAUSE_CERT });
    // USER resolved with a deferred guard -> deferred gap.
    await store.resolveTicket({
      id: "USER-000002",
      summary: "answered",
      guardStatus: "guard_deferred",
      rootCauseCertificate: MINIMAL_ROOT_CAUSE_CERT,
    });
    // DEV (feature) resolved with no guard -> NOT guard-relevant by default.
    await store.resolveTicket({ id: "DEV-000003", summary: "shipped", guardStatus: "none" });

    const report = await store.guardGaps();
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.summary.resolvedConsidered, 2); // ISSUE + USER only
    assert.equal(report.summary.guarded, 0);
    assert.equal(report.summary.gaps, 2);
    assert.equal(report.summary.missing, 1);
    assert.equal(report.summary.deferred, 1);

    // Ordered missing-first.
    assert.equal(report.gaps[0].id, "ISSUE-000001");
    assert.equal(report.gaps[0].reason, "missing");
    assert.equal(report.gaps[1].alias, "USER-000002");
    assert.equal(report.gaps[1].reason, "deferred");

    // allKinds pulls in the resolved DEV ticket too.
    const all = await store.guardGaps({ allKinds: true });
    assert.equal(all.summary.resolvedConsidered, 3);
    assert.equal(all.summary.missing, 2);
    assert.equal(all.summary.gaps, 3);
  });
});

test("guardGaps treats active guards as covered and waived as opt-in", async () => {
  await withSeededStore(async (store) => {
    await store.resolveTicket({
      id: "ISSUE-000001",
      summary: "patched",
      guardStatus: "guard_added",
      rootCauseCertificate: MINIMAL_ROOT_CAUSE_CERT,
    });
    await store.resolveTicket({
      id: "USER-000002",
      summary: "answered",
      guardStatus: "guard_waived",
      rootCauseCertificate: MINIMAL_ROOT_CAUSE_CERT,
    });

    const report = await store.guardGaps();
    assert.equal(report.summary.guarded, 1); // ISSUE-000001 is covered
    assert.equal(report.summary.waived, 1); // USER-000002 waived, counted...
    assert.equal(report.summary.gaps, 0); // ...but not a gap by default

    const withWaived = await store.guardGaps({ includeWaived: true });
    assert.equal(withWaived.summary.gaps, 1);
    assert.equal(withWaived.gaps[0].reason, "waived");
  });
});
