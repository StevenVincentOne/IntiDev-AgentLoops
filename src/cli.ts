#!/usr/bin/env node
import { loadConfig, writeDefaultConfig } from "./config";
import {
  Confidence,
  PatternStatus,
  TicketKind,
  TicketStatus,
} from "./types";
import { AgentLoopStore, normalizeTicketInput } from "./store";
import { buildHandoffPrompt } from "./handoff";

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
  "note",
  "guard",
  "handoff",
  "summary",
  "config",
  "mcp",
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
  printLine("  note <id> --type ... --body ... add a non-resolution note");
  printLine("  guard <id> --guard-status ...   set guard decision");
  printLine("  handoff <id>                    print agent handoff prompt");
  printLine("  summary                         print loop stats");
  printLine("  config                          print effective config");
  printLine("  mcp [--stdio]                   run the read-only MCP server (stdio)");
}

async function ensureConfig() {
  const cwd = process.cwd();
  const config = await loadConfig(cwd);
  const store = new AgentLoopStore(cwd, config);
  return { cwd, config, store };
}

async function cmdInit(argv: string[], options: ArgMap) {
  const { config } = await ensureConfig();
  const project = typeof options.project === "string" ? options.project : config.projectName;
  const cfg = await writeDefaultConfig(process.cwd());
  const created = await new AgentLoopStore(process.cwd(), cfg).ensureInitialized(project);
  printLine(`Initialized ${created.project} at .agentloops/state.json`);
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

async function cmdConfig() {
  const { config } = await ensureConfig();
  printJson(config);
}

async function cmdMcp() {
  const { cwd, config } = await ensureConfig();
  // Lazy-load so the MCP SDK is only required when this command runs, and so
  // its dependency never affects startup of the other CLI commands.
  const { startStdioMcpServer } = await import("./mcp.js");
  // stdout is reserved for the JSON-RPC stream; status goes to stderr.
  process.stderr.write("agentloop MCP server ready on stdio (read-only)\n");
  await startStdioMcpServer({ cwd, config });
}

async function main() {
  const argv = process.argv.slice(2);
  const { args, options } = parseArgs(argv);
  const command = args[0] ?? "help";
  if (!COMMANDS.includes(command)) {
    throw new Error(`Unknown command: ${command}`);
  }
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
    case "config":
      await cmdConfig();
      break;
    case "mcp":
      await cmdMcp();
      break;
    default:
      printHelp();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  printLine(`Error: ${message}`);
  process.exitCode = 1;
});
