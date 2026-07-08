# Ticket Ledger: Prior-Art Push & Recurrence-Loop Plan

Date: 2026-05-28
Status: Implemented
Area: Ticket ledger / agent workflow / recurrence guarding / fingerprint quality

## Summary

The ticket ledger architecture is sound: clean event → cluster → pattern layering,
deterministic-first relationship scoring, and a four-state regression-guard model.
The remaining weaknesses are not structural. They are that the highest-value
behaviors are **pull-based and depend on agent discipline**, and that
**fingerprint quality is an un-guarded single point of failure** for clustering,
reopen detection, and pattern grouping.

This plan turns the most valuable interactions into **push** behaviors that arrive
at the moment of triage, and closes the **recurrence loop** so that a reopened
ticket and a single-ticket resolution both drive a guard decision the way pattern
resolution already does.

The work is grouped into phases by leverage-to-effort. Phases 1-3 are small, touch
existing code paths only, and require no schema change. Phases 4-6 are larger.

Implementation note, 2026-05-28: Phases 1-6 are implemented. Ticket creation now
pushes prior art, likely near-duplicates, and fingerprint near-miss warnings into CLI/API/manual handoff output,
reopened tickets get recurrence side effects, fixed/verified-fixed resolution of
bugs/incidents/user feedback requires a guard decision, new events persist an
inspectable `correlation_key`, guard rot can be audited with `tickets guard-audit`,
and triage/taxonomy friction is reduced by `tickets begin` plus
`config/ticket-taxonomy.json`.

Hardening note, 2026-05-28: post-commit prior-art lookup is best-effort and must
not make already committed ticket creation fail. Expensive intake enrichment is
limited to triage-oriented sources (`agent`, `manual_admin`, `user_report`,
`ingestion`, `smoke`, and `ci`) so high-volume `browser` and `backend` telemetry
can keep recording events without flooding the relationship graph. Derived
`correlation_key` values are family-independent and based on route, document,
stage, and detector anchors.

## Goals

1. Make resolved prior art arrive unsolicited at ticket-creation/handoff time.
2. Make a reopened ticket automatically escalate and flag its prior guard as ineffective.
3. Make single-ticket resolution of meaningful defects require a guard decision,
   symmetric with pattern resolution.
4. Reduce duplicate clusters via intake-time near-duplicate detection.
5. Detect guard rot by cross-checking guards against the smoke-test catalog.
6. Reduce agent friction (composite start command, data-driven semantic tags).

## Non-Goals

- No change to the event/cluster/pattern/resolution/knowledge data model in Phases 1-3.
- No embeddings or paid model calls.
- No new mandatory steps in the agent checklist; the point is to remove steps, not add them.
- No change to existing public CLI command names (additive only).

---

## Phase 1 — Push prior art into create/handoff (highest leverage)

**Problem.** The knowledge graph only pays off if an agent remembers to run
`related --include-resolved` (step 4 of a 10-step checklist). All the machinery to
surface prior art exists, but `createIssueEventWithQueryable`
(`src/services/IssueLedgerService.ts`, ~line 2411) returns only
`{ cluster, created, deduped }`. It runs `reconcilePatternForIssueEventWithQueryable`
but never calls `listRelatedIssueKnowledge`.

**Change.**

1. When a **new** cluster is created (`created === true`, not deduped), synchronously
   compute the top 3-5 prior-art candidates by reusing the existing
   `listRelatedIssueKnowledge` / `searchIssueKnowledge` scoring
   (`IssueLedgerService.ts` ~3363 / ~3477). Cap the candidate query to keep the
   create path fast (limit 5, `includeResolved: true`).
2. Extend `IssueEventResult` with an optional `priorArt` field:

   ```ts
   priorArt?: Array<{
     publicKey: string;
     title: string;
     status: IssueStatus;
     relationReason: string;   // top reason string from the scorer
     score: number;
     rootCause?: string | null;
     fixStrategy?: string | null;
     guardStatus?: IssueRegressionGuardStatus | null;
   }>;
   ```

3. Surface `priorArt` in three places:
   - **CLI output** of `create-event` and `record-fix` (print a short
     "Possible prior art" block with `ISSUE-...` keys and the one-line reason).
   - **Manual-ticket handoff prompt** generated in
     `web/src/components/tickets/ManualTicketModal.tsx` and the API that builds the
     handoff text, so a human-to-agent handoff already carries
     "this resembles resolved ISSUE-X".
   - **Optional** `related_history` system note on the new cluster (behind a flag so
     we do not create note noise; default on for `score >= medium-threshold`).

**Why first.** Converts the graph from a library (agent must visit) into a librarian
(answer arrives). Touches one return type and three call sites. No schema change.

**Acceptance.**
- Creating a new ticket whose family/tokens match a resolved ticket prints the
  resolved `ISSUE-...` key and reason in CLI output.
- The manual-ticket handoff prompt includes prior-art keys when matches exist.
- Deduped events (existing fingerprint) do **not** recompute prior art (no extra cost
  on the hot path).

**Risk / mitigation.** Extra query on the create path → cap limit, run only on
`created === true`, and time-box; fall back to empty `priorArt` on query error so
ticket creation never fails because prior-art lookup failed.

---

## Phase 2 — Close the recurrence loop on reopen

**Problem.** A reopened ticket (same fingerprint after `resolved`) is the strongest
possible signal that a guard was missing or insufficient. Today the service flips
status to `reopened` and preserves the prior resolution, but does nothing else:
the prior `issue_regression_guards` row is not flagged, the knowledge record is not
demoted, and priority is unchanged.

**Change.** In the create path, when an incoming event reopens a terminal cluster
(detected where status transitions to `reopened`):

1. **Escalate** `priority` by one level (capped at `urgent`) and stamp
   `reopened_at`.
2. **Annotate the prior guard.** If an `issue_regression_guards` row exists, write a
   note / metadata marker that the guard did not prevent recurrence
   (`metadata_json.guard_ineffective_at`, `metadata_json.reopened_event_id`). Do not
   delete the guard row; keep the audit trail.
3. **Flag the knowledge record** as needing review by bumping
   `issue_resolution_knowledge.recurrence_risk` toward `high` (or adding a
   `metadata_json.reopened` marker) so it stops reading as a clean prior fix.
4. **Emit a system note** of type `triage`: "Reopened after resolution; prior guard
   `<key/command>` did not prevent recurrence. Re-verify before re-resolving."

**Acceptance.**
- Posting an event with a resolved cluster's fingerprint sets status `reopened`,
  raises priority, and records a guard-ineffective marker when a guard existed.
- The reopened ticket shows the prior resolution and the new "guard ineffective" note
  in `tickets show`.

**Risk / mitigation.** Avoid double-escalation on repeated reopen events for the same
burst — only escalate on the resolved→reopened transition, not on every subsequent
event while already `reopened`.

---

## Phase 3 — Require a guard decision at single-ticket resolve

**Problem.** Asymmetry: pattern-resolve-with-cascade **requires** a guard decision
(the CLI/API rejects linked-ticket pattern resolution without one), but plain
single-ticket `resolve` of a `bug`/`incident`/`user_feedback` does not — it just
lands in `guard-gaps` later and may sit there.

**Change.** In the single-ticket resolve path:

1. For `ticket_kind IN ('bug','incident','user_feedback')` resolved as
   `fixed`/`verified_fixed`, **require** one of:
   - an accompanying guard decision (`--guard-status ...` passed inline), or
   - an explicit `--guard-deferred "<reason>"` / `--guard-waived "<reason>"` escape hatch.
2. If neither is present, the CLI/API **rejects** the resolve with a message pointing
   at `guard-suggest ISSUE-...` (advisory candidates already exist at
   `IssueLedgerService.ts`).
3. Add an inline convenience: allow `resolve` to accept the guard fields in the same
   call so it is one command, not two.

This mirrors the existing pattern-resolution constraint described in the workflow doc
("rejects linked-ticket pattern resolution without a guard decision").

**Acceptance.**
- Resolving a `bug` as `verified_fixed` without any guard flag is rejected with a
  helpful message.
- Resolving with `--guard-deferred "low value one-off"` succeeds and records the
  deferred guard in one step.
- `task`/`feature`/`tech_debt`/`investigation` kinds are unaffected.

**Risk / mitigation.** This adds friction to a common command. Mitigate by (a) the
escape hatch being trivial, and (b) accepting guard fields inline so it stays a single
command. Gate behind a config flag (`TICKETS_REQUIRE_GUARD_ON_RESOLVE`) defaulting on
locally so it can be tuned.

---

## Phase 4 — Intake-time near-duplicate detection & cross-source correlation

**Problem.** Clustering is exact-fingerprint only
(`idx_issue_clusters_fingerprint UNIQUE`). Two events group into one ticket only if
fingerprints are byte-identical. Browser/user/backend feeds hash their seed into an
opaque `sha256` tail, so a user report and a browser error describing the *same crash
on the same route* can never share a cluster. The plan listed "recent linked
browser/runtime fingerprints" as a user-report input but it was never implemented.

**Change.**

1. **Near-duplicate check before creating a new cluster.** When a new fingerprint
   arrives, look for an open cluster with the same `family` and high normalized
   token overlap on title/message within a recent window (reuse `searchTokens` /
   `tokenOverlapCount`). If found above a threshold, attach as a soft relationship
   (`same_symptom`, confidence medium) and surface it in `priorArt` rather than
   silently forking.
2. **Structured correlation key.** Add an inspectable, non-hashed correlation column
   (e.g. `correlation_key` = `route|errorClass|stage`) alongside the existing hashed
   fingerprint, populated by each feed or derived centrally from route, detector,
   source file, stage, document identity, or family. Use it as a secondary association
   signal in intake-time near-duplicate linking so cross-source events about one defect
   can link.
3. **Fingerprint sanity warning** on `create-event`: if the supplied fingerprint is
   one token off an existing cluster's fingerprint, warn (catches typos and volatile
   components that the fingerprint guidance already forbids but nothing enforces).

**Acceptance.**
- A user report and a browser error for the same route+error correlate (linked or
  same-cluster) instead of producing two unrelated clusters.
- `create-event` with a near-miss fingerprint prints a warning naming the close
  existing cluster.

**Note.** Item 2 requires a schema column (`ALTER TABLE issue_clusters/issue_events
ADD COLUMN correlation_key TEXT NULL` + index). Items 1 and 3 do not.

---

## Phase 5 — Guard-rot audit

**Problem.** Guards record `command` / `detector_key` / `artifact_ref`
(`issue_regression_guards`) but nothing verifies they still exist or run. A guard
pointing at a deleted smoke script rots silently; the ticket looks protected when it
is not.

**Change.** Add `npm run tickets -- guard-audit`:

1. For each `guard_added` / `guard_existing` row, cross-check:
   - `command` / `detector_key` against `config/smoke-tests.json` registered targets.
   - `artifact_ref` against the filesystem (file still exists).
2. Report guards whose target is missing or unrecognized, and (optionally) guards
   whose referenced smoke has not produced a run recently.
3. Make it cron-safe and `--json`-able, parallel to `review-relationships`.

**Acceptance.**
- A guard whose `command` no longer matches any registered smoke and whose
  `artifact_ref` file was deleted is reported as rotted.
- A clean catalog produces an empty report.

---

## Phase 6 — Friction & taxonomy

**Problem.** ~25 subcommands and a 10-step start-of-work checklist lean entirely on
discipline. Semantic tagging is 6 hardcoded regex rules (`SEMANTIC_TAG_RULES`,
`IssueLedgerService.ts` ~1583); new areas need a code edit, and broad keywords
(`code`, `image`, `route`) yield low-precision tags. Pattern auto-creation is bounded
by the hardcoded `rootPatternFamily` prefix map (~1093) — families outside that list
never auto-group.

**Change.**

1. **Composite start command** `npm run tickets -- begin <area|ISSUE-...>` that runs
   summary + active patterns + related + knowledge in one shot and prints a single
   triage briefing. Reduces the checklist to one command for the common case.
2. **Data-driven semantic tags.** Move `SEMANTIC_TAG_RULES` into
   `config/ticket-taxonomy.json` (value, confidence, patterns) so areas can be added
   without code edits.
3. **Configurable root-family map.** Move the `rootPatternFamily` prefix table into
   the same config so new families can auto-group without a code change.
4. (Forward-looking) These align with the planned **MCP adapter** (Phase 8 of the
   ledger plan); the `begin` briefing maps cleanly to a future `ticket_begin` tool.

**Acceptance.**
- `tickets begin reader_ingestion` prints active patterns, active tickets, and related
  resolved prior art without the agent running four commands.
- Adding a semantic area or root family is a config edit, not a code edit.

---

## Cross-cutting: redaction & usage feedback (optional hardening)

- **Centralize redaction.** Today `scrubSensitiveText` lives in each feed service.
  Add a defense-in-depth scrub at the single write path (`createIssueEvent`) so a new
  producer cannot leak by forgetting to scrub.
- **Usage feedback.** Nothing records whether a `related` / `search-knowledge` result
  was actually reused/linked. Add a lightweight query→link conversion log so the
  knowledge layer's value (reduced repeat work) is measurable. Without it, there is no
  signal on whether any of the above is working.

---

## Suggested order & effort

| Phase | Change | Goal | Effort | Schema change |
|-------|--------|------|--------|---------------|
| 1 | Push prior art into create/handoff | Discover / associate | Low | No |
| 2 | Close recurrence loop on reopen | Guard recurrence | Low | No |
| 3 | Require guard decision at single resolve | Guard recurrence | Low | No |
| 4 | Near-dup intake + correlation key | Group | Medium | Partial (item 2) |
| 5 | Guard-rot audit | Guard recurrence | Medium | No |
| 6 | begin command + data-driven taxonomy | Discover / friction | Low–Med | No |

Phases 1-6 have landed as additive workflow improvements. The remaining optional
hardening is centralized redaction and usage-feedback measurement for prior-art query
results.

## Key code references

- `src/services/IssueLedgerService.ts`
  - `createIssueEventWithQueryable` (~2411) — create path; where prior art and reopen
    handling attach.
  - `reconcilePatternForIssueEventWithQueryable` (~2350) — existing inline reconciliation.
  - `listRelatedIssueKnowledge` (~3477), `searchIssueKnowledge` (~3363),
    `scoreKnowledgeMatch` (~3303) — reuse for prior-art push.
  - `scoreRelationshipSuggestion` (~3702) — relationship scorer (reuse for correlation).
  - `loadTicketTaxonomyConfig`, `configuredRootFamily`, `rootPatternFamily` — data-driven taxonomy.
  - `searchTokens` / `tokenOverlapCount` (~3154 / ~3206) — reuse for near-dup detection.
- `src/services/IssueLedgerSchemaService.ts` — `issue_regression_guards`,
  `issue_resolution_knowledge` (reopen/guard markers); `correlation_key` column for Phase 4.
- `src/services/{Browser,Backend,User}IssueReportService.ts` — per-feed fingerprints;
  correlation-key population and centralized redaction.
- `web/src/components/tickets/ManualTicketModal.tsx` — handoff prompt for prior-art push.
- `config/smoke-tests.json` — source of truth for the Phase 5 guard-rot audit.
- `config/ticket-taxonomy.json` — source of truth for semantic tags and root-family mapping.
- `scripts/issue-ledger.ts` — CLI surface for new `begin` / `guard-audit` and inline
  guard flags on `resolve`.
