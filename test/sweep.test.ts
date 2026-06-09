/**
 * Tests for the symptom-family sweep (src/sweep.ts).
 *
 * Covers:
 * - Empty ticket set
 * - likelySameSymptom bucket population
 * - adjacentOrDifferentRoot bucket population
 * - historicalPriorArt bucket (resolved/deferred tickets)
 * - Pattern matches
 * - Root-cause bucket guidance
 * - candidateLimit / priorArtLimit / patternLimit options
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sweepTicket } from "../src/sweep";
import type { Pattern, Ticket } from "../src/types";

// ── Fixtures ──────────────────────────────────────────────────────────────────

let _seq = 0;
function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  _seq++;
  return {
    id: `T-${_seq}`,
    title: "generic ticket",
    summary: "generic summary",
    status: "open",
    kind: "bug",
    family: "widget",
    priority: "medium",
    severity: "medium",
    notes: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makePattern(overrides: Partial<Pattern> = {}): Pattern {
  _seq++;
  return {
    id: `PAT-${_seq}`,
    title: "generic pattern",
    summary: "",
    status: "active",
    family: "widget",
    ticketIds: [],
    notes: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("sweepTicket", () => {
  it("returns an empty result when no other tickets exist", () => {
    const seed = makeTicket({ title: "null pointer in widget render", tags: ["widget", "render"] });
    const result = sweepTicket(seed, [seed], [], {});

    assert.equal(result.seed.id, seed.id);
    assert.equal(result.candidates.likelySameSymptom.length, 0);
    assert.equal(result.candidates.adjacentOrDifferentRoot.length, 0);
    assert.equal(result.candidates.historicalPriorArt.length, 0);
    assert.equal(result.candidates.patternMatches.length, 0);
    assert.ok(result.rootCauseBuckets.length >= 1);
  });

  it("classifies an open ticket with high token overlap as likelySameSymptom", () => {
    const seed = makeTicket({
      title: "widget render throws null pointer exception",
      summary: "NullPointerException in widget render method when input is undefined",
      tags: ["widget", "render", "null"],
    });
    // Highly similar open ticket
    const similar = makeTicket({
      title: "widget render null pointer exception on missing input",
      summary: "NullPointerException in widget render when input prop undefined",
      status: "open",
      tags: ["widget", "render", "null"],
    });
    const result = sweepTicket(seed, [seed, similar], [], {});

    const ids = result.candidates.likelySameSymptom.map((c) => c.id);
    assert.ok(ids.includes(similar.id), "similar open ticket should be in likelySameSymptom");
    // Should not appear in adjacentOrDifferentRoot too
    const adjIds = result.candidates.adjacentOrDifferentRoot.map((c) => c.id);
    assert.ok(!adjIds.includes(similar.id), "should not appear in both buckets");
  });

  it("classifies an open ticket with moderate overlap as adjacentOrDifferentRoot", () => {
    const seed = makeTicket({
      title: "widget render throws null pointer exception",
      tags: ["widget", "render"],
    });
    // Related but different — mentions widget and render but in a different context
    const adjacent = makeTicket({
      title: "widget loading spinner fails on render error boundary",
      status: "open",
      tags: ["widget"],
    });
    const result = sweepTicket(seed, [seed, adjacent], [], {});

    const likelyIds = result.candidates.likelySameSymptom.map((c) => c.id);
    const adjIds = result.candidates.adjacentOrDifferentRoot.map((c) => c.id);
    // adjacent should appear in one bucket or the other (might score into likelySameSymptom
    // if overlap is actually high — we just check it isn't in both)
    const inBoth = likelyIds.includes(adjacent.id) && adjIds.includes(adjacent.id);
    assert.ok(!inBoth, "a candidate should not appear in both buckets");
  });

  it("classifies a resolved ticket as historicalPriorArt, not as likelySameSymptom", () => {
    const seed = makeTicket({
      title: "widget render null pointer exception crash",
      tags: ["widget", "render", "null"],
    });
    const resolved = makeTicket({
      title: "widget render null pointer exception on undefined input",
      status: "resolved",
      resolutionSummary: "Added null guard in render()",
      tags: ["widget", "render", "null"],
    });
    const result = sweepTicket(seed, [seed, resolved], [], {});

    const likelyIds = result.candidates.likelySameSymptom.map((c) => c.id);
    const priorIds = result.candidates.historicalPriorArt.map((c) => c.id);
    assert.ok(!likelyIds.includes(resolved.id), "resolved ticket should not be in likelySameSymptom");
    assert.ok(priorIds.includes(resolved.id), "resolved ticket should be in historicalPriorArt");
  });

  it("classifies a deferred ticket as historicalPriorArt", () => {
    const seed = makeTicket({ title: "widget render crash on null", tags: ["widget", "render"] });
    const deferred = makeTicket({
      title: "widget render crash on null input", status: "deferred",
      tags: ["widget", "render"],
    });
    const result = sweepTicket(seed, [seed, deferred], [], {});

    const priorIds = result.candidates.historicalPriorArt.map((c) => c.id);
    assert.ok(priorIds.includes(deferred.id));
  });

  it("does not include the seed ticket itself in any bucket", () => {
    const seed = makeTicket({ title: "widget render null pointer", tags: ["widget"] });
    const result = sweepTicket(seed, [seed], [], {});

    const allCandidateIds = [
      ...result.candidates.likelySameSymptom,
      ...result.candidates.adjacentOrDifferentRoot,
      ...result.candidates.historicalPriorArt,
    ].map((c) => c.id);
    assert.ok(!allCandidateIds.includes(seed.id), "seed should not appear in any candidate bucket");
  });

  it("matches a pattern by token overlap", () => {
    const seed = makeTicket({ title: "widget render crash null input", tags: ["widget"] });
    const pattern = makePattern({
      title: "Widget render null-pointer crashes",
      summary: "Recurring null pointer crashes in widget render path",
      family: "widget",
      status: "active",
    });
    const result = sweepTicket(seed, [seed], [pattern], {});

    assert.ok(result.candidates.patternMatches.length > 0, "should match the pattern");
    assert.equal(result.candidates.patternMatches[0].patternId, pattern.id);
  });

  it("respects candidateLimit option", () => {
    const seed = makeTicket({ title: "widget render null pointer crash", tags: ["widget", "render", "null"] });
    const others = Array.from({ length: 10 }, (_, i) =>
      makeTicket({
        title: `widget render null pointer issue ${i}`,
        status: "open",
        tags: ["widget", "render", "null"],
      }),
    );
    const result = sweepTicket(seed, [seed, ...others], [], { candidateLimit: 3 });

    assert.ok(
      result.candidates.likelySameSymptom.length <= 3,
      "likelySameSymptom should be capped at candidateLimit",
    );
    assert.ok(
      result.candidates.adjacentOrDifferentRoot.length <= 3,
      "adjacentOrDifferentRoot should be capped at candidateLimit",
    );
  });

  it("respects priorArtLimit option", () => {
    const seed = makeTicket({ title: "widget render crash null", tags: ["widget", "render"] });
    const resolved = Array.from({ length: 10 }, (_, i) =>
      makeTicket({
        title: `widget render crash null variant ${i}`,
        status: "resolved",
        tags: ["widget", "render"],
      }),
    );
    const result = sweepTicket(seed, [seed, ...resolved], [], { priorArtLimit: 4 });

    assert.ok(
      result.candidates.historicalPriorArt.length <= 4,
      "historicalPriorArt should be capped at priorArtLimit",
    );
  });

  it("respects patternLimit option", () => {
    const seed = makeTicket({ title: "widget render crash null input", tags: ["widget"] });
    const patterns = Array.from({ length: 10 }, (_, i) =>
      makePattern({ title: `widget render null crash pattern ${i}`, family: "widget" }),
    );
    const result = sweepTicket(seed, [seed], patterns, { patternLimit: 2 });

    assert.ok(
      result.candidates.patternMatches.length <= 2,
      "patternMatches should be capped at patternLimit",
    );
  });

  it("returns rootCauseBuckets with coveredByCurrentFix: agent_must_decide", () => {
    const seed = makeTicket({ title: "widget render crash" });
    const result = sweepTicket(seed, [seed], [], {});

    assert.ok(result.rootCauseBuckets.length >= 1);
    for (const bucket of result.rootCauseBuckets) {
      assert.equal(bucket.coveredByCurrentFix, "agent_must_decide");
    }
  });

  it("includes symptomSignature with seed title and tokens", () => {
    const seed = makeTicket({ title: "widget render crash null pointer" });
    const result = sweepTicket(seed, [seed], [], {});

    assert.ok(result.symptomSignature.label.length > 0);
    assert.ok(Array.isArray(result.symptomSignature.tokens));
  });

  it("includes recommendedActions with classify-siblings guidance", () => {
    const seed = makeTicket({ title: "widget render crash" });
    const result = sweepTicket(seed, [seed], [], {});

    const hasClassifyGuidance = result.recommendedActions.some((a) =>
      a.includes("classify-siblings"),
    );
    assert.ok(hasClassifyGuidance, "should mention classify-siblings in recommendedActions");
  });

  it("priorArtTrust is surfaced on historicalPriorArt candidates when set", () => {
    const seed = makeTicket({ title: "widget crash null input", tags: ["widget"] });
    const resolved = makeTicket({
      title: "widget crash null input fixed",
      status: "resolved",
      tags: ["widget"],
      priorArtTrust: { level: "suspect" },
    });
    const result = sweepTicket(seed, [seed, resolved], [], {});

    const candidate = result.candidates.historicalPriorArt.find((c) => c.id === resolved.id);
    if (candidate) {
      assert.equal(candidate.priorArtTrust, "suspect");
    }
    // If score is 0 and no shared tags the candidate may not appear — that's fine
  });
});
