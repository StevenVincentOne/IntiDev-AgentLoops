import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../src/config";
import { canonicalKey, deriveAliases, padSeq, resolveQueuePrefix } from "../src/aliases";
import { ProjectConfig } from "../src/types";

test("resolveQueuePrefix routes by source override then kind (USER > DEV > ISSUE)", () => {
  const cfg = DEFAULT_CONFIG;

  // Source override: a user_report-sourced bug routes to USER, not ISSUE.
  assert.equal(resolveQueuePrefix({ kind: "bug", source: "user_report" }, cfg), "USER");
  // The user_feedback kind routes to USER regardless of source.
  assert.equal(resolveQueuePrefix({ kind: "user_feedback", source: "smoke" }, cfg), "USER");

  // Development kinds route to DEV.
  for (const kind of ["feature", "task", "investigation", "tech_debt"]) {
    assert.equal(resolveQueuePrefix({ kind, source: "agent" }, cfg), "DEV");
  }

  // Defect kinds route to ISSUE.
  assert.equal(resolveQueuePrefix({ kind: "bug", source: "smoke" }, cfg), "ISSUE");
  assert.equal(resolveQueuePrefix({ kind: "incident", source: "ci" }, cfg), "ISSUE");

  // Unknown kind + unrouted source falls back to the default queue.
  assert.equal(resolveQueuePrefix({ kind: "mystery", source: "nowhere" }, cfg), "ISSUE");
  // Missing source still resolves by kind.
  assert.equal(resolveQueuePrefix({ kind: "feature" }, cfg), "DEV");
});

test("deriveAliases and canonicalKey pad and prefix correctly", () => {
  const cfg = DEFAULT_CONFIG;
  assert.deepEqual(deriveAliases({ kind: "feature", source: "agent" }, 3, cfg), ["DEV-000003"]);
  assert.deepEqual(deriveAliases({ kind: "bug", source: "user_report" }, 42, cfg), ["USER-000042"]);
  assert.equal(canonicalKey(7), "ISSUE-000007");
  assert.equal(padSeq(12), "000012");
});

test("custom queues drive routing", () => {
  const cfg: ProjectConfig = {
    ...DEFAULT_CONFIG,
    queues: [
      { prefix: "OPS", sources: ["pagerduty"] },
      { prefix: "ISSUE", kinds: ["bug"], default: true },
    ],
  };
  assert.equal(resolveQueuePrefix({ kind: "bug", source: "pagerduty" }, cfg), "OPS");
  assert.equal(resolveQueuePrefix({ kind: "feature", source: "agent" }, cfg), "ISSUE"); // default
});
