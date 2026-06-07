import {
  CreateTicketInput,
  GuardStatus,
  LoopState,
  NoteType,
  Pattern,
  PatternStatus,
  ProjectConfig,
  RedactionContext,
  ResolveInput,
  Ticket,
  TicketRedactor,
  TicketStatus,
} from "./types";
import { requiredFields } from "./config";
import { resolveRedactor } from "./redaction";
import { StateBackend, FilesystemStateBackend } from "./backend";
import { deriveAliases } from "./aliases";
import {
  sourceConvergenceReport,
  SourceConvergenceOptions,
  SourceConvergenceReport,
} from "./convergence";
import { guardGapReport, GuardGapOptions, GuardGapReport } from "./guards";
import { workflowAuditReport, WorkflowAuditOptions, WorkflowAuditReport } from "./workflow-audit";
import { nearDuplicateReport, NearDuplicateOptions, NearDuplicateReport } from "./near-duplicates";
import {
  resolutionKnowledge,
  knowledgeGaps,
  KnowledgeSearchOptions,
  ResolutionKnowledgeReport,
  KnowledgeGapsOptions,
  KnowledgeGapsReport,
} from "./knowledge";
import { relatedTickets, PriorArtOptions, PriorArtReport } from "./prior-art";
import {
  refreshPriorArtGraph,
  priorArtGraphForTicket,
  PriorArtGraphOptions,
  PriorArtGraphQueryOptions,
  PriorArtGraphRefreshSummary,
  PriorArtGraphReport,
} from "./prior-art-graph";
import {
  buildGithubIssuePayload,
  parseGithubIssueUrl,
  GithubClient,
  GithubIssue,
} from "./github";

export interface GithubSyncResult {
  ticket: Ticket;
  issue: GithubIssue;
  importedComments: number;
}

type StateEnvelope = LoopState;

const SEQ_PAD = 6;

function ticketId(seq: number) {
  return `ISSUE-${String(seq).padStart(SEQ_PAD, "0")}`;
}

function patternId(seq: number) {
  return `PATTERN-${String(seq).padStart(SEQ_PAD, "0")}`;
}

function edgeId(seq: number) {
  return `EDGE-${String(seq).padStart(SEQ_PAD, "0")}`;
}

function nowIso() {
  return new Date().toISOString();
}

export class AgentLoopStore {
  private state: StateEnvelope | null = null;
  private readonly backend: StateBackend;
  private readonly redactor: TicketRedactor;

  constructor(
    cwd: string,
    private readonly config: ProjectConfig,
    options: { redactor?: TicketRedactor; backend?: StateBackend } = {},
  ) {
    this.backend = options.backend ?? new FilesystemStateBackend(cwd);
    this.redactor = resolveRedactor(config, options.redactor);
  }

  private redact(value: string, context: RedactionContext): string {
    return this.redactor.redactText(value, context);
  }

  async ensureInitialized(project = this.config.projectName): Promise<LoopState> {
    if (this.state) {
      return this.state;
    }
    const loaded = await this.backend.load();
    if (!loaded) {
      this.state = {
        version: 1,
        project,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        nextTicketSeq: 0,
        nextPatternSeq: 0,
        nextPriorArtEdgeSeq: 0,
        tickets: [],
        patterns: [],
        priorArtEdges: [],
      };
      await this.persist();
      return this.state;
    }
    this.state = loaded;
    if (!this.state.project) {
      this.state.project = project;
    }
    // Backfill state persisted before the prior-art graph existed.
    if (!this.state.priorArtEdges) this.state.priorArtEdges = [];
    if (!this.state.nextPriorArtEdgeSeq) this.state.nextPriorArtEdgeSeq = 0;
    return this.state;
  }

  async createTicket(input: CreateTicketInput): Promise<Ticket> {
    const state = await this.ensureInitialized();
    const { title, summary, family, kind, source, severity, confidence, tags = [], handoffText } = input;
    const missing = requiredFields(this.config, kind).filter((field) => !input[field as keyof CreateTicketInput]);
    if (missing.length > 0) {
      throw new Error(`Missing required fields for ${kind}: ${missing.join(", ")}`);
    }
    const id = ticketId(++state.nextTicketSeq);
    const defaultKindConfig = this.config.ticketKinds.find((entry) => entry.kind === kind);
    const defaults = defaultKindConfig?.defaultSeverity ?? "medium";
    const c = this.nowState;
    const aliases = deriveAliases({ kind, source }, state.nextTicketSeq, this.config);
    const ctx = (field: string): RedactionContext => ({ field, ticketKind: kind, source });
    const ticket: Ticket = {
      id,
      family,
      kind,
      source,
      title: this.redact(title, ctx("title")),
      summary: this.redact(summary, ctx("summary")),
      severity: severity ?? defaults,
      confidence: confidence ?? "medium",
      status: "triaged",
      createdAt: c,
      updatedAt: c,
      aliases: Array.from(new Set(aliases)),
      tags: Array.from(new Set(tags)),
      notes: [],
      handoffText: handoffText ? this.redact(handoffText, ctx("handoffText")) : undefined,
      reproducible: true,
    };
    ticket.patternId = this.attachPattern(state, family, ticket.id);
    state.tickets.push(ticket);
    state.updatedAt = nowIso();
    await this.persist();
    return ticket;
  }

  async listTickets(opts: {
    status?: TicketStatus | "all";
    kind?: string;
  }): Promise<Ticket[]> {
    const state = await this.ensureInitialized();
    let rows = [...state.tickets];
    if (opts.status && opts.status !== "all") {
      rows = rows.filter((ticket) => ticket.status === opts.status);
    }
    if (opts.kind) {
      rows = rows.filter((ticket) => ticket.kind === opts.kind);
    }
    return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async listPatterns(opts: { status?: PatternStatus | "all" }): Promise<Pattern[]> {
    const state = await this.ensureInitialized();
    const rows = [...state.patterns];
    if (opts.status && opts.status !== "all") {
      return rows.filter((pattern) => pattern.status === opts.status).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
    return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getTicketByAnyId(rawId: string): Promise<Ticket | undefined> {
    const state = await this.ensureInitialized();
    const normalized = normalizeTicketInput(rawId, state.tickets);
    return state.tickets.find((ticket) => ticket.id === normalized);
  }

  async showTicket(rawId: string): Promise<Ticket | undefined> {
    return this.getTicketByAnyId(rawId);
  }

  async beginTicket(rawId: string): Promise<Ticket> {
    const ticket = await this.transitionTicket(rawId, "active");
    ticket.startedAt = nowIso();
    await this.persist();
    return ticket;
  }

  async resolveTicket(input: ResolveInput): Promise<Ticket> {
    const ticket = await this.transitionTicket(input.id, "resolved");
    const ctx = (field: string): RedactionContext => ({
      field,
      ticketKind: ticket.kind,
      source: ticket.source,
    });
    ticket.resolutionSummary = this.redact(input.summary, ctx("resolutionSummary"));
    ticket.verification = input.verification
      ? this.redact(input.verification, ctx("verification"))
      : undefined;
    ticket.resolvedAt = nowIso();
    ticket.guardStatus = input.guardStatus ?? "none";
    ticket.guardSummary = input.guardSummary
      ? this.redact(input.guardSummary, ctx("guardSummary"))
      : undefined;
    await this.persist();
    return ticket;
  }

  async reopenTicket(rawId: string, reason: string): Promise<Ticket> {
    const ticket = await this.transitionTicket(rawId, "reopened");
    ticket.notes.push({
      id: `${ticket.id}-note-${Date.now()}`,
      type: "hypothesis",
      body: `Reopened: ${this.redact(reason, this.noteCtx(ticket))}`,
      createdAt: nowIso(),
    });
    ticket.updatedAt = nowIso();
    await this.persist();
    return ticket;
  }

  async deferTicket(rawId: string, reason?: string): Promise<Ticket> {
    const ticket = await this.transitionTicket(rawId, "deferred");
    if (reason) {
      ticket.notes.push({
        id: `${ticket.id}-note-${Date.now()}`,
        type: "triage",
        body: `Deferred: ${this.redact(reason, this.noteCtx(ticket))}`,
        createdAt: nowIso(),
      });
    }
    ticket.updatedAt = nowIso();
    await this.persist();
    return ticket;
  }

  async addTicketNote(rawId: string, type: NoteType, body: string, author?: string): Promise<Ticket> {
    const ticket = await this.transitionTicket(rawId, undefined);
    ticket.notes.push({
      id: `${ticket.id}-note-${Date.now()}`,
      type,
      body: this.redact(body, this.noteCtx(ticket)),
      author,
      createdAt: nowIso(),
    });
    ticket.updatedAt = nowIso();
    await this.persist();
    return ticket;
  }

  async setGuard(rawId: string, status: GuardStatus, summary?: string): Promise<Ticket> {
    const ticket = await this.transitionTicket(rawId, undefined);
    ticket.guardStatus = status;
    ticket.guardSummary = summary
      ? this.redact(summary, { field: "guardSummary", ticketKind: ticket.kind, source: ticket.source })
      : undefined;
    await this.persist();
    return ticket;
  }

  private noteCtx(ticket: Ticket): RedactionContext {
    return { field: "note", ticketKind: ticket.kind, source: ticket.source };
  }

  /** Manually link a ticket to an existing GitHub Issue by its web URL. */
  async linkGithubIssue(rawId: string, issueUrl: string): Promise<Ticket> {
    const parsed = parseGithubIssueUrl(issueUrl);
    if (!parsed) {
      throw new Error(`Not a GitHub issue URL: ${issueUrl}`);
    }
    const ticket = await this.transitionTicket(rawId, undefined);
    ticket.github = {
      issueUrl,
      issueNumber: parsed.number,
      lastSyncedAt: ticket.github?.lastSyncedAt,
      lastSyncedCommentId: ticket.github?.lastSyncedCommentId,
    };
    ticket.updatedAt = nowIso();
    await this.persist();
    return ticket;
  }

  /**
   * Sync a ticket onto its linked GitHub Issue (creating one on first sync),
   * mirroring title/body/labels, then import any new Issue comments as ticket
   * notes (redacted, since they originate externally). Tickets remain the
   * richer agent-memory layer — the Issue is a mirror, not the source of truth.
   */
  async syncGithubIssue(rawId: string, client: GithubClient): Promise<GithubSyncResult> {
    const repo = this.config.github?.repo;
    if (!repo) {
      throw new Error("GitHub sync is not configured: set `github.repo` in agentloop.config.json");
    }
    const ticket = await this.transitionTicket(rawId, undefined);
    const payload = buildGithubIssuePayload(ticket, this.config);
    const issue = ticket.github?.issueNumber
      ? await client.updateIssue(repo, ticket.github.issueNumber, payload)
      : await client.createIssue(repo, payload);

    const comments = await client.listComments(repo, issue.number, {
      sinceId: ticket.github?.lastSyncedCommentId,
    });
    let lastSyncedCommentId = ticket.github?.lastSyncedCommentId;
    for (const comment of comments) {
      ticket.notes.push({
        id: `${ticket.id}-note-${Date.now()}-${comment.id}`,
        type: "external",
        body: this.redact(
          `GitHub comment${comment.author ? ` by ${comment.author}` : ""}: ${comment.body}`,
          this.noteCtx(ticket),
        ),
        author: comment.author,
        createdAt: comment.createdAt,
      });
      lastSyncedCommentId = comment.id;
    }

    ticket.github = {
      issueUrl: issue.htmlUrl,
      issueNumber: issue.number,
      lastSyncedAt: nowIso(),
      lastSyncedCommentId,
    };
    ticket.updatedAt = nowIso();
    await this.persist();
    return { ticket, issue, importedComments: comments.length };
  }

  async resolvePattern(patternId: string, note: string): Promise<Pattern> {
    const state = await this.ensureInitialized();
    const pattern = state.patterns.find((entry) => entry.id === patternId);
    if (!pattern) {
      throw new Error(`Pattern not found: ${patternId}`);
    }
    if (pattern.status !== "resolved") {
      pattern.status = "resolved";
      pattern.updatedAt = nowIso();
      if (note) {
        pattern.title = `${pattern.title} (resolved: ${note})`;
      }
    }
    state.updatedAt = nowIso();
    await this.persist();
    return pattern;
  }

  async summary() {
    const state = await this.ensureInitialized();
    return {
      project: state.project,
      totalTickets: state.tickets.length,
      activeTickets: state.tickets.filter((t) => t.status === "active").length,
      triagedTickets: state.tickets.filter((t) => t.status === "triaged").length,
      resolvedTickets: state.tickets.filter((t) => t.status === "resolved").length,
      reopenedTickets: state.tickets.filter((t) => t.status === "reopened").length,
      deferredTickets: state.tickets.filter((t) => t.status === "deferred").length,
      openPatterns: state.patterns.filter((p) => p.status === "active").length,
      stalledPatterns: state.patterns.filter((p) => p.status === "open").length,
      resolvedPatterns: state.patterns.filter((p) => p.status === "resolved").length,
    };
  }

  async getPattern(id: string): Promise<Pattern | undefined> {
    const state = await this.ensureInitialized();
    return state.patterns.find((entry) => entry.id === id);
  }

  getConfig(): ProjectConfig {
    return this.config;
  }

  async sourceConvergence(
    options: SourceConvergenceOptions = {},
  ): Promise<SourceConvergenceReport> {
    const state = await this.ensureInitialized();
    return sourceConvergenceReport(state.tickets, state.patterns, options);
  }

  async guardGaps(options: GuardGapOptions = {}): Promise<GuardGapReport> {
    const state = await this.ensureInitialized();
    return guardGapReport(state.tickets, this.config, options);
  }

  async workflowAudit(options: WorkflowAuditOptions = {}): Promise<WorkflowAuditReport> {
    const state = await this.ensureInitialized();
    return workflowAuditReport(state.tickets, state.patterns, options);
  }

  async nearDuplicates(options: NearDuplicateOptions = {}): Promise<NearDuplicateReport> {
    const state = await this.ensureInitialized();
    return nearDuplicateReport(state.tickets, options);
  }

  async searchKnowledge(
    options: KnowledgeSearchOptions = {},
  ): Promise<ResolutionKnowledgeReport> {
    const state = await this.ensureInitialized();
    return resolutionKnowledge(state.tickets, options);
  }

  async knowledgeGaps(options: KnowledgeGapsOptions = {}): Promise<KnowledgeGapsReport> {
    const state = await this.ensureInitialized();
    return knowledgeGaps(state.tickets, options);
  }

  async related(rawId: string, options: PriorArtOptions = {}): Promise<PriorArtReport> {
    const state = await this.ensureInitialized();
    const targetId = normalizeTicketInput(rawId, state.tickets);
    const configured = this.config.priorArt;
    return relatedTickets(targetId, state.tickets, {
      weights: { ...configured?.weights, ...options.weights },
      minScore: options.minScore ?? configured?.minScore,
      limit: options.limit,
    });
  }

  /**
   * Recompute the durable prior-art graph and persist it (write — mutates and
   * saves state). Reinforces edges whose pairs still score, lets edges that
   * no longer qualify decay in place, and prunes edges that have decayed past
   * the configured floor. See `prior-art-graph.ts` for the full mechanic.
   */
  async refreshPriorArtGraph(options: PriorArtGraphOptions = {}): Promise<PriorArtGraphRefreshSummary> {
    const state = await this.ensureInitialized();
    const configured = this.config.priorArtGraph;
    const { edges, summary } = refreshPriorArtGraph(
      state.tickets,
      state.priorArtEdges,
      () => edgeId(++state.nextPriorArtEdgeSeq),
      {
        weights: options.weights,
        minScore: options.minScore ?? configured?.minScore,
        decayHalfLifeDays: options.decayHalfLifeDays ?? configured?.decayHalfLifeDays,
        pruneBelowStrength: options.pruneBelowStrength ?? configured?.pruneBelowStrength,
        now: options.now,
      },
    );
    state.priorArtEdges = edges;
    state.updatedAt = nowIso();
    await this.persist();
    return summary;
  }

  /**
   * Look up a ticket's persisted prior-art edges (durable, decaying — distinct
   * from `related`'s on-the-fly relatedness). Decay is applied at query time,
   * so `strength` reflects "how related as of right now," not just as of the
   * last `refreshPriorArtGraph`. Read-only: never mutates or persists.
   */
  async priorArtGraph(rawId: string, options: PriorArtGraphQueryOptions = {}): Promise<PriorArtGraphReport> {
    const state = await this.ensureInitialized();
    const targetId = normalizeTicketInput(rawId, state.tickets);
    const configured = this.config.priorArtGraph;
    return priorArtGraphForTicket(targetId, state.tickets, state.priorArtEdges, {
      decayHalfLifeDays: options.decayHalfLifeDays ?? configured?.decayHalfLifeDays,
      minStrength: options.minStrength,
      limit: options.limit,
    });
  }

  // Resolves an id/alias and optionally applies a status change. Does NOT
  // persist — callers mutate further (notes, timestamps, resolution fields) and
  // persist once when done, so those mutations are never lost.
  private async transitionTicket(rawId: string, status?: TicketStatus): Promise<Ticket> {
    const state = await this.ensureInitialized();
    const targetId = normalizeTicketInput(rawId, state.tickets);
    const ticket = state.tickets.find((entry) => entry.id === targetId);
    if (!ticket) {
      throw new Error(`Ticket not found: ${rawId}`);
    }
    if (status && ticket.status !== status) {
      ticket.status = status;
      ticket.updatedAt = nowIso();
    }
    return ticket;
  }

  private attachPattern(state: LoopState, family: string, ticketId: string): string | undefined {
    if (!this.config.patterns.autoCreateByFamily) {
      return undefined;
    }
    const normalizedFamily = family || this.config.patterns.defaultFamily;
    let pattern = state.patterns.find((entry) => entry.family === normalizedFamily && entry.status !== "resolved");
    if (!pattern) {
      pattern = {
        id: patternId(++state.nextPatternSeq),
        family: normalizedFamily,
        title: `Recurring ${normalizedFamily} issues`,
        status: "open",
        createdAt: nowIso(),
        updatedAt: nowIso(),
        ticketIds: [],
      };
      state.patterns.push(pattern);
    }
    if (!pattern.ticketIds.includes(ticketId)) {
      pattern.ticketIds.push(ticketId);
      if (pattern.ticketIds.length >= 2) {
        pattern.status = "active";
      }
    }
    pattern.updatedAt = nowIso();
    return pattern.id;
  }

  private async persist() {
    if (!this.state) {
      return;
    }
    this.state.updatedAt = nowIso();
    await this.backend.save(this.state);
  }

  private get nowState() {
    return nowIso();
  }
}

export function normalizeTicketInput(raw: string, tickets: Ticket[]): string {
  const normalized = raw.toUpperCase();
  const match = /^([A-Z]+)-(\d{1,})$/.exec(normalized);
  if (!match) {
    return raw.toUpperCase();
  }
  const prefix = match[1];
  const seq = match[2];
  const canonical = `ISSUE-${seq}`;
  if (prefix === "ISSUE") {
    return canonical;
  }
  const found = tickets.find((ticket) => ticket.aliases.includes(`${prefix}-${seq}`));
  if (found) {
    return found.id;
  }
  return canonical;
}
