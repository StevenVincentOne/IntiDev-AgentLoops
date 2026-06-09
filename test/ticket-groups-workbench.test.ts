import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { AgentLoopStore } from "../src/store";
import { ProjectConfig } from "../src/types";
import { MINIMAL_ROOT_CAUSE_CERT } from "./helpers";
import { PRIOR_ART_SCHEMA_VERSION, PriorArtReport } from "../src/prior-art";
import {
  aggregateGroupPriorArt,
  findTicketGroup,
  TicketGroup,
  TicketGroupsReport,
  TICKET_GROUPS_SCHEMA_VERSION,
} from "../src/ticket-groups";

async function withStore<T>(
  configOverrides: Partial<ProjectConfig>,
  run: (store: AgentLoopStore) => Promise<T>,
): Promise<T> {
  const dir = await fs.mkdtemp(join(tmpdir(), "agentloops-ticket-groups-workbench-"));
  try {
    const config: ProjectConfig = { ...DEFAULT_CONFIG, ...configOverrides };
    const store = new AgentLoopStore(dir, config);
    await store.ensureInitialized();
    return await run(store);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/**
 * Seeds a resolved "prior art" ticket plus an open Group of three tickets in
 * the same family — two sharing distinctive "repeating glyph artifact"
 * wording with the resolved ticket (and each other), one symptomatically
 * unrelated — so `begin-group` has real cross-member prior art to aggregate
 * and a real keyword cluster to surface as a candidate symptom-Pattern.
 */
async function seedWorkbenchFixture(store: AgentLoopStore) {
  const resolved = await store.createTicket({
    kind: "bug",
    source: "smoke",
    family: "reader_ingestion",
    title: "Repeating glyph artifact corrupts thumbnail cache",
    summary: "Thumbnail cache shows a repeating glyph artifact after export.",
    severity: "high",
    confidence: "high",
  });
  await store.resolveTicket({
    id: resolved.id,
    summary: "Cleared and regenerated the thumbnail cache deterministically.",
    verification: "smoke green",
    guardStatus: "guard_added",
    rootCauseCertificate: MINIMAL_ROOT_CAUSE_CERT,
  });

  const a1 = await store.createTicket({
    kind: "bug",
    source: "smoke",
    family: "reader_ingestion",
    title: "Repeating glyph artifact in chapter export",
    summary: "Exported chapter shows a repeating glyph artifact near page breaks.",
    severity: "high",
    confidence: "high",
  });
  const a2 = await store.createTicket({
    kind: "bug",
    source: "user_report",
    family: "reader_ingestion",
    title: "Repeating glyph artifact in section export",
    summary: "Exported section shows the same repeating glyph artifact.",
    severity: "high",
    confidence: "medium",
  });
  const a3 = await store.createTicket({
    kind: "bug",
    source: "smoke",
    family: "reader_ingestion",
    title: "Reader fails to open a large scanned PDF",
    summary: "Opening a large scanned PDF causes Reader app to hang indefinitely.",
    severity: "medium",
    confidence: "medium",
  });

  // An open ticket in a *different* family — required so the `reader_ingestion`
  // family bucket (3 of 4 open tickets) clears `ticketGroupsReport`'s "narrower
  // than the whole active set" filter and actually surfaces as a computed Group.
  const other = await store.createTicket({
    kind: "bug",
    source: "smoke",
    family: "auth_session",
    title: "Session token refresh races with logout",
    summary: "Refreshing a session token concurrently with logout drops the user.",
    severity: "low",
    confidence: "medium",
  });

  return { resolved, a1, a2, a3, other };
}

function findGroup(report: TicketGroupsReport, key: string): TicketGroup {
  const group = report.groups.find((entry) => entry.key === key);
  assert.ok(group, `expected a computed group with key ${key}`);
  return group!;
}

// ---------------------------------------------------------------------------
// aggregateGroupPriorArt — pure dedup/scoring
// ---------------------------------------------------------------------------

function relatedReport(ticketAlias: string, candidates: PriorArtReport["related"]): PriorArtReport {
  return {
    schemaVersion: PRIOR_ART_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    ticket: { id: ticketAlias, alias: ticketAlias, family: "reader_ingestion", kind: "bug", title: ticketAlias },
    weights: { family: 1, pattern: 1, tag: 1, kind: 1, text: 1 },
    filters: { minScore: 1, limit: 10 },
    related: candidates,
  };
}

function candidate(alias: string, score: number, signals: string[]): PriorArtReport["related"][number] {
  return {
    id: alias,
    alias,
    kind: "bug",
    source: "smoke",
    family: "reader_ingestion",
    status: "resolved",
    title: `Title for ${alias}`,
    score,
    signals,
  };
}

test("aggregateGroupPriorArt dedupes candidates across members, summing score and merging signals", () => {
  const reports = [
    relatedReport("ISSUE-000010", [candidate("ISSUE-000001", 6, ["family", "text:0.4"]), candidate("ISSUE-000002", 2, ["family"])]),
    relatedReport("ISSUE-000011", [candidate("ISSUE-000001", 5, ["family", "text:0.3"]), candidate("ISSUE-000003", 3, ["tag:export"])]),
  ];

  const aggregated = aggregateGroupPriorArt(reports, 10);

  // ISSUE-000001 was surfaced by both members: highest occurrenceCount wins the ranking.
  assert.equal(aggregated[0].key, "ISSUE-000001");
  assert.equal(aggregated[0].occurrenceCount, 2);
  assert.equal(aggregated[0].score, 11); // 6 + 5
  assert.deepEqual(aggregated[0].sourceTicketKeys, ["ISSUE-000010", "ISSUE-000011"]);
  assert.deepEqual(aggregated[0].signals.sort(), ["family", "text:0.3", "text:0.4"]);

  // Single-occurrence candidates remain present but rank below the recurring one.
  const ids = aggregated.map((entry) => entry.key);
  assert.deepEqual(ids, ["ISSUE-000001", "ISSUE-000003", "ISSUE-000002"]);
});

test("aggregateGroupPriorArt respects the limit", () => {
  const reports = [
    relatedReport("ISSUE-000010", [
      candidate("ISSUE-000001", 5, []),
      candidate("ISSUE-000002", 4, []),
      candidate("ISSUE-000003", 3, []),
    ]),
  ];
  assert.equal(aggregateGroupPriorArt(reports, 2).length, 2);
  assert.equal(aggregateGroupPriorArt(reports, 0).length, 1); // floors to at least 1
});

// ---------------------------------------------------------------------------
// findTicketGroup
// ---------------------------------------------------------------------------

test("findTicketGroup resolves by exact key, bucket suffix, or title (case-insensitively)", async () => {
  await withStore({}, async (store) => {
    await seedWorkbenchFixture(store);
    const report = await store.ticketGroups({ limit: 50 });

    const byKey = findTicketGroup(report, "family:reader_ingestion");
    assert.equal(byKey?.key, "family:reader_ingestion");

    const bySuffix = findTicketGroup(report, "READER_INGESTION");
    assert.equal(bySuffix?.key, "family:reader_ingestion");

    const byTitle = findTicketGroup(report, byKey!.title.toUpperCase());
    assert.equal(byTitle?.key, byKey!.key);

    assert.equal(findTicketGroup(report, "nope:nothing"), undefined);
  });
});

// ---------------------------------------------------------------------------
// store.beginGroup — read-only "begin before you build" workbench report
// ---------------------------------------------------------------------------

test("beginGroup aggregates cross-member prior art, surfaces family Patterns/knowledge, and ranks Pattern-discovery hypotheses", async () => {
  await withStore({}, async (store) => {
    const { resolved, a1 } = await seedWorkbenchFixture(store);
    const groupsReport = await store.ticketGroups({ limit: 50 });
    const group = findGroup(groupsReport, "family:reader_ingestion");
    assert.equal(group.tickets.length, 3);

    const report = await store.beginGroup("family:reader_ingestion");

    assert.equal(report.schemaVersion, 1);
    assert.equal(report.group.key, "family:reader_ingestion");
    assert.equal(report.patternFamily, "reader_ingestion");
    assert.ok(report.nextSteps.length > 0);

    // Cross-member prior art: the resolved ticket shares "repeating glyph
    // artifact" wording (and family) with at least two open members, so it
    // should surface with occurrenceCount >= 2 and its resolution carried over.
    const resolvedAlias = resolved.aliases[0] ?? resolved.id;
    const priorArtEntry = report.priorArt.find((entry) => entry.key === resolvedAlias);
    assert.ok(priorArtEntry, "expected the resolved prior-art ticket to be aggregated");
    assert.ok(priorArtEntry!.occurrenceCount >= 2);
    assert.equal(priorArtEntry!.resolutionSummary, "Cleared and regenerated the thumbnail cache deterministically.");
    assert.equal(priorArtEntry!.guardStatus, "guard_added");

    // `relatedByTicket` carries one entry per fanned-out member, identifiable by alias.
    const a1Alias = a1.aliases[0] ?? a1.id;
    assert.ok(report.relatedByTicket.some((entry) => entry.ticket.alias === a1Alias));

    // autoCreateByFamily (on by default) means `reader_ingestion` already has
    // an active Pattern by the time we begin the group — so the top hypothesis
    // should point at comparing against it rather than promoting a fresh one.
    assert.ok(report.activePatterns.length > 0);
    const topHypothesis = report.hypotheses[0];
    assert.equal(topHypothesis.recommendation, "compare_prior_art");
    assert.equal(topHypothesis.suggestedPatternId, report.activePatterns[0].id);

    // The recurring "repeating glyph artifact" prior art should also be called
    // out as its own hypothesis (high-occurrence resolved prior art).
    assert.ok(
      report.hypotheses.some(
        (hypothesis) => hypothesis.recommendation === "compare_prior_art" && hypothesis.priorArtKeys.includes(resolvedAlias),
      ),
    );

    // And the shared "repeating glyph artifact" wording across exactly two
    // members should surface as a candidate symptom-Pattern hypothesis.
    assert.ok(report.hypotheses.some((hypothesis) => hypothesis.title.startsWith("Candidate symptom Pattern:")));

    assert.ok(report.hypotheses.length <= 8);
  });
});

test("beginGroup throws a readable error for an unknown group key", async () => {
  await withStore({}, async (store) => {
    await seedWorkbenchFixture(store);
    await assert.rejects(() => store.beginGroup("family:does_not_exist"), /Ticket group not found/);
  });
});

// ---------------------------------------------------------------------------
// store.promoteGroup — write: find-or-reuse a Pattern, link members, record provenance
// ---------------------------------------------------------------------------

test("promoteGroup creates a Pattern, links every member, records provenance notes, and is idempotent", async () => {
  // Disable auto-attach so promote-group's own linking logic — not `attachPattern`
  // on ticket creation — is what's under test (and so "created"/"newly linked" is exercised).
  await withStore({ patterns: { autoCreateByFamily: false, defaultFamily: "general" } }, async (store) => {
    const { a1, a2, a3 } = await seedWorkbenchFixture(store);
    assert.equal((await store.showTicket(a1.id))?.patternId, undefined);

    const groupsReport = await store.ticketGroups({ limit: 50 });
    const group = findGroup(groupsReport, "family:reader_ingestion");

    const first = await store.promoteGroup("family:reader_ingestion");
    assert.equal(first.schemaVersion, 1);
    assert.equal(first.action, "created");
    assert.equal(first.pattern.family, "reader_ingestion");
    assert.equal(first.pattern.title, `Recurring ${group.title} tickets`);
    assert.equal(first.pattern.status, "active"); // >= 2 linked tickets
    assert.match(first.pattern.summary ?? "", /Promoted from computed Ticket Group family:reader_ingestion/);
    assert.match(first.pattern.summary ?? "", /basis=family/);

    const expectedAliases = [a1, a2, a3].map((ticket) => ticket.aliases[0] ?? ticket.id).sort();
    assert.deepEqual(first.linkedTickets.slice().sort(), expectedAliases);
    assert.deepEqual(first.pattern.ticketIds.slice().sort(), [a1.id, a2.id, a3.id].sort());

    // Each newly-linked ticket points at the Pattern and carries a provenance note.
    for (const ticket of [a1, a2, a3]) {
      const reloaded = await store.showTicket(ticket.id);
      assert.equal(reloaded?.patternId, first.pattern.id);
      const note = reloaded?.notes.find((entry) => entry.type === "related_history");
      assert.ok(note, `expected a related_history provenance note on ${ticket.id}`);
      assert.match(note!.body, new RegExp(`Linked to ${first.pattern.id} via promote-group from Group family:reader_ingestion`));
    }

    // Re-running is idempotent: reuses the same (non-resolved) Pattern, refreshes
    // its summary, and links nothing new (no duplicate notes).
    const second = await store.promoteGroup("family:reader_ingestion", { summary: "custom refreshed summary" });
    assert.equal(second.action, "reused");
    assert.equal(second.pattern.id, first.pattern.id);
    assert.equal(second.pattern.summary, "custom refreshed summary");
    assert.deepEqual(second.linkedTickets, []);

    const reloadedA1 = await store.showTicket(a1.id);
    assert.equal(reloadedA1?.notes.filter((entry) => entry.type === "related_history").length, 1);
  });
});

test("promoteGroup honors title/family/actor overrides and throws a readable error for an unknown group key", async () => {
  await withStore({ patterns: { autoCreateByFamily: false, defaultFamily: "general" } }, async (store) => {
    await seedWorkbenchFixture(store);

    const result = await store.promoteGroup("family:reader_ingestion", {
      title: "Glyph rendering regressions",
      family: "reader_rendering_overridden",
      actor: "triage-bot",
    });
    assert.equal(result.pattern.title, "Glyph rendering regressions");
    assert.equal(result.pattern.family, "reader_rendering_overridden");

    const linkedTicket = await store.getTicketByAnyId(result.linkedTickets[0]);
    const note = linkedTicket?.notes.find((entry) => entry.type === "related_history");
    assert.equal(note?.author, "triage-bot");

    await assert.rejects(() => store.promoteGroup("family:does_not_exist"), /Ticket group not found/);
  });
});
