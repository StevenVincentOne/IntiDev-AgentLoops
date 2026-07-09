import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { AgentLoopStore } from "../src/store";
import { ProjectConfig, TicketGroupCustomRule } from "../src/types";
import { TicketGroup } from "../src/ticket-groups";

async function withStore<T>(
  configOverrides: Partial<ProjectConfig>,
  run: (store: AgentLoopStore) => Promise<T>,
): Promise<T> {
  const dir = await fs.mkdtemp(join(tmpdir(), "agentloops-ticket-groups-"));
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
 * Seeds a small, deliberately-crafted set of active tickets spanning two
 * families, exercising every built-in basis (family, tag, auto-keyword) plus
 * two project-defined `customRules` (a "keyword" rule matching a recurring
 * HTTP-429/rate-limit symptom, and a "correlation" rule extracting an
 * embedded `doc_id:` value) — the reframed stand-ins for Inti's domain-
 * specific `audit_code`/`document` bases.
 */
async function seedGroupFixture(store: AgentLoopStore) {
  const a1 = await store.createTicket({
    kind: "bug",
    source: "smoke",
    family: "reader_ingestion",
    title: "Repeating glyph artifact in chapter export",
    summary: "Exported chapter shows a repeating glyph artifact near page breaks.",
    severity: "high",
    confidence: "high",
    tags: ["export"],
  });
  const a2 = await store.createTicket({
    kind: "bug",
    source: "user_report",
    family: "reader_ingestion",
    title: "Repeating glyph artifact in section export",
    summary: "Exported section shows the same repeating glyph artifact.",
    severity: "high",
    confidence: "medium",
    tags: ["export"],
  });
  const a3 = await store.createTicket({
    kind: "bug",
    source: "smoke",
    family: "reader_ingestion",
    title: "Reader fails to open a large scanned PDF",
    summary: "Opening a large scanned PDF causes Reader app to hang indefinitely.",
    severity: "medium",
    confidence: "medium",
    tags: ["reader"],
  });
  const b1 = await store.createTicket({
    kind: "bug",
    source: "smoke",
    family: "auth_session",
    title: "Login retries return HTTP 429",
    summary: "Repeated login attempts are throttled with a 429 rate limit. doc_id: auth-flow-3",
    severity: "critical",
    confidence: "high",
    tags: ["auth"],
  });
  const b2 = await store.createTicket({
    kind: "bug",
    source: "user_report",
    family: "auth_session",
    title: "Password reset also returns HTTP 429",
    summary: "Password-reset endpoint also throttles with a 429 rate limit too. doc_id: auth-flow-3",
    severity: "critical",
    confidence: "medium",
    tags: ["auth"],
  });
  return { a1, a2, a3, b1, b2 };
}

const CUSTOM_RULES: TicketGroupCustomRule[] = [
  {
    name: "rate_limit_429",
    label: "Rate-limit (HTTP 429)",
    kind: "keyword",
    pattern: "\\b429\\b|rate[ -]?limit",
  },
  {
    name: "doc_id",
    label: "Document",
    kind: "correlation",
    pattern: "doc[_-]?id[:=]\\s*([\\w-]+)",
  },
];

function find(groups: TicketGroup[], key: string): TicketGroup | undefined {
  return groups.find((group) => group.key === key);
}

test("ticketGroups clusters open work by family, shared tags, and auto-detected keywords", async () => {
  await withStore({}, async (store) => {
    await seedGroupFixture(store);
    const report = await store.ticketGroups({ limit: 50 });

    assert.equal(report.schemaVersion, 1);
    assert.equal(report.summary.ticketsConsidered, 5);

    const family = find(report.groups, "family:reader_ingestion");
    assert.ok(family, "expected a family group for reader_ingestion");
    assert.equal(family!.basis, "family");
    assert.equal(family!.activeCount, 3);
    assert.equal(family!.severity, "high");
    assert.deepEqual(
      family!.tickets.map((t) => t.id).sort(),
      ["ISSUE-000001", "ISSUE-000002", "ISSUE-000003"],
    );

    const tag = find(report.groups, "tag:export");
    assert.ok(tag, "expected a tag group for shared 'export' tag");
    assert.equal(tag!.basis, "tag");
    assert.equal(tag!.activeCount, 2);
    assert.deepEqual(
      tag!.tickets.map((t) => t.id).sort(),
      ["ISSUE-000001", "ISSUE-000002"],
    );

    // The auto-keyword basis should pick up "repeating"/"glyph"/"artifact" —
    // recurring, distinguishing wording shared by exactly the same two
    // tickets — without any hardcoded title-suffix list. Tokens that happen
    // to share the exact same membership fold into one combined group
    // (rather than five near-identical "Keyword: Glyph" / "Keyword: Artifact"
    // / … groups), so look for the merged cluster by its label contents.
    const keyword = report.groups.find((group) => group.basis === "keyword" && group.title.includes("Glyph"));
    assert.ok(keyword, "expected an auto-detected keyword group covering 'glyph'");
    assert.match(keyword!.title, /Artifact/);
    assert.match(keyword!.title, /Repeating/);
    assert.deepEqual(
      keyword!.tickets.map((t) => t.id).sort(),
      ["ISSUE-000001", "ISSUE-000002"],
    );

    // ...and it should surface as ONE group, not one per shared token.
    assert.equal(
      report.groups.filter(
        (group) =>
          group.basis === "keyword" &&
          group.tickets.length === 2 &&
          group.tickets.every((t) => ["ISSUE-000001", "ISSUE-000002"].includes(t.id)),
      ).length,
      1,
    );

    // A cluster spanning every active ticket isn't a useful "group" — it's
    // just "all open work" — so it must not surface.
    assert.equal(
      report.groups.some((group) => group.activeCount === report.summary.ticketsConsidered),
      false,
    );
  });
});

test("ticketGroups surfaces narrower candidate splits within a broad family group", async () => {
  await withStore({}, async (store) => {
    await seedGroupFixture(store);
    const report = await store.ticketGroups({ limit: 50 });

    const family = find(report.groups, "family:reader_ingestion");
    assert.ok(family);

    // Within the 3-member reader_ingestion family group, the two
    // export-tagged tickets share a narrower signal — a candidate split worth
    // reviewing as its own (smaller) cluster before assuming all three share one
    // cause. `ticketKeys` carries the human-facing alias (queue-routed).
    // a2 is a `bug` from `user_report`, so with kind-first routing it now lands
    // in the ISSUE queue.
    const split = family!.candidateSplits.find((entry) => entry.key === "tag:export");
    assert.ok(split, "expected a 'tag:export' candidate split inside the family group");
    assert.equal(split!.count, 2);
    assert.deepEqual(split!.ticketKeys.sort(), ["ISSUE-000001", "ISSUE-000002"]);

    // Candidate splits never repeat the group's own basis key, and never
    // include a "split" that's the whole group (that's not a split at all).
    assert.equal(
      family!.candidateSplits.some((entry) => entry.key === family!.key),
      false,
    );
    assert.ok(family!.candidateSplits.every((entry) => entry.count < family!.activeCount));
  });
});

test("ticketGroups custom rules express project-specific clustering vocabulary", async () => {
  await withStore({ ticketGroups: { customRules: CUSTOM_RULES } }, async (store) => {
    await seedGroupFixture(store);
    const report = await store.ticketGroups({ limit: 50 });

    // "keyword" rule: any ticket whose text matches the pattern joins one
    // shared bucket named after the rule — the reframed stand-in for Inti's
    // hardcoded `audit_code` vocabulary.
    const keywordRule = find(report.groups, "custom:rate_limit_429");
    assert.ok(keywordRule, "expected the custom keyword rule to surface a group");
    assert.equal(keywordRule!.basis, "custom");
    assert.equal(keywordRule!.title, "Rate-limit (HTTP 429)");
    assert.deepEqual(
      keywordRule!.tickets.map((t) => t.id).sort(),
      ["ISSUE-000004", "ISSUE-000005"],
    );

    // "correlation" rule: the captured text becomes the bucket key, so
    // tickets are grouped by the *value* they share — the reframed stand-in
    // for Inti's `document`/`correlationKey` fingerprint parsing.
    const correlationRule = find(report.groups, "custom:doc_id:auth-flow-3");
    assert.ok(correlationRule, "expected the custom correlation rule to surface a group keyed by the captured value");
    assert.equal(correlationRule!.basis, "custom");
    assert.equal(correlationRule!.title, "Document: auth-flow-3");
    assert.deepEqual(
      correlationRule!.tickets.map((t) => t.id).sort(),
      ["ISSUE-000004", "ISSUE-000005"],
    );
  });
});

test("ticketGroups has no custom groups when no rules are configured", async () => {
  await withStore({}, async (store) => {
    await seedGroupFixture(store);
    const report = await store.ticketGroups({ limit: 50 });
    assert.equal(
      report.groups.some((group) => group.basis === "custom"),
      false,
    );
  });
});

test("ticketGroups respects the family filter, minSize, and limit options", async () => {
  await withStore({}, async (store) => {
    await seedGroupFixture(store);

    const scoped = await store.ticketGroups({ family: "auth_session", limit: 50 });
    assert.equal(scoped.filters.family, "auth_session");
    assert.equal(scoped.summary.ticketsConsidered, 2);
    assert.ok(scoped.groups.every((group) => group.tickets.every((t) => t.family === "auth_session")));

    const strict = await store.ticketGroups({ minSize: 3, limit: 50 });
    assert.equal(strict.filters.minSize, 3);
    assert.ok(strict.groups.every((group) => group.activeCount >= 3));
    // Only the 3-member reader_ingestion family cluster clears a minSize of 3.
    assert.deepEqual(
      strict.groups.map((group) => group.key),
      ["family:reader_ingestion"],
    );

    const capped = await store.ticketGroups({ limit: 1 });
    assert.equal(capped.filters.limit, 1);
    assert.equal(capped.groups.length, 1);
    // `summary.groupsFlagged` reports the full count before the limit is applied.
    assert.ok(capped.summary.groupsFlagged >= capped.groups.length);
  });
});

test("ticketGroups is pure and deterministic apart from generatedAt", async () => {
  await withStore({ ticketGroups: { customRules: CUSTOM_RULES } }, async (store) => {
    await seedGroupFixture(store);
    const first = await store.ticketGroups({ limit: 50 });
    const second = await store.ticketGroups({ limit: 50 });
    assert.deepEqual({ ...first, generatedAt: null }, { ...second, generatedAt: null });
  });
});
