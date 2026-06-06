import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import { DEFAULT_CONFIG } from "../src/config";
import { AgentLoopStore } from "../src/store";
import { gatherDashboardData, renderDashboard, escapeHtml } from "../src/dashboard";
import { createDashboardServer } from "../src/serve";
import { seedConvergenceDemo } from "../scripts/demo-seed";

async function withSeededStore<T>(run: (store: AgentLoopStore) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(join(tmpdir(), "agentloops-dash-"));
  try {
    await seedConvergenceDemo(dir);
    const store = new AgentLoopStore(dir, { ...DEFAULT_CONFIG });
    await store.ensureInitialized();
    return await run(store);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("escapeHtml neutralizes markup", () => {
  assert.equal(escapeHtml(`<script>"&'`), "&lt;script&gt;&quot;&amp;&#39;");
});

test("renderDashboard produces a self-contained document with the ledger", async () => {
  await withSeededStore(async (store) => {
    const html = renderDashboard(await gatherDashboardData(store));
    assert.ok(html.startsWith("<!DOCTYPE html>"));
    assert.match(html, /AgentLoops Demo/);
    // queues + each demo ticket's alias
    for (const alias of ["ISSUE-000001", "USER-000002", "DEV-000003"]) {
      assert.ok(html.includes(alias), `dashboard should list ${alias}`);
    }
    assert.match(html, /Issues/);
    assert.match(html, /Development/);
    // tabs for the reports we built
    assert.match(html, /Patterns/);
    assert.match(html, /Convergence/);
    assert.match(html, /Guard Gaps/);
    // PATTERN-000001 appears in the patterns tab
    assert.ok(html.includes("PATTERN-000001"));
  });
});

test("renderDashboard escapes ticket content (no raw injection)", async () => {
  await withSeededStore(async (store) => {
    await store.createTicket({
      kind: "bug",
      source: "smoke",
      family: "f",
      title: "<script>alert(1)</script>",
      summary: "x",
    });
    const html = renderDashboard(await gatherDashboardData(store));
    assert.ok(!html.includes("<script>alert(1)</script>"));
    assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  });
});

test("createDashboardServer serves HTML and JSON", async () => {
  await withSeededStore(async (store) => {
    const server = createDashboardServer(store);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const base = `http://127.0.0.1:${port}`;

      const page = await fetch(`${base}/`);
      assert.equal(page.status, 200);
      assert.match(page.headers.get("content-type") ?? "", /text\/html/);
      assert.ok((await page.text()).startsWith("<!DOCTYPE html>"));

      const api = await fetch(`${base}/api/summary`);
      assert.equal(api.status, 200);
      const summary = (await api.json()) as { totalTickets: number };
      assert.equal(summary.totalTickets, 3);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
