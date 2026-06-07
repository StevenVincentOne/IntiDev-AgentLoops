#!/usr/bin/env node
import { loadConfig, writeDefaultConfig } from "./config";
import {
  Confidence,
  PatternStatus,
  ProjectConfig,
  TicketKind,
  TicketStatus,
} from "./types";
import { promises as fs } from "node:fs";
import { AgentLoopStore, normalizeTicketInput } from "./store";
import { buildHandoffPrompt } from "./handoff";
import { gatherDashboardData, renderDashboard } from "./dashboard";
import { createDashboardServer } from "./serve";
import { BackendSelection, resolveBackend } from "./storage";
import { resolveGithubTarget } from "./github";

type ArgMap = Record<string, string | boolean>;

const COMMANDS = [
  "init",
  "create",
  "list",
  "show",
  "patterns",
  "begin",
  "resolve",
  "reopen",
  "defer",
  "note",
  "guard",
  "handoff",
  "summary",
  "convergence",
  "guard-gaps",
  "workflow-audit",
  "knowledge",
  "knowledge-gaps",
  "related",
  "dashboard",
  "serve",
  "config",
  "mcp",
  "github-link",
  "github-sync",
  "help",
];

function parseArgs(argv: string[]): { args: string[]; options: ArgMap } {
  const args: string[] = [];
  const options: ArgMap = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      args.push(token);
      continue;
    }
    const split = token.indexOf("=");
    if (split > -1) {
      options[token.substring(2, split)] = token.substring(split + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      options[token.substring(2)] = next;
      i += 1;
      continue;
    }
    options[token.substring(2)] = true;
  }
  return { args, options };
}

function toArray(value?: string | boolean): string[] {
  if (!value || typeof value !== "string") return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function printLine(...parts: unknown[]) {
  process.stdout.write(parts.join(" ") + "\n");
}

function printJson(value: unknown) {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function shortSummary(status: TicketStatus) {
  return status.toUpperCase().padEnd(8);
}

function printHelp() {
  printLine("IntiDev AgentLoops");
  printLine("Commands:");
  printLine("  init                            initialize a project loop");
  printLine("  create --title ... --summary ... create a new issue/feature/feedback");
  printLine("  list [--status triaged|active|resolved|all] list tickets");
  printLine("  show <id>                       inspect ticket");
  printLine("  patterns [--status open|active|resolved|all] list patterns");
  printLine("  begin <id>                      begin a triaged item");
  printLine("  resolve <id> --summary ...      resolve a ticket");
  printLine("  reopen <id> --summary ...       reopen a resolved/reopen-risk item");
  printLine("  defer <id> [--summary ...]      defer a ticket (records an optional reason)");
  printLine("  note <id> --type ... --body ... add a non-resolution note");
  printLine("  guard <id> --guard-status ...   set guard decision");
  printLine("  handoff <id>                    print agent handoff prompt");
  printLine("  summary                         print loop stats");
  printLine("  convergence [--family ..] [--min-sources N] [--all]  patterns spanning multiple sources");
  printLine("  guard-gaps [--family ..] [--include-waived] [--all-kinds]  resolved tickets missing a guard");
  printLine("  workflow-audit [--family ..]    patterns whose status disagrees with their linked tickets");
  printLine("  knowledge [--family ..] [--kind ..] [--query ..]  search resolved-ticket fix knowledge");
  printLine("  knowledge-gaps [--family ..] [--severity ..] [--source ..]  resolved tickets lacking reusable knowledge");
  printLine("  related <id> [--min-score N] [--limit N]  prior-art: tickets related to <id>");
  printLine("  dashboard [--out file.html] [--stdout]  write a standalone HTML dashboard");
  printLine("  serve [--port N]                serve the dashboard over HTTP (default 4319)");
  printLine("  config                          print effective config");
  printLine("  mcp [--write]                   run the MCP server over stdio (read-only unless --write)");
  printLine("  github-link <id> <issue-url>    manually link a ticket to an existing GitHub Issue");
  printLine("  github-sync <id>                create/update the linked Issue and import new comments");
  printLine("");
  printLine("Storage: set DATABASE_URL to run on Postgres; otherwise .agentloops/state.json is used.");
  printLine(
    "GitHub sync: set github.repo (and GITHUB_TOKEN, or github.tokenEnv) in agentloop.config.json to enable github-sync.",
  );
}

interface OpenStore {
  cwd: string;
  config: ProjectConfig;
  store: AgentLoopStore;
  kind: BackendSelection["kind"];
}

let openedStore: OpenStore | null = null;
let openedSelection: BackendSelection | null = null;

// Opens (once) the store over the resolved backend — Postgres when DATABASE_URL
// or config selects it, otherwise the filesystem. Cached so a single process
// uses one backend (and one Postgres pool).
async function ensureConfig(): Promise<OpenStore> {
  if (openedStore) return openedStore;
  const cwd = process.cwd();
  const config = await loadConfig(cwd);
  openedSelection = await resolveBackend({ cwd, config });
  const store = new AgentLoopStore(cwd, config, { backend: openedSelection.backend });
  openedStore = { cwd, config, store, kind: openedSelection.kind };
  return openedStore;
}

// Release storage resources (closes the Postgres pool so the process can exit).
async function disposeStorage() {
  if (openedSelection) {
    await openedSelection.dispose();
    openedSelection = null;
    openedStore = null;
  }
}

async function cmdInit(argv: string[], options: ArgMap) {
  await writeDefaultConfig(process.cwd());
  const { config, store, kind } = await ensureConfig();
  const project = typeof options.project === "string" ? options.project : config.projectName;
  const created = await store.ensureInitialized(project);
  const where = kind === "postgres" ? "Postgres" : ".agentloops/state.json";
  printLine(`Initialized ${created.project} (${where})`);
}

async function cmdCreate(argv: string[], options: ArgMap) {
  const { store, config } = await ensureConfig();
  const title = typeof options.title === "string" ? options.title : "";
  const summary = typeof options.summary === "string" ? options.summary : "";
  const family = typeof options.family === "string" ? options.family : config.patterns.defaultFamily;
  const kind = (typeof options.kind === "string" ? options.kind : config.defaultKind) as TicketKind;
  const source = typeof options.source === "string" ? options.source : "manual_admin";
  const severity = (typeof options.severity === "string"
    ? options.severity
    : config.ticketKinds.find((entry) => entry.kind === kind)?.defaultSeverity) as
    | "low"
    | "medium"
    | "high"
    | "critical"
    | undefined;
  const confidence = (typeof options.confidence === "string"
    ? options.confidence
    : "medium") as Confidence;
  const tags = toArray(options.tags as string | boolean);
  const ticket = await store.createTicket({
    title,
    summary,
    family,
    kind,
    source,
    severity,
    confidence,
    tags,
    handoffText: typeof options.handoff === "string" ? options.handoff : undefined,
  });
  if (options.json) {
    printJson(ticket);
  } else {
    printLine(`Created ${ticket.id} (${ticket.aliases.join(", ")})`);
    printLine(`kind=${ticket.kind} family=${ticket.family} status=${ticket.status}`);
    printLine(`title: ${ticket.title}`);
    if (ticket.patternId) {
      printLine(`Pattern: ${ticket.patternId}`);
    }
  }
}

async function cmdList(argv: string[], options: ArgMap) {
  const { store } = await ensureConfig();
  const status = options.status ? (options.status as string as TicketStatus) : "all";
  const rows = await store.listTickets({
    status: status as TicketStatus | "all",
    kind: typeof options.kind === "string" ? options.kind : undefined,
  });
  if (options.json) {
    printJson(rows);
    return;
  }
  for (const ticket of rows) {
    printLine(
      `${shortSummary(ticket.status)} ${ticket.id} ${ticket.aliases[0] ?? ""} ${ticket.kind} [${ticket.family}]`,
    );
    printLine(`  ${ticket.title}`);
  }
  if (rows.length === 0) {
    printLine("No tickets found");
  }
}

async function cmdShow(argv: string[]) {
  const { store } = await ensureConfig();
  const raw = argv[1];
  if (!raw) {
    throw new Error("show requires an id");
  }
  if (raw.startsWith("PATTERN-")) {
    const pattern = await store.getPattern(raw);
    if (!pattern) throw new Error(`Pattern not found: ${raw}`);
    printJson(pattern);
    return;
  }
  const canonical = normalizeTicketInput(raw, await store.listTickets({ status: "all" }));
  if (canonical.startsWith("PATTERN-")) {
    const pattern = await store.getPattern(canonical);
    if (!pattern) throw new Error(`Pattern not found: ${raw}`);
    printJson(pattern);
    return;
  }
  const ticket = await store.showTicket(raw);
  if (!ticket) throw new Error(`Not found: ${raw}`);
  printJson(ticket);
}

async function cmdPatterns(argv: string[], options: ArgMap) {
  const { store } = await ensureConfig();
  const status = options.status ? (options.status as string as PatternStatus) : "all";
  const rows = await store.listPatterns({ status });
  if (options.json) {
    printJson(rows);
    return;
  }
  for (const p of rows) {
    printLine(`${p.status.toUpperCase().padEnd(8)} ${p.id} ${p.family} (${p.ticketIds.length} tickets)`);
    printLine(`  ${p.title}`);
  }
  if (rows.length === 0) {
    printLine("No patterns found");
  }
}

async function cmdBegin(argv: string[]) {
  const { store } = await ensureConfig();
  const id = argv[1];
  if (!id) throw new Error("begin requires an id");
  const ticket = await store.beginTicket(id);
  printJson(ticket);
}

async function cmdResolve(argv: string[], options: ArgMap) {
  const { store } = await ensureConfig();
  const id = argv[1];
  const summary = typeof options.summary === "string" ? options.summary : "";
  if (!id || !summary) {
    throw new Error("resolve requires <id> and --summary");
  }
  const ticket = await store.resolveTicket({
    id,
    summary,
    verification: typeof options.verification === "string" ? options.verification : undefined,
    guardStatus: typeof options["guard-status"] === "string" ? (options["guard-status"] as string as any) : "none",
    guardSummary: typeof options["guard-summary"] === "string" ? options["guard-summary"] : undefined,
  });
  printJson(ticket);
}

async function cmdReopen(argv: string[], options: ArgMap) {
  const { store } = await ensureConfig();
  const id = argv[1];
  const reason = typeof options.summary === "string" ? options.summary : "recurrence detected";
  if (!id) throw new Error("reopen requires <id>");
  const ticket = await store.reopenTicket(id, reason);
  printJson(ticket);
}

async function cmdDefer(argv: string[], options: ArgMap) {
  const { store } = await ensureConfig();
  const id = argv[1];
  if (!id) throw new Error("defer requires <id>");
  const reason =
    typeof options.summary === "string"
      ? options.summary
      : typeof options.reason === "string"
        ? options.reason
        : undefined;
  const ticket = await store.deferTicket(id, reason);
  printJson(ticket);
}

async function cmdNote(argv: string[], options: ArgMap) {
  const { store } = await ensureConfig();
  const id = argv[1];
  const body = typeof options.body === "string" ? options.body : "";
  const type = (typeof options.type === "string" ? options.type : "triage") as any;
  if (!id || !body) {
    throw new Error("note requires <id> and --body");
  }
  const ticket = await store.addTicketNote(id, type, body, process.env.USER);
  printJson(ticket);
}

async function cmdGuard(argv: string[], options: ArgMap) {
  const { store } = await ensureConfig();
  const id = argv[1];
  const status = typeof options["guard-status"] === "string" ? options["guard-status"] : "guard_deferred";
  const summary = typeof options["guard-summary"] === "string" ? options["guard-summary"] : undefined;
  if (!id) throw new Error("guard requires <id>");
  const ticket = await store.setGuard(id, status as any, summary);
  printJson(ticket);
}

async function cmdHandoff(argv: string[]) {
  const { store } = await ensureConfig();
  const id = argv[1];
  if (!id) throw new Error("handoff requires <id>");
  const ticket = await store.showTicket(id);
  if (!ticket) throw new Error(`Not found: ${id}`);
  const prompt = buildHandoffPrompt(ticket);
  printLine(`Ticket: ${ticket.id}`);
  printLine(`Aliases: ${ticket.aliases.join(", ")}`);
  printLine("Copyable agent handoff:");
  printLine(prompt);
}

async function cmdSummary() {
  const { store } = await ensureConfig();
  printJson(await store.summary());
}

async function cmdConvergence(options: ArgMap) {
  const { store } = await ensureConfig();
  const family = typeof options.family === "string" ? options.family : undefined;
  const minSources =
    typeof options["min-sources"] === "string" ? Number(options["min-sources"]) : undefined;
  const includeAll = options.all === true;
  printJson(await store.sourceConvergence({ family, minSources, includeAll }));
}

async function cmdGuardGaps(options: ArgMap) {
  const { store } = await ensureConfig();
  const family = typeof options.family === "string" ? options.family : undefined;
  const includeWaived = options["include-waived"] === true;
  const allKinds = options["all-kinds"] === true;
  printJson(await store.guardGaps({ family, includeWaived, allKinds }));
}

async function cmdWorkflowAudit(options: ArgMap) {
  const { store } = await ensureConfig();
  const family = typeof options.family === "string" ? options.family : undefined;
  printJson(await store.workflowAudit({ family }));
}

async function cmdKnowledge(options: ArgMap) {
  const { store } = await ensureConfig();
  const str = (key: string) => (typeof options[key] === "string" ? (options[key] as string) : undefined);
  const limit = typeof options.limit === "string" ? Number(options.limit) : undefined;
  printJson(
    await store.searchKnowledge({
      family: str("family"),
      kind: str("kind"),
      source: str("source"),
      tag: str("tag"),
      query: str("query"),
      limit,
    }),
  );
}

async function cmdKnowledgeGaps(options: ArgMap) {
  const { store } = await ensureConfig();
  const str = (key: string) => (typeof options[key] === "string" ? (options[key] as string) : undefined);
  printJson(
    await store.knowledgeGaps({
      family: str("family"),
      severity: str("severity"),
      source: str("source"),
    }),
  );
}

async function cmdRelated(argv: string[], options: ArgMap) {
  const { store } = await ensureConfig();
  const id = argv[1];
  if (!id) throw new Error("related requires an id");
  const minScore = typeof options["min-score"] === "string" ? Number(options["min-score"]) : undefined;
  const limit = typeof options.limit === "string" ? Number(options.limit) : undefined;
  printJson(await store.related(id, { minScore, limit }));
}

async function cmdDashboard(options: ArgMap) {
  const { store } = await ensureConfig();
  const html = renderDashboard(await gatherDashboardData(store));
  if (options.stdout === true) {
    process.stdout.write(html);
    return;
  }
  const out = typeof options.out === "string" ? options.out : "agentloop-dashboard.html";
  await fs.writeFile(out, html, "utf-8");
  printLine(`Wrote dashboard to ${out}`);
}

async function cmdServe(options: ArgMap) {
  const { store, kind } = await ensureConfig();
  const port = typeof options.port === "string" ? Number(options.port) : 4319;
  const server = createDashboardServer(store);
  await new Promise<void>((resolve) => server.listen(port, resolve));
  process.stderr.write(`agentloop dashboard on http://localhost:${port} (${kind})\n`);
  // Run until the process is stopped.
  await new Promise<void>(() => {});
}

async function cmdConfig() {
  const { config } = await ensureConfig();
  printJson(config);
}

async function cmdGithubLink(argv: string[]) {
  const { store } = await ensureConfig();
  const id = argv[1];
  const issueUrl = argv[2];
  if (!id || !issueUrl) throw new Error("github-link requires <id> <issue-url>");
  printJson(await store.linkGithubIssue(id, issueUrl));
}

async function cmdGithubSync(argv: string[]) {
  const { store, config } = await ensureConfig();
  const id = argv[1];
  if (!id) throw new Error("github-sync requires <id>");
  const target = resolveGithubTarget(config);
  if (!target) {
    throw new Error("GitHub sync is not configured: set `github.repo` in agentloop.config.json");
  }
  const result = await store.syncGithubIssue(id, target.client);
  printJson(result);
}

async function cmdMcp(options: ArgMap) {
  const { cwd, config, kind } = await ensureConfig();
  // Writes are opt-in: read-only unless --write (alias --allow-writes) is set.
  const allowWrites = options.write === true || options["allow-writes"] === true;
  // Lazy-load so the MCP SDK is only required when this command runs, and so
  // its dependency never affects startup of the other CLI commands.
  const { startStdioMcpServer } = await import("./mcp.js");
  // stdout is reserved for the JSON-RPC stream; status goes to stderr.
  process.stderr.write(
    `agentloop MCP server ready on stdio (${allowWrites ? "read-write" : "read-only"}, ${kind})\n`,
  );
  await startStdioMcpServer({ cwd, config, allowWrites, backend: openedSelection?.backend });
}

async function main() {
  const argv = process.argv.slice(2);
  const { args, options } = parseArgs(argv);
  const command = args[0] ?? "help";
  if (!COMMANDS.includes(command)) {
    throw new Error(`Unknown command: ${command}`);
  }
  try {
    switch (command) {
    case "help":
      printHelp();
      break;
    case "init":
      await cmdInit(args, options);
      break;
    case "create":
      await cmdCreate(args, options);
      break;
    case "list":
      await cmdList(args, options);
      break;
    case "show":
      await cmdShow(args);
      break;
    case "patterns":
      await cmdPatterns(args, options);
      break;
    case "begin":
      await cmdBegin(args);
      break;
    case "resolve":
      await cmdResolve(args, options);
      break;
    case "reopen":
      await cmdReopen(args, options);
      break;
    case "defer":
      await cmdDefer(args, options);
      break;
    case "note":
      await cmdNote(args, options);
      break;
    case "guard":
      await cmdGuard(args, options);
      break;
    case "handoff":
      await cmdHandoff(args);
      break;
    case "summary":
      await cmdSummary();
      break;
    case "convergence":
      await cmdConvergence(options);
      break;
    case "guard-gaps":
      await cmdGuardGaps(options);
      break;
    case "workflow-audit":
      await cmdWorkflowAudit(options);
      break;
    case "knowledge":
      await cmdKnowledge(options);
      break;
    case "knowledge-gaps":
      await cmdKnowledgeGaps(options);
      break;
    case "related":
      await cmdRelated(args, options);
      break;
    case "dashboard":
      await cmdDashboard(options);
      break;
    case "serve":
      await cmdServe(options);
      break;
    case "config":
      await cmdConfig();
      break;
    case "mcp":
      await cmdMcp(options);
      break;
    case "github-link":
      await cmdGithubLink(args);
      break;
    case "github-sync":
      await cmdGithubSync(args);
      break;
    default:
      printHelp();
    }
  } finally {
    await disposeStorage();
  }
}

// Exit quietly when output is piped to a reader that closed early
// (e.g. `agentloop list | head`), instead of crashing with EPIPE.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  printLine(`Error: ${message}`);
  process.exitCode = 1;
});
