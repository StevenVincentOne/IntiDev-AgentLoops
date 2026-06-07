<img width="450" height="225" alt="image" src="https://github.com/user-attachments/assets/802115de-3705-4a47-9b50-3b6ead44db91" />

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
- `agentloop create [--prior-art-hint new|previously_ticketed|existing_pattern|adjacent_issues]` add a ticket; a non-`new` hint auto-checks for and prints possible prior art (see "History context")
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
- `agentloop workflow-audit` report patterns whose status disagrees with their linked tickets
- `agentloop workflow-repair [--dry-run]` fix that drift: reopen/resolve patterns to match their tickets
- `agentloop near-duplicates` report open tickets whose title/summary look like the same problem
- `agentloop groups [--family ..] [--min-size 2] [--limit 10]` broad triage clusters of open work worth reviewing together — not resolution objects (see Patterns); customize clustering vocabulary via `ticketGroups.customRules` in config
- `agentloop knowledge` search how prior resolved tickets were fixed
- `agentloop knowledge-gaps` report resolved tickets lacking reusable knowledge
- `agentloop related <id>` find prior-art tickets related to one ticket (on-the-fly, not persisted)
- `agentloop prior-art-graph <id>` show a ticket's durable, decaying prior-art edges (persisted by `prior-art-refresh`)
- `agentloop prior-art-refresh` recompute and persist the prior-art graph, reinforcing/decaying/pruning edges
- `agentloop dashboard` write a standalone HTML dashboard
- `agentloop serve` serve the dashboard over HTTP
- `agentloop config` print resolved configuration
- `agentloop mcp` run the read-only MCP server over stdio
- `agentloop github-link <id> <issue-url>` manually link a ticket to an existing GitHub Issue
- `agentloop github-sync <id>` create/update the linked Issue and import new comments (needs `github.repo`)

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
| `agentloop_workflow_audit` | patterns whose status disagrees with their linked tickets |
| `agentloop_near_duplicates` | open tickets whose title/summary look like the same problem |
| `agentloop_ticket_groups` | broad triage clusters of open work — "worth reviewing together," not resolution objects (see Patterns); each group surfaces narrower "candidate splits" |
| `agentloop_search_knowledge` | search how prior resolved tickets were fixed |
| `agentloop_knowledge_gaps` | resolved tickets lacking reusable knowledge |
| `agentloop_related` | prior-art: tickets related to a given ticket (on-the-fly, not persisted) |
| `agentloop_prior_art_graph` | a ticket's durable, decaying prior-art edges (persisted by `prior-art-refresh`) |

Write tools (only registered with `--write`):

| Tool | Purpose |
| --- | --- |
| `agentloop_create` | create a ticket (`summary` required; `source` defaults to `agent`); optional `priorArtHint` records intake-time "history context" and, when it suggests prior art may exist, auto-surfaces candidates as `priorArtSuggestions` |
| `agentloop_note` | append a non-resolution note |
| `agentloop_workflow` | transition a ticket (`active` / `reopened` / `deferred`) |
| `agentloop_resolve` | resolve with a summary, optional verification + guard |
| `agentloop_guard` | record a regression-guard decision |
| `agentloop_prior_art_refresh` | recompute + persist the prior-art graph (reinforce / decay / prune edges) |
| `agentloop_workflow_repair` | fix `agentloop_workflow_audit` drift by reopening/resolving patterns to match their tickets (pass `dryRun: true` to preview without mutating) |

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

Registering the server gives an agent *access* to the ledger — it doesn't by
itself change what the agent does. To get an agent to actually use the loop
as part of its normal workflow (check prior art before debugging, record a
guard before calling something fixed, etc.), add operating rules to its
`AGENTS.md`/`CLAUDE.md`. See **[docs/agent-integration.md](docs/agent-integration.md)**
for a copy/adapt playbook template (CLI and MCP forms of every rule).

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
exports can be built upon — or use the React components below.

## React components

For teams that want to embed AgentLoops data in their own React app rather than
the static dashboard, [`@stevenvincentone/intidev-agentloops-react`](packages/react)
ships a data hook and presentational components (`useAgentLoopData`,
`<SummaryCards>`, `<TicketList>`, `<PatternList>`) that talk to the same
read-only `/api/*` JSON served by `agentloop serve`:

```bash
npm install @stevenvincentone/intidev-agentloops-react react react-dom
```

```tsx
import { useAgentLoopData, SummaryCards, TicketList } from "@stevenvincentone/intidev-agentloops-react";

function LoopDashboard() {
  const { data, loading, error } = useAgentLoopData({ baseUrl: "http://localhost:4319" });
  if (!data) return <p>Loading…</p>;
  return (
    <>
      <SummaryCards summary={data.summary} />
      <TicketList tickets={data.tickets} />
    </>
  );
}
```

See [packages/react/README.md](packages/react/README.md) for the full component
list and styling notes (everything ships with predictable `agentloops-*` class
names — bring your own CSS).

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

## Ticket Groups (triage clusters)

`agentloop groups` (and the `agentloop_ticket_groups` MCP tool) surfaces broad,
low-investment **Groups**: clusters of open work that are "worth reviewing
together," explicitly distinguished from **Patterns** (a curated, corroborated
shared root cause). Groups are the cheap front door — a triage queue — and a
Group only earns a Pattern once a narrower shared signal is confirmed. Each
group also lists **candidate splits**: narrower sub-clusters sharing a
*different* signal, worth reviewing as their own Group/Pattern before assuming
the whole cluster shares one cause.

Out of the box, grouping runs on generic, zero-config bases — `family`, shared
`tags`, and auto-detected recurring keywords (the same `tokenize`/`jaccard`
text-overlap machinery `near-duplicates` uses, generalized into clusters). Most
real projects also have their own recurring vocabulary — known error codes, a
correlation key embedded in ticket text, a release tag — that's specific to
their domain. Rather than baking any of that in, `ticketGroups.customRules` in
`agentloop.config.json` is the customization path:

```json
{
  "ticketGroups": {
    "minSize": 2,
    "limit": 10,
    "customRules": [
      { "name": "rate_limit_429", "label": "Rate-limit (HTTP 429)", "kind": "keyword", "pattern": "\\b429\\b|rate.?limit" },
      { "name": "doc_id", "label": "Document", "kind": "correlation", "pattern": "doc[_-]?id[:=]\\s*([\\w-]+)" }
    ]
  }
}
```

- `kind: "keyword"` rules bucket every ticket whose text matches `pattern` into
  one shared group named by `label`.
- `kind: "correlation"` rules require a single capture group; whatever text it
  captures becomes the bucket key, so tickets are grouped by the *value* they
  share (a document id, a customer id, …) rather than by the rule itself.

This is how a project like Inti — whose Ticket Groups feature inspired this
report and clusters on a tagging-audit-code vocabulary and document
fingerprints — can express that exact behavior as a config file on top of a
domain-agnostic engine, without AgentLoops core ever needing to know what an
"audit code" or a "document fingerprint" is.

## History context (prior-art hints)

When filing a ticket, a reporter (human or agent) often already has an opinion
about whether it's new or connects to something else. `agentloop create` (and
`agentloop_create` over MCP) accepts an optional `--prior-art-hint` capturing
that self-assessment:

| Hint | Meaning |
| --- | --- |
| `new` | "As far as I know, this hasn't come up before." |
| `previously_ticketed` | "I think this (or something very like it) has been reported." |
| `existing_pattern` | "I think this belongs to a known recurring problem." |
| `adjacent_issues` | "I think this is related to other open work, even if not identical." |

The hint always round-trips onto the created ticket (`ticket.priorArtHint`).
But AgentLoops doesn't stop at storing a label nobody acts on: whenever the
hint is anything other than `new`, ticket creation **automatically runs a
prior-art check** (the same scoring `agentloop related` uses — family, Pattern,
shared tags, kind, and title/summary text-overlap) against the brand-new
ticket and surfaces the strongest candidates immediately:

```bash
$ agentloop create --title "Export still hangs on long PDFs again" \
    --summary "A user reports the export pipeline hangs again on very long PDF reports under load" \
    --family export_pipeline --kind bug --source user_report \
    --prior-art-hint previously_ticketed

Created ISSUE-000002 (USER-000002)
kind=bug family=export_pipeline status=triaged
title: Export still hangs on long PDFs again
Pattern: PATTERN-000001
Possible prior art (priorArtHint=previously_ticketed):
  ISSUE-000001  score=8.8  Export hangs on long PDFs  [family, pattern, kind, text:0.45]
```

Over MCP, `agentloop_create` returns the same candidates as a
`priorArtSuggestions` array on the write-result envelope (only present when
the hint warrants a check and candidates are found), so an agent can confirm
or rule out a match — "did you mean ISSUE-000042?" — right at intake instead
of discovering the duplicate during triage. `--json` on the CLI surfaces the
same `{ ticket, priorArtSuggestions }` shape.

## GitHub Issues sync (optional)

Off by default. Set `github.repo` (and a `GITHUB_TOKEN`-style env var) to mirror
tickets onto linked GitHub Issues — title, body, and labels (queue/kind/severity/status,
each overridable). Tickets remain the richer agent-memory layer; the Issue is a
public mirror others can read and comment on.

```sh
agentloop github-sync ISSUE-000001   # create or update the linked Issue, import new comments
agentloop github-link ISSUE-000001 https://github.com/owner/name/issues/42   # manual link
```

New Issue comments are imported as redacted `external` ticket notes (deduped via
a synced-comment cursor). No SDK dependency — the default client wraps the
GitHub REST API with Node's built-in `fetch`. See [docs/config.md](docs/config.md#github-issues-sync-optional).

## Contributing

Open issues and PRs are welcome.

When adding new sources or fields, include:

1. a config-backed approach, not hardcoded assumptions,
2. a short schema note in docs,
3. a concise example command and expected output.

## License

MIT. See [LICENSE](LICENSE).
