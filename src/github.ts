import { ProjectConfig, Ticket } from "./types";
import { resolveQueuePrefix } from "./aliases";

const GITHUB_API = "https://api.github.com";
const ISSUE_URL_RE = /^https?:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)\/?$/i;

export interface GithubIssue {
  number: number;
  htmlUrl: string;
  title: string;
  body: string;
  labels: string[];
  state: string;
}

export interface GithubComment {
  id: number;
  author?: string;
  body: string;
  createdAt: string;
}

export interface GithubIssueInput {
  title: string;
  body: string;
  labels: string[];
}

/**
 * Minimal client shape the sync logic depends on. The default implementation
 * (`createFetchGithubClient`) wraps the GitHub REST API with the global
 * `fetch` — no SDK dependency. Tests inject a fake client instead of hitting
 * the network.
 */
export interface GithubClient {
  createIssue(repo: string, input: GithubIssueInput): Promise<GithubIssue>;
  updateIssue(repo: string, issueNumber: number, input: Partial<GithubIssueInput>): Promise<GithubIssue>;
  listComments(
    repo: string,
    issueNumber: number,
    options?: { sinceId?: number },
  ): Promise<GithubComment[]>;
}

/** Parse a GitHub Issue web URL into its repo ("owner/repo") and issue number. */
export function parseGithubIssueUrl(url: string): { repo: string; number: number } | undefined {
  const match = ISSUE_URL_RE.exec(url.trim());
  if (!match) return undefined;
  return { repo: match[1], number: Number(match[2]) };
}

function labelFor(
  category: "queue" | "kind" | "severity" | "status",
  value: string,
  config: ProjectConfig,
): string {
  const override = config.github?.labels?.[category]?.[value];
  return override ?? `${category}:${value}`;
}

/**
 * Derive the labels mirrored onto a linked Issue from the ticket's queue,
 * kind, severity, and status. Each category can be overridden via
 * `config.github.labels`; unmapped values fall back to `category:value`.
 */
export function deriveGithubLabels(ticket: Ticket, config: ProjectConfig): string[] {
  const queue = resolveQueuePrefix(ticket, config).toLowerCase();
  return [
    labelFor("queue", queue, config),
    labelFor("kind", ticket.kind, config),
    labelFor("severity", ticket.severity, config),
    labelFor("status", ticket.status, config),
  ];
}

function buildGithubIssueBody(ticket: Ticket): string {
  const lines = [
    ticket.summary,
    "",
    "---",
    `Ticket: ${ticket.id} (${ticket.aliases.join(", ")})`,
    `Kind: ${ticket.kind} · Severity: ${ticket.severity} · Status: ${ticket.status}`,
  ];
  if (ticket.resolutionSummary) {
    lines.push("", `Resolution: ${ticket.resolutionSummary}`);
  }
  lines.push("", "_Synced from AgentLoops — this ticket remains the source of truth._");
  return lines.join("\n");
}

/** Build the create/update payload mirrored onto the linked Issue. Pure and deterministic. */
export function buildGithubIssuePayload(ticket: Ticket, config: ProjectConfig): GithubIssueInput {
  return {
    title: `[${ticket.id}] ${ticket.title}`,
    body: buildGithubIssueBody(ticket),
    labels: deriveGithubLabels(ticket, config),
  };
}

interface RawGithubIssue {
  number: number;
  html_url: string;
  title: string;
  body: string | null;
  labels: Array<string | { name?: string }>;
  state: string;
}

interface RawGithubComment {
  id: number;
  body: string | null;
  created_at: string;
  user?: { login?: string } | null;
}

function toGithubIssue(raw: RawGithubIssue): GithubIssue {
  return {
    number: raw.number,
    htmlUrl: raw.html_url,
    title: raw.title,
    body: raw.body ?? "",
    labels: raw.labels.map((label) => (typeof label === "string" ? label : (label.name ?? ""))).filter(Boolean),
    state: raw.state,
  };
}

function toGithubComment(raw: RawGithubComment): GithubComment {
  return {
    id: raw.id,
    author: raw.user?.login ?? undefined,
    body: raw.body ?? "",
    createdAt: raw.created_at,
  };
}

/**
 * Default `GithubClient` over the GitHub REST API using the global `fetch`
 * (no third-party dependency; Node 20+ ships it). Pass a custom `fetchImpl`
 * to point at a different host or to test against a fake server.
 */
export function createFetchGithubClient(
  token: string,
  fetchImpl: typeof fetch = fetch,
): GithubClient {
  async function request(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await fetchImpl(`${GITHUB_API}${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`GitHub API ${init.method ?? "GET"} ${path} failed: ${response.status} ${detail}`.trim());
    }
    if (response.status === 204) return undefined;
    return response.json();
  }

  return {
    async createIssue(repo, input) {
      const raw = (await request(`/repos/${repo}/issues`, {
        method: "POST",
        body: JSON.stringify(input),
      })) as RawGithubIssue;
      return toGithubIssue(raw);
    },
    async updateIssue(repo, issueNumber, input) {
      const raw = (await request(`/repos/${repo}/issues/${issueNumber}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      })) as RawGithubIssue;
      return toGithubIssue(raw);
    },
    async listComments(repo, issueNumber, options = {}) {
      const raw = (await request(
        `/repos/${repo}/issues/${issueNumber}/comments?per_page=100`,
      )) as RawGithubComment[];
      const comments = raw.map(toGithubComment);
      const sinceId = options.sinceId;
      return sinceId === undefined ? comments : comments.filter((comment) => comment.id > sinceId);
    },
  };
}

export interface GithubSyncTarget {
  client: GithubClient;
  repo: string;
}

/**
 * Resolve the configured sync target (repo + client) from project config and
 * environment. Returns `undefined` when GitHub sync isn't configured (no
 * `github.repo`); throws when it is configured but the token env var is unset.
 */
export function resolveGithubTarget(config: ProjectConfig): GithubSyncTarget | undefined {
  const repo = config.github?.repo;
  if (!repo) return undefined;
  const tokenEnv = config.github?.tokenEnv ?? "GITHUB_TOKEN";
  const token = process.env[tokenEnv];
  if (!token) {
    throw new Error(
      `GitHub sync is configured (github.repo=${repo}) but the ${tokenEnv} environment variable is not set.`,
    );
  }
  return { client: createFetchGithubClient(token), repo };
}
