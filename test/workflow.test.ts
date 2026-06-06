import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { AgentLoopStore } from "../src/store";
import { seedConvergenceDemo } from "../scripts/demo-seed";

async function freshDir(): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), "agentloops-workflow-"));
  await seedConvergenceDemo(dir);
  return dir;
}

test("workflow transitions and their side effects persist across a fresh store", async () => {
  const dir = await freshDir();
  try {
    const writer = new AgentLoopStore(dir, { ...DEFAULT_CONFIG });
    await writer.beginTicket("ISSUE-000001");
    await writer.resolveTicket({
      id: "ISSUE-000001",
      summary: "patched the timeout",
      verification: "smoke green",
      guardStatus: "guard_added",
    });
    await writer.reopenTicket("USER-000002", "user saw it again");
    await writer.deferTicket("DEV-000003", "backlog for next quarter");

    // A brand-new store reading from disk must see every mutation — this is the
    // regression guard for the "mutate after persist" bug.
    const reader = new AgentLoopStore(dir, { ...DEFAULT_CONFIG });
    const issue = await reader.showTicket("ISSUE-000001");
    assert.equal(issue?.status, "resolved");
    assert.equal(issue?.resolutionSummary, "patched the timeout");
    assert.equal(issue?.verification, "smoke green");
    assert.equal(issue?.guardStatus, "guard_added");
    assert.ok(issue?.startedAt, "startedAt should persist");
    assert.ok(issue?.resolvedAt, "resolvedAt should persist");

    const user = await reader.showTicket("USER-000002");
    assert.equal(user?.status, "reopened");
    assert.equal(user?.notes.at(-1)?.body, "Reopened: user saw it again");

    const dev = await reader.showTicket("DEV-000003");
    assert.equal(dev?.status, "deferred");
    assert.equal(dev?.notes.at(-1)?.body, "Deferred: backlog for next quarter");

    const summary = await reader.summary();
    assert.equal(summary.resolvedTickets, 1);
    assert.equal(summary.reopenedTickets, 1);
    assert.equal(summary.deferredTickets, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("deferTicket works without a reason and records no note", async () => {
  const dir = await freshDir();
  try {
    const store = new AgentLoopStore(dir, { ...DEFAULT_CONFIG });
    const before = (await store.showTicket("ISSUE-000001"))?.notes.length ?? 0;
    const deferred = await store.deferTicket("ISSUE-000001");
    assert.equal(deferred.status, "deferred");
    assert.equal(deferred.notes.length, before);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
