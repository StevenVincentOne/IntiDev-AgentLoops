import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AgentLoopStore } from "./store";
import { buildHandoffPrompt } from "./handoff";
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
] as const satisfies readonly NoteType[];
export const GUARD_STATUSES = [
  "guard_added",
  "guard_existing",
  "guard_waived",
  "guard_deferred",
  "none",
] as const satisfies readonly GuardStatus[];
/** Workflow transitions exposed over MCP. `resolved` has its own tool. */
export const WORKFLOW_STATUSES = ["active", "reopened"] as const satisfies readonly TicketStatus[];

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
  } else {
    throw new Error(
      `Unsupported workflow status: ${args.status} (use active|reopened; resolve via agentloop_resolve)`,
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
        "Transition a ticket: status 'active' begins work, 'reopened' records a recurrence. Resolve via agentloop_resolve.",
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
}): Promise<void> {
  const store = new AgentLoopStore(opts.cwd, opts.config);
  await store.ensureInitialized();
  const server = createMcpServer(store, {
    version: opts.version,
    allowWrites: opts.allowWrites,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
