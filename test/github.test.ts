import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, mergeConfig } from "../src/config";
import { AgentLoopStore } from "../src/store";
import { seedConvergenceDemo } from "../scripts/demo-seed";
import {
  parseGithubIssueUrl,
  deriveGithubLabels,
  buildGithubIssuePayload,
  GithubClient,
  GithubIssue,
  GithubComment,
  GithubIssueInput,
} from "../src/github";
import { Ticket } from "../src/types";

async function freshDir(): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), "agentloops-github-"));
  await seedConvergenceDemo(dir);
  return dir;
}

function sampleTicket(overrides: Partial<Ticket> = {}): Ticket {
  const ts = "2026-01-01T00:00:00.000Z";
  return {
    id: "ISSUE-000001",
    family: "export_pipeline",
    kind: "bug",
    source: "smoke",
    title: "Export crashes on large batches",
    summary: "The export pipeline throws on batches over 500 rows.",
    severity: "high",
    confidence: "high",
    status: "active",
    createdAt: ts,
    updatedAt: ts,
    aliases: ["ISSUE-000001"],
    tags: [],
    notes: [],
    ...overrides,
  };
}

test("parseGithubIssueUrl extracts repo and number from a web URL", () => {
  assert.deepEqual(parseGithubIssueUrl("https://github.com/acme/widgets/issues/42"), {
    repo: "acme/widgets",
    number: 42,
  });
  assert.deepEqual(parseGithubIssueUrl("http://github.com/acme/widgets/issues/7/"), {
    repo: "acme/widgets",
    number: 7,
  });
  assert.equal(parseGithubIssueUrl("https://github.com/acme/widgets/pull/1"), undefined);
  assert.equal(parseGithubIssueUrl("not a url"), undefined);
});

test("deriveGithubLabels mirrors queue/kind/severity/status, with config overrides", () => {
  const ticket = sampleTicket({ kind: "bug", source: "smoke", severity: "high", status: "active" });
  assert.deepEqual(deriveGithubLabels(ticket, DEFAULT_CONFIG), [
    "queue:issue",
    "kind:bug",
    "severity:high",
    "status:active",
  ]);

  const withOverrides = mergeConfig({
    github: {
      repo: "acme/widgets",
      labels: { kind: { bug: "type: bug" }, severity: { high: "P1" } },
    },
  });
  assert.deepEqual(deriveGithubLabels(ticket, withOverrides), [
    "queue:issue",
    "type: bug",
    "P1",
    "status:active",
  ]);
});

test("buildGithubIssuePayload mirrors title/body/labels deterministically", () => {
  const ticket = sampleTicket({ resolutionSummary: "Fixed by batching writes." });
  const payload = buildGithubIssuePayload(ticket, DEFAULT_CONFIG);
  assert.equal(payload.title, "[ISSUE-000001] Export crashes on large batches");
  assert.match(payload.body, /The export pipeline throws on batches over 500 rows\./);
  assert.match(payload.body, /Resolution: Fixed by batching writes\./);
  assert.deepEqual(payload.labels, ["queue:issue", "kind:bug", "severity:high", "status:active"]);
});

/** In-memory fake GithubClient — no network, fully deterministic. */
class FakeGithubClient implements GithubClient {
  issues = new Map<number, GithubIssue>();
  comments = new Map<number, GithubComment[]>();
  nextNumber = 100;
  calls: string[] = [];

  async createIssue(_repo: string, input: GithubIssueInput): Promise<GithubIssue> {
    this.calls.push("create");
    const number = this.nextNumber++;
    const issue: GithubIssue = {
      number,
      htmlUrl: `https://github.com/acme/widgets/issues/${number}`,
      title: input.title,
      body: input.body,
      labels: input.labels,
      state: "open",
    };
    this.issues.set(number, issue);
    return issue;
  }

  async updateIssue(_repo: string, issueNumber: number, input: Partial<GithubIssueInput>): Promise<GithubIssue> {
    this.calls.push("update");
    const existing = this.issues.get(issueNumber);
    if (!existing) throw new Error(`no such issue: ${issueNumber}`);
    const updated: GithubIssue = { ...existing, ...input, labels: input.labels ?? existing.labels };
    this.issues.set(issueNumber, updated);
    return updated;
  }

  async listComments(
    _repo: string,
    issueNumber: number,
    options: { sinceId?: number } = {},
  ): Promise<GithubComment[]> {
    this.calls.push("listComments");
    const all = this.comments.get(issueNumber) ?? [];
    return options.sinceId === undefined ? all : all.filter((c) => c.id > options.sinceId!);
  }
}

test("syncGithubIssue creates on first sync, updates + imports new comments thereafter", async () => {
  const dir = await freshDir();
  try {
    const config = mergeConfig({ ...DEFAULT_CONFIG, github: { repo: "acme/widgets" } });
    const store = new AgentLoopStore(dir, config);
    const client = new FakeGithubClient();

    const first = await store.syncGithubIssue("ISSUE-000001", client);
    assert.equal(first.issue.number, 100);
    assert.equal(first.importedComments, 0);
    assert.equal(client.calls.at(-2), "create");

    let ticket = await store.showTicket("ISSUE-000001");
    assert.equal(ticket?.github?.issueNumber, 100);
    assert.equal(ticket?.github?.issueUrl, "https://github.com/acme/widgets/issues/100");

    // Simulate two new external comments landing on the linked Issue.
    client.comments.set(100, [
      { id: 1, author: "alice", body: "I can repro this on staging.", createdAt: "2026-01-02T00:00:00.000Z" },
      { id: 2, author: "bob", body: "Looks like a batching bug.", createdAt: "2026-01-03T00:00:00.000Z" },
    ]);

    const second = await store.syncGithubIssue("ISSUE-000001", client);
    assert.equal(second.importedComments, 2);
    assert.equal(client.calls.at(-2), "update");

    ticket = await store.showTicket("ISSUE-000001");
    const externalNotes = ticket!.notes.filter((n) => n.type === "external");
    assert.equal(externalNotes.length, 2);
    assert.match(externalNotes[0].body, /alice.*repro this on staging/);
    assert.match(externalNotes[1].body, /bob.*batching bug/);
    assert.equal(ticket?.github?.lastSyncedCommentId, 2);

    // A third sync with no new comments must not re-import the same two.
    const third = await store.syncGithubIssue("ISSUE-000001", client);
    assert.equal(third.importedComments, 0);
    ticket = await store.showTicket("ISSUE-000001");
    assert.equal(ticket!.notes.filter((n) => n.type === "external").length, 2);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("linkGithubIssue manually attaches an existing Issue by URL", async () => {
  const dir = await freshDir();
  try {
    const store = new AgentLoopStore(dir, { ...DEFAULT_CONFIG });
    const ticket = await store.linkGithubIssue("ISSUE-000001", "https://github.com/acme/widgets/issues/77");
    assert.equal(ticket.github?.issueNumber, 77);
    assert.equal(ticket.github?.issueUrl, "https://github.com/acme/widgets/issues/77");

    await assert.rejects(() => store.linkGithubIssue("ISSUE-000001", "not a url"), /Not a GitHub issue URL/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("syncGithubIssue requires github.repo to be configured", async () => {
  const dir = await freshDir();
  try {
    const store = new AgentLoopStore(dir, { ...DEFAULT_CONFIG });
    await assert.rejects(
      () => store.syncGithubIssue("ISSUE-000001", new FakeGithubClient()),
      /GitHub sync is not configured/,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
