import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AgentLoopStore } from "./store";
import { StateBackend } from "./backend";
import { buildHandoffPrompt } from "./handoff";
import { resolveGithubTarget } from "./github";
import {
  Confidence,
  GuardStatus,
  NoteType,
  Pattern,
  ProjectConfig,
  Severity,
  Ticket,
  TicketKind,
  TicketStatus,
} from "./types";

/**
 * Schema version for the MCP tool envelopes. Bump only on breaking changes;
 * add fields freely during dogfood (see docs/tickets agent JSON contracts).
 */
export const MCP_SCHEMA_VERSION = 1 as const;

export const MCP_SERVER_NAME = "agentloop";

function nowIso(): string {
  return new Date().toISOString();
}

interface Envelope {
  schemaVersion: typeof MCP_SCHEMA_VERSION;
  generatedAt: string;
}

export interface SummaryResult extends Envelope {
  summary: Awaited<ReturnType<AgentLoopStore["summary"]>>;
}

export interface ListResult extends Envelope {
  filters: { status: string; kind: string | null };
  count: number;
  tickets: Ticket[];
}

export interface ShowTicketResult extends Envelope {
  kind: "ticket";
  ticket: Ticket;
}

export interface ShowPatternResult extends Envelope {
  kind: "pattern";
  pattern: Pattern;
}

export type ShowResult = ShowTicketResult | ShowPatternResult;

export interface HandoffResult extends Envelope {
  ticketId: string;
  aliases: string[];
  prompt: string;
}

function envelope(): Envelope {
  return { schemaVersion: MCP_SCHEMA_VERSION, generatedAt: nowIso() };
}

/**
 * Pure read-only tool implementations. These are transport-agnostic and
 * deterministic apart from `generatedAt`, so they can be unit-tested directly
 * without standing up an MCP transport.
 */
export async function summaryTool(store: AgentLoopStore): Promise<SummaryResult> {
  return { ...envelope(), summary: await store.summary() };
}

export async function listTool(
  store: AgentLoopStore,
  args: { status?: string; kind?: string } = {},
): Promise<ListResult> {
  const status = (args.status ?? "all") as TicketStatus | "all";
  const tickets = await store.listTickets({ status, kind: args.kind });
  return {
    ...envelope(),
    filters: { status: args.status ?? "all", kind: args.kind ?? null },
    count: tickets.length,
    tickets,
  };
}

export async function showTool(
  store: AgentLoopStore,
  args: { id: string },
): Promise<ShowResult> {
  const raw = args.id?.trim();
  if (!raw) {
    throw new Error("show requires an id");
  }
  if (/^PATTERN-/i.test(raw)) {
    const pattern = await store.getPattern(raw.toUpperCase());
    if (!pattern) {
      throw new Error(`Pattern not found: ${raw}`);
    }
    return { ...envelope(), kind: "pattern", pattern };
  }
  const ticket = await store.showTicket(raw);
  if (!ticket) {
    throw new Error(`Not found: ${raw}`);
  }
  return { ...envelope(), kind: "ticket", ticket };
}

export async function handoffTool(
  store: AgentLoopStore,
  args: { id: string },
): Promise<HandoffResult> {
  const raw = args.id?.trim();
  if (!raw) {
    throw new Error("handoff requires an id");
  }
  const ticket = await store.showTicket(raw);
  if (!ticket) {
    throw new Error(`Not found: ${raw}`);
  }
  return {
    ...envelope(),
    ticketId: ticket.id,
    aliases: ticket.aliases,
    prompt: buildHandoffPrompt(ticket),
  };
}

/**
 * Write tools (opt-in via `allowWrites`). These mutate the ledger and are
 * disabled by default; an agent gets the read-only surface unless the operator
 * explicitly enables writes.
 */
export type WriteAction = "created" | "noted" | "workflow" | "resolved" | "guard";

export interface WriteResult extends Envelope {
  action: WriteAction;
  ticket: Ticket;
}

export const SEVERITIES = ["low", "medium", "high", "critical"] as const satisfies readonly Severity[];
export const CONFIDENCES = ["low", "medium", "high"] as const satisfies readonly Confidence[];
export const NOTE_TYPES = [
  "hypothesis",
  "related_history",
  "prior_fix",
  "triage",
  "investigation",
  "external",
] as const satisfies readonly NoteType[];
export const GUARD_STATUSES = [
  "guard_added",
  "guard_existing",
  "guard_waived",
  "guard_deferred",
  "none",
] as const satisfies readonly GuardStatus[];
/** Workflow transitions exposed over MCP. `resolved` has its own tool. */
export const WORKFLOW_STATUSES = ["active", "reopened", "deferred"] as const satisfies readonly TicketStatus[];

/** Source recorded for tickets/notes created by an MCP agent client. */
export const MCP_ACTOR_SOURCE = "agent";

export async function createTicketTool(
  store: AgentLoopStore,
  args: {
    summary: string;
    title?: string;
    family?: string;
    kind?: string;
    source?: string;
    severity?: Severity;
    confidence?: Confidence;
    tags?: string[];
    handoff?: string;
  },
): Promise<WriteResult> {
  const config = store.getConfig();
  const kind = (args.kind ?? config.defaultKind) as TicketKind;
  if (!config.ticketKinds.some((entry) => entry.kind === kind)) {
    const valid = config.ticketKinds.map((entry) => entry.kind).join(", ");
    throw new Error(`Unknown kind: ${kind} (valid: ${valid})`);
  }
  const ticket = await store.createTicket({
    title: args.title ?? "",
    summary: args.summary,
    family: args.family ?? config.patterns.defaultFamily,
    kind,
    source: args.source ?? MCP_ACTOR_SOURCE,
    severity: args.severity,
    confidence: args.confidence ?? "medium",
    tags: args.tags ?? [],
    handoffText: args.handoff,
  });
  return { ...envelope(), action: "created", ticket };
}

export async function noteTool(
  store: AgentLoopStore,
  args: { id: string; body: string; type?: NoteType; author?: string },
): Promise<WriteResult> {
  const ticket = await store.addTicketNote(
    args.id,
    args.type ?? "triage",
    args.body,
    args.author ?? MCP_ACTOR_SOURCE,
  );
  return { ...envelope(), action: "noted", ticket };
}

export async function workflowTool(
  store: AgentLoopStore,
  args: { id: string; status: (typeof WORKFLOW_STATUSES)[number]; reason?: string },
): Promise<WriteResult> {
  let ticket: Ticket;
  if (args.status === "active") {
    ticket = await store.beginTicket(args.id);
  } else if (args.status === "reopened") {
    ticket = await store.reopenTicket(args.id, args.reason ?? "recurrence detected");
  } else if (args.status === "deferred") {
    ticket = await store.deferTicket(args.id, args.reason);
  } else {
    throw new Error(
      `Unsupported workflow status: ${args.status} (use active|reopened|deferred; resolve via agentloop_resolve)`,
    );
  }
  return { ...envelope(), action: "workflow", ticket };
}

export async function resolveTool(
  store: AgentLoopStore,
  args: {
    id: string;
    summary: string;
    verification?: string;
    guardStatus?: GuardStatus;
    guardSummary?: string;
  },
): Promise<WriteResult> {
  const ticket = await store.resolveTicket({
    id: args.id,
    summary: args.summary,
    verification: args.verification,
    guardStatus: args.guardStatus ?? "none",
    guardSummary: args.guardSummary,
  });
  return { ...envelope(), action: "resolved", ticket };
}

export async function guardTool(
  store: AgentLoopStore,
  args: { id: string; guardStatus: GuardStatus; guardSummary?: string },
): Promise<WriteResult> {
  const ticket = await store.setGuard(args.id, args.guardStatus, args.guardSummary);
  return { ...envelope(), action: "guard", ticket };
}

export interface GithubSyncToolResult extends Envelope {
  action: "github_synced";
  ticket: Ticket;
  issueUrl: string;
  issueNumber: number;
  importedComments: number;
}

/**
 * Create or update the ticket's linked GitHub Issue (mirroring title/body/
 * labels) and import any new Issue comments as ticket notes. Requires
 * `github.repo` (and a token env var, default GITHUB_TOKEN) in project config.
 */
export async function githubSyncTool(
  store: AgentLoopStore,
  args: { id: string },
): Promise<GithubSyncToolResult> {
  const target = resolveGithubTarget(store.getConfig());
  if (!target) {
    throw new Error("GitHub sync is not configured: set `github.repo` in agentloop.config.json");
  }
  const result = await store.syncGithubIssue(args.id, target.client);
  return {
    ...envelope(),
    action: "github_synced",
    ticket: result.ticket,
    issueUrl: result.issue.htmlUrl,
    issueNumber: result.issue.number,
    importedComments: result.importedComments,
  };
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function ok(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function fail(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: message }], isError: true };
}

export interface CreateMcpServerOptions {
  version?: string;
  /** Register the mutating write tools. Off by default (read-only surface). */
  allowWrites?: boolean;
}

/**
 * Build an MCP server over the given store. By default only the read-only tools
 * are exposed; pass `allowWrites: true` to also register the guarded write
 * tools (create / note / workflow / resolve / guard).
 */
export function createMcpServer(
  store: AgentLoopStore,
  options: CreateMcpServerOptions = {},
): McpServer {
  const server = new McpServer({
    name: MCP_SERVER_NAME,
    version: options.version ?? "0.1.0",
  });
  const readOnly = { readOnlyHint: true } as const;

  server.registerTool(
    "agentloop_summary",
    {
      title: "AgentLoop summary",
      description: "Read-only loop health metrics (ticket and pattern counts).",
      inputSchema: {},
      annotations: readOnly,
    },
    async () => {
      try {
        return ok(await summaryTool(store));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "agentloop_list",
    {
      title: "List tickets",
      description:
        "Read-only list of tickets, optionally filtered by status (triaged|active|resolved|reopened|deferred|all) and kind.",
      inputSchema: {
        status: z.string().optional(),
        kind: z.string().optional(),
      },
      annotations: readOnly,
    },
    async (args) => {
      try {
        return ok(await listTool(store, args));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "agentloop_show",
    {
      title: "Show ticket or pattern",
      description:
        "Read-only details for a ticket (by canonical ISSUE- id or queue alias such as DEV-/USER-) or a PATTERN- id.",
      inputSchema: { id: z.string() },
      annotations: readOnly,
    },
    async (args) => {
      try {
        return ok(await showTool(store, args));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "agentloop_handoff",
    {
      title: "Ticket handoff prompt",
      description: "Read-only copyable agent handoff prompt for a ticket.",
      inputSchema: { id: z.string() },
      annotations: readOnly,
    },
    async (args) => {
      try {
        return ok(await handoffTool(store, args));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "agentloop_convergence",
    {
      title: "Source-convergence audit",
      description:
        "Read-only report of patterns whose tickets span multiple distinct sources (corroboration across intake channels).",
      inputSchema: {
        family: z.string().optional(),
        minSources: z.number().int().positive().optional(),
        includeAll: z.boolean().optional(),
      },
      annotations: readOnly,
    },
    async (args) => {
      try {
        return ok(await store.sourceConvergence(args));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "agentloop_guard_gaps",
    {
      title: "Guard-gap report",
      description:
        "Read-only report of resolved tickets that lack an active regression guard (defects/user reports by default).",
      inputSchema: {
        family: z.string().optional(),
        includeWaived: z.boolean().optional(),
        allKinds: z.boolean().optional(),
      },
      annotations: readOnly,
    },
    async (args) => {
      try {
        return ok(await store.guardGaps(args));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "agentloop_workflow_audit",
    {
      title: "Workflow consistency audit",
      description:
        "Read-only report of patterns whose status disagrees with their linked tickets: resolved patterns with active (or reopened) linked tickets, and active patterns whose linked tickets are all closed out.",
      inputSchema: {
        family: z.string().optional(),
      },
      annotations: readOnly,
    },
    async (args) => {
      try {
        return ok(await store.workflowAudit(args));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "agentloop_near_duplicates",
    {
      title: "Near-duplicate ticket audit",
      description:
        "Read-only report of ticket pairs whose titles/summaries overlap heavily — a likely sign the same problem was reported twice before it converged into a shared pattern. Scoped to open work (triaged/active/reopened/deferred) by default.",
      inputSchema: {
        family: z.string().optional(),
        minTextOverlap: z.number().optional(),
        includeResolved: z.boolean().optional(),
        limit: z.number().optional(),
      },
      annotations: readOnly,
    },
    async (args) => {
      try {
        return ok(await store.nearDuplicates(args));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "agentloop_search_knowledge",
    {
      title: "Search resolution knowledge",
      description:
        "Read-only search over resolved-ticket fix knowledge (how prior tickets were resolved), by family/kind/source/tag/free-text query.",
      inputSchema: {
        family: z.string().optional(),
        kind: z.string().optional(),
        source: z.string().optional(),
        tag: z.string().optional(),
        query: z.string().optional(),
        limit: z.number().int().nonnegative().optional(),
      },
      annotations: readOnly,
    },
    async (args) => {
      try {
        return ok(await store.searchKnowledge(args));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "agentloop_knowledge_gaps",
    {
      title: "Knowledge-gap report",
      description:
        "Read-only report of resolved tickets whose reusable knowledge is incomplete (missing resolution or verification).",
      inputSchema: {
        family: z.string().optional(),
        severity: z.string().optional(),
        source: z.string().optional(),
      },
      annotations: readOnly,
    },
    async (args) => {
      try {
        return ok(await store.knowledgeGaps(args));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "agentloop_related",
    {
      title: "Related tickets (prior art)",
      description:
        "Read-only prior-art lookup: tickets most related to the given id by shared family/pattern/tags/kind and title overlap.",
      inputSchema: {
        id: z.string(),
        minScore: z.number().nonnegative().optional(),
        limit: z.number().int().nonnegative().optional(),
      },
      annotations: readOnly,
    },
    async (args) => {
      try {
        return ok(await store.related(args.id, { minScore: args.minScore, limit: args.limit }));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "agentloop_prior_art_graph",
    {
      title: "Persisted prior-art graph (durable, decaying)",
      description:
        "Read-only lookup of a ticket's persisted prior-art edges — durable connections discovered by `agentloop_prior_art_refresh` that fade (decay) over time without fresh evidence, rather than being recomputed fresh on every call like agentloop_related.",
      inputSchema: {
        id: z.string(),
        minStrength: z.number().nonnegative().optional(),
        decayHalfLifeDays: z.number().positive().optional(),
        limit: z.number().int().nonnegative().optional(),
      },
      annotations: readOnly,
    },
    async (args) => {
      try {
        return ok(
          await store.priorArtGraph(args.id, {
            minStrength: args.minStrength,
            decayHalfLifeDays: args.decayHalfLifeDays,
            limit: args.limit,
          }),
        );
      } catch (error) {
        return fail(error);
      }
    },
  );

  if (options.allowWrites) {
    registerWriteTools(server, store);
  }

  return server;
}

/** Register the mutating tools. Only called when writes are explicitly enabled. */
function registerWriteTools(server: McpServer, store: AgentLoopStore): void {
  const write = { readOnlyHint: false } as const;

  server.registerTool(
    "agentloop_create",
    {
      title: "Create ticket",
      description:
        "Create a ticket. `summary` is required; `kind`/`family`/`source` default from config (source defaults to 'agent').",
      inputSchema: {
        summary: z.string().min(1),
        title: z.string().optional(),
        family: z.string().optional(),
        kind: z.string().optional(),
        source: z.string().optional(),
        severity: z.enum(SEVERITIES).optional(),
        confidence: z.enum(CONFIDENCES).optional(),
        tags: z.array(z.string()).optional(),
        handoff: z.string().optional(),
      },
      annotations: write,
    },
    async (args) => {
      try {
        return ok(await createTicketTool(store, args));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "agentloop_note",
    {
      title: "Add note",
      description: "Append a non-resolution note to a ticket (by id or alias).",
      inputSchema: {
        id: z.string(),
        body: z.string().min(1),
        type: z.enum(NOTE_TYPES).optional(),
        author: z.string().optional(),
      },
      annotations: write,
    },
    async (args) => {
      try {
        return ok(await noteTool(store, args));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "agentloop_workflow",
    {
      title: "Workflow transition",
      description:
        "Transition a ticket: status 'active' begins work, 'reopened' records a recurrence, 'deferred' shelves it (optional reason). Resolve via agentloop_resolve.",
      inputSchema: {
        id: z.string(),
        status: z.enum(WORKFLOW_STATUSES),
        reason: z.string().optional(),
      },
      annotations: write,
    },
    async (args) => {
      try {
        return ok(await workflowTool(store, args));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "agentloop_resolve",
    {
      title: "Resolve ticket",
      description:
        "Resolve a ticket with a required summary; optionally record verification and a guard decision.",
      inputSchema: {
        id: z.string(),
        summary: z.string().min(1),
        verification: z.string().optional(),
        guardStatus: z.enum(GUARD_STATUSES).optional(),
        guardSummary: z.string().optional(),
      },
      annotations: write,
    },
    async (args) => {
      try {
        return ok(await resolveTool(store, args));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "agentloop_guard",
    {
      title: "Record guard decision",
      description: "Set the regression-guard decision for a ticket (by id or alias).",
      inputSchema: {
        id: z.string(),
        guardStatus: z.enum(GUARD_STATUSES),
        guardSummary: z.string().optional(),
      },
      annotations: write,
    },
    async (args) => {
      try {
        return ok(await guardTool(store, args));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "agentloop_github_sync",
    {
      title: "Sync ticket to GitHub Issue",
      description:
        "Create or update the ticket's linked GitHub Issue (mirroring title/body/labels) and import new Issue comments as ticket notes. Requires github.repo in project config.",
      inputSchema: { id: z.string() },
      annotations: write,
    },
    async (args) => {
      try {
        return ok(await githubSyncTool(store, args));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "agentloop_prior_art_refresh",
    {
      title: "Refresh the persisted prior-art graph",
      description:
        "Recompute deterministic relatedness for every ticket pair and persist it as durable, decaying edges: pairs that still qualify are reinforced, pairs that no longer qualify fade in place, and edges decayed past the prune floor are dropped. Mutates and saves ledger state.",
      inputSchema: {
        minScore: z.number().nonnegative().optional(),
        decayHalfLifeDays: z.number().positive().optional(),
        pruneBelowStrength: z.number().nonnegative().optional(),
      },
      annotations: write,
    },
    async (args) => {
      try {
        return ok(
          await store.refreshPriorArtGraph({
            minScore: args.minScore,
            decayHalfLifeDays: args.decayHalfLifeDays,
            pruneBelowStrength: args.pruneBelowStrength,
          }),
        );
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "agentloop_workflow_repair",
    {
      title: "Repair pattern/ticket workflow drift",
      description:
        "Fix the drift `agentloop_workflow_audit` surfaces by flipping Pattern status to agree with its linked tickets: resolved patterns with active (or reopened) linked tickets reopen, and open/active/reopened patterns whose linked tickets are all closed out resolve. Pass `dryRun: true` to preview the plan without mutating anything; otherwise mutates and saves ledger state.",
      inputSchema: {
        family: z.string().optional(),
        dryRun: z.boolean().optional(),
      },
      annotations: write,
    },
    async (args) => {
      try {
        return ok(await store.repairWorkflow({ family: args.family, dryRun: args.dryRun }));
      } catch (error) {
        return fail(error);
      }
    },
  );
}

/**
 * Start the AgentLoops MCP server over stdio. Reads/writes JSON-RPC on
 * stdin/stdout, so nothing else may be written to stdout while it runs.
 */
export async function startStdioMcpServer(opts: {
  cwd: string;
  config: ProjectConfig;
  version?: string;
  allowWrites?: boolean;
  backend?: StateBackend;
}): Promise<void> {
  const store = new AgentLoopStore(opts.cwd, opts.config, { backend: opts.backend });
  await store.ensureInitialized();
  const server = createMcpServer(store, {
    version: opts.version,
    allowWrites: opts.allowWrites,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Stay alive until the client closes stdin, so callers can dispose resources
  // (e.g. a Postgres pool) cleanly on shutdown.
  await new Promise<void>((resolve) => {
    process.stdin.once("end", resolve);
    process.stdin.once("close", resolve);
  });
}
