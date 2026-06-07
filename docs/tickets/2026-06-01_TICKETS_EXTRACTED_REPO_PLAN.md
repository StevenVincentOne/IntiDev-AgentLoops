# Tickets Extracted Repo Plan

Date: 2026-06-01
Status: Active extraction in progress; public repo bootstrapped
Area: Tickets / open-source extraction / agent harness

## Current State: 2026-06-05

The public extracted repo now exists:

- Product name: `IntiDev AgentLoops`
- Tagline: `Feedback Loops for Agentic Workflows`
- Public repo: `https://github.com/StevenVincentOne/IntiDev-AgentLoops`
- Local repo: `/home/inti/AgentLoops`
- Initial public scaffold pushed to `main` at commit `07457e9`
- Current package name: `@stevenvincentone/intidev-agentloops`
- Current CLI command: `agentloop`

The first public baseline is intentionally small and clean. It contains a TypeScript CLI, JSON filesystem state in `.agentloops/state.json`, project config via `agentloop.config.json`, configurable ticket kinds/sources/aliases, simple family-based Pattern grouping, logo assets, GitHub issue templates, CI, MIT license, and starter docs.

The Inti Reader implementation in `/home/inti/inti-docs` remains the mature dogfood implementation. It still contains the fuller ledger behavior: prior-art relationships, guard audits, resolution knowledge, source-specific ingestion/smoke/manual/user signals, the Admin Portal dashboard, and the current production-tested workflow. Agents should not restart extraction planning from scratch. Continue hardening the public repo and porting proven capabilities from the Inti implementation into reusable, config-backed AgentLoops modules.

This plan is intentionally mirrored in two locations:

- `/home/inti/AgentLoops/docs/tickets/2026-06-01_TICKETS_EXTRACTED_REPO_PLAN.md`
- `/home/inti/inti-docs/docs/issues-tickets/2026-06-01_TICKETS_EXTRACTED_REPO_PLAN.md`

Keep both copies synchronized until the extracted repo becomes the canonical planning home.

## Goal

Continue extracting the current Inti Tickets implementation into a public, installable open-source project that lets other software projects add durable feedback loops for coding-agent workflows.

The product framing should be broader than a bug tracker. `Tickets` is the catch-all work item model. `Issues`, `User`, and `Development` are operational queues built on top of the same ledger:

- `Issues`: bugs, incidents, runtime failures, smoke failures, and other repair work.
- `User`: production feedback, user-reported bugs, and support signals that should feed into engineering triage.
- `Development`: features, tasks, investigations, tech debt, partial implementations, specs, and deferred backlog.

The extracted repo should be marketed as an agent harness: it gives Codex, Claude Code, and other coding agents durable memory, workflow state, prior art, verification evidence, and a clean handoff protocol.

## Positioning

Working description:

> IntiDev AgentLoops is an open-source agent harness that adds durable issue, feature, and feedback loops to a software project. It gives coding agents a shared queue, prior-art memory, regression-guard tracking, and MCP/CLI access without requiring the host app to build its own agent workflow system.

What it is:

- a durable ticket ledger for humans and agents
- a workflow layer for coding agents
- a prior-art and recurrence memory system
- a bridge from production/user feedback to implementation work
- an optional MCP server for agent clients
- a CLI and library that can run deterministically without agent calls

What it is not:

- a replacement for GitHub Issues on day one
- an autonomous production deployer
- a paid hosted service requirement
- a model-dependent triage system
- an Inti Reader-specific feature after extraction

## Extraction Principles

1. Keep canonical behavior deterministic. LLMs and MCP clients can assist, but the core ledger, transitions, matching, and guard rules must work through ordinary code paths.
2. Separate reusable core from host-specific adapters. Inti Reader ingestion, document ids, route capture, and Admin Portal assumptions should move behind adapters.
3. Keep the first install cheap. Support local filesystem plus Postgres before adding hosted services, queues, or external dependencies.
4. Preserve agent ergonomics. Every ticket should have stable ids, copyable handoffs, CLI inspection, prior-art lookup, and verification records.
5. Keep privacy explicit. Host apps own redaction, artifact storage, and which user/project data can be stored in tickets.
6. Make MCP an adapter, not the whole product. CLI, library, HTTP, and MCP should all use the same core service contracts.

## Package Boundary

The extracted repo owns:

- ticket schema and migrations
- ticket ids and queue aliases such as `ISSUE-...`, `DEV-...`, and `USER-...`
- ticket event creation and deduplication
- ticket kinds, statuses, priorities, severities, and workflow transitions
- Development lane logic and readiness metadata
- User queue classification from `user_feedback` and `user_report` sources
- notes, instances, reopen recurrence, and resolution records
- regression guard decisions and guard-gap reporting
- prior-art relationship graph, relationship evidence, and resolution knowledge
- taxonomy config and generated semantic tags
- handoff prompt generation
- CLI commands
- MCP tool server
- optional embeddable UI components or a reference admin app
- smoke/verification registry contracts

The host project owns:

- authentication and authorization
- project-specific telemetry producers
- user identity mapping and privacy redaction
- artifact storage
- route/document/build/deployment metadata
- database connection provisioning
- UI shell integration if embedding the dashboard
- GitHub/GitLab/Linear/Jira sync credentials
- production deployment policy

## Repo Layout

Current first-iteration layout:

```text
IntiDev-AgentLoops/
  src/
    cli.ts
    config.ts
    index.ts
    store.ts
    types.ts
  docs/
    architecture.md
    config.md
    tickets/
  images/
  .github/
    ISSUE_TEMPLATE/
    workflows/
  agentloop.config.json.example
  package.json
  README.md
```

Target mature layout:

```text
IntiDev-AgentLoops/
  packages/
    core/
      src/schema/
      src/services/
      src/taxonomy/
      src/handoff/
      src/guards/
      src/prior-art/
    cli/
      src/commands/
    mcp-server/
      src/tools/
    adapters/
      postgres/
      filesystem-artifacts/
      express-http/
      github-sync/
    ui/
      src/components/
      src/reference-admin/
  examples/
    express-postgres/
    nextjs-app-router/
    vite-react/
    codex-mcp/
    claude-code-mcp/
  docs/
    getting-started.md
    concepts.md
    install-existing-project.md
    mcp.md
    host-adapters.md
    privacy-and-redaction.md
    migrations.md
  config/
    default-ticket-taxonomy.json
    default-smoke-tests.json
```

The first extraction currently starts as a single package. Once the core contracts stabilize, split it into scoped packages:

- `@intidev/agentloops-core`
- `@intidev/agentloops-cli`
- `@intidev/agentloops-mcp`
- `@intidev/agentloops-postgres`
- `@intidev/agentloops-react`

The current npm package is `@stevenvincentone/intidev-agentloops`. A future organization-scoped package such as `@intidev/agentloops` would be cleaner once the namespace exists.

## Public API Shape

Core library:

```ts
const tickets = createTicketHarness({
  store,
  artifacts,
  taxonomy,
  project: {
    key: 'my-app',
    name: 'My App',
  },
});

await tickets.createEvent({
  source: 'user_report',
  ticketKind: 'user_feedback',
  title: 'Export fails for long reports',
  family: 'export_pipeline',
  severity: 'high',
  message: 'The user sees a timeout when exporting a 500-page report.',
  context: {
    route: '/reports/123/export',
    appVersion: '2026.06.01',
  },
});

await tickets.workflow('DEV-000123', {
  status: 'in_progress',
  readyForAgent: true,
  summary: 'Implementation started from the Development queue.',
});
```

CLI:

```bash
agentloop init
agentloop summary
agentloop list --status active
agentloop list --kind user_feedback
agentloop list --kind feature
agentloop show DEV-000123 --json
agentloop handoff ISSUE-000123
agentloop create --kind feature --title "..."
agentloop begin DEV-000123
agentloop resolve ISSUE-000123 --summary "..." --verification passed
agentloop mcp --stdio
```

HTTP adapter:

```text
GET    /tickets
GET    /tickets/:id
POST   /tickets/events
POST   /tickets/:id/notes
POST   /tickets/:id/workflow
POST   /tickets/:id/resolve
GET    /tickets/:id/related
GET    /tickets/guard-gaps
```

MCP tools:

```text
agentloop_summary
agentloop_list
agentloop_show
agentloop_user_queue
agentloop_development_queue
agentloop_related
agentloop_create
agentloop_note
agentloop_workflow
agentloop_resolve
agentloop_guard
agentloop_guard_gaps
agentloop_search_knowledge
```

MCP writes should be opt-in and policy-gated. A project should be able to expose read-only tools to an agent while keeping create/resolve guarded.

## Data Model

The extracted repo should retain the current append-first model:

- `ticket_events`: raw observations and inputs
- `tickets`: durable work items clustered from events
- `ticket_notes`: non-resolution context
- `ticket_resolutions`: completed/fixed/dismissed audit records
- `ticket_patterns`: root-cause groups above individual tickets
- `ticket_pattern_links`: ticket-pattern membership
- `ticket_relationships`: durable prior-art edges
- `ticket_relationship_evidence`: deduped edge evidence
- `ticket_regression_guards`: guard decisions for resolved defects/user reports
- `ticket_resolution_knowledge`: reusable agent memory

The Inti implementation currently uses `issue_*` table names. Extraction should either:

- rename tables to `ticket_*` in the public package with a migration adapter for Inti, or
- keep internal compatibility names hidden behind the store adapter.

For an open-source repo, `ticket_*` is clearer and should be the public schema.

## Host Adapter Contracts

Minimum adapter interfaces:

```ts
interface TicketStore {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  transaction<T>(run: (tx: TicketStore) => Promise<T>): Promise<T>;
  migrate(): Promise<void>;
}

interface TicketArtifactStore {
  put(input: ArtifactInput): Promise<ArtifactRef>;
  get(ref: ArtifactRef): Promise<ArtifactContent>;
  list(ticketId: string): Promise<ArtifactRef[]>;
}

interface TicketRedactor {
  redactText(value: string, context: RedactionContext): string;
  redactJson(value: unknown, context: RedactionContext): unknown;
}

interface TicketProjectAdapter {
  currentActor(): Promise<TicketActor | null>;
  currentVersion(): Promise<string | null>;
  enrichEvent?(event: TicketEventInput): Promise<TicketEventInput>;
}
```

The default adapter set should support:

- Postgres
- local filesystem artifacts
- no-op actor
- config-file taxonomy
- config-file smoke registry

## UI Strategy

There are two reasonable UI deliverables:

1. Reference admin app: a standalone Vite/React app that talks to the HTTP adapter.
2. Component package: React components that host apps can embed into their own admin portal.

The first open-source release should prefer the reference admin app plus a small component package. That keeps integration simple while still letting projects adopt pieces later.

Core UI requirements:

- tabs for Issues, User, Development, All Tickets, Patterns, Prior Art Graph, and Guard Gaps
- creation flows for Issue/User/Development tickets
- copyable handoff prompts
- alias and canonical key display
- workflow lane controls for Development tickets
- details panels for events, notes, artifacts, prior art, and guard state
- search and filters that accept canonical and alias keys

## Installation Flow

Current first-run experience:

```bash
npm install
npm run build
npm run cli -- init
npm run cli -- create --kind feature --title "Try AgentLoops" --summary "Exercise the Development loop" --family setup
npm run cli -- list
npm run cli -- handoff DEV-000001
```

Target package install after publishing:

```ts
import { AgentLoopStore, loadConfig } from '@stevenvincentone/intidev-agentloops';

const config = await loadConfig(process.cwd());
const store = new AgentLoopStore(process.cwd(), config);
```

Future app integration should expose `createAgentLoopHarness(...)` over pluggable stores and artifact adapters once the extracted core stabilizes.

## MCP Integration Plan

Phase 1 should expose read-only tools:

- summary
- list
- show
- related
- user queue
- development queue
- guard gaps
- search knowledge

Phase 2 should expose controlled write tools:

- create ticket
- add note
- workflow transition
- resolve
- record guard

Every write tool should:

- validate ticket id aliases
- enforce required verification or guard fields
- append audit metadata
- return the canonical key and display alias
- avoid storing raw secrets or unredacted user content by default

## GitHub Sync

GitHub Issues sync should be optional and later than the core extraction.

Initial sync direction:

- Tickets can create or update linked GitHub Issues.
- GitHub Issue comments can append ticket notes.
- GitHub labels can mirror queue, kind, severity, and status.
- Tickets remain the richer agent memory layer.

Do not make GitHub a required store. Many coding-agent workflows should work in local repos, private repos, or projects that use another issue tracker.

## Security And Privacy

Open-source defaults should be conservative:

- no model calls by default
- no external telemetry by default
- local-only artifact storage by default
- explicit redaction hook for user content
- documented sensitive-field policy
- MCP write tools disabled unless configured
- clear separation between project content and ticket metadata

The package should make it easy for a host app to store user reports without storing private documents or secrets.

## Extraction Phases

### Phase 0: Dogfood Hardening In Inti

Status: ongoing dogfood source of truth.

Keep using the current implementation long enough to smooth rough edges:

- create Issue, User, and Development tickets from the UI
- exercise add note, add instance, workflow, defer, reopen, resolve, guard, and prior-art flows
- verify CLI parity for every UI workflow
- document the workflows that feel natural versus awkward
- keep smoke/type/build coverage current

The readiness gate for this phase is tracked in `docs/issues-tickets/2026-06-02_TICKETS_EXTRACTION_READINESS_DOGFOOD_GATE.md`. Extraction has now started in parallel with dogfooding; do not treat the gate as a blocker to public scaffold work, but do use it to decide which mature Inti behaviors are ready to port.

Agent-facing JSON contracts that should remain stable through dogfood are tracked in `docs/issues-tickets/2026-06-04_TICKETS_AGENT_JSON_CONTRACTS.md`.

### Phase 1: Public Scaffold And Core Boundary

Status: started.

The public repo currently has a single-package TypeScript baseline. Next harden that baseline before widening scope:

- run local install/build and fix any compile issues
- add a lockfile once dependency versions are accepted
- add a seed/demo workflow for Issue, User, and Development tickets
- add a source-convergence demo showing user/manual, smoke, and agent-sourced tickets grouped into a Pattern
- make README examples match actual current CLI behavior

Then extract pure shared modules:

Extract pure shared modules first:

- ticket aliases
- taxonomy helpers
- type definitions
- status/kind/severity definitions
- handoff prompt generation
- guard decision rules
- relationship scoring helpers

These should have no Inti imports.

### Phase 2: Store And Services

Move the ledger service behind explicit adapter interfaces:

- replace direct repo DB imports with `TicketStore`
- isolate schema migrations
- isolate artifact paths
- isolate project-specific enrichment
- rename public schema/types from issue language to ticket language

### Phase 3: CLI Package

Move mature `npm run tickets -- ...` behavior into the project-agnostic `agentloop` CLI:

- config discovery
- migrations
- list/show/create/note/workflow/resolve/guard commands
- smoke registry integration
- JSON output stable enough for agents

### Phase 4: MCP Server

Add MCP server package over the same service layer:

- read-only default
- write tools behind config
- id alias support
- audit metadata
- clear errors that agents can act on

### Phase 5: Reference UI

Extract a reference dashboard:

- standalone admin app for quick adoption
- optional React component exports
- host-provided auth shell
- adapter-provided API client

### Phase 6: Selective Two-Way Porting (revised 2026-06-07; supersedes "Inti Migration")

**Decision**: do *not* switch Inti to consume the extracted packages as a runtime dependency.
This plan was drafted while AgentLoops was still a scaffold being pulled out of Inti; it has
since become a published, independently-versioned product (`@stevenvincentone/intidev-agentloops`,
`@stevenvincentone/intidev-agentloops-react`) with its own release cadence and generic
abstractions. Forcing Inti — a production app with app-specific needs (Admin Portal integration,
auth, `issue_*` schema, established `ISSUE-...`/`DEV-...`/`USER-...` ids) — to adopt it as a
dependency would mean either compromising AgentLoops' generality to fit Inti, or wrapping/adapting
around it in Inti, for uncertain payoff and real migration risk to a feature that already works.

Instead, treat the two Tickets implementations as **independently-specialized siblings** and port
proven improvements selectively in both directions:

- AgentLoops → inti-docs: pull over generalizable improvements made during/after extraction
  (e.g. redaction hooks, prior-art scoring refinements, GitHub Issues sync, guard-gap detection)
  where they'd benefit Inti's production ledger.
- inti-docs → AgentLoops: pull over generalizable improvements made to Inti's Tickets since the
  extraction snapshot, rewritten as pure modules with no Inti imports (per the Phase 1 extraction
  principles).
- Accept the tradeoff: this means **permanent duplication** between the two codebases (two things
  to maintain, no single source of truth, occasional drift) — in exchange for each staying
  optimized for its actual context instead of compromising to share code.

Tracking: the two-way port-tracking work lives in `inti-docs` as **DEV-001142** — keep findings
and decisions there so they don't get lost. "Retiring duplicated in-repo service code" is
explicitly **off the table** under this revision; do not attempt it without a fresh decision.

## Release Scope

Minimum useful public release for broad promotion:

- core service
- Postgres store
- filesystem artifact store
- CLI
- MCP read tools
- basic write tools for create/note/workflow/resolve
- reference docs
- smoke/type test suite
- example app

Minimum useful public repo for Codex-for-OSS submission:

- public GitHub repo with clear branding
- MIT license
- README with problem statement and quickstart
- runnable CLI scaffold
- config-backed ticket kinds, sources, and aliases
- docs for architecture and config
- issue templates and CI
- roadmap showing MCP, prior art, guards, and user feedback convergence

Defer:

- hosted service
- GitHub sync
- multi-tenant SaaS auth
- advanced UI theming
- automatic LLM triage
- external issue tracker sync beyond GitHub

## Open-Source Readiness Checklist

- license selected: MIT
- project name selected: `IntiDev AgentLoops`
- README with positioning and quickstart
- contribution guide
- code of conduct if desired
- security policy
- changelog
- example project
- test matrix for Node versions and Postgres
- no Inti secrets, private paths, or app-specific data in fixtures
- public schema migration story
- MCP read-only demo
- docs for Codex and Claude Code integration

## Open Questions

- Whether to move from `@stevenvincentone/intidev-agentloops` to `@intidev/agentloops`.
- Whether the public schema should use `ticket_*` only, with an Inti compatibility adapter, or support both names.
- Whether the first UI release should be standalone only or also export component primitives.
- Which write MCP tools should ship enabled by default.
- Whether GitHub Issue sync belongs in the first public milestone or a follow-up.
- How much prior-art scoring should be configurable versus fixed in core.

## Immediate Next Step

In `/home/inti/AgentLoops`, stabilize the pushed scaffold before adding bigger surfaces:

1. run `npm install` and `npm run build`;
2. fix any compile/runtime issues in the current CLI/store;
3. add a small synthetic demo fixture that shows Issue, User, and Development loops converging into Patterns;
4. add read-only MCP tools for `summary`, `list`, `show`, and `handoff`;
5. then port the Inti proven modules in this order: alias/kind config, source-convergence audit, guard gaps, resolution knowledge, prior-art relationships.

Keep `DEV-000847` as the extraction umbrella ticket in Inti and continue recording findings there until AgentLoops has its own mature dogfood ledger.
