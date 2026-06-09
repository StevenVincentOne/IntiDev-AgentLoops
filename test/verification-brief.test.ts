import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { AgentLoopStore } from "../src/store";
import { ProjectConfig, Ticket, VerificationBrief } from "../src/types";

/**
 * Regression coverage for the verification-brief workflow (ported concept
 * from Inti's Reader artifact-verification contract, generalized for an
 * open-source Tickets system — see `src/verification.ts`).
 *
 * The bug this guards against: deterministic resolver rules that accept weak
 * evidence too early — e.g. cascade-resolving a multi-ticket Pattern from a
 * single current-code replay of one page/region, which proves only a narrow
 * case but gets treated as sufficient to close the whole Pattern. The fix
 * keeps deterministic rules as *guardrails* (right shape of evidence present
 * and internally coherent) while leaving the actual sufficiency *judgment* to
 * the agent (`agentJudgment`/`reason`).
 *
 * Domain vocabulary here ("export_pipeline", "DOC-..." ids, "reupload" vs
 * "replay") is test fixture vocabulary, not a port of Inti's Reader-specific
 * names — the feature itself is entirely config-driven (`config.verification`).
 */

const SENSITIVE_FAMILY = "export_pipeline";
const NON_SENSITIVE_FAMILY = "general";

function withVerificationConfig(overrides?: Partial<ProjectConfig["verification"]>): ProjectConfig {
  return {
    ...DEFAULT_CONFIG,
    // Opt out of rootCauseCertificate requirement so tests focus on verificationBrief logic.
    rootCause: { meaningfulKinds: [] },
    verification: {
      sensitiveFamilyPatterns: [`^${SENSITIVE_FAMILY}$`],
      artifactIdPattern: "\\b(DOC-\\d+)\\b",
      ...overrides,
    },
  };
}

async function withStore<T>(config: ProjectConfig, run: (store: AgentLoopStore) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(join(tmpdir(), "agentloops-verification-brief-"));
  try {
    const store = new AgentLoopStore(dir, config);
    await store.ensureInitialized();
    return await run(store);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function createSensitiveTicket(
  store: AgentLoopStore,
  overrides: Partial<{ title: string; summary: string; priorArtHint: Ticket["priorArtHint"] }> = {},
): Promise<Ticket> {
  return store.createTicket({
    kind: "bug",
    source: "user_report",
    family: SENSITIVE_FAMILY,
    title: overrides.title ?? "Export of DOC-1001 renders boxed prose as an image",
    summary:
      overrides.summary ??
      "Reported on chapter_03 of DOC-1001: prose in the export rendered as a boxed image instead of body text.",
    severity: "high",
    confidence: "high",
    priorArtHint: overrides.priorArtHint,
  });
}

// Deliberately neutral — names no verification *method* vocabulary (no "fresh"/
// "reupload"/"end-to-end"/"replay"/"unit test"/etc.) so it can't accidentally
// satisfy the fresh-vs-replay text-matching fallback in `assertVerificationBriefForResolution`
// regardless of which `verificationPerformed` a given test brief declares.
const SUFFICIENT_BRIEF_BASE = {
  agentJudgment: "sufficient",
  reason: "This evidence demonstrates the change resolves the reported problem exactly as claimed, with the observed output now matching expectations.",
};

test("non-sensitive tickets keep the lightweight resolution path (no brief required)", async () => {
  await withStore(withVerificationConfig(), async (store) => {
    const ticket = await store.createTicket({
      kind: "bug",
      source: "agent",
      family: NON_SENSITIVE_FAMILY,
      title: "Typo in onboarding email subject line",
      summary: "Subject line says 'Welcom' instead of 'Welcome'.",
      severity: "low",
      confidence: "high",
    });
    const resolved = await store.resolveTicket({
      id: ticket.id,
      summary: "Fixed the typo in the onboarding template.",
      verification: "Sent a test email and confirmed the corrected subject line.",
    });
    assert.equal(resolved.status, "resolved");
    assert.equal(resolved.verificationBrief, undefined);
  });
});

test("sensitive-domain resolution fails when verificationBrief is missing", async () => {
  await withStore(withVerificationConfig(), async (store) => {
    const ticket = await createSensitiveTicket(store);
    await assert.rejects(
      () =>
        store.resolveTicket({
          id: ticket.id,
          summary: "Fixed the boxed-prose rendering bug for DOC-1001.",
          verification: "Ran npm run check and a current-code replay of the stored chapter_03 artifact.",
        }),
      /requires a structured verificationBrief/,
    );
    const reloaded = await store.getTicketByAnyId(ticket.id);
    assert.equal(reloaded?.status, "triaged", "a failed guardrail must not leave the ticket half-resolved");
  });
});

test("fails when affected artifact ids known from the ticket are absent from the brief/evidence", async () => {
  await withStore(withVerificationConfig(), async (store) => {
    const ticket = await createSensitiveTicket(store); // title/summary name DOC-1001
    const brief: VerificationBrief = {
      claimScope: "single_ticket",
      verificationPerformed: ["current-code replay"],
      coverage: "the reported chapter rendered as body text after the fix",
      ...SUFFICIENT_BRIEF_BASE,
      // Note: affectedArtifactIds omitted, and reason/coverage above don't name DOC-1001 either.
    };
    await assert.rejects(
      () =>
        store.resolveTicket({
          id: ticket.id,
          summary: "Fixed the boxed-prose rendering bug.",
          verificationBrief: brief,
        }),
      /known affected artifact\/entity id\(s\) \(DOC-1001\)/,
    );
  });
});

test("fails when agentJudgment is not an explicit sufficiency call", async () => {
  await withStore(withVerificationConfig(), async (store) => {
    const ticket = await createSensitiveTicket(store);
    const brief: VerificationBrief = {
      claimScope: "single_ticket",
      affectedArtifactIds: ["DOC-1001"],
      verificationPerformed: ["targeted reupload"],
      coverage: "the reported instance in DOC-1001 chapter_03",
      agentJudgment: "looks good to me",
      reason: "Re-ran the export and the chapter rendered as expected this time around, seems fine now.",
    };
    await assert.rejects(
      () =>
        store.resolveTicket({ id: ticket.id, summary: "Fixed the rendering bug for DOC-1001.", verificationBrief: brief }),
      /agentJudgment must be an explicit sufficiency call/,
    );
  });
});

test("fails when the reason is a placeholder rather than a substantive explanation", async () => {
  await withStore(withVerificationConfig(), async (store) => {
    const ticket = await createSensitiveTicket(store);
    const brief: VerificationBrief = {
      claimScope: "single_ticket",
      affectedArtifactIds: ["DOC-1001"],
      verificationPerformed: ["targeted reupload"],
      coverage: "the reported instance in DOC-1001",
      agentJudgment: "sufficient",
      reason: "Fixed it.",
    };
    await assert.rejects(
      () =>
        store.resolveTicket({ id: ticket.id, summary: "Fixed the rendering bug.", verificationBrief: brief }),
      /reason must explain \*why\*/,
    );
  });
});

test("recurrence (priorArtHint) resolution fails on replay-only evidence and succeeds with fresh evidence", async () => {
  await withStore(withVerificationConfig(), async (store) => {
    const ticket = await createSensitiveTicket(store, { priorArtHint: "previously_ticketed" });

    const replayOnlyBrief: VerificationBrief = {
      claimScope: "single_ticket",
      affectedArtifactIds: ["DOC-1001"],
      reportedLocations: ["chapter_03"],
      verificationPerformed: ["current-code replay", "unit test"],
      coverage: "the reported instance in DOC-1001 chapter_03",
      ...SUFFICIENT_BRIEF_BASE,
    };
    await assert.rejects(
      () =>
        store.resolveTicket({
          id: ticket.id,
          summary: "Fixed the recurring rendering bug for DOC-1001.",
          verificationBrief: replayOnlyBrief,
        }),
      /prior-work cue.*replay-only\/unit-only evidence is not enough/s,
    );

    const freshBrief: VerificationBrief = {
      ...replayOnlyBrief,
      verificationPerformed: ["targeted reupload", "post-ingest scan"],
    };
    const resolved = await store.resolveTicket({
      id: ticket.id,
      summary: "Fixed the recurring rendering bug for DOC-1001.",
      verificationBrief: freshBrief,
    });
    assert.equal(resolved.status, "resolved");
    assert.deepEqual(resolved.verificationBrief?.verificationPerformed, ["targeted reupload", "post-ingest scan"]);
  });
});

test("a narrow, non-recurring single-ticket fix may close on replay evidence that names the affected id", async () => {
  await withStore(withVerificationConfig(), async (store) => {
    const ticket = await createSensitiveTicket(store); // priorArtHint left unset -> not a recurrence
    const brief: VerificationBrief = {
      claimScope: "single_ticket",
      affectedArtifactIds: ["DOC-1001"],
      reportedLocations: ["chapter_03"],
      verificationPerformed: ["current-code replay"],
      coverage: "the single reported instance in DOC-1001 chapter_03, which was the true input to the changed renderer",
      agentJudgment: "sufficient",
      reason:
        "The stored chapter_03 artifact for DOC-1001 is the true input to the changed renderer; replaying it against the fixed code reproduced the reported instance and it now renders as body text.",
    };
    const resolved = await store.resolveTicket({
      id: ticket.id,
      summary: "Fixed the boxed-prose renderer for DOC-1001 chapter_03.",
      verificationBrief: brief,
    });
    assert.equal(resolved.status, "resolved");
    assert.equal(resolved.verificationBrief?.claimScope, "single_ticket");
  });
});

test("Pattern/group claim scopes require fresh evidence and broad-coverage language even for a single ticket", async () => {
  await withStore(withVerificationConfig(), async (store) => {
    const ticket = await createSensitiveTicket(store);
    const narrowPatternClaim: VerificationBrief = {
      claimScope: "pattern",
      affectedArtifactIds: ["DOC-1001"],
      verificationPerformed: ["current-code replay"],
      coverage: "the single reported instance in DOC-1001 chapter_03",
      ...SUFFICIENT_BRIEF_BASE,
    };
    await assert.rejects(
      () =>
        store.resolveTicket({
          id: ticket.id,
          summary: "Closing the Pattern from this single replay.",
          verificationBrief: narrowPatternClaim,
        }),
      /scope spanning multiple tickets.*replay-only\/unit-only evidence is not enough/s,
      "claiming a Pattern scope must not be a back door around the recurrence/cascade guardrails",
    );

    const broadFreshClaim: VerificationBrief = {
      ...narrowPatternClaim,
      verificationPerformed: ["full reprocess", "post-ingest scan"],
      coverage: "all reported instances across every linked ticket in the Pattern",
    };
    const resolved = await store.resolveTicket({
      id: ticket.id,
      summary: "Closing the Pattern after a full reprocess covering every linked ticket.",
      verificationBrief: broadFreshClaim,
    });
    assert.equal(resolved.status, "resolved");
  });
});

test("cascadeResolvePattern escalates fresh + broad-coverage requirements once 2+ linked tickets are sensitive", async () => {
  await withStore(withVerificationConfig(), async (store) => {
    const a = await createSensitiveTicket(store, {
      title: "DOC-1001 chapter_03 prose rendered as boxed image",
      summary: "DOC-1001 chapter_03: prose rendered as a boxed image instead of body text.",
    });
    const b = await createSensitiveTicket(store, {
      title: "DOC-1002 chapter_07 prose rendered as boxed image",
      summary: "DOC-1002 chapter_07: the same boxed-image rendering bug as DOC-1001.",
    });
    // A non-sensitive third member should not affect the escalation count.
    const c = await store.createTicket({
      kind: "task",
      source: "agent",
      family: SENSITIVE_FAMILY,
      title: "Add regression smoke for export rendering",
      summary: "Track adding a smoke test for the export renderer once the fix lands.",
      severity: "low",
      confidence: "medium",
    });

    // `createTicket` auto-attaches same-family tickets to a shared (reused, not-yet-resolved)
    // Pattern via `attachPattern` — a, b, and c therefore already share one Pattern.
    const patternId = sharedPatternId([a, b, c]);

    const narrowSingleReplay: VerificationBrief = {
      claimScope: "single_ticket",
      affectedArtifactIds: ["DOC-1001"],
      verificationPerformed: ["current-code replay"],
      coverage: "the single reported instance in DOC-1001 chapter_03",
      ...SUFFICIENT_BRIEF_BASE,
    };
    await assert.rejects(
      () =>
        store.cascadeResolvePattern({
          patternId,
          summary: "Closing the whole Pattern from a single narrow replay.",
          verificationBrief: narrowSingleReplay,
        }),
      /replay-only\/unit-only evidence is not enough|requires broad-coverage language/,
      "cascading from a single narrow replay across 2+ sensitive tickets must be rejected — this is the exact bug scenario",
    );

    const broadFreshBrief: VerificationBrief = {
      claimScope: "cascade",
      affectedArtifactIds: ["DOC-1001", "DOC-1002"],
      verificationPerformed: ["full reprocess", "post-ingest scan"],
      coverage: "all reported instances across every linked ticket (DOC-1001 chapter_03 and DOC-1002 chapter_07)",
      agentJudgment: "sufficient",
      reason:
        "A full reprocess of both affected documents after the fix exercised every reported instance across all linked tickets, and each rendered as body text rather than a boxed image.",
    };
    const result = await store.cascadeResolvePattern({
      patternId,
      summary: "Closed the export-rendering Pattern after a full reprocess covering both linked documents.",
      verificationBrief: broadFreshBrief,
    });

    assert.equal(result.escalatedVerification, true, "2 sensitive linked tickets must trigger escalation");
    assert.equal(result.pattern.status, "resolved");
    const resolvedIds = result.resolvedTickets.map((t) => t.id).sort();
    assert.deepEqual(resolvedIds, [a.id, b.id, c.id].sort());
    for (const ticket of result.resolvedTickets) {
      assert.equal(ticket.status, "resolved");
      assert.equal(ticket.verificationBrief?.claimScope, "cascade");
    }
  });
});

test("cascadeResolvePattern does not escalate when only one linked ticket is sensitive", async () => {
  await withStore(withVerificationConfig(), async (store) => {
    const sensitive = await createSensitiveTicket(store);
    const mundane = await store.createTicket({
      kind: "task",
      source: "agent",
      family: SENSITIVE_FAMILY,
      title: "Document the export pipeline runbook",
      summary: "Write up the operational runbook for the export pipeline.",
      severity: "low",
      confidence: "medium",
    });
    const patternId = sharedPatternId([sensitive, mundane]);

    const narrowReplay: VerificationBrief = {
      claimScope: "single_ticket",
      affectedArtifactIds: ["DOC-1001"],
      reportedLocations: ["chapter_03"],
      verificationPerformed: ["current-code replay"],
      coverage: "the single reported instance in DOC-1001 chapter_03, the true input to the changed renderer",
      agentJudgment: "sufficient",
      reason:
        "The stored chapter_03 artifact for DOC-1001 is the true input to the changed renderer; replaying it reproduced and resolved the one reported instance.",
    };

    const result = await store.cascadeResolvePattern({
      patternId,
      summary: "Closed the lone sensitive ticket on a narrow replay; the other member is just documentation work.",
      verificationBrief: narrowReplay,
    });
    assert.equal(result.escalatedVerification, false, "only one sensitive linked ticket must not escalate");
    assert.equal(result.resolvedTickets.length, 2);
  });
});

test("a bad cascade fails atomically: no linked ticket is resolved when validation fails for any of them", async () => {
  await withStore(withVerificationConfig(), async (store) => {
    const a = await createSensitiveTicket(store, {
      title: "DOC-1001 chapter_03 prose rendered as boxed image",
      summary: "DOC-1001 chapter_03: prose rendered as a boxed image instead of body text.",
    });
    const b = await createSensitiveTicket(store, {
      title: "DOC-1002 chapter_07 prose rendered as boxed image",
      summary: "DOC-1002 chapter_07: the same boxed-image rendering bug as DOC-1001.",
    });
    const patternId = sharedPatternId([a, b]);

    await assert.rejects(
      () =>
        store.cascadeResolvePattern({
          patternId,
          summary: "Attempting to close the whole Pattern with no evidence at all.",
        }),
      /requires a structured verificationBrief/,
    );

    const reloadedA = await store.getTicketByAnyId(a.id);
    const reloadedB = await store.getTicketByAnyId(b.id);
    assert.equal(reloadedA?.status, "triaged");
    assert.equal(reloadedB?.status, "triaged");
    const reloadedPattern = await store.getPattern(patternId);
    assert.notEqual(reloadedPattern?.status, "resolved");
  });
});

/**
 * `createTicket` auto-attaches every ticket to a shared, reused, not-yet-
 * resolved Pattern in its family (`attachPattern`/`config.patterns.autoCreateByFamily`,
 * on by default). All of these fixtures create same-family tickets back to
 * back with no resolution in between, so they are guaranteed to land on one
 * shared Pattern — this just asserts that and returns its id, giving these
 * tests a deterministic Pattern to cascade-resolve without depending on
 * `promoteGroup`'s Group-clustering heuristics.
 */
function sharedPatternId(tickets: Ticket[]): string {
  const ids = new Set(tickets.map((ticket) => ticket.patternId));
  assert.equal(ids.size, 1, "fixture tickets were expected to auto-link to one shared Pattern");
  const [id] = [...ids];
  assert.ok(id, "fixture tickets were expected to have an attached patternId");
  return id as string;
}
