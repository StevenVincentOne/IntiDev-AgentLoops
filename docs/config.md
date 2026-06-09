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

### Root Cause Certificate for meaningful fixed bugs (optional)

On by default for `kind: bug | incident | user_feedback`. When enabled,
`agentloop resolve`/`agentloop_resolve` rejects a resolution of a matching
ticket unless `rootCauseCertificate` is also provided. The certificate is a
required *reasoning surface* — the ledger checks that you made an explicit
architectural claim, not that the claim is correct.

```json
{
  "rootCause": {
    "meaningfulKinds": ["bug", "incident", "user_feedback"],
    "minFieldLength": 20
  }
}
```

- **`meaningfulKinds`** — which ticket kinds require a certificate on
  resolution. Defaults to `["bug", "incident", "user_feedback"]`. Set to `[]`
  to opt out entirely (useful for projects that treat bugs as lightweight tasks).
- **`minFieldLength`** — minimum character length for each text field in the
  certificate. Defaults to `20`. The `regressionRisk` field uses a shorter floor
  (`3`) so short values like `"low"` are accepted.

Generate a scaffold before filling one in:

```sh
agentloop evidence-draft <id> --evidence-only   # JSON object only
agentloop resolve-draft <id>                    # ready-to-edit resolve command
```

See [Root Cause Certificate](agent-integration.md#root-cause-certificate-required-for-meaningful-fixed-bugs)
in agent-integration.md for the full certificate shape and philosophy.

### Verification briefs for evidence-sensitive domains (optional)

Off by default — every ticket keeps the lightweight `agentloop resolve
--summary ... --verification ...` path until you opt in. Some domains are easy
to mark "fixed" on weak evidence (a render/export/migration pipeline whose
output quality is hard to eyeball, an integration whose correctness depends on
which environment you hit, ...). Configure `verification` to require a
structured `verificationBrief` before AgentLoops will resolve tickets in those
domains — see [Verification briefs](agent-integration.md#verification-briefs-deterministic-guardrails-vs-agent-judgment)
for the full philosophy and brief shape:

```json
{
  "verification": {
    "sensitiveFamilyPatterns": ["^export_pipeline$", "^reader_"],
    "sensitiveKinds": ["bug", "incident"],
    "artifactIdPattern": "\\b(DOC-\\d+)\\b",
    "freshVerificationPatterns": ["re-?upload", "full reprocess", "post-ingest scan"],
    "replayVerificationPatterns": ["current-code replay", "unit test"],
    "broadCoveragePatterns": ["all reported instances", "every linked ticket"],
    "sufficientJudgments": ["sufficient", "verified"]
  }
}
```

- **`sensitiveFamilyPatterns`** (required to enable the feature) — regex
  sources matched against `Ticket.family`. No domain vocabulary ships
  hardcoded; nothing happens until you list your own families/patterns here.
- **`sensitiveKinds`** — ticket kinds that require a brief in a sensitive
  family. Defaults to `["bug", "incident"]`.
- **`artifactIdPattern`** — an optional single-capture-group regex that
  extracts "known affected artifact/entity ids" (document ids, order ids,
  routes, correlation keys, ...) from a ticket's title/summary/tags. When it
  matches, the brief/evidence must name those ids — generalizes Inti's
  `correlation_key`-derived document-id checks without a new structured Ticket
  field. Omit it if your domain has no such concept.
- **`freshVerificationPatterns`** / **`replayVerificationPatterns`** /
  **`broadCoveragePatterns`** — regex vocabularies distinguishing "fresh /
  end-to-end" evidence (required for recurrences and Pattern/Group/cascade
  claims) from "replay/local/unit" evidence (sufficient only for narrow,
  non-recurring single-ticket claims that name the affected id), and
  recognizing "broad coverage" language (required for multi-ticket claims).
  Generic, domain-agnostic defaults apply when omitted — override them to
  match your project's actual tooling vocabulary.
- **`sufficientJudgments`** — values accepted for `verificationBrief.agentJudgment`
  as an explicit sufficiency call. Defaults to `["sufficient", "verified", "proven"]`.

Once configured, `agentloop resolve`/`agentloop_resolve` (and the cascade form,
`agentloop resolve-pattern`/`agentloop_resolve_pattern`) reject resolutions of
matching tickets that lack a coherent `verificationBrief`. See
`src/verification.ts` for the full, numbered guardrail rules.

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

### GitHub Issues sync (optional)

Off by default. Set `github.repo` to mirror tickets onto linked GitHub Issues —
the ticket stays the richer agent-memory layer; the Issue is a mirror others can
read and comment on:

```json
{
  "github": {
    "repo": "owner/name",
    "tokenEnv": "GITHUB_TOKEN",
    "labels": {
      "kind": { "bug": "type: bug" },
      "severity": { "critical": "P0", "high": "P1" }
    }
  }
}
```

- `repo` — `"owner/name"` of the GitHub repository to sync with.
- `tokenEnv` — name of the environment variable holding the access token
  (defaults to `GITHUB_TOKEN`; the token itself is never read from config, so it
  stays out of committed files).
- `labels` — optional per-category overrides (`queue`/`kind`/`severity`/`status`);
  unmapped values fall back to `category:value` (e.g. `kind:bug`).

`agentloop github-sync <id>` creates the linked Issue on first sync (or updates
it thereafter), mirroring title/body/labels, and imports any new Issue comments
as `external` ticket notes (redacted, since they originate outside the loop).
`agentloop github-link <id> <issue-url>` manually attaches an existing Issue
without syncing. No SDK dependency — the default client wraps the GitHub REST
API with Node's built-in `fetch`.
