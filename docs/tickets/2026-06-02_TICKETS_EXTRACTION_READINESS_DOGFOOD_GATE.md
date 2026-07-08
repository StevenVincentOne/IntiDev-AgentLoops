# Tickets Extraction Readiness And Dogfood Gate

Date: 2026-06-02
Status: Phase 0 dogfood gate
Area: Tickets / extraction readiness / agent harness

## Decision

Do not extract Tickets into a new public repo yet.

The current implementation is ready for a focused dogfood period inside Inti. The goal of this period is to use Tickets during real ingestion debugging and development work until the workflows prove they are clear, durable, and not dependent on Inti-specific assumptions.

Extraction should begin only after this gate is satisfied.

## Current Ledger State

As of this gate:

- `DEV-000847`: active extraction feature ticket.
- `DEV-000870`: active Reader ingestion stack optimization investigation.
- `ISSUE-000868`: active backend Reader document incident.
- `ISSUE-000684`: resolved ticket still needing guard follow-up.
- Resolution audit reports no terminal Patterns with active linked Tickets, no active Patterns with only terminal linked Tickets, and no active Tickets with resolution records.

This is a good evaluation moment because ingestion debugging is producing real agent workflow pressure: active incidents, development investigations, prior-art lookup, smoke verification, guard decisions, and long-running command handling.

## Dogfood Goal

Use the Inti implementation as the reference harness before extraction.

The dogfood pass should answer:

- Can an agent start from a copied Ticket handoff and reliably know what to do?
- Can active ingestion work stay visible without getting buried in docs or chat?
- Can User, Issue, and Development queues represent different work without duplicating state?
- Can Patterns be created and resolved without leaving linked Tickets stranded?
- Can prior art prevent repeated debugging paths?
- Can verification, guards, and resolution knowledge be captured without excessive ceremony?
- Can the same workflow be explained as an installable agent harness for another project?

## Operating Protocol During Ingestion Debugging

For meaningful ingestion/debugging work:

1. Start with the ledger.

```bash
npm run tickets -- begin <DEV-/ISSUE-/USER-...|family>
```

If no ticket is known:

```bash
npm run tickets -- summary --limit 20
npm run tickets -- patterns --status active --limit 20
npm run tickets -- list --status active --limit 20
```

2. Inspect related resolved work before changing code.

```bash
npm run tickets -- related <key> --include-resolved --limit 10
```

3. Use Tickets for work state instead of ad hoc chat memory.

- Add hypotheses with `tickets note`.
- Move Development work through `tickets workflow`.
- Create a Pattern when several tickets share one root cause.
- Resolve only after verification evidence exists.
- Record or defer guard decisions explicitly.

4. End substantial work with an audit pass.

```bash
npm run tickets -- resolution-audit
npm run tickets -- guard-gaps --limit 20
npm run tickets -- knowledge-gaps --limit 20
```

## Workflows To Exercise Before Extraction

### Agent Start And Handoff

Acceptance:

- A copied handoff for `ISSUE-...`, `DEV-...`, or `USER-...` gives the agent enough context to start.
- `tickets begin` shows active ticket context, active Patterns, prior art, and guard suggestions.
- The canonical `ISSUE-...` key and queue alias remain obvious.

Evidence to collect:

- At least three real agent sessions begin from Tickets.
- At least one begins from a Development ticket.
- At least one begins from an Issue or incident ticket.

### Development Queue

Acceptance:

- Development tickets can hold staged specs, partial implementations, future work, and deferred work without being confused with bugs.
- `readyForAgent`, status, and linked docs are enough to guide implementation.
- Deferred backlog stays visible.

Evidence to collect:

- Use `DEV-000847` for extraction planning.
- Use `DEV-000870` or a successor ticket for ingestion stack work.
- Record at least one workflow transition with a clear summary.

### User Queue

Acceptance:

- User reports and production feedback are first-class work items.
- Browser evidence and artifacts can be inspected without leaking sensitive content into notes.
- User work can route into Issues or Development without losing the original user context.

Evidence to collect:

- Create or process at least one representative User ticket.
- Confirm the handoff prompt emphasizes user impact, browser evidence, and prior art.

### Pattern Lifecycle

Acceptance:

- Patterns represent root-cause groups, not a second unresolved queue.
- Resolving a Pattern with active linked Tickets requires either `--resolve-linked` or explicit `--pattern-only`.
- `resolution-audit` catches stranded Pattern/Ticket states.

Evidence to collect:

- Create or reuse one Pattern during ingestion debugging if multiple Tickets share a root cause.
- Resolve or leave it active intentionally.
- Run `resolution-audit` after resolution.

### Prior Art And Knowledge

Acceptance:

- Related history is visible before implementation.
- Links distinguish pending hypotheses from durable resolved history.
- Resolution knowledge captures root cause, symptom, subsystem, failed approaches, fix strategy, and verification commands.

Evidence to collect:

- Link at least one active ticket to resolved prior art.
- Enrich at least one resolved Ticket knowledge record that was useful during ingestion work.

### Guard Workflow

Acceptance:

- Meaningful bugs/incidents/user reports cannot silently resolve without a guard decision.
- Guard gaps and guard audits are understandable.
- Deferred guards are visible follow-up, not hidden debt.

Evidence to collect:

- Clear or intentionally preserve `ISSUE-000684` as guard follow-up.
- Record at least one `guard_added`, `guard_existing`, `guard_deferred`, or `guard_waived` decision from a real workflow.

### CLI/UI Parity

Acceptance:

- Every important UI action has a CLI equivalent.
- Every important CLI state has a visible UI representation.
- Agents can operate from the CLI without needing the Admin Portal.

Evidence to collect:

- Create/note/workflow/resolve/guard flows are tested from CLI.
- Equivalent state is visible in `/tickets`.

## Extraction Boundary Map

### Reusable Core

These should become package-owned:

- ticket ids and aliases: `ISSUE-...`, `DEV-...`, `USER-...`
- ticket kinds, statuses, severity, priority, and workflow transitions
- event deduplication and cluster lifecycle
- notes, resolution records, reopen handling, and recurrence risk
- Pattern creation, linking, resolution, and resolution audit
- prior-art relationships, relationship evidence, and resolution knowledge
- regression guard rules, guard gaps, and guard audit contracts
- taxonomy config and generated semantic tags
- handoff prompt generation
- CLI command behavior and JSON output contracts
- MCP tool contracts over the same service layer

### Store And Adapter Boundary

These should become explicit adapters:

- SQL store and migrations
- artifact storage
- auth/current actor lookup
- redaction policy
- project metadata enrichment
- smoke registry lookup
- HTTP framework integration
- UI shell integration

### Inti-Specific Host Code

These should stay in Inti or become examples/adapters:

- Reader ingestion anomaly import
- document ids and document metadata links
- browser evidence shape specific to the Reader UI
- Admin Portal navigation shell
- local DigitalOcean deployment/runbook assumptions
- Reader smoke commands and corpus fixtures
- Inti taxonomy defaults such as Reader parsing/rendering families

## Extraction Blockers To Watch

- `IssueLedgerService` still imports Inti database helpers directly.
- Public-facing table names should become `ticket_*`, while Inti currently uses `issue_*`.
- Admin Portal Tickets UI is still part of a larger Inti admin component.
- Smoke registry entries mix generic guard concepts with Reader-specific commands.
- Artifact storage and privacy/redaction are not yet abstracted.
- MCP write policy has not been implemented.
- GitHub sync is not needed for the first release and should not block extraction.
- Package name, license, and public README positioning are still undecided.

## Dogfood Exit Criteria

Extraction can start when all of these are true:

- At least one real ingestion/debugging cycle used Tickets from begin to resolution or intentional deferral.
- `resolution-audit` is clean except for intentional guard follow-up.
- Guard gaps are either cleared or explicitly documented.
- `DEV-000847` has updated acceptance criteria based on dogfood findings.
- The reusable/adapter/Inti-specific boundary has no major unknowns.
- CLI JSON output needed by agents is stable enough to document.
- The reference UI workflow is clear enough to show in public docs or screenshots.
- No extraction step requires copying private Inti data, secrets, or user document content.

## Immediate Actions

1. Keep using Tickets for the active ingestion debugging work instead of treating extraction as the next implementation task.
2. Add dogfood notes to `DEV-000847` whenever a workflow feels awkward, redundant, or especially useful.
3. Clear or intentionally document `ISSUE-000684` guard follow-up.
4. When ingestion debugging stabilizes, update this gate with observed friction and decide whether Phase 1 core-boundary extraction is ready.

