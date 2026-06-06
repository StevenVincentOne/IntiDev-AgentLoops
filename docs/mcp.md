# MCP server

AgentLoops exposes a [Model Context Protocol](https://modelcontextprotocol.io)
server so coding agents can use the ticket ledger directly. Writes are **opt-in**:
the server is read-only by default and only registers the write tools (create /
note / workflow / resolve / guard) when started with `--write`.

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
| `agentloop_list` | `status?`, `kind?` | `{ ..., filters, count, tickets }` |
| `agentloop_show` | `id` | `{ ..., kind: "ticket", ticket }` or `{ ..., kind: "pattern", pattern }` |
| `agentloop_handoff` | `id` | `{ ..., ticketId, aliases, prompt }` |
| `agentloop_convergence` | `family?`, `minSources?`, `includeAll?` | `{ ..., filters, summary, patterns }` — patterns whose tickets span ≥ `minSources` (default 2) distinct sources |
| `agentloop_guard_gaps` | `family?`, `includeWaived?`, `allKinds?` | `{ ..., filters, summary, gaps }` — resolved tickets (ISSUE/USER queues by default) lacking an active regression guard |
| `agentloop_search_knowledge` | `family?`, `kind?`, `source?`, `tag?`, `query?`, `limit?` | `{ ..., filters, summary, entries }` — how prior resolved tickets were fixed (searchable corpus) |
| `agentloop_knowledge_gaps` | `family?`, `severity?`, `source?` | `{ ..., filters, summary, gaps }` — resolved tickets whose knowledge is incomplete (missing resolution or verification) |
| `agentloop_related` | `id`, `minScore?`, `limit?` | `{ ..., ticket, weights, related }` — prior-art lookup ranking tickets by shared family/pattern/tags/kind and title overlap (weights tunable via `config.priorArt`) |

## Write tools

Only registered with `--write`. Each returns `{ schemaVersion, generatedAt,
action, ticket }`, where `ticket` carries the canonical `id` and queue `aliases`.

| Tool | Input | Notes |
| --- | --- | --- |
| `agentloop_create` | `summary` (required), `title?`, `family?`, `kind?`, `source?`, `severity?`, `confidence?`, `tags?`, `handoff?` | `kind`/`family` default from config; `source` defaults to `agent` |
| `agentloop_note` | `id`, `body` (required), `type?`, `author?` | `type` defaults to `triage`, `author` to `agent` |
| `agentloop_workflow` | `id`, `status` (`active` \| `reopened` \| `deferred`), `reason?` | resolve via `agentloop_resolve`, not here |
| `agentloop_resolve` | `id`, `summary` (required), `verification?`, `guardStatus?`, `guardSummary?` | |
| `agentloop_guard` | `id`, `guardStatus`, `guardSummary?` | |

Notes:

- `id` accepts the canonical `ISSUE-NNNNNN` id, any queue alias (`DEV-...`,
  `USER-...`, etc.), or a `PATTERN-NNNNNN` id for `agentloop_show`.
- `status` (for `agentloop_list`) accepts `triaged | active | resolved | reopened | deferred | all`.
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
