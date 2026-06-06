# IntiDev AgentLoops

### Feedback Loops for Agentic Workflows

IntiDev AgentLoops is an open-source toolkit for tracking issues, features, and user feedback through an agent-friendly resolution loop. It is intentionally lightweight and project-agnostic, while remaining opinionated about reproducibility, resolution hygiene, and machine-readable handoff artifacts.

This repo is the first extractable iteration from our internal Tickets implementation, and is aimed at:

- developers building AI coding workflows,
- teams that need one loop for bugfixes, features, and support feedback,
- maintainers who want reusable resolution knowledge and structured evidence.

## Why this project exists

Most bug trackers treat support, defects, and features as separate workflows.
IntiDev AgentLoops links them into one consistent lifecycle so humans and agents use the same ticket surface and knowledge.

## Quick install

```bash
npm install -g @stevenvincentone/intidev-agentloops
```

Then run:

```bash
agentloop init
agentloop create --title "Rendering regression in list pages" --summary "List pages lose anchors after parser update" --family "reader_rendering" --kind bug --source manual_admin
agentloop list
agentloop resolve ISSUE-000001 --summary "Added deterministic fallback for anchor selection"
```

## Try the convergence demo

Run a self-contained demo that seeds three independent intake loops — a smoke
test, a user report, and an agent proposal — all pointing at the same
`export_pipeline` family, and watch them converge into a single Pattern:

```bash
npm run demo
```

Expected output:

```text
AgentLoops source-convergence demo
==================================

Three intake loops, one underlying problem:

  ISSUE-000001  bug            source=smoke        [export_pipeline]
    Export smoke test times out on 500-page report
  USER-000002   user_feedback  source=user_report  [export_pipeline]
    Export fails for long reports
  DEV-000003    feature        source=agent        [export_pipeline]
    Stream the export pipeline instead of buffering

Converged into:
  PATTERN-000001 ACTIVE (3 tickets) — Recurring export_pipeline issues

Summary: 3 tickets, 1 active pattern(s).
```

The demo writes to a throwaway temp directory and leaves your repo untouched.
The same scenario is asserted in `test/demo.test.ts` against a committed golden
state fixture; run it with `npm test`.

## Core concepts

- Ticket: one concrete work item (bug, feature, user feedback, incident, etc.)
- Pattern: a recurring cluster, often by family/domain
- Source: origin (`user_report`, `smoke`, `ci`, `agent`, `ingestion`, etc.)
- Alias: human-facing IDs such as `ISSUE-000001`, `DEV-000001`, `USER-000001`
- Handoff: copyable context block for an agent to continue execution

## Commands

- `agentloop init` initialize `.agentloops` state and local config
- `agentloop create` add a ticket
- `agentloop list` view active and resolved work
- `agentloop begin <id>` mark triaged ticket as in-progress
- `agentloop resolve <id> --summary ...` mark resolved with evidence
- `agentloop reopen <id>` reopen and record a recurrence reason
- `agentloop defer <id> [--summary ...]` defer a ticket with an optional reason
- `agentloop note <id> --type ... --body ...` add context notes
- `agentloop guard <id> --guard-status ...` record guard decision
- `agentloop handoff <id>` print a copyable agent handoff prompt
- `agentloop patterns` list pattern groups
- `agentloop summary` print quick health metrics
- `agentloop convergence` report patterns whose tickets span multiple sources
- `agentloop guard-gaps` report resolved tickets missing a regression guard
- `agentloop knowledge` search how prior resolved tickets were fixed
- `agentloop knowledge-gaps` report resolved tickets lacking reusable knowledge
- `agentloop related <id>` find prior-art tickets related to one ticket
- `agentloop dashboard` write a standalone HTML dashboard
- `agentloop serve` serve the dashboard over HTTP
- `agentloop config` print resolved configuration
- `agentloop mcp` run the read-only MCP server over stdio

All commands support `--json` for machine-readable output where relevant.

## MCP server (agent integration)

AgentLoops ships an [MCP](https://modelcontextprotocol.io) server so coding
agents (Claude Code, Codex, and other MCP clients) can use the ledger directly.
Writes are **opt-in**: the server is read-only unless you pass `--write`.

```bash
agentloop mcp            # read-only; speaks JSON-RPC over stdio, status to stderr
agentloop mcp --write    # also expose the guarded write tools
```

Read-only tools (annotated `readOnlyHint`):

| Tool | Purpose |
| --- | --- |
| `agentloop_summary` | loop health metrics (ticket and pattern counts) |
| `agentloop_list` | list tickets, optional `status` / `kind` filters |
| `agentloop_show` | one ticket (by `ISSUE-`/alias) or a `PATTERN-` id |
| `agentloop_handoff` | copyable agent handoff prompt for a ticket |
| `agentloop_convergence` | patterns whose tickets span multiple sources |
| `agentloop_guard_gaps` | resolved tickets missing a regression guard |
| `agentloop_search_knowledge` | search how prior resolved tickets were fixed |
| `agentloop_knowledge_gaps` | resolved tickets lacking reusable knowledge |
| `agentloop_related` | prior-art: tickets related to a given ticket |

Write tools (only registered with `--write`):

| Tool | Purpose |
| --- | --- |
| `agentloop_create` | create a ticket (`summary` required; `source` defaults to `agent`) |
| `agentloop_note` | append a non-resolution note |
| `agentloop_workflow` | transition a ticket (`active` / `reopened` / `deferred`) |
| `agentloop_resolve` | resolve with a summary, optional verification + guard |
| `agentloop_guard` | record a regression-guard decision |

Each result is a JSON envelope with `schemaVersion` and `generatedAt`. The server
reads/writes state from the `.agentloops/state.json` in its working directory, so
run it from your project root (or where you ran `agentloop init`).

Register it with an MCP client, for example Claude Code:

```bash
claude mcp add agentloop -- agentloop mcp
```

or directly in a client config:

```json
{
  "mcpServers": {
    "agentloop": { "command": "agentloop", "args": ["mcp"] }
  }
}
```

## Dashboard

A zero-dependency reference UI renders the ledger as a single self-contained HTML
page — queues (Issues / User / Development), patterns, source convergence, and
guard gaps — with no build step or frontend framework.

```bash
agentloop dashboard --out dashboard.html   # write a static snapshot, open in a browser
agentloop serve --port 4319                # live dashboard + read-only JSON at /api/*
```

Both work over either storage backend. All ticket content is HTML-escaped. For a
richer or embeddable UI, the `renderDashboard(data)` and `createDashboardServer(store)`
exports can be built upon.

## Data model

State is stored in your working directory at `.agentloops/state.json` by default.
The store persists through a pluggable `StateBackend`, so the same ledger can run
over the filesystem, an in-memory store, or **Postgres** (a relational `ticket_*`
schema) — see [docs/postgres.md](docs/postgres.md).

For local project settings, copy and customize:

```bash
cp agentloop.config.json.example agentloop.config.json
```

The config controls:

- project naming
- ticket kinds and aliases (`ISSUE`, `DEV`, `USER`, etc.)
- default family for auto-grouping
- configured sources

## Privacy and redaction

By default AgentLoops stores ticket text as-is and makes no model or network calls.
Host apps own redaction. Two ways to scrub sensitive content (PII, secrets) before
it is written to `.agentloops/state.json`:

- **Config-driven** — add regex rules under `redaction.patterns` in
  `agentloop.config.json`; they apply to titles, summaries, notes, resolutions,
  and guard summaries on every write (CLI and MCP included):

  ```json
  { "redaction": { "patterns": [{ "pattern": "[\\w.]+@[\\w.]+\\.[a-z]+", "replacement": "[email]" }] } }
  ```

- **Code-driven** — library users can inject a `TicketRedactor`:
  `new AgentLoopStore(cwd, config, { redactor })`.

## Contributing

Open issues and PRs are welcome.

When adding new sources or fields, include:

1. a config-backed approach, not hardcoded assumptions,
2. a short schema note in docs,
3. a concise example command and expected output.

## License

MIT. See [LICENSE](LICENSE).
