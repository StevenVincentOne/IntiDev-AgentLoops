import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AgentLoopStore } from "./store";
import { buildHandoffPrompt } from "./handoff";
import { Pattern, ProjectConfig, Ticket, TicketStatus } from "./types";

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

/**
 * Build an MCP server exposing the read-only AgentLoops tools over the given
 * store. Write tools are intentionally omitted in this phase.
 */
export function createMcpServer(store: AgentLoopStore, version = "0.1.0"): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version });
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

  return server;
}

/**
 * Start the AgentLoops MCP server over stdio. Reads/writes JSON-RPC on
 * stdin/stdout, so nothing else may be written to stdout while it runs.
 */
export async function startStdioMcpServer(opts: {
  cwd: string;
  config: ProjectConfig;
  version?: string;
}): Promise<void> {
  const store = new AgentLoopStore(opts.cwd, opts.config);
  await store.ensureInitialized();
  const server = createMcpServer(store, opts.version);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
