import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../src/config";
import { resolveBackend, resolvePostgresUrl } from "../src/storage";
import { FilesystemStateBackend } from "../src/backend";
import { PostgresStateBackend } from "../src/postgres";

test("resolvePostgresUrl precedence: explicit > DATABASE_URL > config", () => {
  const prev = process.env.DATABASE_URL;
  const withConfig = { cwd: ".", config: { ...DEFAULT_CONFIG, storage: { databaseUrl: "cfg" } } };
  try {
    process.env.DATABASE_URL = "env";
    assert.equal(resolvePostgresUrl({ ...withConfig, databaseUrl: "explicit" }), "explicit");
    assert.equal(resolvePostgresUrl(withConfig), "env");
    delete process.env.DATABASE_URL;
    assert.equal(resolvePostgresUrl(withConfig), "cfg");
    assert.equal(resolvePostgresUrl({ cwd: ".", config: { ...DEFAULT_CONFIG } }), undefined);
  } finally {
    if (prev === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prev;
  }
});

test("resolveBackend falls back to the filesystem without a url", async () => {
  const prev = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const selection = await resolveBackend({ cwd: ".", config: { ...DEFAULT_CONFIG } });
    assert.equal(selection.kind, "filesystem");
    assert.ok(selection.backend instanceof FilesystemStateBackend);
    await selection.dispose();
  } finally {
    if (prev !== undefined) process.env.DATABASE_URL = prev;
  }
});

test("resolveBackend builds a postgres selection from an explicit url", async () => {
  const selection = await resolveBackend({
    cwd: ".",
    config: { ...DEFAULT_CONFIG },
    databaseUrl: "postgres://localhost:1/none",
  });
  assert.equal(selection.kind, "postgres");
  assert.ok(selection.backend instanceof PostgresStateBackend);
  // The pool is unused (lazy connect); dispose must resolve without hanging.
  await selection.dispose();
});
