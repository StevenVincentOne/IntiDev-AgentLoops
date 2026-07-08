# Extraction Session Handoff

Date: 2026-06-05
Status: Scaffold verified and runnable; ready to start porting Inti modules.
Audience: the next agent/session, picking up cold from inside `/home/inti/AgentLoops`.

## TL;DR

You are continuing the extraction of Inti's **Tickets** feature into this public repo
(`IntiDev AgentLoops`). Read the canonical plan first:
[`docs/tickets/2026-06-01_TICKETS_EXTRACTED_REPO_PLAN.md`](2026-06-01_TICKETS_EXTRACTED_REPO_PLAN.md).
This file records the working decision, the verified repo state, the reference-implementation
map in the Inti repo, and the next concrete steps.

## Working decision (settled)

- **Build everything HERE**, in `/home/inti/AgentLoops` — this is the canonical home going forward.
- Use the Inti repo at `/home/inti/inti-docs` as the **reference** implementation to port FROM.
  Direction of flow is **inti-docs → AgentLoops**.
- The mature Inti code is deeply Inti-coupled (direct DB access, ingestion adapters, Admin
  Portal assumptions). It is **reference-and-rewrite behind adapter interfaces, NOT file-copy**.
  Only a few pure modules are near-copyable (alias logic, taxonomy/type defs, handoff prompt
  generation, guard-decision rules, relationship scoring).
- inti-docs stays the stable production dogfood; do not churn it during Phases 1–5. It only
  changes in Phase 6 (migrate Inti to consume the extracted packages).

## Environment / how to run

- This repo lives in the WSL Ubuntu filesystem. Toolchain: **Node v22.22.0, npm 10.9.4** (native in Ubuntu).
- From this directory:
  - `npm install`
  - `npm run build`  (tsc → `dist/`)
  - `npm run lint`   (tsc --noEmit)
  - `npm run cli -- <args>`  (tsx `src/cli.ts`)
- The compiled CLI is `dist/cli.js`; you can run it from any working dir with
  `node /home/inti/AgentLoops/dist/cli.js <cmd>` — state is written to `<cwd>/.agentloops/state.json`.
- Note for cross-repo work from a Windows-rooted session: run builds/tests via
  `wsl -d Ubuntu -- bash -lc '...'` (native npm/node), and prefer `bash`/`find` over Glob/Grep,
  which time out over the `\\wsl$` mount. If running rooted in this dir, none of that applies.

## Verified state (this session)

- `npm install` → OK. Created **`package-lock.json` (NEW, untracked)** — this satisfies the plan's
  "add a lockfile once dependency versions are accepted" item; recommend committing it.
  Also created `node_modules/` (gitignored).
- `npm run build` → **clean, 0 tsc errors**. `dist/` populated (gitignored).
- **End-to-end CLI smoke PASSED** in a temp dir:
  - `init` → `.agentloops/state.json`
  - `create` for bug / feature / user_feedback → aliases **ISSUE- / DEV- / USER-** derived from kind
  - all three (sources `smoke` / `agent` / `user_report`, same `--family export_pipeline`)
    **converged into `PATTERN-000001`** (ACTIVE once ≥2 tickets). This is the source-convergence
    behavior the plan wants — but it was an ad-hoc run, **not yet a committed demo fixture**.
  - `list`, `patterns`, `handoff`, `summary` all work.

## Current AgentLoops surface (what exists)

- `src/types.ts` — Ticket/Pattern/Config types. Kinds: `bug | feature | user_feedback |
  investigation | incident | tech_debt | task`. Statuses: `triaged | active | resolved |
  reopened | deferred`.
- `src/config.ts` — `DEFAULT_CONFIG`: per-kind alias map (bug→ISSUE, feature→DEV,
  user_feedback→USER, investigation→INVEST, incident→INC, tech_debt→DEBT, task→TASK), sources
  list, family-pattern toggle. JSON config via `agentloop.config.json`.
- `src/store.ts` — `AgentLoopStore`: JSON state at `.agentloops/state.json`; canonical id
  `ISSUE-NNNNNN`; per-kind aliases; family→Pattern auto-grouping (flips ACTIVE at ≥2 tickets).
- `src/cli.ts` — commands: `init, create, list, show, patterns, begin, resolve, reopen, note,
  guard, handoff, summary, config, help`.
- `src/index.ts` — package exports.

## Known gaps vs the plan / vs Inti (port targets)

- ✅ ~~No `mcp` command yet~~ — **DONE (session 3, both parts)**: `agentloop mcp` runs a stdio MCP
  server. Read tools (`agentloop_summary` / `_list` / `_show` / `_handoff`) always on; write tools
  (`agentloop_create` / `_note` / `_workflow` / `_resolve` / `_guard`) opt-in via `agentloop mcp --write`.
  **Phase 4 is complete.**
- **No Postgres store** — JSON only. Plan wants a `TicketStore` adapter + Postgres + `ticket_*` schema.
- ✅ ~~Alias model divergence~~ — **DONE (session 4)**: ported Inti's `TicketAliases` model.
  `src/aliases.ts` derives one queue alias from kind **and** source with config-ordered precedence
  USER > DEV > ISSUE (`user_report` source → USER even for a `bug`). Config now uses `queues` instead
  of per-kind `aliases`.
- **Missing big Inti capabilities** (port in plan order, step 5): ⏭ source-convergence audit, ⏭ guard
  records + guard-gap reporting, ⏭ resolution knowledge, ⏭ prior-art relationship graph.
- **README parity**: re-verify examples against actual CLI behavior (e.g. `summary`/`config`
  always emit JSON; `--json` applies to `create`/`list`/`show`).

## Reference map in Inti (read-only — port FROM these)

Absolute WSL paths under `/home/inti/inti-docs`:

| File | Lines | What it is |
| --- | ---: | --- |
| `src/services/IssueLedgerService.ts` | 7,427 | Full ledger: prior-art, guards, resolution knowledge, patterns |
| `src/services/IssueLedgerSchemaService.ts` | 685 | Postgres `issue_*` schema / migrations |
| `scripts/issue-ledger.ts` | 3,700 | Mature CLI (`npm run tickets -- ...`) |
| `src/shared/TicketAliases.ts` | 75 | ISSUE/DEV/USER alias logic (near-copyable; 6-digit pad) |
| `src/services/PostIngestIssueScanService.ts` | 496 | Ingestion-sourced ticket capture (Inti-coupled; reference) |
| `src/services/UserIssueReportService.ts` | 234 | User-report capture (reference) |
| `src/services/BackendIssueReportService.ts` | 217 | Backend error capture (reference) |
| `src/services/BrowserIssueReportService.ts` | 200 | Browser error capture (reference) |
| `src/middleware/backendIssueCapture.ts` | 179 | Express capture middleware (reference) |

Inti also has an Admin Portal dashboard for tickets — UI reference for Phase 5.

Notes on the reference:
- The ticket **schema is managed in-code** by `IssueLedgerSchemaService.ts` (CREATE/ALTER of the
  `issue_*` tables run at startup). It is **not** in `scripts/migrations/` (that dir only holds
  `001_set_admin.sql`). When you build the AgentLoops `ticket_*` schema, port from the schema service.
- The mature CLI (`scripts/issue-ledger.ts`) exposes more subcommands than the AgentLoops CLI
  currently has. Inti `package.json` wires them as:
  `tickets` (base), `tickets:run`, `tickets:suggest-patterns`, `tickets:review-relationships`,
  `tickets:smoke` (+ `--list`, and categories `agent-default | core | ingestion-core |
  ticket-regression | reader-runtime | corpus-upload`). `run`, `suggest-patterns`,
  `review-relationships`, and `smoke` are the notable behaviors to port that AgentLoops lacks.
  (`issues*` aliases exist too and are equivalent to `tickets*`.)

## Next steps (the plan's "Immediate Next Step", with status)

1. ✅ `npm install` + `npm run build` (clean) — **DONE** (session 1).
2. ✅ Fix compile/runtime issues — **none found**; CLI verified end-to-end (session 1).
3. ✅ **Add a committed synthetic demo fixture** showing Issue/User/Development loops converging
   into a Pattern — **DONE this session (2)**. See "Session 2" below.
4. ✅ Add **MCP tools** — **DONE this session (3), both parts**. Read tools (`summary`/`list`/`show`/
   `handoff`) plus opt-in write tools (`create`/`note`/`workflow`/`resolve`/`guard`) behind
   `agentloop mcp --write`. See "Session 3" below. **Phase 4 complete.**
5. ✅ **Port Inti proven modules** — **ALL DONE (session 4)**, each a pure module with no Inti imports:
   - ✅ alias/kind config (`be8cf53`) · ✅ source-convergence audit (`54de32d`) · ✅ guard gaps
     (`23451a2`) · ✅ resolution knowledge (`c7d88c8`) · ✅ prior-art relationships (`7e7da49`).
   - **Step 5 complete. The plan's whole "Immediate Next Step" list (1–5) is now done.**
- Housekeeping: ✅ `package-lock.json` committed (session 2). README parity re-verified for the demo
  and MCP sections (session 3).

## Session 2 (2026-06-05): demo fixture landed

Step 3 is done. The ad-hoc smoke is now a committed, deterministic demo + test:

- `scripts/demo-seed.ts` — exports `seedConvergenceDemo(cwd)` and is runnable via `npm run demo`.
  Seeds three intake loops in family `export_pipeline` — smoke→**ISSUE-000001** (bug),
  user_report→**USER-000002** (user_feedback), agent→**DEV-000003** (feature) — which converge into
  **PATTERN-000001 (ACTIVE, 3 tickets)**. `npm run demo` writes to a throwaway temp dir and prints a
  readable convergence report; it does **not** dirty the repo (session 3 also added `.agentloops/`
  to `.gitignore` in this repo so a stray local ledger can't be committed).
- `test/demo.test.ts` — `node:test` (no new dep; runs under existing `tsx`) via `npm test`. Asserts
  ids/aliases/sources/family, the single ACTIVE pattern, and summary counts, then compares the full
  persisted state to a golden fixture. Timestamps (`*At` fields) are normalized; regenerate the golden
  with `UPDATE_GOLDEN=1 npm test`.
- `test/fixtures/demo-state.golden.json` — normalized golden state (committed).
- `tsconfig.tooling.json` + `npm run typecheck` — type-checks `src` + `scripts` + `test` (the base
  `tsconfig` only covers `src`, so `npm run build`/`lint` would not catch errors in the new files).
- `package.json` scripts added: `demo`, `test`, `typecheck`.
- `.github/workflows/ci.yml` now runs **typecheck → build → test** (was build only).
- `README.md` has a "Try the convergence demo" section with expected output.

Verified green this session: `npm run typecheck`, `npm run build` (dist still contains only `src`
outputs — no scripts/test), `npm test` (clean run + golden regenerate), and `npm run demo`.

Note: the alias-model divergence from Inti (see "Known gaps") is unchanged — the demo derives `USER`
from the `user_feedback` *kind*, not the `user_report` *source*. Reconcile when porting the
source-convergence audit (step 5).

## Session 3 (2026-06-05): read-only MCP server landed

Step 4 is done. `agentloop mcp` serves the ledger over MCP stdio (read-only).

- `src/mcp.ts` — pure, testable tool functions (`summaryTool` / `listTool` / `showTool` /
  `handoffTool`, each returning a `{ schemaVersion: 1, generatedAt, ... }` envelope per the agent
  JSON contracts) plus `createMcpServer(store)` and `startStdioMcpServer({cwd, config})`. Tools
  registered: `agentloop_summary`, `agentloop_list`, `agentloop_show`, `agentloop_handoff`, all
  annotated `readOnlyHint: true`. Unknown ids return `isError` text, not a protocol failure.
- `src/handoff.ts` — extracted `buildHandoffPrompt(ticket)` (a Phase-1 "pure shared module" target);
  now used by both the CLI `handoff` command and the MCP `agentloop_handoff` tool.
- `src/cli.ts` — new `mcp` command. The MCP SDK is **lazy-loaded** via `await import("./mcp.js")` so
  it never affects startup of the other commands; stdout is reserved for JSON-RPC, status → stderr.
- `src/index.ts` — exports the MCP tool fns, `createMcpServer`, `startStdioMcpServer`, `buildHandoffPrompt`.
- `test/mcp.test.ts` — 4 unit tests over the pure tool fns + 1 in-process integration test that wires
  a real SDK `Client` to `createMcpServer` via `InMemoryTransport` (asserts the 4 tools, readOnlyHint,
  a `tools/call`, and `isError` on a bad id). `npm test` is now 6 tests, all green.
- `package.json` — added deps **`@modelcontextprotocol/sdk` ^1.29.0** and **`zod` ^4.4.3** (first
  runtime deps). `test` script now globs `test/*.test.ts`.
- `docs/mcp.md` (new) + README "MCP server" section — run instructions, tool table, client config
  (`claude mcp add agentloop -- agentloop mcp`).
- `.gitignore` — added `.agentloops/` (see note in Session 2).

### Build-system change (important for next session)

- `tsconfig.json` switched from `module: CommonJS` / `moduleResolution: Node` to **`NodeNext` /
  `NodeNext`** so tsc can resolve the SDK's `exports` map. Package stays `"type": "commonjs"`, so emit
  is still CJS and **extensionless relative imports still work** in `.ts` source — EXCEPT **dynamic
  `import()` now needs an explicit `.js` extension** (that's why cli.ts uses `import("./mcp.js")`).
  `tsx` resolves the `.js` specifier back to `.ts` for the dev path. The SDK ships a CJS build
  (`dist/cjs/...`), so `require()` at runtime works on the package's Node `>=20` floor — no ESM-only
  hazard.

### Verified green (session 3)

`npm ci`, `npm run typecheck` (src+scripts+test), `npm run build` (dist contains `mcp.js`/`handoff.js`,
still no scripts/test), `npm test` (6/6). Real stdio handshake against `node dist/cli.js mcp`
(initialize → tools/list → tools/call) returns valid JSON-RPC on stdout with status on stderr; the
tsx dev path (`npx tsx src/cli.ts mcp`) verified too.

### Gotchas hit (so you don't repeat them)

- Shell `mktemp -d` returned **empty** inside `wsl -d Ubuntu -- bash -lc '...'` chains (Windows
  `TMPDIR` leaking in), so manual smoke runs with `cd "$DIR"` silently `cd`'d to the repo root and
  seeded a real `.agentloops/state.json` **into the repo**. Cleaned up; `.agentloops/` now gitignored.
  For one-off scripts prefer Node's `fs.mkdtempSync(os.tmpdir(), ...)` (the test suite already does).
- The convergence seed is **not idempotent** — re-running it against the same dir appends (3 → 6 →
  9 ...). That's fine: `npm run demo` and every test use a fresh temp dir.

### Session 3 part 2 (2026-06-05): MCP write tools landed → Phase 4 complete

- `src/mcp.ts` — added pure write tool fns `createTicketTool` / `noteTool` / `workflowTool` /
  `resolveTool` / `guardTool` (each returns `{ schemaVersion, generatedAt, action, ticket }`).
  `createMcpServer` now takes `options { version?, allowWrites? }`; write tools register **only**
  when `allowWrites` (annotated `readOnlyHint:false`). Enum inputs validated via `z.enum` (the const
  arrays use `as const satisfies readonly T[]` so zod gets a tuple and we still typecheck the union).
  Defaults: create `source` = `agent`, note `author` = `agent`, note `type` = `triage`.
- `src/store.ts` — added `getConfig()` (the create tool fills `kind`/`family` defaults from config).
- `src/cli.ts` — `agentloop mcp --write` (alias `--allow-writes`) flips on writes; stderr reports
  read-only vs read-write.
- `test/mcp.test.ts` — added unit tests per write tool + a gating test (write tools absent by
  default; present + create-round-trips-through-show with `allowWrites`). **`npm test` is now 10/10.**
- README + `docs/mcp.md` updated with the write tools and `--write`.
- Verified: typecheck/build/10 tests, plus a real stdio smoke of `node dist/cli.js mcp --write`
  (9 tools listed; `agentloop_create` over stdio persists to `.agentloops/state.json`).
- **Caveat for step 5+**: write tools do **no redaction** yet (no secrets/user-content scrubbing).
  That belongs with the redaction adapter (`TicketRedactor` in the plan). Also `agentloop_workflow`
  only supports `active`/`reopened` (the store has no `deferred` transition method yet — matches the
  CLI, which also lacks `defer`).
- Pushed: commit `30fec84` (CI expected green; sequence `3ffb897 → d225b0e → 30fec84`).

## Session 4 (2026-06-05): step 5 begins — alias/queue reconciliation

First step-5 module ported from Inti's `src/shared/TicketAliases.ts`.

- `src/aliases.ts` (new) — pure `resolveQueuePrefix({kind, source}, config)`, `deriveAliases`,
  `canonicalKey`, `padSeq`. One queue alias per ticket from kind **and** source, config-ordered
  precedence **USER > DEV > ISSUE**; a queue matches when source ∈ `queue.sources` OR kind ∈
  `queue.kinds`; the `default` queue is the fallback. Canonical key stays `ISSUE-NNNNNN`.
- `types.ts` — dropped `KindConfig.aliases`; added `QueueConfig` + `ProjectConfig.queues`.
- `config.ts` — `DEFAULT_CONFIG.queues` (USER: user_feedback/user_report; DEV: feature/task/
  investigation/tech_debt; ISSUE: bug/incident, default). Removed obsolete `aliasForKind` /
  `canonicalKindFromAlias`; `mergeConfig` defaults `queues` for older configs (backward compatible).
- `store.ts` — `createTicket` now uses `deriveAliases({kind, source}, seq, config)`.
- `test/aliases.test.ts` (new) — source-override / kind routing / fallback / custom queues. The demo
  golden is **unchanged** (existing aliases identical), proving the refactor is behavior-preserving.
  `npm test` is now **13**.
- `agentloop.config.json.example` + `docs/config.md` — document `queues`; drop per-kind `aliases`.
- `.gitignore` — also ignore a local `agentloop.config.json` in this repo.
- Verified: typecheck/build/13 tests + CLI smoke (`--source user_report` bug → `USER-`, smoke bug →
  `ISSUE-`, feature → `DEV-`). Pushed: commit `be8cf53`.

### Session 4 cont. — source-convergence audit (5b) + guard gaps (5c)

Both follow the same shape: a pure module + a thin `store` method + a JSON CLI command + a read-only
MCP tool + a dedicated test file. `npm test` is now **17**.

- **5b source-convergence** (`src/convergence.ts`, commit `54de32d`): `sourceConvergenceReport(
  tickets, patterns, {minSources=2, family?, includeAll?})` → patterns whose member tickets span ≥
  minSources distinct **sources**. `store.sourceConvergence()`, CLI `agentloop convergence
  [--family ..] [--min-sources N] [--all]`, MCP `agentloop_convergence`. `test/convergence.test.ts`.
- **5c guard gaps** (`src/guards.ts`, commit `23451a2`): `guardGapReport(tickets, config, {family?,
  includeWaived?, allKinds?, guardQueues?})` → resolved tickets lacking an active guard
  (guard_added/guard_existing = covered; gaps = missing/deferred/waived). Defaults to guard-relevant
  queues (ISSUE, USER) via `resolveQueuePrefix` — reuses 5a. `store.guardGaps()`, CLI
  `agentloop guard-gaps [--family ..] [--include-waived] [--all-kinds]`, MCP `agentloop_guard_gaps`.
  `test/guards.test.ts`.
- MCP now exposes **6 read tools** (summary/list/show/handoff/convergence/guard_gaps), **11** with
  `--write`. README + `docs/mcp.md` updated.

**5d resolution knowledge** (`src/knowledge.ts`, commit `c7d88c8`): `resolutionKnowledge(tickets,
{family?,kind?,source?,tag?,query?,limit?})` → searchable corpus of how resolved tickets were fixed
(each entry has a `verified` flag); `knowledgeGaps(tickets, {family?,severity?,source?})` → resolved
tickets with incomplete knowledge (`no_resolution`|`unverified`). `store.searchKnowledge()` /
`store.knowledgeGaps()`, CLI `knowledge` / `knowledge-gaps`, MCP `agentloop_search_knowledge` (the
plan's tool name) / `agentloop_knowledge_gaps`. `test/knowledge.test.ts`. MCP read tools now **8**
(13 with `--write`). `npm test` = **19**.

**5e prior-art relationships** (`src/prior-art.ts`, commit `7e7da49`): `relatedTickets(targetId,
tickets, {weights?, minScore?, limit?})` ranks related tickets via deterministic signals — shared
family / shared pattern / shared tags / same kind / title-summary token overlap (Jaccard) — each with
a weight. Resolved the plan's open question as **fixed deterministic defaults
(`DEFAULT_PRIOR_ART_WEIGHTS`), optionally tunable via `config.priorArt.weights`/`minScore`** (no
LLM/embeddings). `store.related(id)` (alias-aware), CLI `related <id> [--min-score N] [--limit N]`,
MCP `agentloop_related`. `test/prior-art.test.ts`.

### Session 4 cont. — smaller gaps closed (commits `ff7edd8`, `1e02b2c`)

- **`deferred` transition** (was missing): `store.deferTicket(id, reason?)`, CLI `agentloop defer
  <id> [--summary ..]`, MCP `agentloop_workflow` status `deferred`. `summary()` gains `deferredTickets`.
- **Redaction hook** (`TicketRedactor`): `src/redaction.ts` — `noopRedactor` (default),
  `createPatternRedactor(rules)`, `resolveRedactor(config, override)`. Store ctor takes `{ redactor? }`;
  resolves explicit override → `config.redaction.patterns` → no-op. Applied on every write path
  (create/note/resolve/guard/reopen/defer). Default is no-op so the demo golden is unchanged.
- **Persistence bug fixed** (latent correctness): `beginTicket`/`resolveTicket`/`reopenTicket` mutated
  the ticket *after* `transitionTicket` had already persisted, so `startedAt`, resolution fields, and
  the reopen note were lost on a fresh process (tests passed only via the in-memory store).
  `transitionTicket` no longer persists; each mutator persists once after its changes.
  `test/workflow.test.ts` is the regression guard (write via one store, read via a fresh one).
- `test/redaction.test.ts` added. `npm test` = **27**.

### Session 4 cont. — Phase 2: storage seam + Postgres (commit `ccb132a`)

- `src/backend.ts` (new): `StateBackend` port (`load`/`save`/optional `migrate`).
  `FilesystemStateBackend` (default; same `.agentloops/state.json` behavior) and `MemoryStateBackend`
  (clones snapshots). `AgentLoopStore` now takes `{ backend }` (defaults to filesystem) and no longer
  touches `fs`/`path` directly. Behavior-preserving — demo golden unchanged.
- `src/postgres.ts` (new): public relational `ticket_*` schema (`TICKET_SCHEMA_SQL`), pure
  `serializeState`/`deserializeRows` (LoopState ↔ rows), and `PostgresStateBackend` over an injected
  `pg`-compatible client (`{ query }`) — **no `pg` runtime dependency**. Saves are transactional
  (whole-snapshot replace on a dedicated pool connection); schema auto-creates on first use.
- Tables: `loop_meta`, `ticket_patterns`, `ticket_pattern_links`, `tickets`, `ticket_aliases`,
  `ticket_tags`, `ticket_notes`. Timestamps stored as ISO text for identical round-trips.
- Tests (`npm test` = **33**): `test/backend.test.ts` (fs/memory/store-over-memory/isolation);
  `test/postgres.test.ts` (pure round-trip + schema check always; **real-DB integration gated on
  `DATABASE_URL`**). Validated locally against Dockerized Postgres 16 (33/33, 0 skipped).
- `pg`+`@types/pg` are **devDependencies** only. CI gained a `postgres:16` service + `DATABASE_URL`
  so the integration test runs there too. `docs/postgres.md` + README updated.

### CLI/MCP Postgres wiring (commit `b1e118e`)

- `src/storage.ts` (new): `resolveBackend({cwd, config, databaseUrl?})` → `PostgresStateBackend` when a
  connection string is set (precedence: explicit > `DATABASE_URL` env > `config.storage.databaseUrl`),
  else `FilesystemStateBackend`. `pg` loaded via dynamic import (optional **peer** dependency; missing
  `pg` → actionable error). `resolvePostgresUrl` exported.
- `src/cli.ts`: `ensureConfig()` resolves+caches the backend once; dispatch wrapped in try/finally that
  **disposes storage** (closes the pool — one-shot commands would otherwise hang on idle connections).
  `init` reports the backend; help notes `DATABASE_URL`.
- `src/mcp.ts`: `startStdioMcpServer` takes a `backend` and stays alive until stdin closes (pool
  disposed on shutdown); stderr reports the backend kind.
- `types.ts`: optional `ProjectConfig.storage.databaseUrl`. `package.json`: `pg` optional peerDep.
- `test/storage.test.ts` (new): url precedence / fs fallback / postgres selection. `npm test` = **36**.
- Verified on Dockerized Postgres 16: `init`/`create`/`summary`/`list` persist + round-trip, processes
  exit cleanly, no local `.agentloops`. **Note**: ad-hoc `wsl bash -lc '...'` smokes are flaky with
  shell vars / `$()` / multiline (vars silently drop) — trust `npm test` + inline-path runs, not
  variable-based shell scripts.

### Phase 5: reference dashboard UI (commit `ce15d85`)

Zero-dependency reference UI — no React/Vite/bundler (keeps installs cheap, output fully testable).

- `src/dashboard.ts` (new): `renderDashboard(data)` → one self-contained HTML doc (inline CSS + tiny
  tab JS). Tabs: Tickets (grouped Issues/User/Development), Patterns, Convergence, Guard Gaps + summary
  cards. **All dynamic text HTML-escaped** (`escapeHtml`). `gatherDashboardData(store)` assembles it
  from existing store methods → works over filesystem **or** Postgres.
- `src/serve.ts` (new): `createDashboardServer(store)` — Node `http` (no deps); serves `/` (HTML) and
  read-only JSON at `/api/{summary,tickets,patterns,convergence,guard-gaps}`, re-read per request.
- `src/cli.ts`: `agentloop dashboard [--out file.html] [--stdout]` (static snapshot);
  `agentloop serve [--port N]` (live server, runs until stopped).
- `test/dashboard.test.ts` (new): render content + escaping of injected `<script>` + a live server
  smoke (ephemeral port, `fetch` `/` and `/api/summary`). `npm test` = **40**.
- `.gitignore`: default `agentloop-dashboard.html` output. README "Dashboard" section.
- A React component package is a possible future enhancement; `renderDashboard`/`createDashboardServer`
  are the building blocks.

## Status: plan 1–5 + small gaps + Phase 2 + CLI/MCP-on-Postgres + Phase 5 dashboard all done

MCP surface: **9 read + 5 write tools**. CLI: **23 commands**, filesystem or Postgres, with a built-in
dashboard. `npm test` = **40** (1 Postgres test skips without `DATABASE_URL`; CI runs it via a
`postgres:16` service). Commit chain: `…b1e118e → ce15d85`. All CI-green.

### npm publish prep (commit `f617ccd`) — DONE, awaiting the owner to publish

Package is publish-ready and validated by a clean-room install of the packed tarball:
- `package.json`: `files` ships only `dist/**/*.{js,d.ts}` + README/LICENSE/CHANGELOG/`docs/*.md`
  (dropped the 5.8MB unreferenced `images/` and the internal `docs/tickets/`); `publishConfig.access:
  public` (scoped pkgs default to restricted!); `exports` map; `prepublishOnly` (typecheck+build+test);
  `homepage`/`bugs`; `repository` → `git+https`. Tarball = **45 files / 44 kB**.
- `src/cli.ts`: stdout **EPIPE** guard (`agentloop list | head` no longer crashes).
- `CHANGELOG.md` (new) for 0.1.0.
- Verified: `npm install <tarball>` in a fresh project — `agentloop` bin runs, library `require()`
  exposes the API, `pg` correctly absent (optional peer), `.d.ts` present, no source maps.
- **Registry state**: name `@stevenvincentone/intidev-agentloops` is **unpublished** (404 = available);
  the dev machine is **not logged in** (`npm whoami` → ENEEDAUTH). The owner must `npm login` (as the
  `stevenvincentone` scope owner) and run `npm publish` (access:public is already configured).

### npm publish — DONE

`@stevenvincentone/intidev-agentloops@0.1.0` is live on the registry (verified via a clean-room
`npm install` of the published package — bin runs, library exports resolve, `pg` stays an absent
optional peer). Commit `cf3842c`.

### GitHub Issues sync (commit `bafdc34`) — DONE

Added two-way sync between tickets and GitHub Issues, mirroring the `PgClient` injected-client
pattern so it's network-free and testable:
- `src/github.ts` (new): `GithubClient` interface, `createFetchGithubClient` (zero-dep, built on
  Node's global `fetch`), URL parsing, label derivation (`queue:x`/`kind:x`/`severity:x`/`status:x`
  with config overrides), issue payload building (title/body mirror).
- `store.linkGithubIssue` (manual link by URL) and `store.syncGithubIssue` (create-or-update +
  import new comments as `external`-type notes, deduped via `lastSyncedCommentId` cursor).
- New `Ticket.github` field (`TicketGithubLink`) persisted through both the filesystem and
  Postgres backends (`TICKET_SCHEMA_SQL` + 4 new `github_*` columns, full row mapping in both
  directions).
- CLI: `agentloop github-link <id> <url>`, `agentloop github-sync <id>`.
- MCP: `agentloop_github_sync` write tool (gated behind `--write`); MCP surface is now
  **9 read + 6 write = 15 tools**.
- Config: optional `github.repo` / `github.tokenEnv` (token resolved from an env var, never
  stored in config) / `github.labels` overrides — see `docs/config.md`.
- Tests: `test/github.test.ts` (6 new, incl. `FakeGithubClient` exercising the full
  create→update→import→dedupe flow with no real network calls). `npm test` = **46** (45 pass,
  1 Postgres test skips without `DATABASE_URL`).
- Docs: README "GitHub Issues sync" section, `docs/config.md`, `docs/mcp.md` table row.
- CI green on `bafdc34`.

### Where to go next

- **Dogfood**: run `agentloop` on AgentLoops' own ledger.
- **React component package** / richer UI (current dashboard is a static snapshot + tiny server).
- **Durable prior-art** edges (5e computes on demand; Inti persists edges + evidence).
- Minor: `normalizeTicketInput` doesn't zero-pad (`ISSUE-3` won't resolve to `ISSUE-000003`); Inti's
  `normalizeTicketIdentifier` pads. Low impact since the system emits padded ids.

## Tracking / housekeeping

- Umbrella tracking ticket in Inti: **DEV-000847** — record findings there until AgentLoops has
  its own mature dogfood ledger.
- The plan is **mirrored in two files**; keep them synchronized:
  - `/home/inti/AgentLoops/docs/tickets/2026-06-01_TICKETS_EXTRACTED_REPO_PLAN.md`
  - `/home/inti/inti-docs/docs/issues-tickets/2026-06-01_TICKETS_EXTRACTED_REPO_PLAN.md`
- **Committed + pushed** to `origin/main`: sessions 2 and 3 work (demo fixture, MCP server, CI gates,
  `package-lock.json`, README/docs/mcp). The canonical plan doc was already public (session 1).
- **Still untracked (deliberately not pushed)**: the internal planning `docs/tickets/*.md` (novelty
  research, agent JSON contracts, readiness/dogfood gate, prior-art & recurrence plan, knowledge-graph
  design, codex workflow, smoke integration, archive/) **and this handoff**. These contain internal
  WSL paths / Inti references; they live locally for session continuity. The repo is intentionally a
  minimal public scaffold. Decide per-doc whether any belong in the public repo before committing.

## First action on resume

From `/home/inti/AgentLoops`:

```bash
npm install
npm run typecheck && npm run build && npm test   # confirm still green (6 tests)
npm run demo                                       # see the convergence demo
node dist/cli.js help                              # sanity check (now lists `mcp`)
```

Then start step 5 (port Inti proven modules, in order). Begin with the **alias/kind config**
reconciliation: AgentLoops currently derives aliases purely from `kind`; Inti
(`/home/inti/inti-docs/src/shared/TicketAliases.ts`, ~75 lines, near-copyable) also derives `USER`
from the `user_report` *source* and `DEV` from a set of kinds over a single numeric `ISSUE-N`. Port
it as a pure module with **no Inti imports**, then move on to the source-convergence audit.
