import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DEFAULT_CONFIG } from "../src/config";
import { AgentLoopStore } from "../src/store";
import {
  createMcpServer,
  handoffTool,
  listTool,
  showTool,
  summaryTool,
  createTicketTool,
  noteTool,
  workflowTool,
  resolveTool,
  guardTool,
  MCP_SCHEMA_VERSION,
} from "../src/mcp";
import { seedConvergenceDemo } from "../scripts/demo-seed";
import { MINIMAL_ROOT_CAUSE_CERT } from "./helpers";

async function withSeededStore<T>(run: (store: AgentLoopStore) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(join(tmpdir(), "agentloops-mcp-"));
  try {
    await seedConvergenceDemo(dir);
    const store = new AgentLoopStore(dir, { ...DEFAULT_CONFIG });
    await store.ensureInitialized();
    return await run(store);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

async function connectedClient(server: ReturnType<typeof createMcpServer>): Promise<Client> {
  const client = new Client({ name: "agentloops-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function textOf(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content[0].text;
}

test("summaryTool reports converged loop counts", async () => {
  await withSeededStore(async (store) => {
    const result = await summaryTool(store);
    assert.equal(result.schemaVersion, MCP_SCHEMA_VERSION);
    assert.match(result.generatedAt, ISO);
    assert.equal(result.summary.totalTickets, 3);
    assert.equal(result.summary.triagedTickets, 3);
    assert.equal(result.summary.openPatterns, 1); // active patterns
  });
});

test("listTool filters by status and kind", async () => {
  await withSeededStore(async (store) => {
    const all = await listTool(store);
    assert.equal(all.count, 3);
    assert.equal(all.tickets.length, 3);
    assert.deepEqual(all.filters, { status: "all", kind: null, family: null, queue: null });

    const features = await listTool(store, { kind: "feature" });
    assert.equal(features.count, 1);
    assert.equal(features.tickets[0]?.aliases[0], "DEV-000003");

    const issues = await listTool(store, { queue: "issues" });
    assert.equal(issues.count, 1);
    assert.equal(issues.tickets[0]?.aliases[0], "ISSUE-000001");

    const pipeline = await listTool(store, { family: "export_pipeline" });
    assert.equal(pipeline.count, 3);

    const resolved = await listTool(store, { status: "resolved" });
    assert.equal(resolved.count, 0);
  });
});

test("showTool resolves tickets by alias and patterns by id", async () => {
  await withSeededStore(async (store) => {
    const ticket = await showTool(store, { id: "DEV-000003" });
    assert.equal(ticket.kind, "ticket");
    assert.equal(ticket.kind === "ticket" && ticket.ticket.id, "ISSUE-000003");

    const pattern = await showTool(store, { id: "pattern-000001" });
    assert.equal(pattern.kind, "pattern");
    assert.equal(pattern.kind === "pattern" && pattern.pattern.ticketIds.length, 3);

    await assert.rejects(() => showTool(store, { id: "NOPE-9" }), /Not found/);
  });
});

test("handoffTool returns a copyable prompt for a ticket alias", async () => {
  await withSeededStore(async (store) => {
    const result = await handoffTool(store, { id: "USER-000002" });
    assert.equal(result.ticketId, "ISSUE-000002");
    assert.deepEqual(result.aliases, ["USER-000002"]);
    assert.match(result.prompt, /ISSUE-000002/);
    assert.match(result.prompt, /Export fails for long reports/);
  });
});

test("MCP server exposes the read-only tools over the protocol", async () => {
  await withSeededStore(async (store) => {
    const server = createMcpServer(store);
    const client = new Client({ name: "agentloops-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const { tools } = await client.listTools();
      assert.deepEqual(
        tools.map((t) => t.name).sort(),
        [
          "agentloop_begin_group",
          "agentloop_convergence",
          "agentloop_guard_gaps",
          "agentloop_handoff",
          "agentloop_knowledge_gaps",
          "agentloop_list",
          "agentloop_near_duplicates",
          "agentloop_prior_art_graph",
          "agentloop_related",
          "agentloop_search_knowledge",
          "agentloop_show",
          "agentloop_summary",
          "agentloop_sweep",
          "agentloop_ticket_groups",
          "agentloop_workflow_audit",
        ],
      );
      // Every exposed tool advertises itself as read-only.
      assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true));

      const summary = await client.callTool({ name: "agentloop_summary", arguments: {} });
      const summaryText = (summary.content as Array<{ type: string; text: string }>)[0].text;
      assert.equal(JSON.parse(summaryText).summary.totalTickets, 3);

      const convergence = await client.callTool({
        name: "agentloop_convergence",
        arguments: {},
      });
      const convergenceJson = JSON.parse(textOf(convergence));
      assert.equal(convergenceJson.summary.convergedPatterns, 1);
      assert.equal(convergenceJson.patterns[0].sourceCount, 3);

      const show = await client.callTool({
        name: "agentloop_show",
        arguments: { id: "ISSUE-000001" },
      });
      const showText = (show.content as Array<{ type: string; text: string }>)[0].text;
      assert.equal(JSON.parse(showText).ticket.kind, "bug");

      // Unknown ids surface as a tool error, not a thrown protocol failure.
      const missing = await client.callTool({
        name: "agentloop_show",
        arguments: { id: "ISSUE-999999" },
      });
      assert.equal(missing.isError, true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

test("createTicketTool appends a ticket with agent source and config defaults", async () => {
  await withSeededStore(async (store) => {
    const result = await createTicketTool(store, {
      summary: "Streaming export needs backpressure",
      kind: "feature",
      family: "export_pipeline",
    });
    assert.equal(result.action, "created");
    assert.equal(result.ticket.id, "ISSUE-000004");
    assert.deepEqual(result.ticket.aliases, ["DEV-000004"]);
    assert.equal(result.ticket.source, "agent"); // MCP default source
    assert.equal(result.ticket.patternId, "PATTERN-000001"); // joins the family pattern

    await assert.rejects(
      () => createTicketTool(store, { summary: "x", kind: "bogus" }),
      /Unknown kind/,
    );
  });
});

test("createTicketTool persists priorArtHint and auto-surfaces prior-art candidates when it suggests they may exist", async () => {
  await withSeededStore(async (store) => {
    // No hint (or "new"): the field round-trips, but no auto-check runs —
    // the reporter is telling us they believe this is novel.
    const fresh = await createTicketTool(store, {
      summary: "Totally novel problem nobody has reported",
      kind: "bug",
      family: "export_pipeline",
      priorArtHint: "new",
    });
    assert.equal(fresh.ticket.priorArtHint, "new");
    assert.equal(fresh.priorArtSuggestions, undefined);

    const noHint = await createTicketTool(store, {
      summary: "Export pipeline drops trailing pages under load",
      kind: "bug",
      family: "export_pipeline",
    });
    assert.equal(noHint.ticket.priorArtHint, undefined);
    assert.equal(noHint.priorArtSuggestions, undefined);

    // "previously_ticketed"/"existing_pattern"/"adjacent_issues": the reporter
    // believes this connects to prior work, so AgentLoops auto-runs the
    // prior-art check and surfaces candidates right at intake — the
    // AgentLoops-native enhancement over a hint that's merely stored.
    const flagged = await createTicketTool(store, {
      summary: "Export still fails for very long reports under load",
      kind: "bug",
      family: "export_pipeline",
      priorArtHint: "previously_ticketed",
    });
    assert.equal(flagged.ticket.priorArtHint, "previously_ticketed");
    assert.ok(flagged.priorArtSuggestions && flagged.priorArtSuggestions.length > 0);
    // The seeded export_pipeline tickets (sharing family + overlapping text)
    // are exactly the kind of candidates a "did you mean...?" check should surface.
    assert.ok(flagged.priorArtSuggestions!.some((candidate) => candidate.alias === "ISSUE-000001"));
    assert.ok(flagged.priorArtSuggestions!.every((candidate) => candidate.score > 0));
  });
});

test("noteTool / workflowTool / guardTool mutate a ticket", async () => {
  await withSeededStore(async (store) => {
    const noted = await noteTool(store, { id: "USER-000002", body: "user pinged again" });
    assert.equal(noted.action, "noted");
    assert.equal(noted.ticket.notes.length, 1);
    assert.equal(noted.ticket.notes[0].author, "agent"); // default actor
    assert.equal(noted.ticket.notes[0].type, "triage"); // default note type

    const begun = await workflowTool(store, { id: "DEV-000003", status: "active" });
    assert.equal(begun.ticket.status, "active");
    assert.ok(begun.ticket.startedAt);

    const reopened = await workflowTool(store, { id: "DEV-000003", status: "reopened" });
    assert.equal(reopened.ticket.status, "reopened");

    const deferred = await workflowTool(store, { id: "ISSUE-000001", status: "deferred", reason: "later" });
    assert.equal(deferred.ticket.status, "deferred");

    const guarded = await guardTool(store, {
      id: "ISSUE-000001",
      guardStatus: "guard_added",
      guardSummary: "added smoke guard",
    });
    assert.equal(guarded.ticket.guardStatus, "guard_added");
  });
});

test("resolveTool records summary, verification, and guard", async () => {
  await withSeededStore(async (store) => {
    const resolved = await resolveTool(store, {
      id: "ISSUE-000001",
      summary: "streamed exporter shipped",
      verification: "smoke green",
      guardStatus: "guard_existing",
      rootCauseCertificate: MINIMAL_ROOT_CAUSE_CERT,
    });
    assert.equal(resolved.action, "resolved");
    assert.equal(resolved.ticket.status, "resolved");
    assert.equal(resolved.ticket.resolutionSummary, "streamed exporter shipped");
    assert.equal(resolved.ticket.verification, "smoke green");
    assert.equal(resolved.ticket.guardStatus, "guard_existing");
    assert.ok(resolved.ticket.resolvedAt);
  });
});

test("write tools are gated: absent by default, present and usable with allowWrites", async () => {
  await withSeededStore(async (store) => {
    // Default server: read-only surface, no write tools.
    const ro = createMcpServer(store);
    const roClient = await connectedClient(ro);
    try {
      const names = (await roClient.listTools()).tools.map((t) => t.name);
      assert.equal(names.length, 15); // 15 read-only tools (includes agentloop_sweep)
      assert.ok(!names.some((n) => n.startsWith("agentloop_create")));
    } finally {
      await roClient.close();
      await ro.close();
    }

    // Write-enabled server: 15 read + 12 write tools; a create round-trips through show.
    const rw = createMcpServer(store, { allowWrites: true });
    const rwClient = await connectedClient(rw);
    try {
      const tools = (await rwClient.listTools()).tools;
      assert.equal(tools.length, 27);
      const createTool = tools.find((t) => t.name === "agentloop_create");
      assert.equal(createTool?.annotations?.readOnlyHint, false);

      const repairTool = tools.find((t) => t.name === "agentloop_workflow_repair");
      assert.equal(repairTool?.annotations?.readOnlyHint, false);

      const created = await rwClient.callTool({
        name: "agentloop_create",
        arguments: { summary: "Reported via MCP", kind: "bug", family: "auth_session" },
      });
      const createdJson = JSON.parse(textOf(created));
      assert.equal(createdJson.action, "created");

      const shown = await rwClient.callTool({
        name: "agentloop_show",
        arguments: { id: createdJson.ticket.id },
      });
      assert.equal(JSON.parse(textOf(shown)).ticket.summary, "Reported via MCP");
    } finally {
      await rwClient.close();
      await rw.close();
    }
  });
});
