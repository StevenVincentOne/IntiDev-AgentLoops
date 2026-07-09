# MCP server

AgentLoops exposes a [Model Context Protocol](https://modelcontextprotocol.io)
server so coding agents can use the ticket ledger directly. Writes are **opt-in**:
the server is read-only by default and only registers the write tools (create /
amend / note / workflow / resolve / guard) when started with `--write`.

## Running

```bash
agentloop mcp            # read-only
agentloop mcp --write    # also expose the write tools (alias: --allow-writes)
```

- Communicates over **stdio** using JSON-RPC. `stdout` carries only the protocol
  stream; human-readable status (including the read-only/read-write mode) is
  written to `stderr`.
- Reads/writes `.agentloops/state.json` from the **current working directory**, so
  start it from the project root where you ran `agentloop init`.
- Implemented over the same `AgentLoopStore` as the CLI, so the CLI and MCP
  surfaces always agree.

## Read-only tools

Always available; annotated `readOnlyHint: true`.

| Tool | Input | Returns |
| --- | --- | --- |
| `agentloop_summary` | none | `{ schemaVersion, generatedAt, summary }` — ticket/pattern counts |
| `agentloop_list` | `status?`, `kind?`, `family?`, `queue?` | `{ ..., filters, count, tickets }` |
| `agentloop_show` | `id` | `{ ..., kind: "ticket", ticket }` or `{ ..., kind: "pattern", pattern }` |
| `agentloop_handoff` | `id` | `{ ..., ticketId, aliases, prompt }` |
| `agentloop_convergence` | `family?`, `minSources?`, `includeAll?` | `{ ..., filters, summary, patterns }` — patterns whose tickets span ≥ `minSources` (default 2) distinct sources |
| `agentloop_guard_gaps` | `family?`, `includeWaived?`, `allKinds?` | `{ ..., filters, summary, gaps }` — resolved tickets (ISSUE/USER queues by default) lacking an active regression guard |
| `agentloop_workflow_audit` | `family?` | `{ ..., filters, summary, patterns }` — patterns whose status disagrees with their linked tickets: resolved patterns with active (or reopened) linked tickets (closed too early), and open/active/reopened patterns whose linked tickets are all closed out (stale, ready to resolve) |
| `agentloop_near_duplicates` | `family?`, `minTextOverlap?`, `includeResolved?`, `limit?` | `{ ..., filters, summary, pairs }` — ticket pairs whose title/summary overlap heavily (Jaccard token-overlap), a likely sign the same problem was reported twice; scoped to open work (triaged/active/reopened/deferred) by default, `includeResolved` widens for historical audits |
| `agentloop_ticket_groups` | `family?`, `minSize?`, `limit?` | `{ ..., filters, summary, groups }` — broad triage clusters of open work worth reviewing together (not resolution objects — see Patterns); each group surfaces narrower "candidate splits" and is identified by a stable `key` (e.g. `family:export_pipeline`) |
| `agentloop_begin_group` | `id` (group key or title), `relatedLimit?`, `priorArtLimit?`, `ticketLimit?` | `{ ..., group, patternFamily, activePatterns, historicalPatterns, priorArt, familyKnowledge, relatedByTicket, hypotheses, nextSteps }` — "begin before you build" workbench: aggregates cross-member prior art and resolution knowledge for a computed Group and ranks Pattern-discovery hypotheses (e.g. compare against an existing Pattern, recurring resolved prior art, candidate symptom-split); run this before implementing fixes for a Group surfaced by `agentloop_ticket_groups` |
| `agentloop_search_knowledge` | `family?`, `kind?`, `source?`, `tag?`, `query?`, `limit?` | `{ ..., filters, summary, entries }` — how prior resolved tickets were fixed (searchable corpus) |
| `agentloop_knowledge_gaps` | `family?`, `severity?`, `source?` | `{ ..., filters, summary, gaps }` — resolved tickets whose knowledge is incomplete (missing resolution or verification) |
| `agentloop_related` | `id`, `minScore?`, `limit?` | `{ ..., ticket, weights, related }` — prior-art lookup ranking tickets by shared family/pattern/tags/kind and title overlap (weights tunable via `config.priorArt`) |
| `agentloop_prior_art_graph` | `id`, `minStrength?`, `decayHalfLifeDays?`, `limit?` | `{ ..., ticket, filters, edges }` — a ticket's *persisted*, decaying prior-art edges (durable connections discovered by `agentloop_prior_art_refresh` that fade over time without fresh evidence — unlike `agentloop_related`, which recomputes relatedness fresh on every call and forgets it instantly); `edges[].strength` reflects decay applied at query time, not just at the last refresh |

## Write tools

Only registered with `--write`. Each returns `{ schemaVersion, generatedAt,
action, ticket }`, where `ticket` carries the canonical `id` and queue `aliases`.

| Tool | Input | Notes |
| --- | --- | --- |
| `agentloop_create` | `summary` (required), `title?`, `family?`, `kind?`, `source?`, `severity?`, `confidence?`, `tags?`, `handoff?` | `kind`/`family` default from config; `source` defaults to `agent` |
| `agentloop_amend` | `id`, `title?`, `summary?`, `family?`, `severity?`, `confidence?`, `tags?`, `handoff?`, `addInstance?`, `instanceType?`, `instanceAuthor?` | Updates mutable ticket fields and optionally appends one non-resolution `addInstance` note for the same ticket in one request |
| `agentloop_note` | `id`, `body` (required), `type?`, `author?` | `type` defaults to `triage`, `author` to `agent` |
| `agentloop_workflow` | `id`, `status` (`active` \| `reopened` \| `deferred`), `reason?` | resolve via `agentloop_resolve`, not here |
| `agentloop_resolve` | `id`, `summary` (required), `verification?`, `guardStatus?`, `guardSummary?`, `verificationBrief?` | Tickets in a configured evidence-sensitive family/kind (`config.verification`) require `verificationBrief` (`{ claimScope, affectedArtifactIds?, reportedLocations?, verificationPerformed, coverage, agentJudgment, reason }`) — deterministic guardrails check it's present and coherent, the agent's `agentJudgment`/`reason` supply the actual sufficiency call; see [Verification briefs](agent-integration.md#verification-briefs-deterministic-guardrails-vs-agent-judgment) |
| `agentloop_resolve_pattern` | `id` (Pattern id), `summary` (required), `verification?`, `guardStatus?`, `guardSummary?`, `verificationBrief?` | resolves a Pattern and cascades the same resolution evidence to every not-yet-resolved linked ticket (the multi-ticket counterpart to `agentloop_resolve`); counts how many linked tickets are evidence-sensitive and, once ≥ 2 are, escalates the fresh-evidence and broad-coverage requirements for all of them regardless of the brief's claimed scope (`escalatedVerification` reports this) — validation runs for every linked ticket before any mutation, so a bad cascade fails atomically. Returns `{ schemaVersion, generatedAt, action: "resolved_pattern", pattern, resolvedTickets, alreadyResolvedTickets, escalatedVerification }` instead of the common write envelope shape |
| `agentloop_guard` | `id`, `guardStatus`, `guardSummary?` | |
| `agentloop_prior_art_refresh` | `minScore?`, `decayHalfLifeDays?`, `pruneBelowStrength?` | recomputes deterministic relatedness for every ticket pair and persists it as durable, decaying edges: pairs that still qualify are reinforced (or created), pairs that no longer qualify fade in place via decay, and edges decayed past the prune floor are dropped. Returns `{ schemaVersion, generatedAt, summary: { ticketsConsidered, pairsScored, edgesReinforced, edgesCreated, edgesDecayedOnly, edgesPruned, totalEdges } }` instead of the common write envelope shape — query the result via `agentloop_prior_art_graph` |
| `agentloop_workflow_repair` | `family?`, `dryRun?` | fixes the drift `agentloop_workflow_audit` surfaces by flipping `Pattern.status` to agree with its linked tickets (resolved-with-active-tickets → reopened, all-linked-tickets-closed → resolved). Pass `dryRun: true` to preview the identical plan without mutating anything (`applied: false`); omit it to apply and persist (`applied: true`). Returns `{ schemaVersion, generatedAt, filters, summary, actions, applied }` (a `WorkflowRepairPlan`/`WorkflowRepairResult`) instead of the common write envelope shape |
| `agentloop_promote_group` | `id` (group key or title), `title?`, `summary?`, `family?`, `actor?` | promotes a computed Group into a trackable Pattern: finds-or-reuses a non-resolved Pattern in the Group's dominant family, links not-yet-linked members (`pattern.ticketIds` / `ticket.patternId`), records provenance via a `related_history` note on each newly-linked ticket, and (re)writes `pattern.summary` with prose provenance. Idempotent — re-running reuses the same Pattern, refreshes its summary, and links nothing new. Returns `{ schemaVersion, generatedAt, action: "created" \| "reused", group, pattern, linkedTickets }` instead of the common write envelope shape |
| `agentloop_github_sync` | `id` | requires `github.repo` in config; returns `{ ticket, issueUrl, issueNumber, importedComments }` instead of the common write envelope shape |

Notes:

- `id` accepts the canonical `ISSUE-NNNNNN` id, any queue alias (`DEV-...`,
  `USER-...`, etc.), or a `PATTERN-NNNNNN` id for `agentloop_show`.
- `status` (for `agentloop_list`) accepts `triaged | active | resolved | reopened | deferred | open | all`.
- `family` and `queue` (for `agentloop_list`) narrow the surface by domain and queue alias (`issues`, `development`, `user`, `ISSUE`, `DEV`, `USER`).
- `kind`, `severity`, `confidence`, `guardStatus`, and note `type` are validated
  against the configured/known values; invalid inputs return a readable error.
- Every envelope includes `schemaVersion` (currently `1`) and `generatedAt`.
  Fields are added, not removed, within a schema version.
- Unknown ids return a tool error (`isError: true`) with a readable message
  rather than failing the protocol call.
- Writes pass through the configured redactor before storage (no-op by default;
  see `redaction.patterns` in [config](config.md) or inject a `TicketRedactor`).

## Client configuration

Claude Code:

```bash
claude mcp add agentloop -- agentloop mcp
```

Generic MCP client config:

```json
{
  "mcpServers": {
    "agentloop": {
      "command": "agentloop",
      "args": ["mcp"]
    }
  }
}
```

If you have not installed the package globally, point the client at the built CLI
instead, e.g. `"command": "node", "args": ["/path/to/dist/cli.js", "mcp"]`.

## Getting an agent to actually use these tools

Registering the server only makes the tools *available* — it doesn't teach an
agent when to reach for them. For that, add operating rules to the agent's
`AGENTS.md`/`CLAUDE.md` (or equivalent): see
[agent-integration.md](agent-integration.md) for a copy/adapt playbook
template that maps each step of a typical dev loop (triage → investigate →
fix → verify → guard) onto the CLI commands and MCP tools above.
