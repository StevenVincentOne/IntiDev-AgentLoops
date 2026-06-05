# Configuration

`agentloop.config.json` controls the project vocabulary.

```json
{
  "projectName": "IntiDev AgentLoops",
  "description": "Feedback loops for agentic workflows",
  "defaultKind": "bug",
  "ticketKinds": [
    {
      "kind": "bug",
      "aliases": ["ISSUE"],
      "defaultSeverity": "high",
      "requiredFields": ["summary"]
    },
    {
      "kind": "feature",
      "aliases": ["DEV"],
      "defaultSeverity": "medium",
      "requiredFields": ["summary"]
    }
  ],
  "sources": ["user_report", "manual_admin", "agent", "smoke", "ci", "ingestion"]
}
```

### Ticket kinds

Each kind can define:

- `aliases`: user-facing id prefixes
- `defaultSeverity`: used when `--severity` is omitted
- `requiredFields`: enforcement when creating tickets

### Aliases

Canonical ids are stored as `ISSUE-000123`. User-facing aliases are derived from config:

- `DEV-000123` for feature work
- `USER-000123` for support and product feedback

This keeps downstream systems stable while giving projects recognizable prefixes.
