import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { AgentLoopStore } from "../src/store";
import { createPatternRedactor, noopRedactor } from "../src/redaction";
import { ProjectConfig } from "../src/types";

const EMAIL = { pattern: "[\\w.]+@[\\w.]+\\.[a-z]+", replacement: "[email]" };

test("createPatternRedactor masks matches in text and nested json", () => {
  const redactor = createPatternRedactor([EMAIL, { pattern: "sk-[a-z0-9]+", replacement: "[key]" }]);
  assert.equal(redactor.redactText("ping a@b.com now", { field: "x" }), "ping [email] now");
  assert.deepEqual(
    redactor.redactJson({ a: "token sk-abc123", b: ["reach x@y.io"], n: 1 }, { field: "x" }),
    { a: "token [key]", b: ["reach [email]"], n: 1 },
  );
});

test("noopRedactor leaves content unchanged", () => {
  assert.equal(noopRedactor.redactText("a@b.com", { field: "x" }), "a@b.com");
});

test("store applies config-driven redaction on every write path", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "agentloops-redact-"));
  try {
    const config: ProjectConfig = { ...DEFAULT_CONFIG, redaction: { patterns: [EMAIL] } };
    const store = new AgentLoopStore(dir, config);
    await store.ensureInitialized();

    const ticket = await store.createTicket({
      kind: "bug",
      source: "smoke",
      family: "f",
      title: "Crash reported by a@b.com",
      summary: "user a@b.com hit a timeout",
    });
    assert.equal(ticket.title, "Crash reported by [email]");
    assert.equal(ticket.summary, "user [email] hit a timeout");

    const noted = await store.addTicketNote(ticket.id, "triage", "reach me at c@d.org");
    assert.equal(noted.notes.at(-1)?.body, "reach me at [email]");

    const resolved = await store.resolveTicket({
      id: ticket.id,
      summary: "patched; pinged e@f.com",
      verification: "confirmed by g@h.net",
    });
    assert.equal(resolved.resolutionSummary, "patched; pinged [email]");
    assert.equal(resolved.verification, "confirmed by [email]");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("an explicit redactor override beats config", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "agentloops-redact-"));
  try {
    const store = new AgentLoopStore(
      dir,
      { ...DEFAULT_CONFIG },
      { redactor: createPatternRedactor([{ pattern: "secret", replacement: "***" }]) },
    );
    await store.ensureInitialized();
    const ticket = await store.createTicket({
      kind: "bug",
      source: "smoke",
      family: "f",
      title: "the secret sauce",
      summary: "nothing here",
    });
    assert.equal(ticket.title, "the *** sauce");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
