import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { AgentLoopStore } from "../src/store";
import { FilesystemStateBackend, MemoryStateBackend } from "../src/backend";

test("FilesystemStateBackend writes and reloads state on disk", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "agentloops-backend-"));
  try {
    assert.equal(await new FilesystemStateBackend(dir).load(), null);
    const store = new AgentLoopStore(dir, { ...DEFAULT_CONFIG }, { backend: new FilesystemStateBackend(dir) });
    await store.createTicket({ kind: "bug", source: "smoke", family: "f", title: "t", summary: "s" });
    const reread = await new FilesystemStateBackend(dir).load();
    assert.equal(reread?.tickets.length, 1);
    assert.equal(reread?.tickets[0].id, "ISSUE-000001");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("AgentLoopStore runs over an in-memory backend, shared across instances", async () => {
  const backend = new MemoryStateBackend();
  const writer = new AgentLoopStore("", { ...DEFAULT_CONFIG }, { backend });
  await writer.createTicket({ kind: "feature", source: "agent", family: "x", title: "t", summary: "s" });

  const reader = new AgentLoopStore("", { ...DEFAULT_CONFIG }, { backend });
  const summary = await reader.summary();
  assert.equal(summary.totalTickets, 1);
  assert.equal((await reader.showTicket("DEV-000001"))?.aliases[0], "DEV-000001");
});

test("MemoryStateBackend snapshots are isolated (clone on save/load)", async () => {
  const backend = new MemoryStateBackend();
  const store = new AgentLoopStore("", { ...DEFAULT_CONFIG }, { backend });
  await store.createTicket({ kind: "bug", source: "smoke", family: "f", title: "t", summary: "s" });

  const loaded = await backend.load();
  loaded!.tickets[0].title = "mutated externally";
  const again = await backend.load();
  assert.equal(again!.tickets[0].title, "t");
});
