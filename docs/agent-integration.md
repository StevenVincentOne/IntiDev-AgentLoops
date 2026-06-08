# Wiring AgentLoops into a coding agent's workflow

Installing `agentloop` and registering its [MCP server](mcp.md) gives a coding
agent *access* to the ledger — but access alone rarely changes behavior. An
agent will not spontaneously decide to check for prior art before debugging,
or to record a regression guard before calling a bug fixed. It does that
because something in its operating instructions told it, explicitly and
repeatedly, exactly when to reach for which command.

That "something" is usually a project's `AGENTS.md` / `CLAUDE.md` (or
equivalent agent-instructions file). This doc is a **starting playbook** —
copy the block below into that file, then adapt the bracketed placeholders to
your project. It is intentionally written as a sequence of "when X, do Y"
rules, because that is the form agents actually follow — a list of available
tools rarely gets used on its own, but a rule that says "*before* doing X,
*first* do Y" reliably does.

This is the same extension-point philosophy as `ticketGroups.customRules` and
`priorArtHint`: AgentLoops ships the primitives (CLI + MCP tools); your
project supplies the vocabulary (family names, verification standards, what
"done" means here) by adapting this template.

## Two invocation surfaces — pick what matches your agent

- **CLI** (works with any agent that can run shell commands, e.g. Codex):
  every rule below has an `agentloop <command>` form. Add `--json` for
  machine-readable output the agent can parse.
- **MCP** (works with MCP-aware clients, e.g. Claude Code, once you've run
  `claude mcp add agentloop -- agentloop mcp --write`): every rule below also
  has an `agentloop_<tool>` form — see [mcp.md](mcp.md) for the full schema of
  each tool's inputs/outputs.

Pick one and use it consistently in your instructions file — mixing both in
the same rule just adds noise. The examples below show the CLI form with the
matching MCP tool name in parentheses.

## The playbook (copy/adapt this block)

```markdown
## Ticket ledger workflow (AgentLoops)

- Before starting debugging or implementation work that might relate to
  existing defects or pending work: if you know a ticket id or family, run
  `agentloop begin <id>` (`agentloop_workflow` with status `active`).
  Otherwise run `agentloop summary` (`agentloop_summary`) for the active
  pattern/ticket/guard view, or at minimum `agentloop list --status active`
  (`agentloop_list`) and `agentloop patterns --status active`.
- When a likely-matching ticket exists, inspect prior art before changing
  code: `agentloop related <id>` (`agentloop_related`). Use high-confidence
  matches to avoid repeating failed approaches and to reuse existing
  regression guards (`agentloop guard-gaps`, `agentloop_guard_gaps`).
- When several open tickets look like symptoms of one root cause, check
  `agentloop groups` (`agentloop_ticket_groups`) and
  `agentloop near-duplicates` (`agentloop_near_duplicates`) before assuming
  they're independent — and before opening a near-duplicate ticket.
- **Begin before you build**: when `agentloop groups` surfaces a Group that
  looks relevant to the work at hand, run `agentloop begin-group <group-key>`
  (`agentloop_begin_group`) *before* implementing fixes for it. It aggregates
  prior art and resolution knowledge across every member in one pass and
  ranks Pattern-discovery hypotheses (e.g. "an active Pattern may already
  cover this", "resolved prior art recurs", "this looks like its own
  symptom-cluster") — so you correct course before duplicating a fix or
  missing a shared root cause. If the workbench confirms the Group is its own
  recurring problem, promote it to a trackable Pattern with `agentloop
  promote-group <group-key>` (`agentloop_promote_group`) so future tickets
  auto-cluster onto it; this is idempotent and safe to re-run.
- If a real bug, task, feature, investigation, tech-debt item, incident, or
  user-feedback item is found and no matching ticket exists, create one:
  `agentloop create --title "..." --summary "..." --family <family> --kind
  bug|feature|user_feedback|investigation|incident|tech_debt|task --source
  <source>` (`agentloop_create`). Use a stable, timestamp-free summary so
  later near-duplicate/prior-art matching works. If you already believe this
  connects to existing work, set `--prior-art-hint previously_ticketed
  |existing_pattern|adjacent_issues` — AgentLoops will auto-surface candidate
  matches in the response so you can confirm or rule them out immediately
  (see [the README section on history context](../README.md#history-context-prior-art-hints)).
- If useful context comes up before a fix is verified, record it as a note
  rather than editing the summary: `agentloop note <id> --type
  hypothesis|related_history|prior_fix|triage --body "..."`
  (`agentloop_note`).
- Do not mark a ticket resolved just because code changed. Resolution
  requires verification evidence: run `<your project's test/verification
  command(s)>` and capture the result. Then resolve with `agentloop resolve
  <id> --summary "..." --verification "<command + result>"`
  (`agentloop_resolve`).
- **Evidence-sensitive resolutions need a verification brief, not just a
  command transcript**: if your project configures `verification` (see
  [Customizing for your project](#customizing-for-your-project) and
  [Verification briefs](#verification-briefs-deterministic-guardrails-vs-agent-judgment)
  below) and this ticket's family/kind matches, `agentloop resolve` /
  `agentloop_resolve` will *reject* the resolution unless you also pass
  `--verification-brief '{ "claimScope": ..., "verificationPerformed": [...],
  "coverage": "...", "agentJudgment": "sufficient", "reason": "..." }'`
  (`verificationBrief` for the MCP tool). Raw commands/logs are not enough by
  themselves — state what you verified, what scope you're claiming, what
  coverage you achieved, and *why* that proves the fix. Resolving a Pattern
  and cascading to its linked tickets (`agentloop resolve-pattern <pattern-id>
  --summary ...`, `agentloop_resolve_pattern`) faces *stricter* checks than a
  single ticket — see that section before using it.
- For meaningful resolved bugs, incidents, and user-reported defects, record
  a regression-guard decision: `agentloop guard <id> --guard-status
  guard_added|guard_existing|guard_waived|guard_deferred --guard-summary
  "..."` (`agentloop_guard`). Use `guard_added` only after adding or updating
  a concrete test/check that would have caught this.
- If a resolved ticket reopens, treat the prior fix and guard as suspect —
  `agentloop reopen <id> --summary "<why it came back>"` and reinvestigate
  before reapplying the old approach.
```

## Maintenance rules (run periodically, or via your CI/scheduler — not per-task)

These keep the ledger trustworthy without adding per-task overhead. They're
read/write loops an agent (or a scheduled job) can run on a cadence:

```markdown
- `agentloop workflow-audit` (`agentloop_workflow_audit`) — find patterns
  whose status disagrees with their linked tickets; `agentloop
  workflow-repair --dry-run` previews the fix, drop `--dry-run` to apply.
- `agentloop prior-art-refresh` (`agentloop_prior_art_refresh`) — recompute
  and persist the durable prior-art graph (reinforces/decays/prunes edges).
- `agentloop knowledge-gaps` (`agentloop_knowledge_gaps`) and `agentloop
  guard-gaps` (`agentloop_guard_gaps`) — find resolved tickets missing
  reusable resolution knowledge or a regression guard, and close the gaps.
- `agentloop convergence` (`agentloop_convergence`) — patterns whose tickets
  span multiple independent sources (smoke, user reports, agent proposals)
  are usually your highest-signal root-cause candidates; triage those first.
```

## Verification briefs: deterministic guardrails vs. agent judgment

Some domains are easy to mark "fixed" on weak evidence — a document/export/
render pipeline whose output quality is hard to eyeball from a log line, a
data-migration whose correctness depends on coverage you can't grep for, an
integration whose "it works" claim hinges on which environment you actually
hit. AgentLoops calls these **evidence-sensitive** domains, and a project opts
in by configuring `verification.sensitiveFamilyPatterns` (and optionally
`sensitiveKinds`, `artifactIdPattern`, and the fresh/replay/broad-coverage
vocabulary — see [config](config.md)). Tickets outside a configured domain keep
the lightweight `agentloop resolve --summary ... --verification ...` path
unchanged — this section only applies once a project opts in.

**The problem this solves**: a deterministic rule that just checks "was
*something* verified?" can be satisfied by evidence that proves far less than
it's being treated as proving — e.g. cascade-resolving a multi-ticket Pattern
because *one* page/region was replayed against the new code. That replay is
real evidence, but it proves a narrow case, not the broad claim being used to
close everything linked to it.

**The fix is not a smarter deterministic judge** — rules can check that
evidence has the right *shape*; they cannot decide whether it actually proves
a given claim. So AgentLoops splits the job:

- **Deterministic rules act as guardrails.** When a resolution targets a
  configured evidence-sensitive family/kind, `agentloop resolve` /
  `agentloop_resolve` (and the cascade form, `agentloop resolve-pattern` /
  `agentloop_resolve_pattern`) require a structured `verificationBrief` and
  check that it's *internally coherent*: a sufficiency judgment was actually
  made, the reason isn't a placeholder, known affected ids are named,
  recurrences and Pattern/Group/cascade claims cite fresh/end-to-end methods
  rather than replay-only proof, and multi-ticket claims use broad-coverage
  language. These are the rules in `assertVerificationBriefForResolution`
  (`src/verification.ts`) — see that module's doc comment for the full
  numbered list.
- **Agent reasoning supplies the actual sufficiency judgment.** The brief's
  `agentJudgment` and `reason` fields are where *you* state, in your own
  words, whether the evidence proves the claimed scope and why. Rules can
  confirm you made that call and that it's substantive; only you can make it
  correctly.

### The brief shape

```json
{
  "claimScope": "single_ticket | group | pattern | cascade",
  "affectedArtifactIds": ["DOC-1001"],
  "reportedLocations": ["chapter_03 page 220", "export route /books/9098350"],
  "verificationPerformed": ["targeted reupload", "post-ingest scan", "browser inspection"],
  "coverage": "all reported instances in the targeted page ranges",
  "agentJudgment": "sufficient",
  "reason": "The fresh targeted reupload exercised the affected artifact after the fix, and every reported instance now renders correctly."
}
```

Pass it as `--verification-brief '<json>'` on the CLI or `verificationBrief`
on `agentloop_resolve`/`agentloop_resolve_pattern`. It's persisted on the
ticket (`Ticket.verificationBrief`) so the evidence that justified closing it
stays auditable later.

### What the guardrails actually require

- **A brief at all** — for evidence-sensitive family + kind combinations;
  everything else is unaffected.
- **An explicit sufficiency call** — `agentJudgment` must be one of the
  configured values (default `sufficient`/`verified`/`proven`); "looks fine"
  or "should be okay" don't count.
- **A substantive `reason`** — long enough to be an actual explanation, not
  "fixed" or "should work now".
- **Known affected ids named** — if `verification.artifactIdPattern` can
  extract an id from the ticket's own title/summary/tags, the brief or
  evidence text must name it. A claim that doesn't mention the thing it's
  supposedly about isn't checkable.
- **Fresh/end-to-end evidence for recurrences and cascades** — if the ticket
  carries a prior-work cue (`priorArtHint: previously_ticketed |
  existing_pattern` — reusing the *existing* hint field rather than inventing
  new "history signal" schema) or the brief claims a `group`/`pattern`/
  `cascade` scope, replay-only/unit-only methods are not enough:
  `verificationPerformed` must include something that exercises live or
  freshly produced output (a reupload, full reprocess, post-ingest scan,
  browser/live check — see `verification.freshVerificationPatterns`).
- **Broad-coverage language for multi-ticket claims** — `group`/`pattern`/
  `cascade` claims must describe coverage in terms like "all reported
  instances", "every linked ticket", or "full <artifact/workflow>"
  (`verification.broadCoveragePatterns`); narrow per-instance language cannot
  justify closing several tickets at once.
- **Replay/local/unit evidence can close only a narrow claim** — it's good
  diagnostic evidence and it *can* close a single ticket, but only when the
  claim scope is `single_ticket`, the ticket carries no recurrence cue, and
  the affected id is named (i.e. the stored/replayed artifact is provably the
  true input to the changed code path and covers the reported instance).
  Anything broader needs fresh or end-to-end proof.

### Pattern/Group cascade resolution requires *more*, not the same

`agentloop resolve-pattern <pattern-id> --summary ... [--verification-brief
<json>]` (`agentloop_resolve_pattern`) resolves a Pattern and applies the same
evidence to every not-yet-resolved ticket linked to it — exactly the operation
that can close many tickets from one evidence bundle, and exactly the
operation the originating bug exploited. Before applying it, AgentLoops counts
how many linked tickets fall in a configured evidence-sensitive domain/kind;
once **two or more** do, it escalates the fresh-evidence and broad-coverage
requirements for *all* of them, regardless of how the brief labels its own
`claimScope` (the result reports this as `escalatedVerification: true`).
Validation runs for every linked ticket before any of them are mutated, so a
bad cascade fails atomically rather than partially resolving the Pattern.

## Customizing for your project

Fill in the placeholders the way you would for `ticketGroups.customRules` or
`redaction.patterns` — this template is a baseline, not a finished policy:

- **`<family>` / `<source>`** — use the family names and source labels your
  project actually configures (see `agentloop config`); these drive routing,
  pattern clustering, and queue aliases (`ISSUE-`/`DEV-`/`USER-`/...).
- **`<your project's test/verification command(s)>`** — name the actual
  commands whose passing output counts as "verified" here (test suite, smoke
  run, lint+typecheck, manual repro steps, whatever applies). Vague
  verification standards produce tickets that *look* resolved but aren't.
- **Vocabulary extensions** — if your project has its own recurring
  error-code/correlation-key/symptom vocabulary, express it via
  `ticketGroups.customRules` (see the [Ticket Groups](../README.md#ticket-groups-triage-clusters)
  section) rather than teaching the agent ad-hoc heuristics; then the
  playbook rule "check `agentloop groups`" automatically benefits from it.
- **Stricter or looser gates** — e.g. some teams want every `bug`/`incident`
  resolution to require `guard_added` specifically (no waiving); encode that
  as a rule here, not as a one-off reminder.
- **Evidence-sensitive domains** — if your project has output that's easy to
  mark "fixed" on weak evidence (a render/export/migration pipeline, an
  integration whose correctness depends on which environment you hit, ...),
  configure `verification.sensitiveFamilyPatterns` (and optionally
  `sensitiveKinds`/`artifactIdPattern`/the fresh-vs-replay-vs-broad-coverage
  vocabulary) so `agentloop resolve`/`agentloop resolve-pattern` require a
  structured `verificationBrief` for them — see [Verification briefs](#verification-briefs-deterministic-guardrails-vs-agent-judgment)
  and [config](config.md). Do not hardcode a domain's artifact vocabulary into
  agent instructions; express it here so the guardrails and the playbook agree.

## Why a playbook, not just MCP tool descriptions

AgentLoops' MCP tools ship with descriptions written to nudge tool selection
in context (e.g. `agentloop_create`'s description explains when to set
`priorArtHint`). That helps — but it's a thin signal compared to an explicit,
ordered playbook the agent reads as part of its standing instructions. Tool
descriptions answer "what does this do?"; a playbook answers "*when, in my
workflow, should I reach for it — and what do I do with what comes back?*"
The latter is what actually makes a ledger part of an agent's habits rather
than a tool it technically has but rarely uses.
