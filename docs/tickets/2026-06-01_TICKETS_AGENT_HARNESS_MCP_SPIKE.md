# Tickets Agent Harness MCP Spike

Companion plan: `docs/issues-tickets/2026-06-01_TICKETS_EXTRACTED_REPO_PLAN.md` covers the extracted public repo, package boundary, adapter contracts, install flow, and release phases. This spike focuses only on the MCP surface.

## Goal

Frame Tickets as an agent harness that can extend Codex, Claude Code, and other coding agents without requiring those agents to know the host app internals.

## Initial MCP Shape

Start read-only and deterministic:

- `tickets.list`: list active, development, guard-gap, or resolved tickets.
- `tickets.show`: return one ticket with notes, events, artifacts, development brief, and guard state.
- `tickets.related`: return prior art, relationship edges, and resolution knowledge.
- `tickets.development`: return Development lanes such as ready, needs-spec, in-progress, blocked, and deferred.

Then add controlled writes:

- `tickets.create`: create issue or development tickets with typed context.
- `tickets.note`: append triage, hypothesis, prior-fix, verification, or handoff notes.
- `tickets.workflow`: update Development status/readiness with an audit note.
- `tickets.resolve`: resolve with verification evidence and guard decision rules.
- `tickets.guard`: record added/existing/waived/deferred regression guards.

## Distribution Boundary

The reusable package should own the ledger schema, CLI, MCP server, prior-art matching, workflow transitions, and agent handoff generation. Host apps should supply adapters for auth, artifact storage, app-specific telemetry sources, and UI embedding.

## Adoption Path

1. Keep the current Inti implementation as the reference harness.
2. Extract a package boundary around the service, CLI, taxonomy, smoke registry, and MCP tools.
3. Ship host adapters for local filesystem/Postgres first.
4. Add docs for installing Tickets into an existing project and exposing it to an agent as MCP.
