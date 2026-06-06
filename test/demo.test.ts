import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedConvergenceDemo } from "../scripts/demo-seed";

/**
 * Replace any `*At` ISO-timestamp field with a stable placeholder so the
 * persisted state can be compared against a committed golden fixture.
 */
function normalizeTimestamps(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeTimestamps);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] =
        /At$/.test(key) && typeof val === "string"
          ? "<timestamp>"
          : normalizeTimestamps(val);
    }
    return out;
  }
  return value;
}

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(join(tmpdir(), "agentloops-demo-"));
  try {
    return await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("source-convergence demo groups Issue/User/Development loops into one active Pattern", async () => {
  await withTempDir(async (cwd) => {
    const result = await seedConvergenceDemo(cwd);

    // One ticket per intake loop, all sharing a single numeric ISSUE space.
    const byId = [...result.tickets].sort((a, b) => a.id.localeCompare(b.id));
    assert.deepEqual(
      byId.map((t) => t.id),
      ["ISSUE-000001", "ISSUE-000002", "ISSUE-000003"],
    );

    // Each loop surfaces under its own queue alias.
    assert.deepEqual(
      byId.map((t) => t.aliases[0]),
      ["ISSUE-000001", "USER-000002", "DEV-000003"],
    );

    // Distinct sources converge on the same family.
    assert.deepEqual(
      byId.map((t) => t.source),
      ["smoke", "user_report", "agent"],
    );
    assert.ok(byId.every((t) => t.family === "export_pipeline"));

    // The three tickets form one Pattern, ACTIVE because >= 2 converged.
    assert.equal(result.patterns.length, 1);
    const [pattern] = result.patterns;
    assert.equal(pattern.id, "PATTERN-000001");
    assert.equal(pattern.status, "active");
    assert.equal(pattern.family, "export_pipeline");
    assert.deepEqual(
      [...pattern.ticketIds].sort(),
      ["ISSUE-000001", "ISSUE-000002", "ISSUE-000003"],
    );

    // Summary reflects the converged loop.
    assert.equal(result.summary.totalTickets, 3);
    assert.equal(result.summary.triagedTickets, 3);
    assert.equal(result.summary.openPatterns, 1); // active patterns
    assert.equal(result.summary.stalledPatterns, 0); // none left at "open"

    // Golden: the full persisted state (timestamps normalized) is stable.
    const stateText = await fs.readFile(
      join(cwd, ".agentloops", "state.json"),
      "utf-8",
    );
    const actual = normalizeTimestamps(JSON.parse(stateText));
    const goldenPath = join(__dirname, "fixtures", "demo-state.golden.json");
    if (process.env.UPDATE_GOLDEN) {
      await fs.mkdir(join(__dirname, "fixtures"), { recursive: true });
      await fs.writeFile(goldenPath, JSON.stringify(actual, null, 2) + "\n", "utf-8");
    }
    const golden = JSON.parse(await fs.readFile(goldenPath, "utf-8"));
    assert.deepEqual(actual, golden);
  });
});
