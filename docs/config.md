# Configuration

`agentloop.config.json` controls the project vocabulary.

```json
{
  "projectName": "IntiDev AgentLoops",
  "description": "Feedback loops for agentic workflows",
  "defaultKind": "bug",
  "ticketKinds": [
    { "kind": "bug", "defaultSeverity": "high", "requiredFields": ["summary"] },
    { "kind": "feature", "defaultSeverity": "medium", "requiredFields": ["summary"] }
  ],
  "queues": [
    { "prefix": "USER", "kinds": ["user_feedback"], "sources": ["user_report"] },
    { "prefix": "DEV", "kinds": ["feature", "task", "investigation", "tech_debt"] },
    { "prefix": "ISSUE", "kinds": ["bug", "incident"], "default": true }
  ],
  "sources": ["user_report", "manual_admin", "agent", "smoke", "ci", "ingestion"]
}
```

### Ticket kinds

Each kind can define:

- `defaultSeverity`: used when `--severity` is omitted
- `requiredFields`: enforcement when creating tickets

### Queues and aliases

Canonical ids are always stored as `ISSUE-000123`. Each ticket also gets one
user-facing **queue alias** derived from its `kind` and `source`:

- `queues` are evaluated in order; the first whose `sources` includes the
  ticket's source, or whose `kinds` includes its kind, wins.
- a `sources` match takes that queue's precedence, so a `user_report`-sourced
  bug routes to `USER-000123` even though `bug` is otherwise an `ISSUE` kind.
- the queue marked `"default": true` is the fallback when nothing matches.

With the default config that yields:

- `USER-000123` for product/support feedback (kind `user_feedback` or source `user_report`)
- `DEV-000123` for development work (`feature`, `task`, `investigation`, `tech_debt`)
- `ISSUE-000123` for defects (`bug`, `incident`) and anything unrouted

The canonical `ISSUE-` key keeps downstream systems stable while the alias gives
each operational queue a recognizable prefix. Aliases and canonical ids share the
same number, and any of them resolves back to the same ticket on lookup.

### Prior-art scoring (optional)

`agentloop related <id>` (and the `agentloop_related` MCP tool) rank related
tickets from deterministic signals: shared family, shared pattern, shared tags,
same kind, and title/summary token overlap. Core ships fixed default weights; a
project can override any of them, or raise the default match threshold:

```json
{
  "priorArt": {
    "weights": { "family": 3, "pattern": 3, "tag": 2, "kind": 1, "textOverlap": 4 },
    "minScore": 1
  }
}
```

Omit `priorArt` entirely to use the core defaults.

### Redaction (optional)

By default ticket text is stored unchanged. Add regex rules under
`redaction.patterns` to scrub sensitive content (PII, secrets) on every write —
titles, summaries, notes, resolutions, and guard summaries, via both the CLI and
the MCP write tools:

```json
{
  "redaction": {
    "patterns": [
      { "name": "email", "pattern": "[\\w.]+@[\\w.]+\\.[a-z]+", "replacement": "[email]" }
    ]
  }
}
```

Each rule takes a `pattern` (regex source), optional `flags` (default `g`), and
optional `replacement` (default `[redacted]`). Library users can instead inject a
`TicketRedactor` directly: `new AgentLoopStore(cwd, config, { redactor })`.
