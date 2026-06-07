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

## Why a playbook, not just MCP tool descriptions

AgentLoops' MCP tools ship with descriptions written to nudge tool selection
in context (e.g. `agentloop_create`'s description explains when to set
`priorArtHint`). That helps — but it's a thin signal compared to an explicit,
ordered playbook the agent reads as part of its standing instructions. Tool
descriptions answer "what does this do?"; a playbook answers "*when, in my
workflow, should I reach for it — and what do I do with what comes back?*"
The latter is what actually makes a ledger part of an agent's habits rather
than a tool it technically has but rarely uses.
