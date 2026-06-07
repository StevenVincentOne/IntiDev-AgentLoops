import { LoopState, Pattern, PriorArtEdge, Ticket } from "./types";
import { StateBackend } from "./backend";

/**
 * Public relational schema for the ledger. Faithfully mirrors `LoopState`:
 * timestamps are stored as ISO text to keep round-trips identical to the JSON
 * backend, and ordered child collections carry an `ord` column.
 */
export const TICKET_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS loop_meta (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  project text NOT NULL,
  version integer NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  next_ticket_seq integer NOT NULL,
  next_pattern_seq integer NOT NULL,
  next_prior_art_edge_seq integer NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ticket_patterns (
  id text PRIMARY KEY,
  family text NOT NULL,
  title text NOT NULL,
  status text NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE TABLE IF NOT EXISTS tickets (
  id text PRIMARY KEY,
  family text NOT NULL,
  kind text NOT NULL,
  source text NOT NULL,
  title text NOT NULL,
  summary text NOT NULL,
  severity text NOT NULL,
  confidence text NOT NULL,
  status text NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  started_at text,
  resolved_at text,
  handoff_text text,
  guard_status text,
  guard_summary text,
  prior_art_hint text,
  pattern_id text,
  verification text,
  reproducible boolean,
  resolution_summary text,
  github_issue_url text,
  github_issue_number integer,
  github_last_synced_at text,
  github_last_synced_comment_id integer
);
CREATE TABLE IF NOT EXISTS ticket_aliases (ticket_id text NOT NULL, alias text NOT NULL, ord integer NOT NULL);
CREATE TABLE IF NOT EXISTS ticket_tags (ticket_id text NOT NULL, tag text NOT NULL, ord integer NOT NULL);
CREATE TABLE IF NOT EXISTS ticket_notes (
  id text NOT NULL,
  ticket_id text NOT NULL,
  type text NOT NULL,
  body text NOT NULL,
  author text,
  created_at text NOT NULL,
  ord integer NOT NULL
);
CREATE TABLE IF NOT EXISTS ticket_pattern_links (pattern_id text NOT NULL, ticket_id text NOT NULL, ord integer NOT NULL);
CREATE TABLE IF NOT EXISTS prior_art_edges (
  id text PRIMARY KEY,
  ticket_id_a text NOT NULL,
  ticket_id_b text NOT NULL,
  score double precision NOT NULL,
  signals_json text NOT NULL,
  strength double precision NOT NULL,
  first_seen_at text NOT NULL,
  last_seen_at text NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
`;

/** Tables in dependency-free delete order (no FKs; order is for readability). */
const TABLES = [
  "prior_art_edges",
  "ticket_pattern_links",
  "ticket_notes",
  "ticket_tags",
  "ticket_aliases",
  "tickets",
  "ticket_patterns",
  "loop_meta",
];

// --- Relational row shapes (camelCase) -------------------------------------

interface MetaRows {
  project: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  nextTicketSeq: number;
  nextPatternSeq: number;
  nextPriorArtEdgeSeq: number;
}
interface PatternRow {
  id: string;
  family: string;
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}
interface TicketRow {
  id: string;
  family: string;
  kind: string;
  source: string;
  title: string;
  summary: string;
  severity: string;
  confidence: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  resolvedAt: string | null;
  handoffText: string | null;
  guardStatus: string | null;
  guardSummary: string | null;
  priorArtHint: string | null;
  patternId: string | null;
  verification: string | null;
  reproducible: boolean | null;
  resolutionSummary: string | null;
  githubIssueUrl: string | null;
  githubIssueNumber: number | null;
  githubLastSyncedAt: string | null;
  githubLastSyncedCommentId: number | null;
}
interface AliasRow {
  ticketId: string;
  alias: string;
  ord: number;
}
interface TagRow {
  ticketId: string;
  tag: string;
  ord: number;
}
interface NoteRow {
  id: string;
  ticketId: string;
  type: string;
  body: string;
  author: string | null;
  createdAt: string;
  ord: number;
}
interface LinkRow {
  patternId: string;
  ticketId: string;
  ord: number;
}
interface EdgeRow {
  id: string;
  ticketIdA: string;
  ticketIdB: string;
  score: number;
  signalsJson: string;
  strength: number;
  firstSeenAt: string;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface RelationalRows {
  meta: MetaRows;
  patterns: PatternRow[];
  tickets: TicketRow[];
  aliases: AliasRow[];
  tags: TagRow[];
  notes: NoteRow[];
  links: LinkRow[];
  edges: EdgeRow[];
}

// --- Pure mapping (LoopState <-> relational rows), no DB -------------------

export function serializeState(state: LoopState): RelationalRows {
  const aliases: AliasRow[] = [];
  const tags: TagRow[] = [];
  const notes: NoteRow[] = [];
  const links: LinkRow[] = [];

  for (const ticket of state.tickets) {
    ticket.aliases.forEach((alias, ord) => aliases.push({ ticketId: ticket.id, alias, ord }));
    ticket.tags.forEach((tag, ord) => tags.push({ ticketId: ticket.id, tag, ord }));
    ticket.notes.forEach((note, ord) =>
      notes.push({
        id: note.id,
        ticketId: ticket.id,
        type: note.type,
        body: note.body,
        author: note.author ?? null,
        createdAt: note.createdAt,
        ord,
      }),
    );
  }
  for (const pattern of state.patterns) {
    pattern.ticketIds.forEach((ticketId, ord) =>
      links.push({ patternId: pattern.id, ticketId, ord }),
    );
  }
  const edges: EdgeRow[] = state.priorArtEdges.map((edge) => ({
    id: edge.id,
    ticketIdA: edge.ticketIds[0],
    ticketIdB: edge.ticketIds[1],
    score: edge.score,
    signalsJson: JSON.stringify(edge.signals),
    strength: edge.strength,
    firstSeenAt: edge.firstSeenAt,
    lastSeenAt: edge.lastSeenAt,
    createdAt: edge.createdAt,
    updatedAt: edge.updatedAt,
  }));

  return {
    meta: {
      project: state.project,
      version: state.version,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      nextTicketSeq: state.nextTicketSeq,
      nextPatternSeq: state.nextPatternSeq,
      nextPriorArtEdgeSeq: state.nextPriorArtEdgeSeq,
    },
    patterns: state.patterns.map((p) => ({
      id: p.id,
      family: p.family,
      title: p.title,
      status: p.status,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    })),
    tickets: state.tickets.map((t) => ({
      id: t.id,
      family: t.family,
      kind: t.kind,
      source: t.source,
      title: t.title,
      summary: t.summary,
      severity: t.severity,
      confidence: t.confidence,
      status: t.status,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      startedAt: t.startedAt ?? null,
      resolvedAt: t.resolvedAt ?? null,
      handoffText: t.handoffText ?? null,
      guardStatus: t.guardStatus ?? null,
      guardSummary: t.guardSummary ?? null,
      priorArtHint: t.priorArtHint ?? null,
      patternId: t.patternId ?? null,
      verification: t.verification ?? null,
      reproducible: t.reproducible ?? null,
      resolutionSummary: t.resolutionSummary ?? null,
      githubIssueUrl: t.github?.issueUrl ?? null,
      githubIssueNumber: t.github?.issueNumber ?? null,
      githubLastSyncedAt: t.github?.lastSyncedAt ?? null,
      githubLastSyncedCommentId: t.github?.lastSyncedCommentId ?? null,
    })),
    aliases,
    tags,
    notes,
    links,
    edges,
  };
}

function byOrd<T extends { ord: number }>(a: T, b: T): number {
  return a.ord - b.ord;
}

export function deserializeRows(rows: RelationalRows): LoopState {
  const aliasesByTicket = new Map<string, AliasRow[]>();
  for (const a of rows.aliases) (aliasesByTicket.get(a.ticketId) ?? aliasesByTicket.set(a.ticketId, []).get(a.ticketId)!).push(a);
  const tagsByTicket = new Map<string, TagRow[]>();
  for (const t of rows.tags) (tagsByTicket.get(t.ticketId) ?? tagsByTicket.set(t.ticketId, []).get(t.ticketId)!).push(t);
  const notesByTicket = new Map<string, NoteRow[]>();
  for (const n of rows.notes) (notesByTicket.get(n.ticketId) ?? notesByTicket.set(n.ticketId, []).get(n.ticketId)!).push(n);
  const linksByPattern = new Map<string, LinkRow[]>();
  for (const l of rows.links) (linksByPattern.get(l.patternId) ?? linksByPattern.set(l.patternId, []).get(l.patternId)!).push(l);

  const tickets: Ticket[] = rows.tickets.map((row) => {
    const ticket: Ticket = {
      id: row.id,
      family: row.family,
      kind: row.kind as Ticket["kind"],
      source: row.source,
      title: row.title,
      summary: row.summary,
      severity: row.severity as Ticket["severity"],
      confidence: row.confidence as Ticket["confidence"],
      status: row.status as Ticket["status"],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      aliases: (aliasesByTicket.get(row.id) ?? []).sort(byOrd).map((a) => a.alias),
      tags: (tagsByTicket.get(row.id) ?? []).sort(byOrd).map((t) => t.tag),
      notes: (notesByTicket.get(row.id) ?? []).sort(byOrd).map((n) => {
        const note: Ticket["notes"][number] = {
          id: n.id,
          type: n.type as Ticket["notes"][number]["type"],
          body: n.body,
          createdAt: n.createdAt,
        };
        if (n.author != null) note.author = n.author;
        return note;
      }),
    };
    if (row.startedAt != null) ticket.startedAt = row.startedAt;
    if (row.resolvedAt != null) ticket.resolvedAt = row.resolvedAt;
    if (row.handoffText != null) ticket.handoffText = row.handoffText;
    if (row.guardStatus != null) ticket.guardStatus = row.guardStatus as Ticket["guardStatus"];
    if (row.guardSummary != null) ticket.guardSummary = row.guardSummary;
    if (row.priorArtHint != null) ticket.priorArtHint = row.priorArtHint as Ticket["priorArtHint"];
    if (row.patternId != null) ticket.patternId = row.patternId;
    if (row.verification != null) ticket.verification = row.verification;
    if (row.reproducible != null) ticket.reproducible = row.reproducible;
    if (row.resolutionSummary != null) ticket.resolutionSummary = row.resolutionSummary;
    if (row.githubIssueUrl != null && row.githubIssueNumber != null) {
      ticket.github = {
        issueUrl: row.githubIssueUrl,
        issueNumber: row.githubIssueNumber,
        ...(row.githubLastSyncedAt != null ? { lastSyncedAt: row.githubLastSyncedAt } : {}),
        ...(row.githubLastSyncedCommentId != null ? { lastSyncedCommentId: row.githubLastSyncedCommentId } : {}),
      };
    }
    return ticket;
  });

  const patterns: Pattern[] = rows.patterns.map((row) => ({
    id: row.id,
    family: row.family,
    title: row.title,
    status: row.status as Pattern["status"],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ticketIds: (linksByPattern.get(row.id) ?? []).sort(byOrd).map((l) => l.ticketId),
  }));

  const priorArtEdges: PriorArtEdge[] = rows.edges.map((row) => {
    let signals: string[];
    try {
      const parsed = JSON.parse(row.signalsJson);
      signals = Array.isArray(parsed) ? parsed.map((s) => String(s)) : [];
    } catch {
      signals = [];
    }
    return {
      id: row.id,
      ticketIds: [row.ticketIdA, row.ticketIdB],
      score: row.score,
      signals,
      strength: row.strength,
      firstSeenAt: row.firstSeenAt,
      lastSeenAt: row.lastSeenAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  });

  return {
    version: rows.meta.version,
    project: rows.meta.project,
    createdAt: rows.meta.createdAt,
    updatedAt: rows.meta.updatedAt,
    nextTicketSeq: rows.meta.nextTicketSeq,
    nextPatternSeq: rows.meta.nextPatternSeq,
    nextPriorArtEdgeSeq: rows.meta.nextPriorArtEdgeSeq,
    tickets,
    patterns,
    priorArtEdges,
  };
}

// --- Postgres backend ------------------------------------------------------

/** Minimal client shape; a `pg.Pool` or `pg.Client` satisfies it. */
export interface PgClient {
  query<R = unknown>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

/** A pool exposes `connect()` returning a single dedicated connection. */
interface PgPoolLike extends PgClient {
  connect(): Promise<PgConnection>;
}
interface PgConnection extends PgClient {
  release(): void;
}

function isPool(client: PgClient): client is PgPoolLike {
  return typeof (client as Partial<PgPoolLike>).connect === "function";
}

/**
 * Postgres-backed `StateBackend` over the relational `ticket_*` schema. Brings
 * no `pg` dependency — the host injects a `pg.Pool`/`pg.Client`-shaped client.
 * Saves are transactional (whole-snapshot replace), so a failed write never
 * leaves a partially-updated ledger.
 */
export class PostgresStateBackend implements StateBackend {
  private migrated = false;

  constructor(private readonly client: PgClient) {}

  async migrate(): Promise<void> {
    await this.client.query(TICKET_SCHEMA_SQL);
    this.migrated = true;
  }

  private async ensureSchema(): Promise<void> {
    if (!this.migrated) await this.migrate();
  }

  private async withConnection<T>(run: (c: PgClient) => Promise<T>): Promise<T> {
    if (isPool(this.client)) {
      const conn = await this.client.connect();
      try {
        return await run(conn);
      } finally {
        conn.release();
      }
    }
    return run(this.client);
  }

  async load(): Promise<LoopState | null> {
    await this.ensureSchema();
    return this.withConnection(async (c) => {
      const meta = (await c.query<Record<string, unknown>>("SELECT * FROM loop_meta WHERE id = 1")).rows[0];
      if (!meta) return null;
      const patterns = (await c.query<Record<string, unknown>>("SELECT * FROM ticket_patterns ORDER BY id")).rows;
      const tickets = (await c.query<Record<string, unknown>>("SELECT * FROM tickets ORDER BY id")).rows;
      const aliases = (await c.query<Record<string, unknown>>("SELECT * FROM ticket_aliases ORDER BY ticket_id, ord")).rows;
      const tags = (await c.query<Record<string, unknown>>("SELECT * FROM ticket_tags ORDER BY ticket_id, ord")).rows;
      const notes = (await c.query<Record<string, unknown>>("SELECT * FROM ticket_notes ORDER BY ticket_id, ord")).rows;
      const links = (await c.query<Record<string, unknown>>("SELECT * FROM ticket_pattern_links ORDER BY pattern_id, ord")).rows;
      const edges = (await c.query<Record<string, unknown>>("SELECT * FROM prior_art_edges ORDER BY id")).rows;
      const rows: RelationalRows = {
        meta: {
          project: String(meta.project),
          version: Number(meta.version),
          createdAt: String(meta.created_at),
          updatedAt: String(meta.updated_at),
          nextTicketSeq: Number(meta.next_ticket_seq),
          nextPatternSeq: Number(meta.next_pattern_seq),
          nextPriorArtEdgeSeq: Number(meta.next_prior_art_edge_seq ?? 0),
        },
        patterns: patterns.map((r) => ({
          id: String(r.id),
          family: String(r.family),
          title: String(r.title),
          status: String(r.status),
          createdAt: String(r.created_at),
          updatedAt: String(r.updated_at),
        })),
        tickets: tickets.map((r) => ({
          id: String(r.id),
          family: String(r.family),
          kind: String(r.kind),
          source: String(r.source),
          title: String(r.title),
          summary: String(r.summary),
          severity: String(r.severity),
          confidence: String(r.confidence),
          status: String(r.status),
          createdAt: String(r.created_at),
          updatedAt: String(r.updated_at),
          startedAt: (r.started_at as string | null) ?? null,
          resolvedAt: (r.resolved_at as string | null) ?? null,
          handoffText: (r.handoff_text as string | null) ?? null,
          guardStatus: (r.guard_status as string | null) ?? null,
          guardSummary: (r.guard_summary as string | null) ?? null,
          priorArtHint: (r.prior_art_hint as string | null) ?? null,
          patternId: (r.pattern_id as string | null) ?? null,
          verification: (r.verification as string | null) ?? null,
          reproducible: (r.reproducible as boolean | null) ?? null,
          resolutionSummary: (r.resolution_summary as string | null) ?? null,
          githubIssueUrl: (r.github_issue_url as string | null) ?? null,
          githubIssueNumber: (r.github_issue_number as number | null) ?? null,
          githubLastSyncedAt: (r.github_last_synced_at as string | null) ?? null,
          githubLastSyncedCommentId: (r.github_last_synced_comment_id as number | null) ?? null,
        })),
        aliases: aliases.map((r) => ({ ticketId: String(r.ticket_id), alias: String(r.alias), ord: Number(r.ord) })),
        tags: tags.map((r) => ({ ticketId: String(r.ticket_id), tag: String(r.tag), ord: Number(r.ord) })),
        notes: notes.map((r) => ({
          id: String(r.id),
          ticketId: String(r.ticket_id),
          type: String(r.type),
          body: String(r.body),
          author: (r.author as string | null) ?? null,
          createdAt: String(r.created_at),
          ord: Number(r.ord),
        })),
        links: links.map((r) => ({ patternId: String(r.pattern_id), ticketId: String(r.ticket_id), ord: Number(r.ord) })),
        edges: edges.map((r) => ({
          id: String(r.id),
          ticketIdA: String(r.ticket_id_a),
          ticketIdB: String(r.ticket_id_b),
          score: Number(r.score),
          signalsJson: String(r.signals_json),
          strength: Number(r.strength),
          firstSeenAt: String(r.first_seen_at),
          lastSeenAt: String(r.last_seen_at),
          createdAt: String(r.created_at),
          updatedAt: String(r.updated_at),
        })),
      };
      return deserializeRows(rows);
    });
  }

  async save(state: LoopState): Promise<void> {
    await this.ensureSchema();
    const rows = serializeState(state);
    await this.withConnection(async (c) => {
      await c.query("BEGIN");
      try {
        for (const table of TABLES) await c.query(`DELETE FROM ${table}`);
        await c.query(
          "INSERT INTO loop_meta (id, project, version, created_at, updated_at, next_ticket_seq, next_pattern_seq, next_prior_art_edge_seq) VALUES (1, $1, $2, $3, $4, $5, $6, $7)",
          [rows.meta.project, rows.meta.version, rows.meta.createdAt, rows.meta.updatedAt, rows.meta.nextTicketSeq, rows.meta.nextPatternSeq, rows.meta.nextPriorArtEdgeSeq],
        );
        for (const p of rows.patterns) {
          await c.query(
            "INSERT INTO ticket_patterns (id, family, title, status, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)",
            [p.id, p.family, p.title, p.status, p.createdAt, p.updatedAt],
          );
        }
        for (const t of rows.tickets) {
          await c.query(
            `INSERT INTO tickets (id, family, kind, source, title, summary, severity, confidence, status, created_at, updated_at, started_at, resolved_at, handoff_text, guard_status, guard_summary, prior_art_hint, pattern_id, verification, reproducible, resolution_summary, github_issue_url, github_issue_number, github_last_synced_at, github_last_synced_comment_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
            [t.id, t.family, t.kind, t.source, t.title, t.summary, t.severity, t.confidence, t.status, t.createdAt, t.updatedAt, t.startedAt, t.resolvedAt, t.handoffText, t.guardStatus, t.guardSummary, t.priorArtHint, t.patternId, t.verification, t.reproducible, t.resolutionSummary, t.githubIssueUrl, t.githubIssueNumber, t.githubLastSyncedAt, t.githubLastSyncedCommentId],
          );
        }
        for (const a of rows.aliases) {
          await c.query("INSERT INTO ticket_aliases (ticket_id, alias, ord) VALUES ($1, $2, $3)", [a.ticketId, a.alias, a.ord]);
        }
        for (const tag of rows.tags) {
          await c.query("INSERT INTO ticket_tags (ticket_id, tag, ord) VALUES ($1, $2, $3)", [tag.ticketId, tag.tag, tag.ord]);
        }
        for (const n of rows.notes) {
          await c.query("INSERT INTO ticket_notes (id, ticket_id, type, body, author, created_at, ord) VALUES ($1, $2, $3, $4, $5, $6, $7)", [n.id, n.ticketId, n.type, n.body, n.author, n.createdAt, n.ord]);
        }
        for (const l of rows.links) {
          await c.query("INSERT INTO ticket_pattern_links (pattern_id, ticket_id, ord) VALUES ($1, $2, $3)", [l.patternId, l.ticketId, l.ord]);
        }
        for (const e of rows.edges) {
          await c.query(
            "INSERT INTO prior_art_edges (id, ticket_id_a, ticket_id_b, score, signals_json, strength, first_seen_at, last_seen_at, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
            [e.id, e.ticketIdA, e.ticketIdB, e.score, e.signalsJson, e.strength, e.firstSeenAt, e.lastSeenAt, e.createdAt, e.updatedAt],
          );
        }
        await c.query("COMMIT");
      } catch (error) {
        await c.query("ROLLBACK");
        throw error;
      }
    });
  }
}
