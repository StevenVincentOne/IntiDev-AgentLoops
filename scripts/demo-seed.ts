import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { AgentLoopStore } from "../src/store";
import { Pattern, Ticket } from "../src/types";

const DEMO_PROJECT = "AgentLoops Demo";
const DEMO_FAMILY = "export_pipeline";

export interface DemoResult {
  tickets: Ticket[];
  patterns: Pattern[];
  summary: Awaited<ReturnType<AgentLoopStore["summary"]>>;
}

/**
 * Seed a deterministic source-convergence scenario into `cwd`/.agentloops.
 *
 * Three independent intake loops all observe the same underlying problem in
 * the `export_pipeline` family:
 *
 *   - Issue loop:       a smoke test catches a regression     -> ISSUE-000001
 *   - User loop:        a user reports the same failure        -> USER-000002
 *   - Development loop: an agent proposes the structural fix    -> DEV-000003
 *
 * Because all three share a family, the store groups them into a single
 * Pattern (PATTERN-000001), which flips to ACTIVE once >= 2 tickets converge.
 * This is the source-convergence behavior the extraction plan wants to show.
 */
export async function seedConvergenceDemo(cwd: string): Promise<DemoResult> {
  const config = { ...DEFAULT_CONFIG, projectName: DEMO_PROJECT };
  const store = new AgentLoopStore(cwd, config);
  await store.ensureInitialized(DEMO_PROJECT);

  // Issue loop: an automated smoke run catches the regression first.
  await store.createTicket({
    kind: "bug",
    source: "smoke",
    family: DEMO_FAMILY,
    title: "Export smoke test times out on 500-page report",
    summary:
      "The export smoke run exceeds its timeout when rendering very long reports.",
    severity: "high",
    confidence: "high",
    tags: ["export", "timeout"],
  });

  // User loop: production feedback reports the same failure independently.
  await store.createTicket({
    kind: "user_feedback",
    source: "user_report",
    family: DEMO_FAMILY,
    title: "Export fails for long reports",
    summary: "A user reports that exporting a 500-page report fails with a timeout.",
    severity: "high",
    confidence: "medium",
    tags: ["export", "user"],
  });

  // Development loop: an agent proposes the structural fix for the family.
  await store.createTicket({
    kind: "feature",
    source: "agent",
    family: DEMO_FAMILY,
    title: "Stream the export pipeline instead of buffering",
    summary:
      "Replace the buffered exporter with a streaming pipeline to remove the timeout ceiling.",
    severity: "medium",
    confidence: "medium",
    tags: ["export", "streaming"],
  });

  return {
    tickets: await store.listTickets({ status: "all" }),
    patterns: await store.listPatterns({ status: "all" }),
    summary: await store.summary(),
  };
}

function report(target: string, result: DemoResult): void {
  const tickets = [...result.tickets].sort((a, b) => a.id.localeCompare(b.id));
  const lines: string[] = [];
  lines.push("AgentLoops source-convergence demo");
  lines.push("==================================");
  lines.push("");
  lines.push("Three intake loops, one underlying problem:");
  lines.push("");
  for (const ticket of tickets) {
    lines.push(
      `  ${ticket.aliases[0]?.padEnd(13) ?? ""} ${ticket.kind.padEnd(14)} source=${ticket.source.padEnd(12)} [${ticket.family}]`,
    );
    lines.push(`    ${ticket.title}`);
  }
  lines.push("");
  lines.push("Converged into:");
  for (const pattern of result.patterns) {
    lines.push(
      `  ${pattern.id} ${pattern.status.toUpperCase()} (${pattern.ticketIds.length} tickets) — ${pattern.title}`,
    );
  }
  lines.push("");
  lines.push(
    `Summary: ${result.summary.totalTickets} tickets, ${result.summary.openPatterns} active pattern(s).`,
  );
  lines.push("");
  lines.push(`State written to ${join(target, ".agentloops", "state.json")}`);
  process.stdout.write(lines.join("\n") + "\n");
}

async function main(): Promise<void> {
  const target = process.argv[2] ?? (await fs.mkdtemp(join(tmpdir(), "agentloops-demo-")));
  const result = await seedConvergenceDemo(target);
  report(target, result);
}

if (require.main === module) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`demo-seed failed: ${message}\n`);
    process.exitCode = 1;
  });
}
