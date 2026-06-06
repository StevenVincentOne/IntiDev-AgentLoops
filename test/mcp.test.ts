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
    assert.deepEqual(all.filters, { status: "all", kind: null });

    const features = await listTool(store, { kind: "feature" });
    assert.equal(features.count, 1);
    assert.equal(features.tickets[0]?.aliases[0], "DEV-000003");

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

test("MCP server exposes the four read-only tools over the protocol", async () => {
  await withSeededStore(async (store) => {
    const server = createMcpServer(store);
    const client = new Client({ name: "agentloops-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const { tools } = await client.listTools();
      assert.deepEqual(
        tools.map((t) => t.name).sort(),
        ["agentloop_handoff", "agentloop_list", "agentloop_show", "agentloop_summary"],
      );
      // Every exposed tool advertises itself as read-only.
      assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true));

      const summary = await client.callTool({ name: "agentloop_summary", arguments: {} });
      const summaryText = (summary.content as Array<{ type: string; text: string }>)[0].text;
      assert.equal(JSON.parse(summaryText).summary.totalTickets, 3);

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
      assert.equal(names.length, 4);
      assert.ok(!names.some((n) => n.startsWith("agentloop_create")));
    } finally {
      await roClient.close();
      await ro.close();
    }

    // Write-enabled server: 9 tools, and a create round-trips through show.
    const rw = createMcpServer(store, { allowWrites: true });
    const rwClient = await connectedClient(rw);
    try {
      const tools = (await rwClient.listTools()).tools;
      assert.equal(tools.length, 9);
      const createTool = tools.find((t) => t.name === "agentloop_create");
      assert.equal(createTool?.annotations?.readOnlyHint, false);

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
