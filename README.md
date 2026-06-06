# IntiDev AgentLoops

### Feedback Loops for Agentic Workflows

IntiDev AgentLoops is an open-source toolkit for tracking issues, features, and user feedback through an agent-friendly resolution loop. It is intentionally lightweight and project-agnostic, while remaining opinionated about reproducibility, resolution hygiene, and machine-readable handoff artifacts.

This repo is the first extractable iteration from our internal Tickets implementation, and is aimed at:

- developers building AI coding workflows,
- teams that need one loop for bugfixes, features, and support feedback,
- maintainers who want reusable resolution knowledge and structured evidence.

## Why this project exists

Most bug trackers treat support, defects, and features as separate workflows.
IntiDev AgentLoops links them into one consistent lifecycle so humans and agents use the same ticket surface and knowledge.

## Quick install

```bash
npm install -g @stevenvincentone/intidev-agentloops
```

Then run:

```bash
agentloop init
agentloop create --title "Rendering regression in list pages" --summary "List pages lose anchors after parser update" --family "reader_rendering" --kind bug --source manual_admin
agentloop list
agentloop resolve ISSUE-000001 --summary "Added deterministic fallback for anchor selection"
```

## Try the convergence demo

Run a self-contained demo that seeds three independent intake loops — a smoke
test, a user report, and an agent proposal — all pointing at the same
`export_pipeline` family, and watch them converge into a single Pattern:

```bash
npm run demo
```

Expected output:

```text
AgentLoops source-convergence demo
==================================

Three intake loops, one underlying problem:

  ISSUE-000001  bug            source=smoke        [export_pipeline]
    Export smoke test times out on 500-page report
  USER-000002   user_feedback  source=user_report  [export_pipeline]
    Export fails for long reports
  DEV-000003    feature        source=agent        [export_pipeline]
    Stream the export pipeline instead of buffering

Converged into:
  PATTERN-000001 ACTIVE (3 tickets) — Recurring export_pipeline issues

Summary: 3 tickets, 1 active pattern(s).
```

The demo writes to a throwaway temp directory and leaves your repo untouched.
The same scenario is asserted in `test/demo.test.ts` against a committed golden
state fixture; run it with `npm test`.

## Core concepts

- Ticket: one concrete work item (bug, feature, user feedback, incident, etc.)
- Pattern: a recurring cluster, often by family/domain
- Source: origin (`user_report`, `smoke`, `ci`, `agent`, `ingestion`, etc.)
- Alias: human-facing IDs such as `ISSUE-000001`, `DEV-000001`, `USER-000001`
- Handoff: copyable context block for an agent to continue execution

## Commands

- `agentloop init` initialize `.agentloops` state and local config
- `agentloop create` add a ticket
- `agentloop list` view active and resolved work
- `agentloop begin <id>` mark triaged ticket as in-progress
- `agentloop resolve <id> --summary ...` mark resolved with evidence
- `agentloop reopen <id>` reopen and record a recurrence reason
- `agentloop note <id> --type ... --body ...` add context notes
- `agentloop guard <id> --guard-status ...` record guard decision
- `agentloop handoff <id>` print a copyable agent handoff prompt
- `agentloop patterns` list pattern groups
- `agentloop summary` print quick health metrics
- `agentloop config` print resolved configuration

All commands support `--json` for machine-readable output where relevant.

## Data model

State is stored in your working directory at `.agentloops/state.json`.
For local project settings, copy and customize:

```bash
cp agentloop.config.json.example agentloop.config.json
```

The config controls:

- project naming
- ticket kinds and aliases (`ISSUE`, `DEV`, `USER`, etc.)
- default family for auto-grouping
- configured sources

## Contributing

Open issues and PRs are welcome.

When adding new sources or fields, include:

1. a config-backed approach, not hardcoded assumptions,
2. a short schema note in docs,
3. a concise example command and expected output.

## License

MIT. See [LICENSE](LICENSE).
