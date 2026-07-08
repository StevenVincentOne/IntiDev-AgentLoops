# Codex Ticket Ledger Workflow

Date: 2026-05-24
Status: Ticket migration implemented
Area: Agent workflow / Admin Portal tickets / ticket resolution audit

## Purpose

The ticket ledger is the durable record for bugs, tasks, features, investigations, tech debt, incidents, and user feedback discovered by ingestion, browser/runtime telemetry, users, smoke tests, and coding agents. It is separate from the older `/api/admin/ingest-issues` view, which is only a current-source anomaly feed.

Internally, raw telemetry is still represented as issue events/signals. The actionable workflow object is now a ticket.

Agents should use the ledger to:

- identify open or recurring tickets before starting relevant work
- add structured events when they discover new bugs, tasks, features, investigations, incidents, or feedback
- add non-resolution notes when they learn useful triage context, related history, or a plausible cause
- resolve tickets only after implementing and verifying a fix or completing the tracked work
- leave evidence that a later agent or human can inspect

For the open-source extraction plan, keep treating the current Inti implementation as the reference harness until the Issue/User/Development workflows have been dogfooded. The extracted repo plan lives in `docs/issues-tickets/2026-06-01_TICKETS_EXTRACTED_REPO_PLAN.md`.

## CLI

Use the repo-local CLI:

```bash
npm run tickets -- help
```

The legacy `npm run issues -- ...` alias remains available. The CLI loads `.env.local` first when present, then `.env`, and uses the same schema guards as the API.

Common commands:

```bash
npm run tickets -- summary --limit 20
npm run tickets -- list --status active --limit 20
npm run tickets -- list --status all --source ingestion --limit 50
npm run tickets -- list --ticket-kind feature --status active
npm run tickets -- show ISSUE-000123
npm run tickets -- patterns --status active --limit 20
npm run tickets -- pattern PATTERN-000001
npm run tickets -- suggest-patterns --limit 200
npm run tickets -- import-ingest --limit 200
npm run tickets -- begin ISSUE-000123
npm run tickets -- begin reader_ingestion
npm run tickets -- resolution-audit --json
npm run tickets -- guard-audit --json
```

Ticket ids are stored canonically as `ISSUE-...`. The dashboard and handoff prompts may display queue aliases such as `DEV-...` for Development tickets and `USER-...` for User tickets; CLI ticket-id arguments accept `ISSUE-...`, `DEV-...`, `USER-...`, or numeric ids and normalize aliases back to the canonical ticket.

For a normal agent start, prefer `npm run tickets -- begin <ISSUE-/DEV-/USER-...|family>` when a ticket id or area is known. It prints the ticket or family briefing, active patterns, active tickets, related resolved/open knowledge, and guard suggestions in one pass. Use the narrower commands above when you need a specific view.

Manual document uploads are ticket-integrated at queue completion. The worker imports explicit ingest failures/warnings and then runs the lightweight post-ingest quality scan for processed documents. That scan reuses high-confidence smoke detector families for cheap per-document checks and creates `source=ingestion` events with `sourceBridge=post-ingest-quality-scan` when it finds medium-or-higher defects. It is not a substitute for full smoke before accepting a cohort.

Ticket status uses `active` as a filter, not a stored status. Active means `open`, `reopened`, `triaged`, `in_progress`, `blocked`, or `needs_verification`. Use `deferred` for valid feature, investigation, or tech-debt work that should remain in the ledger but leave the active queue until explicitly picked up or until a new event reactivates it. Deferred tickets are not terminal and should not be treated as resolved knowledge. Deferred is no longer a top-level category; it is the parked/backlog lane inside the Development workflow.

Add triage context without changing ticket status:

```bash
npm run tickets -- note ISSUE-000123 \
  --note-type hypothesis \
  --body "This resembles the previous cursor restore ordering bug; inspect document hydration before paging state."
```

Use notes for hypotheses, related historical fixes, human observations, handoff context, and verification breadcrumbs that are not yet sufficient to resolve the ticket. Do not use notes as a substitute for `resolve`; a resolved ticket still needs verification evidence.

Park valid but intentionally postponed work with:

```bash
npm run tickets -- defer ISSUE-000123 \
  --summary "Deferred until the Lite source-PDF highlight roadmap is scheduled."
```

The Admin Portal `/tickets` cards expose the same distinction:

- `Add Note` records open-ticket context without changing status.
- `Add Instance` records another occurrence of the same active ticket, with optional document/route/evidence, and increments recurrence/pattern signals.
- `Reopen with Instance` records a recurrence of a resolved ticket with optional evidence and reopens it through the normal same-fingerprint event path.
- `Defer ticket` moves valid postponed work to `deferred` and records the reason as a triage note.
- `Mark Fixed` writes a resolution audit record and moves the ticket toward a terminal/resolution state.

Use `Add Note` when a user remembers a prior fix, suspects a cause, reports a similar historical issue, or leaves testing context for an agent.

The Admin Portal `/tickets` page is organized as a tabbed dashboard so admins and agents can switch between current work surfaces without scrolling through every section. `Tickets` is the catch-all term for every work item. `Issues` is the defect queue for accepted developer terminology, `User` is the production feedback and user-report intake queue, and `Development` keeps planned or partial future work visible instead of burying it in docs:

- `Issues`: bugs, incidents, runtime errors, and smoke failures that need triage or repair.
- `User`: production user feedback and user-reported bugs. The queue includes `ticketKind=user_feedback` plus tickets whose source summary includes `user_report`, so user-reported defects stay elevated without losing their bug/incident lineage.
- `Development`: feature work, design specs, investigations, tech debt, deferred backlog, and partial implementations queued for current or future agent/maintainer work.
- `All Tickets`: the catch-all ledger for every ticket kind, including closed history.
- `Ticket Patterns`: root-cause pattern work items above individual tickets.
- `Prior Art Graph`: durable ticket relationship edges, evidence signals, strength tiers, and admin curation state.
- `Guard Gaps`: resolved issue tickets that still need a regression guard decision, grouped by root family/pattern area.
- `Ingest Source Heat Map`: current ingest anomaly families before or after import into the ledger.
- `Recent Ingest Anomaly Groups`: grouped source rows from failed ingests and processed documents with warnings.

Pattern and ticket keys in the dashboard have copy buttons. Prefer copying `PATTERN-...` or the displayed ticket key from the UI when prompting an agent. User and Development cards may show `USER-...` or `DEV-...` beside the canonical `ISSUE-...` key; either form works with `npm run tickets -- show ...`.

Admins can also create a new Ticket directly from `/tickets` with the `New Ticket` action. The form is kind-aware: `Issue`, `Incident`, and `User feedback` templates focus on observation/repro context, while `Feature`, `Task`, `Investigation`, and `Tech debt` templates expose a Development brief with goal, acceptance criteria, linked docs/spec, implementation notes, test strategy, and a `Ready for agent` flag. It can also capture severity, area/family, optional document id/route, and up to five evidence attachments. Browser page state can be attached as a `browser_evidence` JSON artifact with the current URL, viewport, visible controls, DOM snapshot, and recent browser actions. The system assigns the canonical `ISSUE-...` key automatically, computes `DEV-...` or `USER-...` display aliases when applicable, and stores attachments as ticket artifacts under `data/ticket-evidence/<yyyy-mm>/<report-id>/`.

After creation, the modal shows a copyable agent handoff prompt. Issue handoffs lead with reproduction/evidence/prior-art context and guard expectations; User handoffs lead with user impact, reproduction path, route/environment, artifacts, `browser_evidence`, and prior art; Development handoffs lead with goal, acceptance criteria, implementation notes, linked specs, and test strategy. The User tab has its own status filter and should be used for production feedback triage before deciding whether the ticket becomes an Issue fix, a Development item, or a note-only support follow-up. The Development tab is operationally lane-based and opens on `All` so parked backlog is not hidden: `Ready for agent`, `Needs spec`, `In progress`, `Blocked`, `Deferred`, and `All`. `Deferred` is the old deferred-category behavior folded into the Development workflow; it means valid development/backlog work that is intentionally parked, not resolved. Development cards expose quick actions for `Mark ready`, `Needs spec`, `Start work`, `Block`, and `Defer`; each action records a workflow triage note and updates the same cluster metadata used by agent handoffs. Every Ticket card also exposes a persistent `Agent handoff` block in Details plus a `Copy Handoff` action in the card header, so older tickets can be handed to an agent without recreating them. New triage-oriented Ticket creation also asks the ledger for possible prior art and near-duplicates, and includes strong matches in CLI/API output and the copied handoff prompt. This heavier intake enrichment runs for agent, manual admin, user report, ingestion, smoke, and CI sources; high-volume browser/backend telemetry still records durable events, tags, and pattern links, but skips prior-art lookup and near-duplicate linking at intake to avoid noisy relationship churn. When a user pastes a handoff prompt, start by running the included `npm run tickets -- show <key> --json` command, inspect the event context/artifacts, review any listed prior-art or near-duplicate tickets, and if `browser_evidence` is present open the captured page in the local browser, usually `http://localhost:5173`. Then either add notes, link a pattern, or resolve the ticket only after verification.

Agents can inspect the User and Development queues without opening the UI:

```bash
npm run tickets -- user --status active
npm run tickets -- user --status all
npm run tickets -- development --ready
npm run tickets -- development --needs-spec
npm run tickets -- workflow ISSUE-000123 --status in_progress --ready --summary "Started implementation from the Development queue."
```

Before extracting Tickets into its own repo, run a dogfood pass across the current implementation:

- create one Issue, one User, and one Development ticket from the UI
- verify copyable handoff prompts for `ISSUE-...`, `USER-...`, and `DEV-...` keys
- exercise add note, add instance, workflow transitions, defer, reopen, resolve, guard, prior-art lookup, and search
- confirm every UI action has an equivalent CLI/API path
- update the extracted repo plan with any workflow gaps before moving code

Resolved bugs, incidents, and user reports must also get a regression guard decision when they are resolved as `fixed` or `verified_fixed`. The goal is not to make the app noisy; it is to preserve knowledge from meaningful fixes so backsliding creates a clear future ticket. Use one of:

- `guard_added`: a new smoke, regression test, ingest detector, browser reporter, backend detector, or CI check now catches recurrence. This requires a concrete command, detector key, or artifact path.
- `guard_existing`: existing coverage already catches recurrence, with evidence. This also requires a concrete command, detector key, or artifact path.
- `guard_waived`: not worth automating, with a short reason.
- `guard_deferred`: worth guarding, but intentionally left as follow-up.

Record the decision with:

```bash
npm run tickets -- guard ISSUE-000123 \
  --guard-status guard_added \
  --guard-type regression_test \
  --summary "TOC structure regression now fails if OceanofPDF markdown links survive cleanup as headings." \
  --command "npm run tickets -- smoke toc-rebuild" \
  --artifact-ref "scripts/run-toc-structure-regression.ts"
```

Do not use `guard_added` just because the code fix passed. First add or update the relevant assertion in a smoke/regression script, ingest detector, telemetry rule, or CI check, run it, then record the command and changed file/detector. If recurrence cannot be checked reliably without brittle or expensive automation, use `guard_waived` or `guard_deferred` with a reason.

Find resolved tickets still missing this decision with:

```bash
npm run tickets -- guard-gaps --limit 100
```

Ask the ledger for likely guard coverage before deciding:

```bash
npm run tickets -- guard-suggest ISSUE-000123 --limit 5
```

`guard-suggest` is advisory. It looks at related resolved tickets, existing guard records, resolution knowledge, and the registered smoke-test catalog. Use an existing guard suggestion only after confirming it really covers this recurrence. Use a smoke-target suggestion as a prompt to add or update a deterministic assertion first, then record `guard_added`.

Audit guard rot with:

```bash
npm run tickets -- guard-audit --json
```

The audit checks `guard_added` and `guard_existing` records against `config/smoke-tests.json` and artifact paths. A warning usually means the guard cites an ad hoc command that should either be registered as a smoke target or documented as intentionally outside the catalog. A rotted guard means the guard lacks an actionable target or points at a missing artifact.

Audit resolved/open workflow drift with:

```bash
npm run tickets -- resolution-audit --json
```

The resolution audit reports terminal Patterns that still have active linked Tickets, active Patterns whose linked Tickets are all terminal, active Tickets with resolution records, and resolved Tickets still needing guard follow-up. Use it after batch Pattern work, schema changes, or manual dashboard cleanup.

When a new event reopens a previously resolved ticket, the ledger treats that as recurrence evidence: it escalates ticket priority, adds a system triage note, marks any prior guard metadata as ineffective, and raises the resolution knowledge recurrence risk. Reopened tickets should be re-diagnosed rather than assuming the old fix was complete.

Resolved-ticket knowledge is the short, structured memory layer that future agents should consult before repeating a fix or a failed approach. Resolving a bug, incident, or user report as fixed now creates a draft knowledge record when none exists; agents should enrich that draft with the real root cause, symptom signature, subsystem/stage, files touched, verification commands, guard summary, recurrence risk, and agent guidance:

```bash
npm run tickets -- knowledge ISSUE-000123 \
  --root-cause "Standalone markdown-link watermarks were not normalized before source-junk classification." \
  --symptom "OceanofPDF.com survived cleanup and became a bogus Reader heading." \
  --subsystem reader_ingestion_artifact_suppression \
  --failure-stage page_artifact_suppression \
  --fix-strategy "Normalize standalone markdown links and bare URLs to domains before artifact classification." \
  --files-touched-json '["src/services/PageArtifactSuppressionService.ts","scripts/run-toc-structure-regression.ts"]' \
  --verification-commands-json '["npm run tickets -- smoke toc-rebuild"]' \
  --regression-guard "TOC structure regression covers markdown-link source junk." \
  --recurrence-risk medium \
  --agent-guidance "If this recurs, inspect cleanup before nav generation; do not patch nav to ignore arbitrary headings."
```

Link related current and historical tickets when the connection is meaningful:

```bash
npm run tickets -- link ISSUE-000456 ISSUE-000123 \
  --relation regression_of \
  --confidence high \
  --reason "Same source-junk domain survived cleanup and affected Reader navigation."
```

Find resolved bugs/incidents/user reports that still need a distilled knowledge entry:

```bash
npm run tickets -- knowledge-gaps --limit 100
```

Suggest missing prior-art relationships across active Tickets and resolved history:

```bash
npm run tickets -- suggest-relationships --limit 50
```

This is read-only by default. It proposes links using deterministic evidence such as shared family/root family, non-generic title/fingerprint tokens, existing regression guards, structured resolution knowledge, and generated tags. Tags include semantic areas such as `Raster Image Handling`, `Figure Detection`, `Navigation Headings`, and `Reader Markdown Display`, along with detector, parser, route, source-file/function, input class, and stable document identity tags.

If generated tags need to be refreshed after ledger schema/workflow changes, run:

```bash
npm run tickets -- backfill-tags --limit 800
```

Apply only high-confidence suggestions automatically:

```bash
npm run tickets -- suggest-relationships --apply
```

Use `--include-medium` only after reviewing the suggestions, because medium confidence often means “same family and guard area” rather than a proven regression or root cause. High confidence should require a specific anchor, such as shared stable document identity, source file/function, or detector match plus stronger text overlap.

Run a verification command and automatically record a `smoke` or `ci` ticket if it fails:

```bash
npm run tickets -- run --source smoke --family reader_navigation_smoke -- npm run reader:compat-smoke
npm run tickets -- run --source ci --family ci_web_build -- npm run build:web
```

The wrapper streams command output normally and exits with the wrapped command's status. It records only failures. The ticket event includes command metadata, git branch/SHA, exit code, signal, runtime duration, and a scrubbed tail of stdout/stderr.

Registered smoke tests live in `config/smoke-tests.json`. Prefer the registered smoke runner when a target exists because it supplies the stable ticket family, ticket kind, severity, subsystem metadata, and safety gates:

```bash
npm run tickets:smoke:list
npm run tickets -- smoke agent-default --dry-run
npm run tickets -- smoke toc-rebuild
npm run tickets -- smoke ingestion-core --include-expensive
npm run tickets -- smoke reader-runtime --include-live --include-mutating
```

By default, `tickets smoke` skips tests that require a live API, mutate the database/uploads, require Docker, or are marked expensive. Use `--include-live`, `--include-mutating`, `--include-docker`, `--include-expensive`, or `--all` only when that risk/cost is intentional. Like `tickets run`, registered smoke runs record ticket events only for failures.

Smoke report bridging is not limited to command-level failures. If a wrapped smoke emits a JSON artifact through `--out`, `--resume-report`, a registered smoke `artifacts` entry, or a `JSON report: ...json` output line, the ticket runner inspects structured findings in:

- root-level `issueFindings`, `issues`, or `findings`
- item-level `issueFindings`, `issues`, or `findings` under `cases`, `results`, `documents`, `files`, or `tests`

Medium-or-higher findings become `smoke` or `ci` ticket events with stable fingerprints, report context, and artifact references. Low-severity findings are skipped to avoid noise, and import-owned findings stay with `import-ingest`.

Create an agent-discovered ticket:

```bash
npm run tickets -- create-event \
  --source agent \
  --ticket-kind bug \
  --severity high \
  --family reader_navigation \
  --title "Reader cursor jumps after reload" \
  --message "Observed during local browser verification." \
  --fingerprint "reader:navigation:cursor-reload-jump" \
  --dedupe-key "agent:reader:navigation:cursor-reload-jump:2026-05-24"
```

Create a feature/task ticket:

```bash
npm run tickets -- create-event \
  --source agent \
  --ticket-kind feature \
  --severity low \
  --family reader_library \
  --title "Add saved library filters" \
  --message "User-facing enhancement to persist library filter presets." \
  --fingerprint "reader:library:saved-filter-presets"
```

Record a same-session bug fix when the agent found, fixed, and verified a real bug before a ticket existed:

```bash
npm run tickets -- record-fix \
  --title "OceanofPDF markdown link watermark becomes a bogus heading" \
  --family reader_ingestion_artifact_suppression \
  --severity medium \
  --fingerprint "reader:ingestion:artifact-suppression:oceanofpdf-markdown-link-heading" \
  --message "Fresh Ascent of Man ingest retained an OceanofPDF markdown link and nav treated it as a heading." \
  --summary "Normalized standalone markdown-link watermarks before artifact classification; regression smoke passed." \
  --verification passed \
  --evidence-json '{"commands":["npm run tickets -- run --source smoke --family reader_ingestion -- ./node_modules/.bin/ts-node scripts/run-toc-structure-regression.ts"],"notes":"Regression covers ## [OceanofPDF.com](https://oceanofpdf.com)."}' \
  --guard-status guard_added \
  --guard-type regression_test \
  --guard-summary "TOC structure regression now catches OceanofPDF markdown-link headings." \
  --guard-command "npm run tickets -- run --source smoke --family reader_ingestion -- ./node_modules/.bin/ts-node scripts/run-toc-structure-regression.ts" \
  --guard-artifact-ref "scripts/run-toc-structure-regression.ts"
```

`record-fix` creates the ticket event and resolution in one database transaction. Use it only for verified same-session fixes. If verification has not passed, create an open ticket with `create-event` and add notes until a normal `resolve` is justified.

Resolve a ticket after verification:

```bash
npm run tickets -- resolve ISSUE-000123 \
  --summary "Fixed cursor restore ordering and verified reload resume locally." \
  --verification passed \
  --commit "$(git rev-parse --short HEAD)" \
  --branch "$(git branch --show-current)" \
  --evidence-json '{"commands":["npm run check","npm run check:web"],"notes":"Browser reload resume smoke passed."}' \
  --guard-status guard_existing \
  --guard-type regression_test \
  --guard-summary "Existing reload resume smoke covers recurrence." \
  --guard-command "npm run check:web"
```

Create a root-cause pattern when multiple tickets point to the same underlying problem:

```bash
npm run tickets -- suggest-patterns --limit 200

npm run tickets -- create-pattern \
  --title "PDF partition overlap fallout in math-heavy documents" \
  --pattern-key "reader_ingest_pdf_partition_overlap_math" \
  --ticket-kind bug \
  --family "partition_overlap_other" \
  --severity high \
  --summary "Several ingest tickets share the same partition ownership contract failure."

npm run tickets -- link-pattern reader_ingest_pdf_partition_overlap_math ISSUE-000123 --relation primary
npm run tickets -- link-pattern reader_ingest_pdf_partition_overlap_math ISSUE-000124 --relation related
```

`suggest-patterns` combines two signals:

- active-count grouping by root family, with the default high-confidence threshold at 3 active clusters and no 10-event floor
- durable relationship evidence from resolved/pending-history links, using relationship strength, relationship count, and deduped evidence signals

Evidence-based suggestions require at least one live ticket, so resolved-only history stays prior art instead of becoming active work. Tune the evidence pass with `--evidence-min-strength`, `--evidence-min-edges`, or disable it with `--skip-evidence` during diagnostics.

New ticket events now run a lightweight pattern reconciliation step when they are created. If a matching `auto_<root_family>` pattern already exists, the new ticket is linked immediately; if a resolved pattern recurs, the link is marked as a regression. If at least 3 active tickets share a root family and no active pattern exists, the ledger creates the pattern and links the active tickets. Pattern metadata records an escalation state so agents can see when a cluster is only a candidate versus ready for root-cause analysis.

Resolve the pattern after the root fix is verified. Use `--resolve-linked` only when the linked tickets were covered by the same verification evidence:

```bash
npm run tickets -- resolve-pattern reader_ingest_pdf_partition_overlap_math \
  --summary "Fixed partition owner arbitration before Reader contract assembly; corpus smoke passed for the linked documents." \
  --verification passed \
  --resolve-linked \
  --linked-resolution-type verified_fixed \
  --evidence-json '{"commands":["npm run check","node scripts/run-reader-corpus-upload.cjs --folder docs/Reader/test-docs/pdf/Lite-Target/Math-Tables-Figures --strict-reader-contract"],"notes":"Linked failures no longer reproduce."}'
```

Pattern resolution now refuses to leave linked active Tickets open unless that intent is explicit. Use `--resolve-linked` when the same verification covers the linked Tickets, including a regression guard decision for bug/incident/user-report Tickets. Use `--pattern-only` only when the Pattern itself is no longer useful as an active grouping but its linked Tickets still need separate triage, implementation, or verification.

## Agent Start-Of-Work Checklist

Before starting a debugging or implementation task:

1. Check the active ticket summary first, or at minimum active root-cause patterns and relevant active tickets.

```bash
npm run tickets -- summary --limit 20
npm run tickets -- patterns --status active --limit 20
npm run tickets -- list --status active --limit 20
```

2. If the task is ingestion-related, import current ingest anomalies first.

```bash
npm run tickets -- import-ingest --limit 200
```

Manual document ingestion in the app now syncs that document's failed/warning metadata into Tickets automatically after the queue worker writes final document metadata. The import command is still useful as a backfill/reconciliation step for older documents or if an automatic sync failed.

3. Inspect any likely matching cluster.

```bash
npm run tickets -- show ISSUE-000123
```

4. Check resolved prior art for likely matches before changing code.

```bash
npm run tickets -- related ISSUE-000123 --include-resolved --limit 10
```

Use high-confidence matches and knowledge entries to avoid repeating failed approaches, to reuse the right source-level fix area, and to check whether a prior regression guard should already catch the recurrence.

5. If several tickets share a likely root cause, create or reuse a ticket pattern and link the tickets before implementing the fix.

6. If no ticket matches but real work is found, create one with a stable fingerprint and the right `--ticket-kind`.

7. If no ticket matches because the agent found and fixed the bug within the same session, use `record-fix` after verification passes so the ledger still records the original symptom, root-cause fix, and verification evidence.

8. Before final handoff on a meaningful bug/incident/user-report fix, decide whether recurrence should be caught automatically. Add a regression guard with `tickets guard`, or mark it waived/deferred with a reason. Do not add noisy coverage for one-off low-value cases.

9. For meaningful resolved bugs, add or update resolution knowledge with `tickets knowledge`. For regressions or reused fixes, link the current ticket to prior art with `tickets link`.

10. During cleanup passes, use the Ticket card Details `Prior Art & Hypotheses` panel for per-ticket triage, or run `tickets suggest-relationships` for broader maintenance scans. Review medium-confidence suggestions before applying. Links made while either endpoint is still active are stored as pending hypotheses; once both endpoint tickets become terminal, the ledger promotes the link to durable resolved history. Durable links carry a derived strength tier based on distinct evidence signals, so repeated observation of the same signal does not inflate the edge. Use the Admin Portal `Prior Art Graph` tab to review durable edges, inspect their evidence signals, and mark reopened/suspect edges reviewed or still needing review.

For scheduled maintenance, use:

```bash
npm run tickets -- review-relationships --json
npm run tickets -- resolution-audit --json
npm run tickets -- guard-audit --json
```

The scheduled relationship review command refreshes generated tags, computes relationship suggestions, and applies only high-confidence links by default. Medium-confidence suggestions should be reviewed through per-ticket `Prior Art & Hypotheses` context or CLI dry-runs rather than treated as a global open-ticket approval queue. Use `--dry-run` to preview without changing relationships or tags, and use `--backfill-in-dry-run` only when a dry-run should also refresh generated tags. The resolution audit is read-only and should be reviewed for lingering resolved/open workflow mismatches. The guard audit is read-only and should be reviewed for stale or uncataloged recurrence guards.

Ticket creation stores a structured `correlation_key` when one is supplied or can be derived from route, stage, detector/error class, or document identity. Derived keys are intentionally inspectable and family-independent, so browser reports, user reports, smoke findings, and agent-created events about the same route/stage/document can be associated even when their exact fingerprints differ. Triage-oriented new events also perform near-duplicate detection and create soft relationships for likely duplicates instead of silently forking unrelated clusters. If a hand-written fingerprint looks one token away from an existing same-family fingerprint, the CLI/API returns a warning so agents can avoid typo-driven cluster splits.

Semantic tags and root-family grouping rules are data-driven through `config/ticket-taxonomy.json`. Add high-level semantic areas or new root-family prefixes there before changing code. After taxonomy changes, run `npm run tickets -- backfill-tags --limit 800` and, if needed, `npm run tickets -- suggest-patterns --limit 200`.

## Pattern Rules

Ticket patterns are root-cause work items above individual tickets. Use them when a fix should address a family of recurring symptoms or related work.

Create or reuse a pattern when:

- multiple open tickets share the same subsystem, error class, parser stage, route, or failing smoke
- the planned fix is architectural or source-level rather than a document-by-document remediation
- the same verification command can reasonably cover the linked tickets

Do not create a pattern for a single isolated ticket unless you expect the same work item to recur.

Useful link relations:

- `primary`: the clearest cluster that represents the pattern
- `related`: another symptom expected to be fixed by the same root change
- `duplicate`: same problem already represented by another linked cluster
- `regression_of`: recurrence of a previously fixed pattern or cluster
- `caused_by`: downstream symptom caused by another cluster
- `superseded_by`: cluster is replaced by newer pattern work

Resolving a pattern records an `issue_pattern_resolutions` audit row. If `--resolve-linked` is passed, the CLI also writes resolution rows for linked non-terminal tickets and moves them to the linked resolution status. Only use that cascade after verification covers the linked tickets.

The suggestion pass is read-only by default. It can apply high-confidence groups with:

```bash
npm run tickets -- suggest-patterns --apply --min-clusters 3 --min-events 0
```

`--apply` creates or reuses an `auto_<family>` pattern and links the suggested tickets. It does not resolve anything. Medium-confidence groups require `--include-medium`.

## Resolution Rules

Do not mark a ticket resolved only because the code was edited. Resolution requires evidence.

Minimum evidence:

- files or module area changed
- targeted verification command or browser/API smoke
- outcome of the verification

Good resolution summaries are concrete:

- "Fixed PDF placeholder region ID propagation in `DocumentIrMarkdownRenderer`; verified with `npm run reader:region-contract-hardening-smoke` and `npm run check`."
- "No code change: duplicate of `ISSUE-000042`; linked and marked duplicate after comparing fingerprints."

Weak resolution summaries should be avoided:

- "Fixed"
- "Should work now"
- "Probably resolved"

After a meaningful fix is verified, write enough knowledge for a future agent to understand what to reuse or avoid without rereading the whole thread. The knowledge entry should not duplicate the resolution audit verbatim; it should distill the lesson:

- root cause and symptom signature
- subsystem, input class, and failure stage when known
- fix strategy, touched files, and verification commands
- failed approaches or downstream patches that should not be repeated
- recurrence risk and agent guidance

Use `npm run tickets -- knowledge-gaps --limit 100` during cleanup passes to find resolved tickets that still have no distilled knowledge.

## Reopened Tickets

If a new event arrives with the same fingerprint after a ticket is resolved, the service reopens the ticket. This is intentional.

When a reopened ticket appears:

1. Inspect the new event context.
2. Compare it with the prior resolution evidence.
3. Decide whether the original fix was incomplete, verification was insufficient, or the new event should use a different fingerprint.
4. Resolve again only after new verification.

## Fingerprint Guidance

Fingerprints should be stable across repeated sightings of the same root cause and should avoid volatile data.

Good fingerprint components:

- ticket family
- route or subsystem
- error class
- parser/warning code
- normalized stage

Avoid volatile components:

- timestamps
- document IDs unless the problem is document-specific
- cache-bust IDs
- line numbers that shift frequently
- full user content

## Current Source Feeds

Implemented now:

- ingestion warnings and failures from manual app ingestion after queue completion, plus backfill/reconciliation via `npm run tickets -- import-ingest`
- browser console errors, warnings, unhandled promise rejections, and resource load failures via `/api/support/browser-issue`; local/dev runtime reports include bounded browser page evidence in event context
- user feedback and bug reports via the Inti menu Feedback modal and `/api/support/user-report`, with optional `browser_evidence` JSON artifacts; admin accounts also see an `Admin Ticket` mode in the same menu that creates `manual_admin` tickets directly with ingestion/debugging fields and multiple screenshot attachments
- backend API 5xx responses, uncaught Express route errors, unhandled promise rejections, and uncaught exception monitor events as `backend` source events
- smoke/CI command failures via `npm run tickets -- run --source smoke|ci -- <command>`
- agent-authored events via `npm run tickets -- create-event`
- manual Admin Portal Tickets with optional evidence attachments and `browser_evidence` JSON artifacts via `/api/admin/tickets/events`
- regression guard decisions for resolved bugs via `npm run tickets -- guard ...` and Admin Portal controls
- resolved-ticket knowledge and cluster-to-cluster relationships via `npm run tickets -- knowledge`, `related`, `search-knowledge`, `knowledge-gaps`, and `link`
- deterministic relationship suggestions via `npm run tickets -- suggest-relationships`
- scheduled relationship review via `npm run tickets -- review-relationships --json`
- Admin Portal per-ticket `Prior Art & Hypotheses` panels for linked history, resolved-ticket matches, knowledge summaries, and admin/agent hypothesis links. Triage links are explicitly labeled as pending hypotheses until endpoint resolution promotes them to durable history. Durable links show strength tier and evidence freshness from the relationship evidence ledger.
- Admin Portal `Prior Art Graph` curation for durable relationship edges, evidence signals, review-required state, and curation history.
- root-cause patterns via `npm run tickets -- create-pattern`, `link-pattern`, and `resolve-pattern`
- manual/admin notes via CLI and Admin Portal
- manual/admin resolution via CLI and Admin Portal

Planned feeds:

- MCP or HTTP adapters for agent harnesses

The browser reporter is enabled by default in production builds. In local development it is opt-in to avoid flooding the ledger with ordinary dev noise:

```text
http://localhost:5173/?browserIssueReporter=1
```

Local storage/session storage flag:

```text
inti.browserIssueReporter=1
```

User feedback reports are explicit submissions from the Reader UI. The Inti floating menu has a `Feedback` action that opens a guided report modal with issue category, impact, context checkboxes, message text, optional contact email for anonymous users, and up to three image attachments. Uploaded images are stored under `data/issue-reports/<yyyy-mm>/<report-id>/` and referenced as issue artifacts; agents should inspect those artifacts only when needed for debugging and should avoid copying sensitive screenshot content into resolution notes.

Backend runtime reports are automatic and intentionally narrow. The API middleware records 5xx responses and uncaught Express errors without storing request bodies, cookies, authorization headers, or raw query values. Repeated backend failures are deduped into short time buckets, so agents should inspect the newest event context before assuming a cluster represents every occurrence.

Smoke/CI reports record command-level failures and medium-or-higher structured findings from supported JSON reports. Reader corpus upload reports remain the richest producer, but other smoke scripts can now emit the same `issueFindings`/`issues`/`findings` shape. Use them when running meaningful verification, especially corpus smokes, local regression scripts, build checks, and CI jobs. Import-owned findings such as structure-contract ingest warnings stay with `import-ingest`, and low-severity smoke findings are skipped to avoid ledger noise. A clean verification pass will not add ledger events.

When resolving a `PATTERN-...` and clearing linked tickets, include a pattern-level guard decision. The CLI/API will reject linked-ticket pattern resolution without a guard decision, because otherwise the system creates a batch of resolved Tickets that immediately become guard gaps. A deferred or waived decision is acceptable when automation is not ready or not worthwhile, but the reason must be recorded.

## Safety Boundaries

Agents may create and resolve local ticket-ledger records when working in local development.

Production resolution should include stronger evidence:

- reviewed commit or PR
- deployment version when applicable
- production or staging verification
- no sensitive user document content in evidence JSON

Do not store secrets, full user documents, private credentials, auth tokens, or raw sensitive browser logs in issue events or resolution evidence.
