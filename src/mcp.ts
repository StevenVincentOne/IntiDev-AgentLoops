import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AgentLoopStore } from "./store";
import { StateBackend } from "./backend";
import { buildHandoffPrompt } from "./handoff";
import { resolveGithubTarget } from "./github";
import { RelatedTicket, shouldSurfacePriorArt } from "./prior-art";
import {
  Confidence,
  GuardStatus,
  NoteType,
  Pattern,
  PriorArtAuditResult,
  PriorArtHint,
  PriorArtTrustLevel,
  ProjectConfig,
  RootCauseCertificate,
  Severity,
  Ticket,
  TicketKind,
  TicketSweepResult,
  TicketStatus,
  VerificationBrief,
} from "./types";
import { CascadeResolveResult } from "./verification";

/**
 * Mirrors `VerificationBrief` for MCP input validation. Required for
 * resolutions that fall in a configured evidence-sensitive domain/kind (see
 * `ProjectConfig.verification` and `docs/agent-integration.md`): deterministic
 * rules check that the brief is present and internally coherent; the agent's
 * `agentJudgment`/`reason` supply the actual sufficiency call rules cannot make.
 */
const verificationBriefSchema = z.object({
  claimScope: z.enum(["single_ticket", "group", "pattern", "cascade"]),
  affectedArtifactIds: z.array(z.string()).optional(),
  reportedLocations: z.array(z.string()).optional(),
  verificationPerformed: z.array(z.string()).min(1),
  coverage: z.string().min(1),
  agentJudgment: z.string().min(1),
  reason: z.string().min(1),
});

/**
 * Mirrors `RootCauseCertificate` for MCP input validation. Required for
 * meaningful fixed bug/incident/user-feedback resolutions (see
 * `ProjectConfig.rootCause`): deterministic rules check the certificate is
 * present and that required fields are not TODO-placeholders; the agent
 * remains responsible for the architectural correctness of the diagnosis.
 *
 * Generate a scaffold: `agentloop evidence-draft <id> --evidence-only`
 */
const rootCauseCertificateSchema = z.object({
  symptom: z.string().min(1).describe("The visible failure symptom as experienced by a user or detector"),
  rootCause: z.string().min(1).describe("The code-level or architecture-level root cause — not a restatement of the symptom"),
  earliestFailureStage: z.string().min(1).describe("The earliest stage where correct data became incorrect or unavailable"),
  whySourceLevelFixOrWhyNot: z.string().min(1).describe("Why the fix is at the earliest responsible layer, or why a downstream fix was chosen"),
  affectedContractOrInvariant: z.string().min(1).describe("The contract or invariant that failed"),
  filesChanged: z.array(z.string()).min(1).describe("Source files changed, or ['none: <reason>'] if no files changed"),
  guardDecision: z.string().min(1).describe("Names the guard added/existing/waived/deferred and why it catches recurrence"),
  regressionRisk: z.string().min(1).describe("Regression risk: low|medium|high|critical|none"),
});

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
  /**
   * Populated only on `created`, and only when `priorArtHint` suggests the
   * reporter believes prior art may already exist ("previously ticketed" /
   * "existing pattern" / "adjacent issues"): candidates from an auto-run
   * `relatedTickets` check against the new ticket, so the reporter/agent can
   * confirm or rule out a match ("did you mean ISSUE-000042?") right at
   * intake — the AgentLoops-native enhancement over a hint that's merely
   * stored for later human review.
   */
  priorArtSuggestions?: RelatedTicket[];
}

export const PRIOR_ART_HINTS = [
  "new",
  "previously_ticketed",
  "existing_pattern",
  "adjacent_issues",
] as const satisfies readonly PriorArtHint[];

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
    priorArtHint?: PriorArtHint;
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
    priorArtHint: args.priorArtHint,
  });

  let priorArtSuggestions: RelatedTicket[] | undefined;
  if (shouldSurfacePriorArt(args.priorArtHint)) {
    const related = await store.related(ticket.id, { limit: 5 });
    if (related.related.length > 0) {
      priorArtSuggestions = related.related;
    }
  }

  return {
    ...envelope(),
    action: "created",
    ticket,
    ...(priorArtSuggestions ? { priorArtSuggestions } : {}),
  };
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
    guardCommand?: string;
    guardArtifactRef?: string;
    guardDetectorKey?: string;
    verificationBrief?: VerificationBrief;
    rootCauseCertificate?: RootCauseCertificate;
  },
): Promise<WriteResult> {
  const ticket = await store.resolveTicket({
    id: args.id,
    summary: args.summary,
    verification: args.verification,
    guardStatus: args.guardStatus ?? "none",
    guardSummary: args.guardSummary,
    guardCommand: args.guardCommand,
    guardArtifactRef: args.guardArtifactRef,
    guardDetectorKey: args.guardDetectorKey,
    verificationBrief: args.verificationBrief,
    rootCauseCertificate: args.rootCauseCertificate,
  });
  return { ...envelope(), action: "resolved", ticket };
}

export interface ResolvePatternToolResult extends Envelope {
  action: "resolved_pattern";
  pattern: Pattern;
  resolvedTickets: Ticket[];
  alreadyResolvedTickets: Ticket[];
  escalatedVerification: boolean;
}

/**
 * Resolves a Pattern and cascades the same resolution evidence to its
 * not-yet-resolved linked tickets — the multi-ticket counterpart to
 * `agentloop_resolve` (generalized from Inti's `resolve-pattern --resolve-linked`).
 * `escalatedVerification` reports whether ≥ 2 linked tickets fell in a
 * configured evidence-sensitive domain/kind, which escalates the
 * fresh-evidence and broad-coverage requirements for all of them — "Pattern/
 * group cascade resolution should require stronger coverage than single-ticket
 * resolution," precisely the guardrail the originating bug lacked.
 */
export async function resolvePatternTool(
  store: AgentLoopStore,
  args: {
    id: string;
    summary: string;
    verification?: string;
    guardStatus?: GuardStatus;
    guardSummary?: string;
    verificationBrief?: VerificationBrief;
  },
): Promise<ResolvePatternToolResult> {
  const result: CascadeResolveResult = await store.cascadeResolvePattern({
    patternId: args.id,
    summary: args.summary,
    verification: args.verification,
    guardStatus: args.guardStatus ?? "none",
    guardSummary: args.guardSummary,
    verificationBrief: args.verificationBrief,
  });
  return {
    ...envelope(),
    action: "resolved_pattern",
    pattern: result.pattern,
    resolvedTickets: result.resolvedTickets,
    alreadyResolvedTickets: result.alreadyResolvedTickets,
    escalatedVerification: result.escalatedVerification,
  };
}

export interface SweepToolResult extends Envelope {
  kind: "sweep";
  result: TicketSweepResult;
}

export interface ClassifySiblingsToolResult extends Envelope {
  action: "classified_siblings";
  seedId: string;
  classified: Array<{ ticketId: string; category: string }>;
  linkedSameRoot: boolean;
}

export interface PriorArtAuditToolResult extends Envelope {
  kind: "prior_art_audit";
  result: PriorArtAuditResult;
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
    "agentloop_ticket_groups",
    {
      title: "Ticket Groups (triage clusters)",
      description:
        "Read-only report clustering open work into broad triage Groups — 'worth reviewing together,' explicitly not resolution objects — distinct from curated Patterns. Built-in bases are family, shared tags, and auto-detected recurring keywords; project-specific clustering vocabulary can be added via the ticketGroups.customRules config (e.g. a known error-code list or an embedded correlation key) without this tool needing to understand the domain. Each group also surfaces 'candidate splits': narrower sub-clusters worth reviewing as their own Group/Pattern before assuming the whole cluster shares one cause.",
      inputSchema: {
        family: z.string().optional(),
        minSize: z.number().int().positive().optional(),
        limit: z.number().int().positive().optional(),
      },
      annotations: readOnly,
    },
    async (args) => {
      try {
        return ok(await store.ticketGroups(args));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "agentloop_begin_group",
    {
      title: "Begin a Ticket Group (workbench + Pattern discovery)",
      description:
        "Read-only 'begin before you build' report for a computed Ticket Group: identifies the group by key (from agentloop_ticket_groups, e.g. 'family:export_pipeline'), aggregates cross-member prior art via the same scoring agentloop_related uses, looks up active/historical Patterns and resolution knowledge in the group's dominant family, and surfaces ranked hypotheses (with a confidence and a recommendation — compare_prior_art / split_group / promote_group / treat_as_workbench) about whether the group is a duplicate of known work, one coherent Pattern, several narrower ones, or just a triage convenience. Run this before implementing fixes for a Group's members.",
      inputSchema: {
        id: z.string().describe("The Group's key, e.g. 'family:export_pipeline' (see agentloop_ticket_groups)"),
        relatedLimit: z.number().int().positive().optional().describe("Cap on related candidates considered per member ticket"),
        priorArtLimit: z.number().int().positive().optional().describe("Cap on aggregated prior-art / family-knowledge entries returned"),
        ticketLimit: z.number().int().positive().optional().describe("Cap on how many group members fan out through agentloop_related"),
      },
      annotations: readOnly,
    },
    async (args) => {
      try {
        return ok(
          await store.beginGroup(args.id, {
            relatedLimit: args.relatedLimit,
            priorArtLimit: args.priorArtLimit,
            ticketLimit: args.ticketLimit,
          }),
        );
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

  server.registerTool(
    "agentloop_sweep",
    {
      title: "Symptom-family sweep",
      description:
        "Read-only symptom-family sweep for a seed ticket. Searches open and resolved tickets in the same family (and across " +
        "families) for candidates sharing the seed's symptom tokens; classifies them into 'likely same symptom' vs 'adjacent / " +
        "different root cause' vs 'historical prior art' buckets; and emits rootCauseBuckets as prompts for agent classification. " +
        "Run this between investigation and resolution for any definable symptom — the result is a flow regulator, not a verdict. " +
        "Persist your classifications with agentloop_classify_siblings.",
      inputSchema: {
        id: z.string().describe("Ticket id or alias of the seed ticket"),
        candidateLimit: z.number().int().positive().optional().describe("Max candidates per bucket (default 20)"),
        priorArtLimit: z.number().int().positive().optional().describe("Max historical prior-art entries (default 15)"),
        patternLimit: z.number().int().positive().optional().describe("Max pattern matches (default 10)"),
      },
      annotations: readOnly,
    },
    async (args) => {
      try {
        const result = await store.sweep(args.id, {
          candidateLimit: args.candidateLimit,
          priorArtLimit: args.priorArtLimit,
          patternLimit: args.patternLimit,
        });
        return ok({ ...envelope(), kind: "sweep" as const, result });
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
        "Create a ticket. `summary` is required; `kind`/`family`/`source` default from config (source defaults to 'agent'). " +
        "Optional `priorArtHint` records the reporter's intake-time self-assessment of whether this looks new or " +
        "connects to existing work ('History context'); when it's 'previously_ticketed', 'existing_pattern', or " +
        "'adjacent_issues', AgentLoops auto-runs a prior-art check against the new ticket and returns candidates " +
        "as `priorArtSuggestions` so you can confirm or rule out a match right away.",
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
        priorArtHint: z.enum(PRIOR_ART_HINTS).optional(),
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
        "Resolve a ticket with a required summary; optionally record verification and a guard decision. " +
        "Tickets in a configured evidence-sensitive family/kind (see config.verification, docs/agent-integration.md) " +
        "additionally require `verificationBrief` — a structured account of what was verified, what scope was claimed, " +
        "what coverage was achieved, and why that evidence is sufficient (`agentJudgment`/`reason`). Deterministic rules " +
        "check the brief is present and internally coherent (e.g. naming known affected ids, requiring fresh/end-to-end " +
        "evidence for recurrences); the agent's judgment is what actually proves sufficiency. Raw commands/logs alone do not satisfy this.",
      inputSchema: {
        id: z.string(),
        summary: z.string().min(1),
        verification: z.string().optional(),
        guardStatus: z.enum(GUARD_STATUSES).optional(),
        guardSummary: z.string().optional(),
        guardCommand: z.string().optional().describe("Concrete test/smoke command serving as the regression guard, e.g. 'npm test -- --grep ...'"),
        guardArtifactRef: z.string().optional().describe("Artifact path (test file, spec, detector config) referenced by the guard"),
        guardDetectorKey: z.string().optional().describe("Stable detector/rule key that would catch recurrence"),
        verificationBrief: verificationBriefSchema
          .optional()
          .describe(
            "Required for evidence-sensitive resolutions: { claimScope, affectedArtifactIds?, reportedLocations?, " +
              "verificationPerformed, coverage, agentJudgment, reason }. See docs/agent-integration.md for the full shape and philosophy.",
          ),
        rootCauseCertificate: rootCauseCertificateSchema
          .optional()
          .describe(
            "Required for meaningful fixed bug/incident/user-feedback resolutions (see config.rootCause): " +
              "{ symptom, rootCause, earliestFailureStage, whySourceLevelFixOrWhyNot, affectedContractOrInvariant, " +
              "filesChanged, guardDecision, regressionRisk }. Generate a scaffold: agentloop evidence-draft <id> --evidence-only",
          ),
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
    "agentloop_resolve_pattern",
    {
      title: "Resolve a Pattern and cascade to its linked tickets",
      description:
        "Resolve a Pattern and apply the same resolution narrative/evidence to every not-yet-resolved ticket linked to it " +
        "(the multi-ticket counterpart to agentloop_resolve — generalized from Inti's `resolve-pattern --resolve-linked`). " +
        "This is exactly the kind of operation that can close several tickets on weak evidence: before applying it, " +
        "AgentLoops counts how many linked tickets fall in a configured evidence-sensitive domain/kind, and when ≥ 2 do, " +
        "escalates the fresh-evidence and broad-coverage requirements for ALL of them regardless of the brief's own claimed " +
        "scope (`escalatedVerification` reports whether this happened) — guardrails the originating bug lacked, when a single " +
        "narrow replay was accepted as proof for a whole multi-ticket Pattern. Validation runs for every linked ticket before " +
        "any mutation, so a bad cascade fails atomically. Mutates and saves ledger state.",
      inputSchema: {
        id: z.string().describe("Pattern id, e.g. 'PATTERN-000007' (see agentloop_list / agentloop_show)"),
        summary: z.string().min(1),
        verification: z.string().optional(),
        guardStatus: z.enum(GUARD_STATUSES).optional(),
        guardSummary: z.string().optional(),
        verificationBrief: verificationBriefSchema
          .optional()
          .describe(
            "Required when ≥ 1 linked ticket is evidence-sensitive; checked against the escalated rules when ≥ 2 are. " +
              "Use claimScope 'pattern' or 'cascade' and broad-coverage language (e.g. 'all reported instances', " +
              "'every linked ticket') for genuine multi-ticket claims. See docs/agent-integration.md.",
          ),
      },
      annotations: write,
    },
    async (args) => {
      try {
        return ok(await resolvePatternTool(store, args));
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
    "agentloop_promote_group",
    {
      title: "Promote a Ticket Group to a Pattern",
      description:
        "Promote a computed Ticket Group (identified by key, e.g. 'family:export_pipeline' — see agentloop_ticket_groups, and inspect it first with agentloop_begin_group) to a Pattern: finds-or-reuses a non-resolved Pattern in the group's dominant family, links member tickets that aren't linked yet (reusing the existing patternId/ticketIds idiom), records human-readable provenance in the Pattern's `summary` (which Group it came from, its basis, candidate splits), and appends a `related_history` note to each newly-linked ticket. Idempotent — safe to re-run as a Group's membership grows. Mutates and saves ledger state.",
      inputSchema: {
        id: z.string().describe("The Group's key, e.g. 'family:export_pipeline' (see agentloop_ticket_groups)"),
        title: z.string().optional().describe("Override the Pattern title (defaults to 'Recurring <group title> tickets')"),
        summary: z.string().optional().describe("Override the Pattern summary (defaults to a composed provenance description)"),
        family: z.string().optional().describe("Override the Pattern family (defaults to the group's dominant member family)"),
        actor: z.string().optional().describe("Attribution for the linking notes recorded on newly-linked tickets (defaults to 'agent')"),
      },
      annotations: write,
    },
    async (args) => {
      try {
        return ok(
          await store.promoteGroup(args.id, {
            title: args.title,
            summary: args.summary,
            family: args.family,
            actor: args.actor,
          }),
        );
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

  server.registerTool(
    "agentloop_classify_siblings",
    {
      title: "Persist sibling ticket classifications",
      description:
        "Persist sibling classifications from a symptom-family sweep or manual triage onto the seed ticket and its reviewed siblings. " +
        "Each sibling receives a triage note recording whether it is same_root, adjacent, unverified, or unrelated to the seed. " +
        "The seed ticket receives a summary triage note listing all reviewed siblings. " +
        "Use this after agentloop_sweep to make sweep decisions durable before resolving the seed. " +
        "Mutates and saves ledger state.",
      inputSchema: {
        seedId: z.string().describe("Ticket id or alias of the seed (the ticket being fixed)"),
        sameRoot: z
          .array(z.string())
          .optional()
          .describe("Ticket ids confirmed to share the exact same root cause as the seed"),
        adjacent: z
          .array(z.string())
          .optional()
          .describe("Ticket ids with a related but distinct root cause — keep open"),
        unverified: z
          .array(z.string())
          .optional()
          .describe("Ticket ids reviewed but inconclusive — more investigation needed"),
        unrelated: z
          .array(z.string())
          .optional()
          .describe("Ticket ids confirmed unrelated to the seed symptom"),
        reason: z
          .string()
          .optional()
          .describe("Optional free-text rationale recorded on the seed's summary note"),
        linkSameRoot: z
          .boolean()
          .optional()
          .describe(
            "If true, also record a related_history note on each same-root sibling (default false)",
          ),
      },
      annotations: write,
    },
    async (args) => {
      try {
        return ok(
          await store.classifySiblings({
            seedId: args.seedId,
            sameRoot: args.sameRoot,
            adjacent: args.adjacent,
            unverified: args.unverified,
            unrelated: args.unrelated,
            reason: args.reason,
            linkSameRoot: args.linkSameRoot,
          }),
        );
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "agentloop_prior_art_audit",
    {
      title: "Audit and annotate prior-art trust on resolved tickets",
      description:
        "Heuristic audit of resolved tickets whose verification may be stale, too brief, or provisional. " +
        "Returns an audit report with a recommended trust level (trusted/provisional/suspect/deprecated) for each candidate. " +
        "Without --apply this is a read-only preview. " +
        "With apply: true, each candidate's priorArtTrust metadata is written and a triage note is appended. " +
        "Use after a code-base overhaul, dependency upgrade, or when sweep surfaces many prior-art candidates with stale evidence. " +
        "Optionally scope to a single family or a cutoff date.",
      inputSchema: {
        apply: z
          .boolean()
          .optional()
          .describe("If true, write the recommended trust level and a triage note onto each audited ticket. Default false (preview only)."),
        family: z.string().optional().describe("Limit audit to tickets in this family"),
        cutoffDate: z
          .string()
          .optional()
          .describe("ISO date string — only tickets resolved before this date are audited"),
        addNote: z
          .boolean()
          .optional()
          .describe("If true (and apply is true), append a triage note to each audited ticket explaining the trust decision. Default true."),
        trustLevel: z
          .enum(["trusted", "provisional", "suspect", "deprecated"])
          .optional()
          .describe("Override: force this trust level on all audited tickets instead of computing a recommendation per-ticket"),
      },
      annotations: write,
    },
    async (args) => {
      try {
        return ok(
          await store.priorArtAudit({
            apply: args.apply,
            family: args.family,
            cutoffDate: args.cutoffDate,
            addNote: args.addNote,
            trustLevel: args.trustLevel as PriorArtTrustLevel | undefined,
          }),
        );
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
