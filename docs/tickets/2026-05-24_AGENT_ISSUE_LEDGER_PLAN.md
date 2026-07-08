# Agent Ticket Ledger Plan

Date: 2026-05-24
Status: Implemented incrementally; ticket migration, pattern layer, notes, and source feeds added
Area: Admin Portal / ticket tracking / agent workflow / production observability

## Summary

The Admin Portal workflow is migrating from "Issues" to "Tickets". `/tickets` is now the user-facing dashboard and `/issues` remains a compatibility alias. This widens the scope from pending problems to actionable work items: bugs, tasks, features, investigations, tech debt, incidents, and user feedback.

The older Admin Portal `/issues` tab was useful, but narrow. It was a live view over recent document ingestion anomalies:

- failed ingests
- processed documents with `metadata_json.ingestWarnings`
- frontend-only grouping of those anomalies into issue families

It is not a durable issue lifecycle system. Rows appear because document records currently have warning or failure metadata, and old rows disappear only when displaced by newer rows in the latest query window. They are not truly opened, claimed, resolved, archived, or mined as a historical debugging record.

This plan proposes a generalized Agent Ticket Ledger: a durable, searchable, groupable ticket system that can ingest signals from production, users, tests, and coding agents, then support resolution with evidence.

## Implementation Snapshot

Current implementation uses Ticket language for the product and workflow, while retaining `issue_*` table names internally for compatibility with the first ledger implementation.

Implemented now:

- Admin Portal `/tickets` dashboard, with `/issues` kept as a compatibility alias.
- Tabbed dashboard sections for `Issues`, `User`, `Development`, `All Tickets`, `Ticket Patterns`, `Prior Art Graph`, `Guard Gaps`, `Ingest Source Heat Map`, and `Recent Ingest Anomaly Groups`.
- Copy buttons for `PATTERN-...` and ticket ids so users can hand exact work items to agents. Canonical ticket ids remain `ISSUE-...`; Development and User queues may display `DEV-...` and `USER-...` aliases that resolve to the same ticket.
- Durable ticket clusters in `issue_clusters`.
- Append-only ticket events in `issue_events`.
- Append-only manual/triage notes in `issue_notes`.
- Append-only ticket and pattern resolution records in `issue_resolutions` and `issue_pattern_resolutions`.
- Regression guard decisions in `issue_regression_guards` so meaningful resolved bugs either have a detector/test, an existing guard reference, a waiver, or a deferred follow-up.
- Root-cause pattern grouping in `issue_patterns` and `issue_pattern_cluster_links`.
- CLI entrypoint `npm run tickets -- ...`, with legacy `npm run issues -- ...` alias still available.
- Same-session verified fix recording with `npm run tickets -- record-fix ...`.
- Registered smoke runner in `config/smoke-tests.json` through `npm run tickets -- smoke ...`.
- Source feeds for manual ingestion anomalies, browser runtime reports, backend runtime reports, user feedback, smoke/CI failures, and agent-authored events.

Still planned or partial:

- Merge/split ticket management.
- GitHub Issue sync.
- MCP adapter.
- Open-source extraction, tracked in `docs/issues-tickets/2026-06-01_TICKETS_EXTRACTED_REPO_PLAN.md`.

## Goals

1. Turn `/tickets` from a latest-anomaly list into a durable ticket workflow.
2. Preserve the current ingestion-warning heat map and make it more useful.
3. Let users, production runtime, test scripts, and agents all report signals into one shared system.
4. Let coding agents claim, investigate, update, and resolve tickets with structured evidence.
5. Keep a long-lived audit log of what broke, how it was fixed, how it was verified, and whether it returned.
6. Make recurring ticket patterns mineable so they can drive architectural improvements.
7. Design the core to be harness-agnostic, so it can later support Codex, Claude Code, and other agent coding tools through CLI, HTTP, or MCP adapters.

The extraction plan now treats the current Inti implementation as the reference harness to dogfood before splitting reusable packages from host adapters. See `2026-06-01_TICKETS_EXTRACTED_REPO_PLAN.md` for the package boundary, MCP plan, adapter contracts, and open-source release phases.

## Non-Goals

- Do not let production agents deploy directly without review gates.
- Do not replace GitHub Issues immediately; keep GitHub Issues as an external sync target.
- Do not require MCP for the first version.
- Do not store sensitive user document content by default.
- Do not turn every console warning into a high-priority issue.

## Current State

### Existing Admin Portal Behavior

The current API route is:

- `GET /api/admin/ingest-issues`

It queries `documents` for:

- `processing_status = 'failed'`
- or `processing_status = 'processed'` with non-empty `metadata_json.ingestWarnings`

The frontend groups rows into display families such as:

- `structure_contract_unresolved`
- `object_manifest_mask_fallback`
- `partition_overlap_other`
- `ingest_failed_other`

This is useful for ingest triage, but it has several limitations:

- It is limited to document ingestion.
- It has no issue lifecycle.
- It has no durable resolution record.
- Repeated reuploads create repeated rows.
- Older issues fall off because of query limits, not because they are fixed.
- Severity is too flat; minor unresolved navigation anchors count the same as broad failures.
- Agents do not write to it directly.

### Current Ingestion Warning Sources

The ingestion pipeline already creates structured warning objects with fields like:

- `code`
- `stage`
- `message`
- `detail`
- `fallbackMode`
- `fromParser`
- `toParser`
- `createdAt`

These should become one source of raw issue events rather than the entire ticket system.

## Proposed Model

The ledger has five layers:

1. `IssueEvent`: one observed signal.
2. `IssueCluster`: the current internal table for a durable ticket.
3. `IssuePattern`: the current internal table for a root-cause ticket pattern.
4. `IssueNote`: human or agent triage context that does not change status.
5. `IssueResolution`: evidence that a ticket or pattern was fixed, completed, dismissed, or superseded.

Events are append-only. Notes and resolutions are append-only audit records. Tickets and patterns are mutable workflow objects. Resolutions update ticket or pattern status; notes do not.

## Core Concepts

### Issue Event / Signal

An issue event is a single raw observation. It may report a defect, support request, feature request, task, or operational incident.

Examples:

- A document ingestion failed.
- A document imported with a parser fallback warning.
- A browser route threw an uncaught exception.
- A user clicked "Report bug" and described broken behavior.
- A coding agent found a failed test while investigating.
- A smoke run produced a contract regression.
- A backend route returned repeated 500s.

Suggested fields:

```text
id
cluster_id
source
environment
severity
fingerprint
family
title
message
detail
context_json
artifact_refs_json
actor_type
actor_id
created_at
```

Suggested `source` values:

```text
ingestion
browser
backend
user_report
agent
ci
smoke
manual_admin
```

Suggested `environment` values:

```text
local
development
staging
production
```

### Ticket

A ticket is the durable work item. The current table is still named `issue_clusters` for compatibility, and multiple issue events can map to one ticket through fingerprinting.

Suggested fields:

```text
id
public_key
title
ticket_kind
family
status
priority
severity
fingerprint
source_summary_json
first_seen_at
last_seen_at
event_count
affected_user_count
affected_document_count
assigned_to_type
assigned_to_id
linked_ticket_path
linked_github_issue_url
linked_pr_url
linked_commit_sha
created_at
updated_at
resolved_at
reopened_at
```

Suggested `status` values:

```text
open
triaged
in_progress
blocked
deferred
needs_verification
resolved
wont_fix
duplicate
superseded
reopened
```

`deferred` is a parked-work state for valid feature, investigation, or tech-debt tickets that should not appear in the default active queue. It is intentionally non-terminal: deferred tickets are not resolved knowledge, and a later instance can reactivate the ticket.

Suggested `ticket_kind` values:

```text
bug
task
feature
investigation
tech_debt
incident
user_feedback
```

### Ticket Pattern

A ticket pattern is the root-cause layer above tickets. It exists when several tickets are likely symptoms of the same underlying defect, architectural gap, or recurring workflow problem.

Suggested fields:

```text
id
public_key
pattern_key
title
summary
ticket_kind
family
status
priority
severity
source_summary_json
first_seen_at
last_seen_at
cluster_count
event_count
affected_user_count
affected_document_count
assigned_to_type
assigned_to_id
linked_ticket_path
linked_github_issue_url
linked_pr_url
linked_commit_sha
metadata_json
created_at
updated_at
resolved_at
reopened_at
```

Patterns link to tickets through `issue_pattern_cluster_links` with a relation:

```text
primary
related
duplicate
superseded_by
regression_of
caused_by
```

Resolving a pattern records an `issue_pattern_resolutions` row. When verification covers linked clusters, an agent can resolve the pattern and cascade the same evidence to linked non-terminal clusters.

### Ticket Resolution

A ticket resolution records why a cluster or pattern changed to a terminal or verification state. The current table remains `issue_resolutions` for compatibility.

Suggested fields:

```text
id
cluster_id
resolution_type
summary
evidence_json
resolved_by_type
resolved_by_id
commit_sha
branch_name
pr_url
deployment_version
verification_status
verification_notes
created_at
```

Suggested `resolution_type` values:

```text
fixed
verified_fixed
dismissed_false_positive
duplicate
wont_fix
superseded
cannot_reproduce
reopened
```

Resolution should not delete events. The history remains searchable.

### Ticket Note

A ticket note records context that is useful for triage or handoff but is not resolution evidence by itself.

Current fields:

```text
id
cluster_id
note_type
body
author_type
author_id
metadata_json
created_at
updated_at
```

Current `note_type` values:

```text
manual
triage
hypothesis
related_history
prior_fix
verification
handoff
```

Use notes for:

- a human observation from testing
- a remembered prior fix or similar historical issue
- a plausible root-cause hypothesis
- investigation handoff context
- verification breadcrumbs that are not enough to close the ticket

Do not use notes as a substitute for resolution. A ticket should move to a terminal status only through a resolution record with verification evidence.

## Fingerprinting And Grouping

Events should be grouped by stable, privacy-safe fingerprints.

### Ingestion Fingerprints

Inputs:

- warning code
- stage
- normalized detail
- parser
- doc type
- source family
- top-level exception class

Examples:

```text
ingestion:structure_contract_unresolved:nav:low_coverage
ingestion:object_manifest_mask_fallback:partition_math_vs_body_text
ingestion:failed:placeholder_missing_region_id
```

Avoid including unique document ids in the primary fingerprint unless the issue is document-specific.

### Browser Runtime Fingerprints

Inputs:

- error name
- normalized message
- route
- top stack frame from app code
- app build/version

Examples:

```text
browser:/reader:TypeError:ReaderPage.tsx:handleReadAloudParagraphClick
browser:/admin/issues:RenderError:AdminPortal.tsx:IssuesTab
```

Throttle noisy repeats by session and fingerprint.

### User Report Fingerprints

Inputs:

- route
- optional selected issue family
- document id/type if relevant
- normalized user-provided title
- recent linked browser/runtime fingerprints

User reports should often create new clusters unless they clearly attach to an existing open cluster.

### Agent Event Fingerprints

Inputs:

- repo path
- command/test name
- normalized error line
- linked cluster if known

Examples:

```text
agent:test_failure:npm_run_reader_region_contract_hardening_smoke:placeholder_missing_region_id
agent:code_review:DocumentIngestionService:unclassified_fallback
```

## Event Sources

### 1. Existing Ingestion Warnings

Convert the existing `/api/admin/ingest-issues` source into issue events.

Initial approach:

- Keep writing `metadata_json.ingestWarnings` for document compatibility.
- Add a post-ingest step that upserts issue events from final document metadata.
- Mark the existing `/issues` display as "Legacy Recent Ingest Anomalies" only during migration.

Later approach:

- Query issue clusters directly for the Admin Portal heat map.
- Keep document metadata warnings as document-local provenance.

### 2. Browser Console And Runtime Errors

Add a client-side error capture module.

Capture:

- `window.onerror`
- `window.onunhandledrejection`
- selected `console.error` calls from app code
- React render errors if an error boundary is added

Context:

- route
- build/version/git sha
- user id or hashed user id
- document id if active
- browser user agent
- last few app-level breadcrumbs

Privacy rules:

- Do not send full document text.
- Redact URLs/tokens/secrets.
- Sample/throttle repeated events.
- Allow disabling in local/dev if too noisy.

### 3. Backend Runtime Errors

Status: implemented for API 5xx responses and uncaught runtime errors.

Promote selected backend failures into issue events.

Capture:

- API 500s
- uncaught Express route errors
- unhandled promise rejections
- uncaught exception monitor events
- repeated parser service failures, when they surface as backend errors
- failed background jobs, when they surface as unhandled runtime errors
- unexpected retry exhaustion
- known critical fallback paths

Do not promote every warning. Use explicit allowlists or severity thresholds.

### 4. User Bug Reports

Status: implemented for explicit Reader UI feedback.

The Reader Inti floating menu includes a `Feedback` action that opens a guided modal. It submits to `/api/support/user-report`, stores image attachments under `data/issue-reports/`, and creates `user_report` issue-ledger events.

Fields:

- user description
- route
- category
- impact
- context checkboxes
- optional contact email for anonymous users
- optional screenshot
- current app version

User reports should create issue events immediately and either:

- attach to an existing matching cluster, or
- create a new `user_report` cluster.

### 5. Agent-Reported Tickets

Agents should create issue events when they encounter:

- failed tests unrelated to the immediate edit
- reproducible bugs found during investigation
- user-observed bugs that need tracking
- suspicious production/admin ticket clusters that deserve code work
- flaky or unclear behavior that blocks verification

Agents should update clusters when they:

- claim work
- identify root cause
- link a docs ticket
- link a branch/commit/PR
- provide verification evidence
- mark fixed, blocked, duplicate, or needs user verification

If an agent finds, fixes, and verifies a real bug before a ticket exists, it should still create the audit trail with:

```bash
npm run tickets -- record-fix \
  --title "..." \
  --family reader_ingestion \
  --summary "..." \
  --verification passed \
  --evidence-json '{"commands":["npm run check"],"notes":"Targeted regression passed."}' \
  --guard-status guard_added \
  --guard-type regression_test \
  --guard-summary "Targeted regression now covers recurrence." \
  --guard-command "npm run check"
```

`record-fix` exists for the narrow same-session verified-fix case. It creates the event and resolution in one transaction so future recurrences can be compared against a concrete prior symptom, fix, and verification record.

Resolved bugs, incidents, and user reports resolved as `fixed` or `verified_fixed` must receive a regression guard decision. The allowed decisions are:

- `guard_added`: new targeted coverage was added and recorded with a concrete command, detector key, or artifact path.
- `guard_existing`: current coverage already catches recurrence and is recorded with a concrete command, detector key, or artifact path.
- `guard_waived`: not worth automating, with a reason.
- `guard_deferred`: worth guarding, but intentionally left as follow-up.

This is deliberately not a general sensitivity increase. Low-value one-offs can be waived; important misses should become targeted smoke/regression coverage or a detector.

For ticket-to-smoke closure, a resolved defect should normally follow this path: create or identify the Ticket, add/update a deterministic smoke or regression assertion where practical, run that command, resolve the Ticket with verification evidence, then record `guard_added` with the command and changed smoke/detector artifact. Smoke-only findings that come from Reader corpus reports can create Tickets automatically, and the guard record is what proves the fix also improved future detection.

Implemented refinement: agents can run `npm run tickets -- guard-suggest ISSUE-...` to get advisory guard candidates from related resolved tickets, existing guard records, resolution knowledge, and the registered smoke catalog. The command does not modify tests or mark anything guarded; it helps the agent choose whether to add/update a smoke assertion, reuse an existing guard, defer, or waive.

Implemented refinement: resolving a Pattern while also clearing linked tickets now requires a regression guard decision. The decision is applied to the linked tickets as their guard record. This prevents batch pattern resolution from producing resolved Tickets with no stated recurrence policy.

Implemented refinement: new Ticket creation pushes possible prior art from resolved/open related tickets into `create-event` / `record-fix` output and manual handoff prompts. Strong prior-art matches are also recorded as `related_history` system notes.

Implemented refinement: when a resolved ticket reopens, the ledger escalates priority, records a system triage note, flags any prior guard metadata as ineffective, and raises resolution knowledge recurrence risk.

Implemented refinement: new Ticket intake now stores an inspectable `correlation_key` on events and clusters when one is supplied or can be derived from route, detector, source file, stage, document identity, or family. New clusters also run same-family near-duplicate detection, soft-link likely duplicates, return those candidates in CLI/API/manual handoff output, warn when hand-written fingerprints are near-misses for existing same-family clusters, and record relationship context as `related_history` notes.

Implemented refinement: recurrence guards can be audited with `npm run tickets -- guard-audit --json`. The audit compares guard commands against `config/smoke-tests.json`, recognizes both direct smoke commands and `npm run tickets -- smoke <id|suite>` wrappers, checks artifact paths, and reports `ok`, `warning`, or `rotted` guard records.

Implemented refinement: semantic tags and root-family grouping rules now live in `config/ticket-taxonomy.json`. This lets agents add high-level areas such as `Raster Image Handling`, `Figure Detection`, `Navigation Headings`, and `Reader Markdown Display`, plus new root-family prefixes, without code edits.

Implemented refinement: `npm run tickets -- begin <ISSUE-/DEV-/USER-...|family>` provides a composite triage briefing with active patterns, active tickets or ticket detail, related prior-art knowledge, and guard suggestions.

### 6. CI And Smoke Runs

Status: implemented for command-level failure capture.

Scripts should be able to emit structured issue events.

Candidate producers:

- corpus upload smoke
- body retention smoke
- region contract hardening smoke
- tagging audit smoke
- frontend browser/visual tests
- production health checks

The first implementation is a wrapper command:

```bash
npm run tickets -- run --source smoke --family reader_smoke -- npm run reader:compat-smoke
npm run tickets -- run --source ci --family ci_verify -- npm run check
```

It streams the wrapped command and exits with the same status. On failure, it creates a `smoke` or `ci` ticket event with a scrubbed output tail, command metadata, git branch/SHA, duration, and a stable command fingerprint.

Registered smoke targets now live in `config/smoke-tests.json`:

```bash
npm run tickets:smoke:list
npm run tickets -- smoke agent-default --dry-run
npm run tickets -- smoke toc-rebuild
npm run tickets -- smoke reader-runtime --include-live --include-mutating
```

The smoke runner records only failures. Successful verification should be referenced in a resolution record, not as a new event.

Structured report ingestion now supports more than Reader corpus upload reports. If a wrapped smoke exposes a JSON artifact with root-level `issueFindings`, `issues`, or `findings`, or item-level findings under `cases`, `results`, `documents`, `files`, or `tests`, the ticket runner can create medium-or-higher `smoke`/`ci` ticket events with stable fingerprints and artifact references. Low-severity findings remain skipped to avoid ledger noise, and ingest-owned warning families remain delegated to `import-ingest`.

Each run should attach:

- command
- run id
- output path
- summary counts
- failing fixture/document ids

## Agent Workflow

### Discovery

When starting work, an agent can run:

```bash
npm run tickets -- summary --limit 20
npm run tickets -- patterns --status active --limit 20
npm run tickets -- list --status active --limit 20
npm run tickets -- show ISSUE-000123
npm run tickets -- list --status all --family structure_contract_unresolved --limit 50
```

The agent should use this as context, not as an automatic mandate to fix everything.

### Creating Tickets

When an agent finds a new bug:

```bash
npm run tickets -- create-event \
  --source agent \
  --ticket-kind bug \
  --family parser_contract \
  --severity medium \
  --title "Placeholder tag missing regionId in Consciousness Explosion ingest" \
  --message "Local reupload failed with PLACEHOLDER missing regionId at line 9427" \
  --fingerprint "reader:ingest:placeholder-missing-region-id"
```

When an agent or user has useful context but no verified fix yet:

```bash
npm run tickets -- note ISSUE-000123 \
  --note-type hypothesis \
  --body "This resembles the prior placeholder region propagation fix; inspect the earliest tag-generation stage first."
```

### Claiming Work

```bash
npm run tickets -- note ISSUE-000123 \
  --note-type triage \
  --body "Agent codex started investigation in local thread; likely parser contract work."
```

Formal claim/status editing is still planned. When added, it should set `status = in_progress`, `assigned_to_type = agent`, and `assigned_to_id = codex:<session or thread id if available>`. Until then, use notes for handoff context and keep `AGENTS.md` workflow expectations explicit.

### Linking Docs Tickets

```bash
npm run tickets -- note ISSUE-000123 \
  --note-type related_history \
  --body "Related planning ticket: docs/issues-tickets/2026-05-24_PLACEHOLDER_REGION_ID_TICKET.md"
```

Structured linked ticket paths exist on the cluster schema, but the current CLI does not yet expose a direct link command for docs ticket paths.

### Resolving Tickets

Resolution should require evidence:

```bash
npm run tickets -- resolve ISSUE-000123 \
  --resolution-type verified_fixed \
  --commit abc123 \
  --verification passed \
  --evidence-json '{"commands":["npm run reader:region-contract-hardening-smoke"],"notes":"Reupload of the target fixture now processes without PLACEHOLDER regionId failure."}' \
  --summary "Fixed placeholder region propagation and verified with the region contract smoke." \
  --guard-status guard_added \
  --guard-type smoke \
  --guard-summary "Region contract hardening smoke covers PLACEHOLDER regionId recurrence." \
  --guard-command "npm run reader:region-contract-hardening-smoke"
```

For production tickets, resolution should usually move to `needs_verification` until:

- the fix is deployed
- a new production event no longer occurs
- a reingest/user confirmation verifies the fix

### Reopening

If the same fingerprint appears after resolution:

- create a new event
- increment the existing cluster
- set status to `reopened`
- preserve the earlier resolution record
- escalate priority once for the resolved-to-reopened transition
- mark the prior guard metadata as ineffective when a guard exists
- add a system triage note and raise resolution knowledge recurrence risk

## API Surface

### Admin API

Current routes:

```text
GET    /api/admin/tickets
GET    /api/admin/tickets/:id
POST   /api/admin/tickets/events
POST   /api/admin/tickets/import-ingest
POST   /api/admin/tickets/:id/notes
POST   /api/admin/tickets/:id/resolve
GET    /api/admin/ticket-patterns
POST   /api/admin/ticket-patterns
GET    /api/admin/ticket-patterns/:id
POST   /api/admin/ticket-patterns/:id/links
POST   /api/admin/ticket-patterns/:id/resolve
```

Compatibility aliases under `/api/admin/issues` and `/api/admin/issue-patterns` remain available where implemented.

Still planned:

```text
POST   /api/admin/tickets/:id/claim
POST   /api/admin/tickets/:id/status
POST   /api/admin/tickets/:id/link-doc-ticket
GET    /api/admin/tickets/stats
```

### Public/User Report API

Current routes:

```text
POST /api/support/user-report
POST /api/support/browser-issue
```

These must enforce rate limits and privacy redaction.

### CLI

Current scripts:

```text
npm run tickets -- list
npm run tickets -- show
npm run tickets -- create-event
npm run tickets -- record-fix
npm run tickets -- guard
npm run tickets -- guard-gaps
npm run tickets -- note
npm run tickets -- resolve
npm run tickets -- summary
npm run tickets -- patterns
npm run tickets -- pattern
npm run tickets -- create-pattern
npm run tickets -- link-pattern
npm run tickets -- resolve-pattern
npm run tickets -- suggest-patterns
npm run tickets -- import-ingest
npm run tickets -- run
npm run tickets -- smoke
```

Pattern suggestions default to a 3-active-cluster high-confidence threshold with no 10-event floor. They also mine durable relationship evidence from `issue_cluster_relationships` and `issue_relationship_evidence`, so strong `same_root_cause`, `regression_of`, or `fixed_by_same_change` edges can crystallize a Pattern before raw event counts accumulate. Evidence-based candidates report their basis, relationship count, derived strength, and evidence signals, and require at least one live ticket so resolved-only history remains prior art. New ticket events opportunistically attach to matching open or resolved root-cause patterns at creation time, and pattern metadata tracks escalation state for candidate, investigation, and agent-analysis thresholds.

The current CLI calls the database directly and loads `.env.local` before `.env`. A production/staging API mode is still planned.

## MCP Layer

MCP should be an adapter, not the first dependency.

Future tools:

```text
ticket_search
ticket_get
ticket_create_event
ticket_add_note
ticket_claim
ticket_resolve
ticket_link_artifact
ticket_link_commit
ticket_pattern_search
ticket_pattern_resolve
```

This makes the system usable from Codex, Claude Code, and other MCP-compatible agent harnesses.

The underlying system should still work through HTTP and CLI so it remains portable.

## Admin Portal UX

The Admin Portal `/tickets` tab is the durable ticket dashboard. `/issues` remains a compatibility alias while older links and agent habits transition.

### Current Dashboard

The current dashboard keeps summary cards visible at the top, then uses tabs to avoid forcing admins to scroll past unrelated sections. `Tickets` is the catch-all object type; `Issues` is the focused defect queue, `User` is the focused production-feedback intake queue, and `Development` is the focused feature/planning queue.

- `Issues`: bugs, incidents, runtime errors, and smoke failures that need triage or repair.
- `User`: production user feedback and user-reported bugs. It merges `ticketKind=user_feedback` with tickets whose source summary includes `user_report`, so reports from users stay elevated while preserving their underlying bug/incident lineage.
- `Development`: feature work, design specs, investigations, tech debt, deferred backlog, and partial implementations queued for current or future agent/maintainer work. It is lane-based and opens on `All` so parked work remains visible: `Ready for agent`, `Needs spec`, `In progress`, `Blocked`, `Deferred`, and `All`.
- `All Tickets`: durable catch-all ledger with status, severity, note entry, per-ticket prior-art/hypothesis lookup, and resolution controls.
- `Ticket Patterns`: root-cause pattern work items linked to one or more tickets.
- `Prior Art Graph`: durable relationship edges after ticket links become reusable history.
- `Guard Gaps`: resolved issue tickets missing a concrete added/existing guard, waiver, or deferred reason, grouped by root family/pattern area.
- `Ingest Source Heat Map`: grouped ingest anomaly families, with counts for recent anomaly rows, grouped anomalies, failed ingests, and warning rows.
- `Recent Ingest Anomaly Groups`: grouped source rows for failed ingests and processed documents with warnings.

`PATTERN-...` and ticket keys are copyable from the dashboard. This is intentional agent-workflow support: a user can copy a key into a prompt, and an agent can inspect the same object through the CLI. Canonical ticket keys remain `ISSUE-...`; queue-specific display aliases such as `DEV-...` and `USER-...` keep Development and User work recognizable without changing the underlying ledger identity.

For extraction, this alias model should remain public API: aliases are display and command conveniences, while the canonical key remains stable for storage, relationships, GitHub sync, and migrations.

Manual Ticket creation is implemented through the `New Ticket` action. Admins can enter the observed problem or requested work, classify kind/severity/area, include suspected causes or prior related fixes, link docs/spec references, attach up to five evidence files, optionally attach browser page state, and save the item into the same ledger. The form is template-driven by kind: Issues focus on observation/repro context; Development kinds add goal, acceptance criteria, implementation notes, test strategy, linked docs/spec, and `Ready for agent`. Admin accounts also get an `Admin Ticket` mode in the Inti menu Feedback modal for fast bug or ingestion reports from the Reader surface. The API assigns the `ISSUE-...` key and stores evidence as artifacts under `data/ticket-evidence/`. Browser page-state attachments use artifact type `browser_evidence` and include current URL, viewport, visible controls, DOM snapshot, and recent browser actions.

After a manual Ticket is created, the UI shows a copyable agent handoff prompt containing the assigned key and a `npm run tickets -- show <key> --json` starting command. Issue handoffs emphasize evidence, repro, prior art, and guard expectations. User handoffs emphasize user impact, reproduction path, route/environment, artifacts, `browser_evidence`, and prior art. Development handoffs emphasize goal, acceptance criteria, implementation notes, linked specs, and test strategy. Each Ticket card also keeps a persistent visible/copyable handoff in Details, so the same task prompt remains available after the creation modal is closed or when working from older Tickets. When page state is attached, the handoff also names the captured route and local browser entrypoint. This makes user-observed bugs like visual document inspection failures first-class agent tasks before any code changes happen.

Development ticket events mirror their brief into cluster metadata so the Development tab can show goal, acceptance criteria, linked specs, and `Ready for agent` state without loading full event history. The event context remains the source of truth for the full handoff.

The User queue is available from the CLI with `npm run tickets -- user --status active` and `npm run tickets -- user --status all`, and `npm run tickets -- begin active` prints User work before Development work. Development cards expose quick actions for `Mark ready`, `Needs spec`, `Start work`, `Block`, and `Defer`. These actions call the shared ticket workflow transition path, update ticket status/readiness metadata, and write a triage note. `Deferred` is the parked Development lane that replaces the older deferred category pattern; it keeps backlog visible without treating it as active implementation work. The CLI exposes the same surface with `npm run tickets -- development --ready`, `npm run tickets -- development --needs-spec`, `npm run tickets -- development --lane deferred`, and `npm run tickets -- workflow ISSUE-... --status in_progress --ready --summary "..."`.

Before extraction, this workflow should be dogfooded as the public contract: create representative Issue, User, and Development tickets; exercise notes, instances, workflow transitions, defer, reopen, resolve, guards, prior art, and search; then extract only the flows that have proven useful in the current implementation.

Resolved bug, incident, and user-report cards expose a regression guard panel. If no guard is recorded, the card is flagged as `Needs Guard`; admins and agents can record added/existing/waived/deferred coverage without reopening the ticket.

The `All Tickets` view and per-queue cards expose per-ticket `Prior Art & Hypotheses` inside each Ticket card's Details area. It uses the same resolved-knowledge retrieval path as `npm run tickets -- related`, shows direct history links, reusable resolution knowledge, and candidate prior-art matches, and lets admins link a candidate as a ticket-local triage hypothesis. Hypothesis links remain pending while either endpoint is active, then promote to durable resolved history when both endpoint tickets reach a terminal status. Durable links now carry deduped relationship evidence, a derived strength score/tier, and evidence freshness; repeated maintenance runs refresh the same evidence keys instead of ratcheting strength upward. Broader `suggest-relationships` scans remain available through the CLI for maintenance, but the main UI no longer presents open-ticket relationships as a global approval queue.

Ticket cards also support `Defer ticket` for valid work that should be parked rather than resolved. The dashboard keeps deferred work visible through the Development `Deferred` lane, and the All Tickets status filter can still isolate `deferred` status for ledger audits. Deferred tickets are excluded from active pattern thresholds but remain searchable and can be reactivated by adding a new instance.

The `Prior Art Graph` tab exposes the durable relationship graph after links have become reusable history. It lists endpoint tickets, relationship type, confidence, strength tier, evidence rows, and review-required state. Admin curation records reviewed/needs-review decisions into relationship metadata history rather than deleting edges, so reopened or suspect relationships can be audited without losing evidence.

Scheduled prior-art maintenance is implemented through `npm run tickets -- review-relationships --json`. The command is safe for cron-style execution: it refreshes generated knowledge tags, applies only high-confidence links by default, and reports counts for high/medium/low suggestions. Review-only suggestions should be inspected through CLI dry-runs or the relevant Ticket card's `Prior Art & Hypotheses` details. `--dry-run` previews without applying relationships or refreshing tags unless `--backfill-in-dry-run` is passed.

The ingest tabs expose `Import Ingest Anomalies` as a reconciliation/backfill action. Manual app ingestion now creates ticket events automatically after queued ingest completion, so the import button should not be required for ordinary new uploads. Processed uploads also run a lightweight post-ingest quality scan that reuses high-confidence smoke detector families for cheap per-document checks. It tickets medium-or-higher findings such as markdown control characters, known junk artifact leaks, obvious markdown/rendering defects, object placeholder/comment defects, and ownership/tagging/page-partition audit findings when those artifacts already exist.

### Planned Dashboard Metrics

Additional metrics can be added as the ledger matures:

- new events in last 24h
- production critical tickets
- user reports awaiting triage
- reopened tickets
- resolved this week

### Heat Map Dimensions

Group by:

- source
- family
- severity
- environment
- affected document
- route
- first seen / last seen

### Cluster Detail Page

Show:

- status and priority
- summary
- event timeline
- affected documents/users/routes
- linked tickets
- linked commits/PRs
- notes from users/admins/agents
- resolution records
- recurrence history
- verification checklist

### User Report Flow

In Reader:

- "Report bug"
- attach route and document id automatically
- optional screenshot
- optional "include recent app errors"

In Admin Portal:

- create ticket manually with evidence attachments and copyable agent handoff
- add note without changing ticket status
- merge/split clusters
- mark duplicate
- assign priority
- request agent investigation

## Data Retention And Privacy

Production ticket and issue-event data must avoid sensitive document leakage.

Rules:

- Store document id, filename, parser, warning code, and redacted detail.
- Do not store full document text.
- Redact auth tokens, cookies, email addresses in logs unless explicitly needed.
- Browser event payloads must be bounded and sampled.
- User reports can include user text, but screenshots/artifacts should be explicit uploads.
- Support deletion/anonymization by user id if needed later.

## Production Agent Safety

The long-term vision is dynamic improvement, but production fixes need gates.

Allowed automatically:

- ticket creation
- clustering
- severity suggestion
- reproduction attempt
- branch creation
- PR drafting
- test execution
- suggested resolution

Require review/gating:

- production deploy
- destructive data repair
- schema migrations
- user-visible behavior changes with uncertain blast radius
- paid model/service usage beyond approved limits

## Relation To GitHub Issues

GitHub Issues can be an external synchronization target, but should not be the core database for app runtime events.

Possible mapping:

- High-priority clusters can create/link GitHub Issues.
- Fix PRs can link back to ledger clusters.
- Ledger remains the detailed event store and production/user signal store.

This keeps GitHub clean while retaining rich operational history.

## Relation To Docs Tickets

`docs/issues-tickets` should remain the human-readable planning and design layer.

Recommended mapping:

- one durable cluster can link to zero or more docs tickets
- one docs ticket can link to one or more clusters
- resolved tickets should include the cluster id and resolution evidence
- clusters can exist without docs tickets when they are small operational issues

## Implementation Plan

### Phase 0: Clarify Existing Semantics

Status: superseded by `/tickets` migration.

- Rename current `/issues` labels from "Open issues" to "Recent ingest anomalies" until the durable ledger exists.
- Add copy explaining that rows are recent document rows, not lifecycle issues.
- Add severity splitting for `structure_contract_unresolved`.
- Add grouping by fingerprint/title so repeated reuploads do not dominate the page.

Acceptance:

- User can tell whether an item is a minor warning, broad failure, or hard ingest failure.
- Repeated reuploads are visually grouped.

### Phase 1: Database Schema

Status: implemented for core ledger, pattern layer, resolutions, and notes.

Add tables:

- `issue_clusters`
- `issue_events`
- `issue_notes`
- `issue_resolutions`
- `issue_patterns`
- `issue_pattern_cluster_links`
- `issue_pattern_resolutions`
- optional future `issue_artifacts`

Add indexes:

- cluster status
- fingerprint
- source/environment/family
- first seen / last seen
- linked document id
- linked route

Acceptance:

- Migrations create durable issue tables.
- Events can be inserted and grouped into clusters.
- Clusters retain history after resolution.

### Phase 2: Ingestion Import

Status: implemented for queued manual app ingestion, with `npm run tickets -- import-ingest` retained for backfill/reconciliation.

Create services that convert ingest warnings/failures and high-confidence post-ingest quality findings into issue events.

Current hooks:

- after queued document ingest completion, when the document is marked `processed` and has `ingestWarnings`
- after queued document ingest completion, when the document is marked `processed` and the lightweight post-ingest scan finds medium-or-higher quality defects
- after queued document ingest failure, when the document is marked `failed` and has `ingestError`
- as a backfill script through `npm run tickets -- import-ingest`

Acceptance:

- Current manual app ingest warnings/failures appear as ledger clusters without needing an Admin Portal import click.
- Current manual app ingest smoke-overlap findings appear as ledger clusters without requiring a full corpus smoke run.
- Existing `/issues` data can be reproduced from ledger queries.
- Legacy document warning metadata remains available.

### Phase 3: Admin Portal Ledger UI

Status: implemented as the Admin Portal `/tickets` tab, with `/issues` as a compatibility alias.

Build the durable ticket dashboard.

Views:

- list clusters
- filter by status/source/severity/family/environment
- cluster detail timeline
- resolution panel
- note panel and manual note entry
- manual ticket creation
- merge/duplicate controls later

Acceptance:

- User can see open vs resolved tickets.
- User can inspect why a ticket is open.
- User can add non-resolution notes.
- User can see resolution evidence for fixed tickets.

### Phase 4: Agent CLI

Status: implemented through `scripts/issue-ledger.ts` and `npm run tickets -- ...`.

Current commands:

- `list`
- `show`
- `create-event`
- `note`
- `resolve`
- `summary`
- `patterns`
- `pattern`
- `create-pattern`
- `link-pattern`
- `resolve-pattern`
- `suggest-patterns`
- `import-ingest`
- `run`
- `smoke`
- `knowledge`
- `knowledge-gaps`
- `search-knowledge`
- `related`
- `link`
- `backfill-tags`
- `suggest-relationships`
- `review-relationships`

Update `AGENTS.md` with workflow rules:

- create/update tickets for discovered bugs
- record same-session verified fixes instead of skipping the ledger
- add notes for unresolved triage context
- claim before working when issue-led
- resolve only with evidence
- avoid noisy issue creation for transient exploration

Acceptance:

- Codex can use shell commands to read and write the ledger.
- A resolved ticket has a linked evidence record.

### Phase 5: User Bug Reports

Status: implemented for Reader Feedback modal and `/api/support/user-report`.

Add user-facing issue submission.

Reader context:

- route
- document id
- current nav/section if safe
- app version
- optional screenshot
- optional recent client errors

Acceptance:

- User reports create issue events.
- Admin can triage reports into clusters.
- User reports can be linked to agent resolution records.

### Phase 6: Browser Runtime Capture

Status: implemented for browser console errors/warnings, unhandled rejections, and resource load failures through `/api/support/browser-issue`. Local/dev runtime reports attach bounded browser page evidence in event context. User Feedback and manual Admin Tickets can also upload `browser_evidence` JSON artifacts.

Add client-side runtime event capture.

Capture:

- uncaught errors
- unhandled rejections
- selected app console errors
- error boundary crashes
- DOM/page-state evidence for dev/manual ticket reproduction
- recent browser action logs and failed fetch context

Acceptance:

- Production browser errors appear as throttled issue events.
- Payloads are redacted and bounded.
- Admin heat map can show route/build/frequency.
- Manual/user-reported UI bugs can carry enough page state for an agent to reopen the relevant local route and inspect the captured DOM.

### Phase 7: Backend And CI Producers

Status: implemented for backend runtime reports, command wrapper failure capture, registered smoke tests, Reader corpus upload report findings, and generic structured smoke report findings.

Add structured issue event emission from:

- backend error middleware
- smoke scripts
- corpus upload scripts
- CI failures

Acceptance:

- Critical backend failures, command smoke failures, and high-confidence Reader corpus smoke findings are queryable with the same lifecycle as user reports and ingest warnings.

### Phase 8: MCP Adapter

Status: planned.

Create an MCP server around the issue API/CLI.

Acceptance:

- MCP-compatible agents can search, create, claim, update, and resolve issues.
- The MCP adapter remains optional; CLI/API still work.

### Phase 9: Open-Source Extraction

Status: planned.

Once stable inside Inti Docs, extract generic components:

- schema patterns
- fingerprinting library
- CLI
- MCP server
- agent workflow docs
- GitHub sync adapter

Keep app-specific producers/adapters in Inti Docs.

Acceptance:

- A separate repo can be used by Codex and non-Codex agent harnesses.
- Inti Docs remains a real-world reference implementation.

## Initial Candidate Tickets To Seed

Seed from current local state:

1. `structure_contract_unresolved`
   - Mostly processed documents with nav coverage warnings.
   - Needs severity split by coverage/unresolved count.

2. `object_manifest_mask_fallback`
   - Object-manifest exclusion failed, primary parser markdown delivered.
   - Related to partition contract resilience work.

3. `placeholder_missing_region_id`
   - Current failed ingest example:
     - `Consciousness_Explosion_-_Ebook_Comic_Book_v6.pdf`
     - `Markdown tagging contract failed: line 9427: PLACEHOLDER is missing regionId`

4. `partition_overlap_other`
   - Current grouping is too vague.
   - Needs better detail classification, including duplicate ids vs overlap incompatibility.

## Open Questions

1. Should ticket clusters live in the same Postgres database as documents, or a separate ops schema?
2. Should production user reports be visible only to admins, or should users see their own report status?
3. How much browser context is acceptable to collect by default?
4. Should unresolved low-severity nav warnings auto-resolve after reingest with high enough coverage?
5. Should GitHub Issues sync be one-way or two-way?
6. Should agent claiming be advisory only, or should it lock a ticket from other agents?
7. What is the threshold for auto-reopening a resolved cluster?

## Success Criteria

The system is successful when:

- A user report, browser error, ingestion warning, and agent-discovered bug can all appear in one ticket dashboard.
- Repeated events group into stable clusters instead of flooding the page.
- Agents can claim and resolve tickets with audit evidence.
- Resolved tickets remain searchable by family, document, route, commit, and verification.
- Recurring patterns become visible enough to drive architecture-level fixes.
- Production can improve continuously without sacrificing review and deployment safety.
