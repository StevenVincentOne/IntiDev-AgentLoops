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
  const dir = await fs.mkdtemp(join(tmpdir(), "agentloops-workflow-audit-"));
  try {
    await seedConvergenceDemo(dir);
    const store = new AgentLoopStore(dir, { ...DEFAULT_CONFIG });
    await store.ensureInitialized();
    return await run(store);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("workflowAudit is empty when pattern and ticket statuses agree", async () => {
  await withSeededStore(async (store) => {
    // The demo seeds three same-family tickets that converge into one ACTIVE
    // pattern; all three tickets are still triaged -> no drift to report.
    const report = await store.workflowAudit();
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.summary.totalPatterns, 1);
    assert.equal(report.summary.resolvedWithActiveTickets, 0);
    assert.equal(report.summary.resolvedWithReopenedTickets, 0);
    assert.equal(report.summary.activeWithNoActiveTickets, 0);
    assert.deepEqual(report.resolvedPatternsWithActiveTickets, []);
    assert.deepEqual(report.resolvedPatternsWithReopenedTickets, []);
    assert.deepEqual(report.activePatternsWithNoActiveTickets, []);
  });
});

test("workflowAudit flags a resolved pattern with active (and reopened) linked tickets", async () => {
  await withSeededStore(async (store) => {
    const [pattern] = await store.listPatterns({ status: "all" });
    assert.ok(pattern, "demo seed should converge into a pattern");

    // Close the pattern out while its tickets are still open -> drift.
    await store.resolvePattern(pattern.id, "closed early");

    const afterResolve = await store.workflowAudit();
    assert.equal(afterResolve.summary.resolvedWithActiveTickets, 1);
    assert.equal(afterResolve.summary.resolvedWithReopenedTickets, 0);
    const flagged = afterResolve.resolvedPatternsWithActiveTickets[0];
    assert.equal(flagged.id, pattern.id);
    assert.equal(flagged.status, "resolved");
    assert.equal(flagged.linkedTicketCount, 3);
    assert.equal(flagged.activeLinkedTicketCount, 3);
    assert.equal(flagged.tickets.length, 3);

    // One of the linked tickets reopens -> stronger signal, separate bucket.
    await store.resolveTicket({ id: "ISSUE-000001", summary: "patched", rootCauseCertificate: MINIMAL_ROOT_CAUSE_CERT });
    await store.reopenTicket("ISSUE-000001", "regressed in prod");

    const afterReopen = await store.workflowAudit();
    assert.equal(afterReopen.summary.resolvedWithActiveTickets, 1);
    assert.equal(afterReopen.summary.resolvedWithReopenedTickets, 1);
    const reopened = afterReopen.resolvedPatternsWithReopenedTickets[0];
    assert.equal(reopened.id, pattern.id);
    assert.equal(reopened.tickets.length, 1);
    assert.equal(reopened.tickets[0].id, "ISSUE-000001");
    assert.equal(reopened.tickets[0].status, "reopened");
  });
});

test("workflowAudit flags an active pattern whose linked tickets are all closed out", async () => {
  await withSeededStore(async (store) => {
    const [pattern] = await store.listPatterns({ status: "all" });
    assert.equal(pattern.status, "active");

    // Close out every linked ticket without ever resolving the pattern itself.
    await store.resolveTicket({ id: "ISSUE-000001", summary: "patched", rootCauseCertificate: MINIMAL_ROOT_CAUSE_CERT });
    await store.resolveTicket({ id: "USER-000002", summary: "answered", rootCauseCertificate: MINIMAL_ROOT_CAUSE_CERT });
    await store.deferTicket("DEV-000003", "deprioritized");

    const report = await store.workflowAudit();
    assert.equal(report.summary.activeWithNoActiveTickets, 1);
    assert.equal(report.summary.resolvedWithActiveTickets, 0);
    const stale = report.activePatternsWithNoActiveTickets[0];
    assert.equal(stale.id, pattern.id);
    assert.equal(stale.status, "active");
    assert.equal(stale.linkedTicketCount, 3);
    assert.equal(stale.activeLinkedTicketCount, 0);
    assert.equal(stale.tickets.length, 3);
  });
});

test("workflowAudit respects the family filter", async () => {
  await withSeededStore(async (store) => {
    const [pattern] = await store.listPatterns({ status: "all" });
    await store.resolvePattern(pattern.id, "closed early");

    const matching = await store.workflowAudit({ family: pattern.family });
    assert.equal(matching.summary.totalPatterns, 1);
    assert.equal(matching.summary.resolvedWithActiveTickets, 1);
    assert.equal(matching.filters.family, pattern.family);

    const nonMatching = await store.workflowAudit({ family: "unrelated_family" });
    assert.equal(nonMatching.summary.totalPatterns, 0);
    assert.equal(nonMatching.summary.resolvedWithActiveTickets, 0);
    assert.equal(nonMatching.filters.family, "unrelated_family");
  });
});
