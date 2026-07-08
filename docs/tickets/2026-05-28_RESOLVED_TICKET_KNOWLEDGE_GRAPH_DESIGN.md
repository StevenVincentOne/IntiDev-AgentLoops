# Resolved-Ticket Knowledge Graph: Design

Date: 2026-05-28
Status: Proposed (design only — not scheduled)
Area: Ticket ledger / resolution knowledge / prior-art retrieval / pattern intelligence

## Premise

Tickets have two fundamentally different lifetimes, and the current system treats
them as one graph. They are not one graph.

- **Open tickets are transient.** Bugs, incidents, and user reports are opened,
  worked, and resolved on a timescale of days. Any relationship edge between two
  open tickets has a half-life measured in days, because one endpoint resolves and
  the edge's meaning changes or evaporates.
- **Resolved tickets are durable evidence.** Once resolved, a ticket is a frozen
  record that future investigations query repeatedly: "have we seen this shape
  before, what fixed it, what failed, what should catch the recurrence." This is the
  asset. It is read many times and never changes.

The design error to avoid is spending sophisticated graph machinery — evidence
accumulation, gradient confidence, typed-edge promotion — on the **transient**
layer, where it cannot pay back its cost before the nodes resolve. The sophistication
belongs on the **durable** layer, which is queried thousands of times over its life.

This document proposes splitting the relationship model into two layers with
different engines, and concentrating all accumulating-evidence machinery on the
resolved substrate.

## Two graphs, two engines

| | Transient association layer | Durable knowledge graph |
|---|---|---|
| Nodes | open tickets | resolved tickets + patterns |
| Lifetime | days | indefinite |
| Read count | ~once, during triage | many, by every future investigation |
| Right engine | agent judgment + retrieval | accumulating, typed, evidence-backed |
| Human/agent role | agent decides in the moment | agent/human curates durable lineages |
| UI surface | none needed (or minimal) | curated resolved-graph review |

### Transient association layer (open tickets)

The engine here is **the agent**, and its only inputs are current known state plus
retrieved resolved evidence. The system's job is not to build a durable graph among
open tickets; it is to:

1. Cheaply prevent duplicate work at intake (deterministic dedup + fingerprinting).
2. Retrieve the right resolved prior art and push it at the agent (already started
   by the prior-art push in
   `2026-05-28_TICKET_LEDGER_PRIOR_ART_AND_RECURRENCE_PLAN.md`).
3. Capture the agent's judgment so it can graduate to the durable graph at
   resolution (see "The bridge").

Open-to-open relationship *suggestion and approval* is explicitly **not** worth a
sophisticated engine. The open-ticket Relationship Suggestions panel should be
demoted or retired (see "Admin Portal implications").

### Durable knowledge graph (resolved tickets + patterns)

This is where evidence accumulation, gradient strength, and typed-edge promotion
live. A resolved ticket is a frozen node, but the **graph around it keeps growing**:

- more resolved tickets point at it as `same_root_cause`,
- it spawns regressions/recurrences,
- its fix-area overlaps with newer fixes.

That growth is the signal. A resolved node that keeps attracting siblings and
recurrences is a *known failure mode*, and the natural promotion target for that is
the existing **Pattern** layer. The evidence ledger is what lets a cluster of
resolved tickets crystallize into a Pattern with earned confidence, instead of the
current hardcoded "3 active clusters" threshold.

## Why this is cheaper and better

- **No wasted maintenance.** We stop recomputing and storing edges that evaporate on
  resolution.
- **Targeted sophistication.** Evidence accumulation only runs against the substrate
  that is read many times, so the per-edge cost is amortized over the edge's long
  life.
- **Better evidence quality.** The transient layer becomes the intake funnel for the
  highest-quality evidence the durable graph will ever get: agent-confirmed,
  fix-verified links (see "The bridge").
- **Retrieval becomes the priority, not link-approval.** If open-ticket association
  is agent judgment over resolved evidence, the bottleneck is retrieval quality, not
  a human approving machine-suggested edges. That is the one place embeddings
  eventually earn their cost.

## The bridge: open judgment → durable edge

The single most important mechanic. When an agent, while working an open ticket,
decides "this is a regression of resolved ISSUE-X" or "same root cause as ISSUE-Y,"
that judgment is **higher-quality evidence than any deterministic token overlap** —
it is a human-level decision with a verified outcome attached once the fix lands.

Flow:

```text
open ticket
  -> agent judgment (using retrieved resolved evidence)
  -> fix + verify
  -> at resolution, the confirmed link solidifies into a durable
     resolved-graph edge, with provenance and a higher base weight than
     machine-suggested edges
```

Consequences:

- Agent-confirmed edges enter the durable graph with `source = agent_confirmed` and a
  higher initial weight than `system`-suggested edges.
- A link asserted on an open ticket should be stored as **pending** and only
  promoted to a durable resolved-graph edge when both endpoints are terminal (or one
  is terminal and the other resolves with the link intact). This keeps transient
  guesses out of the durable layer until they are earned.

## Data model

Keep existing `issue_*` tables. Add an evidence layer scoped to the durable graph.

### `issue_relationship_evidence`

Discrete, append-only evidence signals for a resolved-graph edge. Strength is
**derived** from the evidence set, not stored as a standalone guess.

Suggested columns:

- `id`
- `relationship_id` — FK to `issue_cluster_relationships`
- `signal_type` — `shared_family | shared_pattern | shared_source_file | shared_function | detector_match | input_class_match | fingerprint_reopen | token_overlap | agent_confirmed | admin_confirmed`
- `signal_key` — the specific anchor (e.g. the file path, pattern key, detector key)
- `weight` — numeric contribution
- `source` — `system | agent | admin`
- `created_by_id`
- `created_at`
- `UNIQUE (relationship_id, signal_type, signal_key)`

The UNIQUE constraint is load-bearing. It is what stops the same signal being
counted again on every recompute run. Strength must come from *distinct* corroborating
signals, not from repeated observation of one signal.

### `issue_cluster_relationships` (extend)

The existing edge table gains derived/decay fields. `confidence` becomes a *rendered*
value derived from evidence, not a hand-set bucket.

Add:

- `strength` — continuous derived score (sum of distinct evidence weights, with decay)
- `strength_tier` — rendered gradient: `weak | low | medium | high | strong`
- `pending` — boolean; true while asserted on a non-terminal ticket, false once promoted
- `last_evidence_at` — for staleness/decay
- `relation_type` — already present; now allowed to **graduate** (see below)

Keep `reason` as a first-class human-readable field, regenerated from the evidence
set on each recompute (e.g. "strong: shares PATTERN-12, both touch `Foo.ts`,
ISSUE-44 reopened with ISSUE-31 fingerprint"). The number must never replace the
explanation.

### Decay / staleness

Strength is not monotonic. Without decay an edge can only ever ratchet up and the
gradient becomes meaningless over time. Apply mild time decay to `strength` based on
`last_evidence_at`, and allow a recurrence/reopen to actively *re-open an edge for
review* rather than only strengthening it.

## Relation-type graduation

Today the relation type is picked per-run from the single strongest signal. With an
evidence set, the type can **graduate** as evidence sharpens:

```text
related_history  (weak: shared family/tokens only)
  -> same_input_class | same_detector | same_fix_area  (a concrete shared anchor)
  -> same_root_cause  (shared pattern + shared fix surface)
  -> regression_of    (fingerprint reopen / verified recurrence)
```

Graduation is driven by which `signal_type`s are present in the evidence set, not by
a single run's snapshot.

## Pattern crystallization

This model subsumes the current hardcoded auto-pattern threshold. Instead of "create
a pattern when 3 active clusters share a root family," a Pattern crystallizes when a
**resolved-graph neighborhood** accumulates enough mutually-reinforcing
`same_root_cause` strength. The Pattern becomes the durable root-cause node; its
member edges carry their evidence. This makes Patterns earn their existence from
evidence rather than from a count, and lets a recurring failure mode promote itself.

## Retrieval (the open-side priority)

Because open-ticket association is agent judgment over retrieved evidence, retrieval
quality is the bottleneck. Investment order:

1. Prior-art push at intake (done / in progress).
2. High-quality resolved-side tagging and deterministic search (largely present).
3. Embeddings over redacted resolved-knowledge text — only after deterministic recall
   is measured and found wanting, and only as a recall booster with deterministic
   explanations preserved.

## Admin Portal implications

- **Demote or retire the open-ticket Relationship Suggestions panel.** Transient
  edges adjudicated once by an agent do not need a human approval queue, and the
  current copy ("Review tag-aware prior-art links before adding them to the Ticket
  graph") describes the mechanism, not the job.
- **Keep transient prior art local to a Ticket.** The active-triage UI should be a
  lazy `Prior Art & Hypotheses` section inside each Ticket card's Details view, so
  agents and admins see resolved evidence in the context of the ticket they are
  actually working.
- **Add a resolved-graph curation surface instead.** The durable layer is the part
  worth a careful human/agent pass: confirm `same_root_cause` neighborhoods, confirm
  regression lineages, spot fix-area hotspots, and surface Pattern crystallization
  candidates. This is a monitoring/curation surface, not a data-entry queue.
- Render `strength_tier` as a gradient with the human-readable `reason`, never a bare
  number.

## What stays simple (explicit non-goals)

- **Do not build accumulating evidence on open-to-open edges.** They evaporate on
  resolution.
- **Do not put long-lived work items in the knowledge graph.** `tech_debt`,
  `feature`, and `investigation` tickets can stay open for weeks, but they are work
  items, not evidence. They belong in the work-tracking / Pattern layer, not the
  durable knowledge graph. "Long-lived" is not "needs the knowledge engine."
- **Do not let the open side rot to zero.** Keep cheap deterministic intake dedup and
  fingerprinting so two agents do not independently open and re-fix the same bug. That
  is a heuristic, not a graph engine.
- **No paid model calls in the core local workflow.** Embeddings, if added, are an
  optional recall booster.

## When to build this

This is over-engineering at current volume. The deterministic snapshot model and the
existing Pattern threshold are adequate while ticket and suggestion counts are low.
Build the evidence layer only when both of the following are true:

1. Resolved-ticket volume is high enough that relationships genuinely strengthen over
   time (recurrences, sibling clusters, fix-area overlaps are routinely observed).
2. The medium-confidence suggestion band is noisy enough that humans have stopped
   reviewing it — at which point un-reviewed suggestions quietly rot, the same failure
   mode as guard rot.

Until then, the actionable subset is small and worth doing early:

- Keep prior-art push and resolved-side retrieval sharp (open-side judgment depends
  on it).
- Implement **the bridge** (open judgment → pending edge → durable edge at
  resolution) without the full evidence ledger; even a single `agent_confirmed` flag
  with promotion-on-resolution captures the premium evidence.
- Reframe the Admin Portal panel from open-ticket approval to resolved-graph
  curation.

## Phasing

### Phase A — Bridge only (low effort, high value)

Status: implemented. `issue_cluster_relationships` now carries `pending` and
`promoted_at`. Links involving an active/non-terminal ticket are stored as pending
hypotheses. When ticket resolution makes both endpoints terminal, pending links are
promoted to durable history; agent/admin-created hypotheses are raised to high
confidence during promotion, while system-created links keep their existing
confidence.

- Store agent/admin-asserted links on open tickets as `pending`.
- Promote to durable edges when both endpoints are terminal, with
  `source = agent_confirmed` and a higher base weight.
- No evidence table yet; `confidence` stays as today.

Acceptance: an agent's "regression of ISSUE-X" judgment on an open ticket becomes a
durable, higher-weight resolved-graph edge only after the fix resolves.

### Phase B — Evidence ledger on the durable graph

Status: implemented for durable relationship edges. Relationship links now write
deduped evidence rows into `issue_relationship_evidence`, keyed by
`relationship_id`, `signal_type`, and `signal_key`. Edge `strength`,
`strength_tier`, `confidence`, `reason`, and eligible relation-type graduation are
derived from the distinct evidence set. Evidence uses a mild age decay when
recomputing strength, and ticket reopen events mark durable relationship edges for
review instead of treating recurrence as only a strengthening signal.

- Add `issue_relationship_evidence` with the UNIQUE dedup key.
- Derive `strength` / `strength_tier` from the evidence set; regenerate `reason`.
- Add decay and reopen-driven re-review.

Acceptance: an edge that accrues distinct corroborating signals over time climbs the
gradient; repeated observation of one signal does not.

### Phase C — Pattern crystallization from evidence

Status: implemented in the `suggest-patterns` maintenance path. The command still
keeps the cheap active-count candidate pass, but now also mines durable
`issue_cluster_relationships` plus deduped `issue_relationship_evidence` for
strong `same_root_cause`, `regression_of`, and `fixed_by_same_change` components.
Evidence-crystallized candidates report their `basis`, relationship count,
derived strength, and evidence signals, then merge with count-based candidates
before optional `--apply`.

To avoid turning pure history into active work, evidence-based candidates require
at least one non-terminal ticket in the component. Historical resolved-only edges
remain useful prior art but do not create an active Pattern by themselves.

- Replace the hardcoded auto-pattern count threshold with crystallization from
  mutually-reinforcing durable relationship strength.
- Keep raw active-cluster counts as a cheap fallback signal.
- Support `--evidence-min-strength`, `--evidence-min-edges`, and
  `--skip-evidence` for maintenance tuning.

Acceptance: a recurring failure mode promotes itself into a Pattern from evidence,
not from a raw cluster count.

### Phase D — Admin curation surface + optional embeddings

Status: implemented for deterministic graph curation. The Admin Portal now has a
`Resolved Graph` tab that lists durable relationship edges, their derived
strength/confidence, endpoint tickets, evidence signals, and review-required
state. Admins can mark an edge reviewed or flag it for review; those decisions are
stored in relationship metadata as curation history rather than deleting graph
evidence.

- Resolved-graph curation panel replaces global open-ticket suggestion approval.
- Edge review uses relationship evidence and strength tiers as the primary UI
  context.
- Open-ticket prior-art remains per-ticket in `Prior Art & Hypotheses`.
- Embeddings over redacted resolved knowledge remain optional future recall
  boosters; deterministic explanations stay primary.

## Open questions

1. Should `pending` edges be visible during triage as "agent hypotheses," or hidden
   until promoted?
2. What decay half-life keeps the gradient meaningful without erasing genuinely
   durable lineages?
3. Should Pattern crystallization require at least one `agent_confirmed` edge, or can
   it form from system evidence alone?
4. How is evidence weight calibrated across signal types (a verified
   `fingerprint_reopen` should dominate `token_overlap`)?
5. Should resolved-graph curation be agent-first (agent proposes, human audits) or
   human-first?

## Relationship to existing plans

- Builds on `2026-05-28_TICKET_LEDGER_PRIOR_ART_AND_RECURRENCE_PLAN.md`: the prior-art
  push is the open-side retrieval path this design depends on, and the reopen
  recurrence handling is the canonical `fingerprint_reopen` evidence signal.
- Supersedes the open-ticket framing in
  `2026-05-26_TICKET_KNOWLEDGE_GRAPH_AND_RESOLUTION_INTELLIGENCE_PLAN.md` by scoping
  the accumulating graph to the resolved/pattern substrate rather than all clusters.
