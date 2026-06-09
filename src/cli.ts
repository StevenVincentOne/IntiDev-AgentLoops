#!/usr/bin/env node
import { loadConfig, writeDefaultConfig } from "./config";
import {
  Confidence,
  PatternStatus,
  PriorArtHint,
  PriorArtTrustLevel,
  ProjectConfig,
  RootCauseCertificate,
  TicketKind,
  TicketStatus,
  VerificationBrief,
} from "./types";
import { promises as fs } from "node:fs";
import { AgentLoopStore, normalizeTicketInput } from "./store";
import { shouldSurfacePriorArt } from "./prior-art";
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
  "workflow-repair",
  "near-duplicates",
  "groups",
  "begin-group",
  "promote-group",
  "knowledge",
  "knowledge-gaps",
  "related",
  "prior-art-graph",
  "prior-art-refresh",
  "prior-art-audit",
  "sweep",
  "classify-siblings",
  "evidence-draft",
  "resolve-draft",
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
  printLine("  create --title ... --summary ... [--prior-art-hint new|previously_ticketed|existing_pattern|adjacent_issues]");
  printLine("                                  create a new issue/feature/feedback; a non-'new' hint auto-checks for prior art");
  printLine("  list [--status triaged|active|resolved|all] list tickets");
  printLine("  show <id>                       inspect ticket");
  printLine("  patterns [--status open|active|resolved|all] list patterns");
  printLine("  begin <id>                      begin a triaged item");
  printLine("  resolve <id> --summary ... [--verification ..] [--verification-brief <json>]");
  printLine("                                  resolve a ticket; evidence-sensitive families/kinds (see config.verification)");
  printLine("                                  require --verification-brief — see docs/agent-integration.md for the shape");
  printLine("  resolve-pattern <id> --summary ... [--verification-brief <json>] [...]");
  printLine("                                  resolve a Pattern and cascade the same evidence to its not-yet-resolved linked tickets;");
  printLine("                                  ≥2 evidence-sensitive linked tickets escalate to fresh + broad-coverage requirements (write)");
  printLine("  reopen <id> --summary ...       reopen a resolved/reopen-risk item");
  printLine("  defer <id> [--summary ...]      defer a ticket (records an optional reason)");
  printLine("  note <id> --type ... --body ... add a non-resolution note");
  printLine("  guard <id> --guard-status ...   set guard decision");
  printLine("  handoff <id>                    print agent handoff prompt");
  printLine("  summary                         print loop stats");
  printLine("  convergence [--family ..] [--min-sources N] [--all]  patterns spanning multiple sources");
  printLine("  guard-gaps [--family ..] [--include-waived] [--all-kinds]  resolved tickets missing a guard");
  printLine("  workflow-audit [--family ..]    patterns whose status disagrees with their linked tickets");
  printLine("  workflow-repair [--family ..] [--dry-run]");
  printLine("                                  fix that drift: reopen/resolve patterns to match their tickets (write unless --dry-run)");
  printLine("  near-duplicates [--family ..] [--min-overlap 0.5] [--include-resolved] [--limit 20]");
  printLine("                                  open tickets whose title/summary look like the same problem");
  printLine("  groups [--family ..] [--min-size 2] [--limit 10]");
  printLine("                                  broad triage clusters of open work worth reviewing together (not resolution objects — see Patterns)");
  printLine("  begin-group <group-key> [--limit N] [--prior-art-limit N] [--ticket-limit N]");
  printLine("                                  'begin before you build' for a Group: aggregated prior art, family Patterns/knowledge, and ranked Pattern-discovery hypotheses (read-only)");
  printLine("  promote-group <group-key> [--title ..] [--summary ..] [--family ..] [--actor ..]");
  printLine("                                  promote a computed Group to a Pattern: find-or-reuse a Pattern in its family, link members, record provenance (write)");
  printLine("  knowledge [--family ..] [--kind ..] [--query ..]  search resolved-ticket fix knowledge");
  printLine("  knowledge-gaps [--family ..] [--severity ..] [--source ..]  resolved tickets lacking reusable knowledge");
  printLine("  related <id> [--min-score N] [--limit N]  prior-art: tickets related to <id> (on-the-fly)");
  printLine("  prior-art-graph <id> [--min-strength N] [--half-life-days N] [--limit N]");
  printLine("                                  durable, decaying prior-art edges persisted for <id>");
  printLine("  prior-art-refresh [--min-score N] [--half-life-days N] [--prune-below N]");
  printLine("                                  recompute + persist the prior-art graph (write)");
  printLine("  prior-art-audit [--cutoff-date YYYY-MM-DD] [--family ..] [--limit N]");
  printLine("    [--apply] [--add-note] [--trust-level provisional|suspect|deprecated]");
  printLine("                                  audit resolved tickets for weak prior art (read); --apply persists trust overlay (write)");
  printLine("  sweep <id> [--candidate-limit N] [--prior-art-limit N] [--pattern-limit N]");
  printLine("                                  symptom-family sweep: classify open/resolved tickets by symptom overlap before resolution");
  printLine("  classify-siblings <seed-id> [--same-root <id>] [--adjacent <id>] [--unverified <id>] [--unrelated <id>]");
  printLine("    [--reason ...] [--link-same-root]");
  printLine("                                  persist sibling ticket classifications from sweep/expansion review (write)");
  printLine("  evidence-draft <id> [--evidence-only] [--claim-scope ..] [--verify-command ..] [--file ..]");
  printLine("    [--guard-status ..] [--guard-command ..] [--guard-artifact-ref ..] [--symptom ..] [--root-cause ..]");
  printLine("    [--earliest-failure-stage ..] [--why-source-level-fix ..] [--affected-contract ..] [--regression-risk ..]");
  printLine("                                  generate a verificationBrief + rootCauseCertificate scaffold; --evidence-only emits exact JSON");
  printLine("  resolve-draft <id> [same options as evidence-draft]");
  printLine("                                  same as evidence-draft but also emits a ready-to-edit resolve command with explicit guard flags");
  printLine("");
  printLine("Guard flags (resolve / evidence-draft / resolve-draft):");
  printLine("  --guard-command <cmd>         concrete test/smoke command that acts as the regression guard");
  printLine("  --guard-artifact-ref <path>   artifact path (test file, spec) referenced by the guard");
  printLine("  --guard-detector-key <key>    stable detector/rule key that would catch recurrence");
  printLine("");
  printLine("JSON output: add --json to any command for machine-readable output; pipe with no extra flags:");
  printLine("  agentloop list --json | jq '.tickets[].id'");
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
  const priorArtHint =
    typeof options["prior-art-hint"] === "string" ? (options["prior-art-hint"] as PriorArtHint) : undefined;
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
    priorArtHint,
  });

  // "History context" auto-surfacing: when the reporter signals they believe
  // prior art may exist, run the prior-art check immediately and show
  // candidates — instead of leaving the hint as a label nobody acts on.
  let suggestions: Awaited<ReturnType<AgentLoopStore["related"]>>["related"] = [];
  if (shouldSurfacePriorArt(priorArtHint)) {
    const related = await store.related(ticket.id, { limit: 5 });
    suggestions = related.related;
  }

  if (options.json) {
    printJson(suggestions.length > 0 ? { ticket, priorArtSuggestions: suggestions } : ticket);
  } else {
    printLine(`Created ${ticket.id} (${ticket.aliases.join(", ")})`);
    printLine(`kind=${ticket.kind} family=${ticket.family} status=${ticket.status}`);
    printLine(`title: ${ticket.title}`);
    if (ticket.patternId) {
      printLine(`Pattern: ${ticket.patternId}`);
    }
    if (suggestions.length > 0) {
      printLine(`Possible prior art (priorArtHint=${priorArtHint}):`);
      for (const candidate of suggestions) {
        printLine(`  ${candidate.alias}  score=${candidate.score}  ${candidate.title}  [${candidate.signals.join(", ")}]`);
      }
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
    guardCommand: typeof options["guard-command"] === "string" ? options["guard-command"] : undefined,
    guardArtifactRef: typeof options["guard-artifact-ref"] === "string" ? options["guard-artifact-ref"] : undefined,
    guardDetectorKey: typeof options["guard-detector-key"] === "string" ? options["guard-detector-key"] : undefined,
    verificationBrief: parseVerificationBriefOption(options),
    rootCauseCertificate: parseRootCauseCertOption(options),
  });
  printJson(ticket);
}

/**
 * Parses `--verification-brief <json>` into a `VerificationBrief`. Evidence-
 * sensitive tickets/Patterns require this — see `ProjectConfig.verification`
 * and `docs/agent-integration.md` for the shape and the philosophy behind it
 * (deterministic rules check the brief is complete and coherent; the agent's
 * `agentJudgment`/`reason` supply the actual sufficiency call).
 */
function parseVerificationBriefOption(options: ArgMap): VerificationBrief | undefined {
  const raw = options["verification-brief"];
  if (typeof raw !== "string" || raw.trim().length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`--verification-brief must be valid JSON: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("--verification-brief must be a JSON object matching the VerificationBrief shape");
  }
  return parsed as VerificationBrief;
}

/**
 * Parses `--root-cause-certificate <json>` (or `--root-cause-cert <json>`) into
 * a `RootCauseCertificate`. Meaningful fixed bugs/incidents/user-feedback
 * tickets require this when `ProjectConfig.rootCause.meaningfulKinds` matches.
 * Generate a scaffold first: `agentloop evidence-draft <id> --evidence-only`.
 */
function parseRootCauseCertOption(options: ArgMap): RootCauseCertificate | undefined {
  const raw = options["root-cause-certificate"] ?? options["root-cause-cert"];
  if (typeof raw !== "string" || raw.trim().length === 0) return undefined;
  let source = raw;
  if (raw.startsWith("@")) {
    const { readFileSync } = require("node:fs");
    try {
      source = readFileSync(raw.slice(1), "utf8");
    } catch (err) {
      throw new Error(`--root-cause-certificate: could not read file ${raw}: ${(err as Error).message}`);
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (err) {
    throw new Error(`--root-cause-certificate must be valid JSON: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--root-cause-certificate must be a JSON object");
  }
  return parsed as RootCauseCertificate;
}

/** Parses a list flag that can be repeated (e.g. `--file a --file b`). */
function parseRepeatedFlag(options: ArgMap, key: string): string[] {
  const raw = options[key];
  if (!raw) return [];
  if (typeof raw === "boolean") return [];
  // Multiple `--key val` flags are joined with "\n" by the arg parser.
  return String(raw).split("\n").map((s) => s.trim()).filter(Boolean);
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
  return `"${value.replace(/["\\$`]/g, "\\$&")}"`;
}

/**
 * Generate an evidence JSON scaffold — `verificationBrief` + `rootCauseCertificate`
 * — for the given ticket. Designed to be written to a temp file and passed to
 * `agentloop resolve --root-cause-certificate @tmp/evidence.json`.
 *
 * With `--evidence-only` the output is the exact JSON object accepted by
 * `resolve`'s `--root-cause-certificate` / `--verification-brief` flags.
 * `resolve-draft` additionally emits a ready-to-edit CLI command.
 */
async function cmdEvidenceDraft(argv: string[], options: ArgMap, includeResolveCommand: boolean) {
  const { store, config } = await ensureConfig();
  const id = argv[1];
  if (!id) throw new Error("evidence-draft requires <id>");
  const ticket = await store.showTicket(id);
  if (!ticket) throw new Error(`Ticket not found: ${id}`);

  const key = ticket.aliases[0] ?? ticket.id;
  const claimScope = typeof options["claim-scope"] === "string"
    ? options["claim-scope"]
    : "single_ticket";
  const verificationPerformed = parseRepeatedFlag(options, "verify-command").length > 0
    ? parseRepeatedFlag(options, "verify-command")
    : ["TODO: run the test/smoke command that exercises this fix, e.g. npm test -- --grep '...'"];
  const filesChanged = parseRepeatedFlag(options, "file").length > 0
    ? parseRepeatedFlag(options, "file")
    : ["TODO: src/path/to/changed-file.ts"];

  const guardStatus = typeof options["guard-status"] === "string" ? options["guard-status"] : "guard_added|guard_existing|guard_waived|guard_deferred";
  const guardType = typeof options["guard-type"] === "string" ? options["guard-type"] : "regression_test";
  const guardCommand = typeof options["guard-command"] === "string" ? options["guard-command"] : null;
  const guardArtifactRef = typeof options["guard-artifact-ref"] === "string" ? options["guard-artifact-ref"] : null;
  const guardSummary = typeof options["guard-summary"] === "string" ? options["guard-summary"] : "TODO: name the regression guard, detector, smoke, or why this is waived/deferred";

  const evidence = {
    verificationBrief: {
      claimScope,
      affectedArtifactIds: typeof options["affected-artifact-id"] === "string"
        ? [options["affected-artifact-id"]]
        : [],
      verificationPerformed,
      coverage: typeof options.coverage === "string" ? options.coverage : `TODO: describe coverage (e.g. "single ticket: ${key}")`,
      agentJudgment: "TODO_sufficient_or_not",
      reason: "TODO: explain why this evidence proves the claimed scope, and why adjacent tickets are or are not covered.",
    },
    rootCauseCertificate: {
      symptom: typeof options.symptom === "string" ? options.symptom : (ticket.title || "TODO: describe the visible failure symptom"),
      rootCause: typeof options["root-cause"] === "string" ? options["root-cause"] : "TODO: state the code-level or architecture-level root cause (not just a restatement of the symptom)",
      earliestFailureStage: typeof options["earliest-failure-stage"] === "string" ? options["earliest-failure-stage"] : "TODO: name the earliest stage where correct data became wrong or unavailable",
      whySourceLevelFixOrWhyNot: typeof options["why-source-level-fix"] === "string" ? options["why-source-level-fix"] : "TODO: explain why the fix is at the earliest responsible layer, or why a downstream fix was chosen",
      affectedContractOrInvariant: typeof options["affected-contract"] === "string" ? options["affected-contract"] : "TODO: name the contract/invariant that failed",
      filesChanged,
      guardDecision: guardSummary,
      regressionRisk: typeof options["regression-risk"] === "string" ? options["regression-risk"] : "TODO: low|medium|high|critical|none",
    },
  };

  const evidenceOnly = options["evidence-only"] === true;

  if (evidenceOnly) {
    printJson(evidence);
    return;
  }

  // Full draft including suggested resolve command.
  const evidencePath = typeof options["evidence-path"] === "string" ? options["evidence-path"] : "tmp/evidence.json";
  const resolveArgs = [
    "agentloop", "resolve", key,
    `--summary ${shellQuote("...")}`,
    `--guard-status ${guardStatus}`,
    `--guard-type ${guardType}`,
  ];
  if (guardCommand) resolveArgs.push(`--guard-command ${shellQuote(guardCommand)}`);
  if (guardArtifactRef) resolveArgs.push(`--guard-artifact-ref ${shellQuote(guardArtifactRef)}`);
  resolveArgs.push(`--guard-summary ${shellQuote(guardSummary)}`);
  resolveArgs.push(`--root-cause-certificate @${evidencePath}`);
  resolveArgs.push(`--verification-brief @${evidencePath}`);

  const draft = {
    ticket: { id: ticket.id, title: ticket.title, status: ticket.status, family: ticket.family },
    evidence,
    guard: { status: guardStatus, type: guardType, command: guardCommand, artifactRef: guardArtifactRef, summary: guardSummary },
    suggestedResolveCommand: resolveArgs.join(" \\\n  "),
    notes: [
      `Write evidence to ${evidencePath} and pass it with --root-cause-certificate @${evidencePath}`,
      "Use --evidence-only for the exact JSON object accepted by resolve.",
      "Replace every TODO field before resolving.",
      "Set agentJudgment to \"sufficient\" only after verifying the claimed scope.",
      "Use repeated --file / --verify-command flags instead of JSON arrays: --file src/a.ts --file src/b.ts",
    ],
  };

  if (typeof options.json !== "undefined") {
    printJson(draft);
    return;
  }

  printLine(`Evidence draft for ${key} (${ticket.title})`);
  printLine(JSON.stringify(evidence, null, 2));
  if (includeResolveCommand) {
    printLine("");
    printLine("Suggested resolve command:");
    printLine(`  ${draft.suggestedResolveCommand.replace(/\n/g, "\n  ")}`);
  }
  printLine("");
  for (const note of draft.notes) printLine(`- ${note}`);
}

async function cmdSweep(argv: string[], options: ArgMap) {
  const { store } = await ensureConfig();
  const id = argv[1];
  if (!id) throw new Error("sweep requires <id>");
  const result = await store.sweep(id, {
    candidateLimit: typeof options["candidate-limit"] === "string" ? Number(options["candidate-limit"]) : undefined,
    priorArtLimit: typeof options["prior-art-limit"] === "string" ? Number(options["prior-art-limit"]) : undefined,
    patternLimit: typeof options["pattern-limit"] === "string" ? Number(options["pattern-limit"]) : undefined,
  });
  printJson(result);
}

async function cmdClassifySiblings(argv: string[], options: ArgMap) {
  const { store } = await ensureConfig();
  const seedId = argv[1];
  if (!seedId) throw new Error("classify-siblings requires <seed-id>");
  const result = await store.classifySiblings({
    seedId,
    sameRoot: parseRepeatedFlag(options, "same-root"),
    adjacent: parseRepeatedFlag(options, "adjacent"),
    unverified: parseRepeatedFlag(options, "unverified"),
    unrelated: parseRepeatedFlag(options, "unrelated"),
    reason: typeof options.reason === "string" ? options.reason : undefined,
    linkSameRoot: options["link-same-root"] === true,
  });
  printJson(result);
}

async function cmdPriorArtAudit(options: ArgMap) {
  const { store } = await ensureConfig();
  const result = await store.priorArtAudit({
    cutoffDate: typeof options["cutoff-date"] === "string" ? options["cutoff-date"] : undefined,
    family: typeof options.family === "string" ? options.family : undefined,
    limit: typeof options.limit === "string" ? Number(options.limit) : undefined,
    apply: options.apply === true,
    addNote: options["add-note"] === true,
    trustLevel: typeof options["trust-level"] === "string" ? (options["trust-level"] as PriorArtTrustLevel) : undefined,
    overwrite: options.overwrite === true,
  });
  printJson(result);
}

async function cmdResolvePattern(argv: string[], options: ArgMap) {
  const { store } = await ensureConfig();
  const id = argv[1];
  const summary = typeof options.summary === "string" ? options.summary : "";
  if (!id || !summary) {
    throw new Error("resolve-pattern requires <id> and --summary");
  }
  const result = await store.cascadeResolvePattern({
    patternId: id,
    summary,
    verification: typeof options.verification === "string" ? options.verification : undefined,
    guardStatus: typeof options["guard-status"] === "string" ? (options["guard-status"] as string as any) : "none",
    guardSummary: typeof options["guard-summary"] === "string" ? options["guard-summary"] : undefined,
    verificationBrief: parseVerificationBriefOption(options),
  });
  printJson(result);
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

async function cmdWorkflowRepair(options: ArgMap) {
  const { store } = await ensureConfig();
  const family = typeof options.family === "string" ? options.family : undefined;
  const dryRun = options["dry-run"] === true;
  printJson(await store.repairWorkflow({ family, dryRun }));
}

async function cmdNearDuplicates(options: ArgMap) {
  const { store } = await ensureConfig();
  const family = typeof options.family === "string" ? options.family : undefined;
  const minTextOverlap =
    typeof options["min-overlap"] === "string" ? Number(options["min-overlap"]) : undefined;
  const includeResolved = options["include-resolved"] === true;
  const limit = typeof options.limit === "string" ? Number(options.limit) : undefined;
  printJson(await store.nearDuplicates({ family, minTextOverlap, includeResolved, limit }));
}

async function cmdGroups(options: ArgMap) {
  const { store } = await ensureConfig();
  const family = typeof options.family === "string" ? options.family : undefined;
  const minSize = typeof options["min-size"] === "string" ? Number(options["min-size"]) : undefined;
  const limit = typeof options.limit === "string" ? Number(options.limit) : undefined;
  printJson(await store.ticketGroups({ family, minSize, limit }));
}

async function cmdBeginGroup(argv: string[], options: ArgMap) {
  const { store } = await ensureConfig();
  const identifier = argv[1];
  if (!identifier) throw new Error("begin-group requires a group key, e.g. family:export_pipeline");
  const ticketLimit = typeof options["ticket-limit"] === "string" ? Number(options["ticket-limit"]) : undefined;
  const relatedLimit = typeof options.limit === "string" ? Number(options.limit) : undefined;
  const priorArtLimit =
    typeof options["prior-art-limit"] === "string" ? Number(options["prior-art-limit"]) : undefined;
  printJson(await store.beginGroup(identifier, { ticketLimit, relatedLimit, priorArtLimit }));
}

async function cmdPromoteGroup(argv: string[], options: ArgMap) {
  const { store } = await ensureConfig();
  const identifier = argv[1];
  if (!identifier) throw new Error("promote-group requires a group key, e.g. family:export_pipeline");
  const family = typeof options.family === "string" ? options.family : undefined;
  const title = typeof options.title === "string" ? options.title : undefined;
  const summary = typeof options.summary === "string" ? options.summary : undefined;
  const actor = typeof options.actor === "string" ? options.actor : undefined;
  printJson(await store.promoteGroup(identifier, { family, title, summary, actor }));
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

async function cmdPriorArtGraph(argv: string[], options: ArgMap) {
  const { store } = await ensureConfig();
  const id = argv[1];
  if (!id) throw new Error("prior-art-graph requires an id");
  const minStrength = typeof options["min-strength"] === "string" ? Number(options["min-strength"]) : undefined;
  const decayHalfLifeDays =
    typeof options["half-life-days"] === "string" ? Number(options["half-life-days"]) : undefined;
  const limit = typeof options.limit === "string" ? Number(options.limit) : undefined;
  printJson(await store.priorArtGraph(id, { minStrength, decayHalfLifeDays, limit }));
}

async function cmdPriorArtRefresh(options: ArgMap) {
  const { store } = await ensureConfig();
  const minScore = typeof options["min-score"] === "string" ? Number(options["min-score"]) : undefined;
  const decayHalfLifeDays =
    typeof options["half-life-days"] === "string" ? Number(options["half-life-days"]) : undefined;
  const pruneBelowStrength =
    typeof options["prune-below"] === "string" ? Number(options["prune-below"]) : undefined;
  printJson(await store.refreshPriorArtGraph({ minScore, decayHalfLifeDays, pruneBelowStrength }));
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
    case "resolve-pattern":
      await cmdResolvePattern(args, options);
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
    case "workflow-repair":
      await cmdWorkflowRepair(options);
      break;
    case "near-duplicates":
      await cmdNearDuplicates(options);
      break;
    case "groups":
      await cmdGroups(options);
      break;
    case "begin-group":
      await cmdBeginGroup(args, options);
      break;
    case "promote-group":
      await cmdPromoteGroup(args, options);
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
    case "prior-art-graph":
      await cmdPriorArtGraph(args, options);
      break;
    case "prior-art-refresh":
      await cmdPriorArtRefresh(options);
      break;
    case "prior-art-audit":
      await cmdPriorArtAudit(options);
      break;
    case "sweep":
      await cmdSweep(args, options);
      break;
    case "classify-siblings":
      await cmdClassifySiblings(args, options);
      break;
    case "evidence-draft":
      await cmdEvidenceDraft(args, options, false);
      break;
    case "resolve-draft":
      await cmdEvidenceDraft(args, options, true);
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
