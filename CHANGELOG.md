# Changelog

All notable changes to this project are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## 0.1.0

First public release.

### Core
- Durable ticket ledger with kinds, statuses, severities, confidences, and notes.
- Source-aware **queue aliases** (`ISSUE-` / `USER-` / `DEV-`) derived from kind and
  source, over a single canonical `ISSUE-NNNNNN` id (config-driven `queues`).
- Family-based **Pattern** grouping (auto-activates at ≥2 tickets).
- Workflow transitions: begin, resolve, reopen, **defer**.
- **Source-convergence audit**, **guard-gap report**, **resolution knowledge** search +
  gaps, and **prior-art** related-ticket lookup (config-tunable scoring).
- Copyable agent **handoff** prompts.
- Optional **redaction** hook (`TicketRedactor`) — config patterns or injected redactor.

### Storage
- Pluggable `StateBackend`: filesystem JSON (default), in-memory, and **Postgres**
  (public relational `ticket_*` schema; `pg` is an optional peer dependency).
- CLI and MCP run on Postgres automatically via `DATABASE_URL`.

### Interfaces
- `agentloop` **CLI** (init, create, list, show, patterns, begin, resolve, reopen,
  defer, note, guard, handoff, summary, convergence, guard-gaps, knowledge,
  knowledge-gaps, related, dashboard, serve, config, mcp).
- **MCP server** (`agentloop mcp`): 9 read-only tools, plus 5 write tools behind `--write`.
- Zero-dependency **dashboard** (`agentloop dashboard` / `agentloop serve`).
