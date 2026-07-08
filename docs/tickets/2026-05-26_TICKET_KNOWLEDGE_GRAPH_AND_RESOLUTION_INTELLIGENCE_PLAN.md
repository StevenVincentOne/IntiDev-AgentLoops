# Ticket Knowledge Graph and Resolution Intelligence Plan

Date: 2026-05-26
Status: Proposed
Area: Ticket ledger / agent workflow / resolution knowledge / debugging memory

## Summary

The Ticket ledger is working as an active issue/task intake and resolution system. Agents are checking open Tickets, creating new Tickets, resolving verified fixes, adding notes, and recording regression guards. The remaining gap is that resolved Tickets are still mostly passive audit records.

This plan turns resolved Tickets into an active knowledge layer for agents. The core idea mirrors the IntiDoc Intelligent Document principle:

```text
Raw document -> ingestion/tagging -> intelligent document -> lower-entropy downstream reading/agent work

Raw issue/task -> ticket interpretation/resolution tagging -> intelligent task record -> lower-entropy downstream debugging/agent work
```

At document ingestion time, IntiDoc writes interpretive structure into the document through tags, partitions, ownership, object roles, heading contracts, and metadata. At Ticket creation and resolution time, the ledger should similarly write interpretive structure into the task record: symptom signatures, root cause, affected subsystem, failed hypotheses, successful fix strategy, verification commands, regression guards, and relationships to prior work.

The goal is simple: resolved Tickets should stop being only closed records and become prior art that agents actively query before repeating mistakes.

## Current Gap

Current resolved Ticket records are useful for audit:

- what happened
- when it was seen
- what agent or user reported it
- how it was resolved
- what verification evidence was attached
- whether a regression guard exists

But they are not yet optimized for future agent reasoning:

- There is no dedicated "lesson learned" structure.
- Related resolved Tickets are not surfaced automatically.
- Agents are instructed to check open Tickets, but not necessarily similar resolved Tickets.
- Resolved Tickets can be searched only indirectly through existing list/show flows.
- Pattern grouping primarily organizes open work, not long-lived prior art.
- The system does not yet distinguish same symptom, same root cause, regression, failed prior approach, same input class, or same detector.

## Design Principle

Create once, reason many times.

When a Ticket is created or resolved, the system should pay a small extra cost to write reusable structure. Later agents should receive lower-entropy context:

- "Have we seen this shape before?"
- "What fixed it last time?"
- "What failed last time?"
- "What files/functions were involved?"
- "What smoke or detector should catch recurrence?"
- "Is this a regression, a sibling symptom, or a novel issue?"

This is not decorative metadata. The structure should be limited to fields that change agent behavior.

## Goals

1. Make resolved Tickets actively searchable and relevant during new investigations.
2. Capture reusable resolution knowledge in structured fields, not only prose notes.
3. Add typed relationships between Tickets so prior art becomes graph-like.
4. Let agents query similar resolved Tickets from the CLI before debugging.
5. Surface related resolved Tickets in the Admin Portal.
6. Preserve deterministic, low-cost matching first; defer embeddings until needed.
7. Keep production/user privacy constraints: do not store raw user document content as knowledge.
8. Support future open-source extraction by keeping the model harness-agnostic.

## Non-Goals

- Do not replace the existing event/cluster/pattern/resolution model.
- Do not require LLM calls or embeddings for v1.
- Do not turn every resolved Ticket into a large postmortem.
- Do not require perfect graph correctness before the feature is useful.
- Do not expose sensitive user text, full document text, secrets, or screenshots in public exports.

## Proposed Concepts

### Resolution Knowledge Record

A structured summary of what was learned from fixing a Ticket.

This is distinct from:

- `issue_notes`: running context, hypotheses, triage notes.
- `issue_resolutions`: audit record that a Ticket was fixed/dismissed/etc.
- `issue_regression_guards`: detector/test/waiver/deferred decision.

A resolution knowledge record is the reusable interpretation:

- symptom signature
- root cause
- affected subsystem
- input/document class
- fix strategy
- failed or avoided approaches
- verification command
- regression guard reference
- recurrence guidance for future agents

### Ticket Relationship

A typed edge between two Tickets or between a Ticket and a Pattern.

Useful relationship types:

- `regression_of`: current Ticket appears to be a recurrence of a resolved Ticket.
- `same_root_cause`: different symptoms came from the same underlying defect.
- `same_symptom`: similar symptom, root cause not yet proven.
- `same_input_class`: issue appears on the same document/input class.
- `same_detector`: issue is caught by the same smoke, warning, or runtime detector.
- `same_fix_area`: likely involves the same files/services.
- `fixed_by_same_change`: multiple Tickets were closed by one verified change.
- `failed_prior_approach`: prior attempted fix should not be repeated.
- `supersedes`: newer Ticket or Pattern replaces an older record.
- `related_history`: weaker contextual relation.

Relationships should carry:

- confidence: low/medium/high
- reason
- created_by_type: agent/admin/system
- created_by_id
- created_at

### Applicability Profile

A compact description of when a resolved Ticket is useful again.

Example fields:

- `families`: `reader_ingestion`, `reader_rendering`, `browser_ui`
- `warning_codes`: `STRUCTURE_CONTRACT_UNRESOLVED`
- `parser`: `odl`, `ppdoclayout`, `native_pdf`, `liteparse`
- `document_classes`: `book`, `legal`, `math_tables_figures`, `ocr_scan`
- `routes`: `/reader`, `/tickets`, `/admin`
- `detectors`: smoke names, guard detector keys
- `files_touched`: source paths
- `functions_touched`: function/class names where practical
- `artifact_types`: `browser_evidence`, `reader_corpus_report`, `tagging_audit`

The matching system can use this deterministic profile before considering semantic search.

## Proposed Data Model

Keep existing `issue_*` table names internally for compatibility.

### `issue_resolution_knowledge`

One row per meaningful resolved Ticket, usually one-to-one with `issue_clusters`.

Suggested columns:

- `id`
- `cluster_id`
- `resolution_id`
- `root_cause_summary`
- `symptom_signature`
- `affected_subsystem`
- `input_class`
- `failure_stage`
- `fix_strategy`
- `failed_approaches_json`
- `files_touched_json`
- `functions_touched_json`
- `verification_commands_json`
- `regression_guard_summary`
- `recurrence_risk`: `low|medium|high|unknown`
- `agent_guidance`
- `privacy_level`: `internal|redacted|exportable`
- `metadata_json`
- `created_by_type`
- `created_by_id`
- `created_at`
- `updated_at`

### `issue_cluster_relationships`

Typed edges between Tickets.

Suggested columns:

- `id`
- `from_cluster_id`
- `to_cluster_id`
- `relation_type`
- `confidence`: `low|medium|high`
- `reason`
- `created_by_type`
- `created_by_id`
- `metadata_json`
- `created_at`

Constraints:

- prevent self-links
- unique `(from_cluster_id, to_cluster_id, relation_type)` where practical
- allow directional relationships such as `regression_of`

### `issue_knowledge_tags`

Flexible structured tags that can apply to a Ticket, Pattern, Resolution, or Knowledge record.

Suggested columns:

- `id`
- `entity_type`: `cluster|pattern|resolution|knowledge`
- `entity_id`
- `tag_namespace`: `semantic|subsystem|parser|input|route|detector|source_file|function|document|stage|warning_code|symptom`
- `tag_key`
- `tag_value`
- `confidence`: `low|medium|high`
- `source`: `agent|system|admin|derived`
- `created_at`

This avoids schema churn while the knowledge model matures. Initial generated semantic area tags include `Raster Image Handling`, `Figure Detection`, `Navigation Headings`, `Reader Markdown Display`, `Browser Runtime`, and `TTS Playback`.

## CLI Additions

### Create or Update Knowledge

```bash
npm run tickets -- knowledge ISSUE-000123 \
  --root-cause "Standalone markdown links for OceanofPDF.com bypassed source artifact suppression." \
  --symptom "OceanofPDF link appears as bogus Reader heading" \
  --subsystem reader_ingestion \
  --input-class book_pdf \
  --fix-strategy "Normalize standalone markdown links to domains before artifact classification." \
  --failed-approach "Do not patch only nav rendering; remove source junk before heading tagging." \
  --verification-command "npm run tickets -- smoke reader-ledger-regression" \
  --guard "run-toc-structure-regression OceanofPDF markdown-link fixture"
```

### Link Tickets

```bash
npm run tickets -- link ISSUE-000400 ISSUE-000342 \
  --relation regression_of \
  --confidence high \
  --reason "Same OceanofPDF bogus heading symptom and same artifact suppression path."
```

### Find Related Tickets

```bash
npm run tickets -- related ISSUE-000400 --include-resolved --limit 10
```

Expected output:

- direct linked Tickets
- related Patterns
- high-scoring resolved Tickets
- relevant knowledge records
- matching guards/smoke commands

### Search Resolved Knowledge

```bash
npm run tickets -- search-knowledge \
  --query "bogus heading source junk markdown link" \
  --family reader_ingestion \
  --include-resolved \
  --limit 20
```

### Agent Workflow Check

Add to `AGENTS.md` once implemented:

```bash
npm run tickets -- related ISSUE-000123 --include-resolved --limit 10
```

Agents should run this after identifying or creating a Ticket and before making a nontrivial fix.

## Retrieval Strategy

Use deterministic scoring first.

Score candidates by:

- exact family match
- shared Pattern
- shared warning code / detector key
- shared route
- shared parser
- shared document/input class
- title token overlap
- message/detail token overlap
- source file overlap
- regression guard command overlap
- same artifact type
- explicit relationship edge

Example result scoring:

```text
+ direct relationship edge
+ same root-cause Pattern
+ same family
+ same detector or guard command
+ same warning code
+ same source file/function
+ title/symptom token overlap
+ same document class/parser
-- terminal status is wont_fix without useful knowledge
-- low-confidence or stale relationship
```

Embeddings can be a later enhancement if deterministic search misses too much, but v1 should be cheap, explainable, and local.

## Admin Portal Additions

### Ticket Detail/Card

Add a `Related Resolved Tickets` panel:

- public key
- title
- relation/scored reason
- resolution summary
- root cause
- fix strategy
- verification command
- regression guard state
- copy button

### Resolution Knowledge Panel

For resolved Tickets, show:

- root cause
- fix strategy
- failed approaches
- verification
- guard
- recurrence guidance

For open Tickets, show:

- "Potential prior art" from related resolved Tickets
- quick link action: `Mark as regression of ISSUE-...`
- quick note action: `Add prior-fix note`

### Pattern View

Patterns should aggregate resolved knowledge:

- common root causes
- common fix areas
- repeated failed approaches
- guard coverage gaps

This turns Patterns into architectural insight, not just ticket grouping.

## Agent Workflow

### New Ticket Investigation

1. Inspect open Ticket:

   ```bash
   npm run tickets -- show ISSUE-000123 --json
   ```

2. Pull related prior art:

   ```bash
   npm run tickets -- related ISSUE-000123 --include-resolved --limit 10
   ```

3. If a prior resolved Ticket is relevant, link it:

   ```bash
   npm run tickets -- link ISSUE-000123 ISSUE-000045 --relation same_symptom --confidence medium --reason "..."
   ```

4. Add note if the prior fix changes the plan:

   ```bash
   npm run tickets -- note ISSUE-000123 --note-type related_history --body "Similar to ISSUE-000045; prior fix was source-stage artifact suppression."
   ```

5. Implement source-level fix.
6. Verify.
7. Resolve with evidence.
8. Record or update regression guard.
9. Add or update resolution knowledge.

### Same-Session Fix

For `record-fix`, allow optional knowledge fields:

```bash
npm run tickets -- record-fix ... \
  --knowledge-root-cause "..." \
  --knowledge-fix-strategy "..." \
  --knowledge-agent-guidance "..."
```

If knowledge fields are absent for meaningful bugs, `guard-gaps` or a new `knowledge-gaps` command can flag the resolved Ticket.

## Knowledge Gap Workflow

Add:

```bash
npm run tickets -- knowledge-gaps --limit 50
```

It should return resolved bug/incident/user-report Tickets that:

- have no knowledge record
- have a guard but no root cause
- have a root cause but no fix strategy
- have no relationship and look similar to other resolved Tickets

This parallels the current regression guard gap workflow.

## Automation Opportunities

### Scheduled Prior-Art Grouping

Run twice daily or after enough new Tickets accumulate:

```bash
npm run tickets -- suggest-relationships --include-resolved --limit 500
```

Suggested relationship candidates should be reviewed before applying unless confidence is high.

### Resolution Knowledge Drafting

After a Ticket is resolved, a helper can draft a knowledge record from:

- resolution summary
- notes
- changed files
- guard record
- verification evidence
- linked Pattern

The first version can be deterministic and template-based. Later, an agent can improve the draft.

## Privacy and Exportability

Each knowledge record should carry a privacy/export flag:

- `internal`: may reference local paths, private docs, internal route details.
- `redacted`: safe to show in admin UI but not public export.
- `exportable`: safe for open-source examples/docs.

Knowledge records should avoid:

- raw user document content
- full screenshots
- auth tokens
- emails unless redacted
- private document titles when unnecessary
- raw browser storage values

## Implementation Phases

### Phase 1: Schema and CLI

- Add `issue_resolution_knowledge`.
- Add `issue_cluster_relationships`.
- Add `issue_knowledge_tags`.
- Add CLI:
  - `knowledge`
  - `related`
  - `link`
  - `search-knowledge`
  - `knowledge-gaps`

Acceptance:

- An agent can attach structured knowledge to a resolved Ticket.
- An agent can link an open Ticket to a resolved Ticket.
- `related --include-resolved` returns deterministic prior-art candidates.

### Phase 2: Agent Workflow Integration

- Update `AGENTS.md`.
- Update workflow docs.
- Add `related --include-resolved` to the standard debugging flow.
- Add `knowledge-gaps` to resolved Ticket hygiene.

Acceptance:

- Agents routinely inspect related resolved Tickets before nontrivial fixes.
- Resolved meaningful bugs are not considered complete unless guard and knowledge decisions are present or waived/deferred.

### Phase 3: Admin Portal UI

- Show related resolved Tickets on Ticket cards/details.
- Add relationship creation controls.
- Show knowledge record summary for resolved Tickets.
- Add "Knowledge Missing" filter.

Acceptance:

- Admin can see prior art without using CLI.
- Admin can link a current Ticket to a resolved one.
- Admin can copy a prior-art-aware agent handoff prompt.

### Phase 4: Pattern Intelligence

- Aggregate knowledge under Patterns.
- Identify repeated failed approaches.
- Identify fix hotspots by source file/subsystem.
- Identify guard coverage gaps by family/detector.

Acceptance:

- Patterns produce architectural insight, not only grouping.
- A recurring root cause can produce an explicit refactor/hardening Ticket.

### Phase 5: Optional Semantic Search

Only after deterministic matching is measured:

- Add embeddings for redacted knowledge text.
- Keep deterministic explanations in result output.
- Do not require paid model calls for core local workflow.

Acceptance:

- Semantic search improves recall without hiding why a prior Ticket was suggested.

## Example: OceanofPDF Regression

Resolved Ticket knowledge might look like:

```json
{
  "symptomSignature": "Source junk domain appears as Reader heading",
  "rootCauseSummary": "Standalone markdown links were not normalized to domains before artifact suppression.",
  "affectedSubsystem": "reader_ingestion",
  "inputClass": "book_pdf",
  "failureStage": "source_cleanup_before_nav_tagging",
  "fixStrategy": "Normalize standalone markdown links and bare URLs to domains before artifact classification.",
  "failedApproaches": [
    "Do not patch only Reader nav rendering; remove source junk before headings are generated."
  ],
  "filesTouched": [
    "src/services/PageArtifactSuppressionService.ts",
    "scripts/run-toc-structure-regression.ts"
  ],
  "verificationCommands": [
    "npm run tickets -- run --source smoke --family reader_ingestion -- ./node_modules/.bin/ts-node scripts/run-toc-structure-regression.ts"
  ],
  "agentGuidance": "If a future bogus heading contains a source/watermark domain, inspect source cleanup before nav generation."
}
```

A future similar Ticket should immediately surface this prior art.

## Open Questions

1. Should `issue_resolution_knowledge` be required for every resolved bug, or only medium+ severity and user/admin-reported defects?
2. Should relationship suggestions be auto-applied only for exact fingerprints and shared guards?
3. Should knowledge records be editable from the Admin Portal or only append/revise through CLI initially?
4. Should Patterns also have first-class knowledge records, or should they aggregate child Ticket knowledge?
5. What level of source path/function extraction can be automated reliably from git diff and resolution evidence?

## Recommended First Implementation Step

Start with the smallest useful prior-art loop:

1. Add `issue_resolution_knowledge`.
2. Add `issue_cluster_relationships`.
3. Implement CLI:

   ```bash
   npm run tickets -- knowledge ISSUE-...
   npm run tickets -- link ISSUE-... ISSUE-...
   npm run tickets -- related ISSUE-... --include-resolved
   ```

4. Update `AGENTS.md` so agents run `related --include-resolved` before nontrivial debugging.

This gives immediate value without changing the Admin Portal first.

## Implementation Status

Branch: `codex/ticket-knowledge-graph`

Implemented first-phase foundation:

- `issue_resolution_knowledge` for distilled resolved-ticket lessons.
- `issue_cluster_relationships` for explicit current-to-prior-art links.
- `issue_knowledge_tags` as an active lightweight tagging surface for semantic areas, detector/parser/input/route/source-file tags, and stable document identity.
- CLI commands: `knowledge`, `link`, `related`, `search-knowledge`, `knowledge-gaps`, and `backfill-tags`.
- CLI relationship suggestions with `suggest-relationships`, including dry-run output, tag-aware scoring, and high-confidence gated `--apply`.
- Cron-safe CLI relationship review with `review-relationships`, including generated tag refresh, high-confidence default auto-linking, dry-run preview, and review-only counts.
- Agent workflow documentation requiring resolved prior-art checks before nontrivial debugging.
- Admin API routes for related prior art and ticket-to-ticket relationship creation.
- Admin Portal Ticket Ledger `Prior Art` panel, loaded on demand per Ticket card, showing current knowledge summaries, linked history, potential resolved-ticket matches, and link controls.
- Admin Portal Ticket Ledger `Relationship Suggestions` panel for reviewing tag-aware prior-art links, copying both ticket ids, and bulk-applying high-confidence suggestions.

Deferred to later phases:

- Wiring a production scheduler to run `npm run tickets -- review-relationships --json` on the desired cadence after this branch is merged.
- Diff/evidence-enhanced suggestion scoring.
- Pattern-level knowledge aggregation and optional semantic search.
