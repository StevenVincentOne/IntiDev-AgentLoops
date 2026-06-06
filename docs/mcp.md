# MCP server

AgentLoops exposes a [Model Context Protocol](https://modelcontextprotocol.io)
server so coding agents can read the ticket ledger directly. The current phase is
**read-only**: it never mutates state. Writes (create / note / workflow / resolve
/ guard) remain on the CLI until guarded MCP write tools are added.

## Running

```bash
agentloop mcp
```

- Communicates over **stdio** using JSON-RPC. `stdout` carries only the protocol
  stream; human-readable status is written to `stderr`.
- Reads `.agentloops/state.json` from the **current working directory**, so start
  it from the project root where you ran `agentloop init`.
- Implemented over the same `AgentLoopStore` as the CLI, so the CLI and MCP
  surfaces always agree.

## Tools

All tools are annotated with `readOnlyHint: true`.

| Tool | Input | Returns |
| --- | --- | --- |
| `agentloop_summary` | none | `{ schemaVersion, generatedAt, summary }` — ticket/pattern counts |
| `agentloop_list` | `status?`, `kind?` | `{ ..., filters, count, tickets }` |
| `agentloop_show` | `id` | `{ ..., kind: "ticket", ticket }` or `{ ..., kind: "pattern", pattern }` |
| `agentloop_handoff` | `id` | `{ ..., ticketId, aliases, prompt }` |

Notes:

- `id` accepts the canonical `ISSUE-NNNNNN` id, any queue alias (`DEV-...`,
  `USER-...`, etc.), or a `PATTERN-NNNNNN` id for `agentloop_show`.
- `status` accepts `triaged | active | resolved | reopened | deferred | all`.
- Every envelope includes `schemaVersion` (currently `1`) and `generatedAt`.
  Fields are added, not removed, within a schema version.
- Unknown ids return a tool error (`isError: true`) with a readable message
  rather than failing the protocol call.

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
