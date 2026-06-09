import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { AgentLoopStore } from "../src/store";
import { seedConvergenceDemo } from "../scripts/demo-seed";
import { workflowRepairPlan } from "../src/workflow-repair";
import { MINIMAL_ROOT_CAUSE_CERT } from "./helpers";

async function withSeededStore<T>(run: (store: AgentLoopStore) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(join(tmpdir(), "agentloops-workflow-repair-"));
  try {
    await seedConvergenceDemo(dir);
    const store = new AgentLoopStore(dir, { ...DEFAULT_CONFIG });
    await store.ensureInitialized();
    return await run(store);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("workflowRepairPlan proposes nothing when pattern and ticket statuses already agree", async () => {
  await withSeededStore(async (store) => {
    // Mirrors workflow-audit.test.ts's first case: the demo seed's three
    // same-family tickets converge into one ACTIVE pattern, all still
    // triaged -> no drift, so nothing to repair.
    const tickets = await store.listTickets({ status: "all" });
    const patterns = await store.listPatterns({ status: "all" });
    const plan = workflowRepairPlan(tickets, patterns);

    assert.equal(plan.schemaVersion, 1);
    assert.deepEqual(plan.summary, {
      patternsConsidered: 1,
      reopens: 0,
      resolves: 0,
      totalActions: 0,
    });
    assert.deepEqual(plan.actions, []);
  });
});

test("repairWorkflow reopens a resolved pattern that still has active linked tickets, persists, and is idempotent", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "agentloops-workflow-repair-reopen-"));
  try {
    await seedConvergenceDemo(dir);
    const store = new AgentLoopStore(dir, { ...DEFAULT_CONFIG });
    await store.ensureInitialized();

    const [pattern] = await store.listPatterns({ status: "all" });
    assert.ok(pattern, "demo seed should converge into a pattern");

    // Close the pattern out early while its tickets are still open -- the
    // exact drift `workflow-audit.test.ts` exercises.
    await store.resolvePattern(pattern.id, "closed early");
    await store.resolveTicket({ id: "ISSUE-000001", summary: "patched", rootCauseCertificate: MINIMAL_ROOT_CAUSE_CERT });
    await store.reopenTicket("ISSUE-000001", "regressed in prod");

    // `dryRun` plans the fix without touching anything.
    const preview = await store.repairWorkflow({ dryRun: true });
    assert.equal(preview.applied, false);
    assert.equal(preview.summary.totalActions, 1);
    assert.equal(preview.summary.reopens, 1);
    assert.equal(preview.summary.resolves, 0);
    const [previewAction] = preview.actions;
    assert.equal(previewAction.patternId, pattern.id);
    assert.equal(previewAction.fromStatus, "resolved");
    assert.equal(previewAction.toStatus, "reopened");
    assert.equal(previewAction.reason, "reopened_linked_tickets");
    // The reopened ticket is the strongest signal -- it's the one surfaced.
    assert.deepEqual(
      previewAction.tickets.map((t) => t.id),
      ["ISSUE-000001"],
    );
    assert.equal(previewAction.tickets[0].status, "reopened");

    // Previewing must not mutate or persist anything.
    const stillResolved = await store.getPattern(pattern.id);
    assert.equal(stillResolved?.status, "resolved");

    // Now actually apply it.
    const applied = await store.repairWorkflow({});
    assert.equal(applied.applied, true);
    assert.equal(applied.summary.totalActions, 1);
    assert.deepEqual(
      applied.actions.map(({ ...a }) => a),
      preview.actions.map(({ ...a }) => a),
    );

    const fixed = await store.getPattern(pattern.id);
    assert.equal(fixed?.status, "reopened");

    // Persists -- a fresh store over the same directory sees the new status.
    const reloaded = new AgentLoopStore(dir, { ...DEFAULT_CONFIG });
    await reloaded.ensureInitialized();
    assert.equal((await reloaded.getPattern(pattern.id))?.status, "reopened");

    // Drift resolved -> a follow-up plan finds nothing left to do.
    const settled = await store.repairWorkflow({ dryRun: true });
    assert.equal(settled.summary.totalActions, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("repairWorkflow resolves a stale pattern whose linked tickets are all closed out", async () => {
  await withSeededStore(async (store) => {
    const [pattern] = await store.listPatterns({ status: "all" });
    assert.equal(pattern.status, "active");

    // Close out every linked ticket without ever resolving the pattern --
    // the second drift case `workflow-audit.test.ts` exercises.
    await store.resolveTicket({ id: "ISSUE-000001", summary: "patched", rootCauseCertificate: MINIMAL_ROOT_CAUSE_CERT });
    await store.resolveTicket({ id: "USER-000002", summary: "answered", rootCauseCertificate: MINIMAL_ROOT_CAUSE_CERT });
    await store.deferTicket("DEV-000003", "deprioritized");

    const preview = await store.repairWorkflow({ dryRun: true });
    assert.equal(preview.applied, false);
    assert.equal(preview.summary.totalActions, 1);
    assert.equal(preview.summary.reopens, 0);
    assert.equal(preview.summary.resolves, 1);
    const [action] = preview.actions;
    assert.equal(action.patternId, pattern.id);
    assert.equal(action.fromStatus, "active");
    assert.equal(action.toStatus, "resolved");
    assert.equal(action.reason, "all_linked_tickets_closed");
    assert.equal(action.linkedTicketCount, 3);
    assert.equal(action.activeLinkedTicketCount, 0);
    assert.equal(action.tickets.length, 3);

    // Still untouched after a dry run.
    assert.equal((await store.getPattern(pattern.id))?.status, "active");

    const applied = await store.repairWorkflow({});
    assert.equal(applied.applied, true);
    assert.equal((await store.getPattern(pattern.id))?.status, "resolved");

    // Idempotent: nothing left to repair once the drift is gone.
    const settled = await store.repairWorkflow({ dryRun: true });
    assert.equal(settled.summary.totalActions, 0);
    assert.deepEqual(settled.actions, []);
  });
});

test("repairWorkflow respects the family filter", async () => {
  await withSeededStore(async (store) => {
    const [pattern] = await store.listPatterns({ status: "all" });
    await store.resolvePattern(pattern.id, "closed early");

    // A non-matching family filter sees no drift and applies nothing.
    const elsewhere = await store.repairWorkflow({ family: "unrelated_family" });
    assert.equal(elsewhere.summary.totalActions, 0);
    assert.equal(elsewhere.filters.family, "unrelated_family");
    assert.equal((await store.getPattern(pattern.id))?.status, "resolved");

    // The matching family filter finds and fixes it.
    const matching = await store.repairWorkflow({ family: pattern.family });
    assert.equal(matching.summary.totalActions, 1);
    assert.equal(matching.filters.family, pattern.family);
    assert.equal((await store.getPattern(pattern.id))?.status, "reopened");
  });
});
