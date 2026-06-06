import { promises as fs } from "fs";
import { existsSync } from "fs";
import { join } from "path";
import {
  CreateTicketInput,
  GuardStatus,
  LoopState,
  NoteType,
  Pattern,
  PatternStatus,
  ProjectConfig,
  ResolveInput,
  Ticket,
  TicketStatus,
} from "./types";
import { requiredFields } from "./config";
import { deriveAliases } from "./aliases";
import {
  sourceConvergenceReport,
  SourceConvergenceOptions,
  SourceConvergenceReport,
} from "./convergence";

type StateEnvelope = LoopState;

const STATE_FILE_NAME = "state.json";
const SEQ_PAD = 6;

function ticketId(seq: number) {
  return `ISSUE-${String(seq).padStart(SEQ_PAD, "0")}`;
}

function patternId(seq: number) {
  return `PATTERN-${String(seq).padStart(SEQ_PAD, "0")}`;
}

function nowIso() {
  return new Date().toISOString();
}

export class AgentLoopStore {
  private statePath: string;
  private state: StateEnvelope | null = null;

  constructor(
    private readonly cwd: string,
    private readonly config: ProjectConfig,
  ) {
    this.statePath = join(cwd, ".agentloops", STATE_FILE_NAME);
  }

  async ensureInitialized(project = this.config.projectName): Promise<LoopState> {
    if (this.state) {
      return this.state;
    }
    await fs.mkdir(join(this.cwd, ".agentloops"), { recursive: true });
    const exists = existsSync(this.statePath);
    if (!exists) {
      this.state = {
        version: 1,
        project,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        nextTicketSeq: 0,
        nextPatternSeq: 0,
        tickets: [],
        patterns: [],
      };
      await this.persist();
      return this.state;
    }
    const text = await fs.readFile(this.statePath, "utf-8");
    this.state = JSON.parse(text) as StateEnvelope;
    if (!this.state.project) {
      this.state.project = project;
    }
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
    const ticket: Ticket = {
      id,
      family,
      kind,
      source,
      title,
      summary,
      severity: severity ?? defaults,
      confidence: confidence ?? "medium",
      status: "triaged",
      createdAt: c,
      updatedAt: c,
      aliases: Array.from(new Set(aliases)),
      tags: Array.from(new Set(tags)),
      notes: [],
      handoffText,
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
    return ticket;
  }

  async resolveTicket(input: ResolveInput): Promise<Ticket> {
    const ticket = await this.transitionTicket(input.id, "resolved");
    ticket.resolutionSummary = input.summary;
    ticket.verification = input.verification;
    ticket.resolvedAt = nowIso();
    ticket.guardStatus = input.guardStatus ?? "none";
    ticket.guardSummary = input.guardSummary;
    return ticket;
  }

  async reopenTicket(rawId: string, reason: string): Promise<Ticket> {
    const ticket = await this.transitionTicket(rawId, "reopened");
    ticket.notes.push({
      id: `${ticket.id}-note-${Date.now()}`,
      type: "hypothesis",
      body: `Reopened: ${reason}`,
      createdAt: nowIso(),
    });
    return ticket;
  }

  async addTicketNote(rawId: string, type: NoteType, body: string, author?: string): Promise<Ticket> {
    const ticket = await this.transitionTicket(rawId, undefined);
    ticket.notes.push({
      id: `${ticket.id}-note-${Date.now()}`,
      type,
      body,
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
    ticket.guardSummary = summary;
    await this.persist();
    return ticket;
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
    await this.persist();
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
    await fs.writeFile(this.statePath, JSON.stringify(this.state, null, 2), "utf-8");
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
