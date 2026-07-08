# Tickets Agent JSON Contracts

Date: 2026-06-04
Status: Dogfood contract baseline
Area: Tickets / CLI / API / MCP extraction readiness

## Purpose

These contracts define the current agent-facing JSON shapes that should remain stable while the Tickets system is dogfooded and prepared for extraction.

The first public repo and MCP server should preserve these concepts even if field names are later converted from `issue_*` internals to public `ticket_*` naming.

## Contract Rules

- Include `schemaVersion` on new agent-facing JSON envelopes.
- Include `generatedAt` for audit and cleanup reports.
- Keep canonical `ISSUE-...` ids and queue aliases such as `DEV-...` and `USER-...` in returned ticket objects.
- Add fields instead of removing fields during dogfood.
- Keep read-only audit commands read-only unless a repair flag is explicit.
- Separate recurrence context from workflow anomalies.

## Resolution Audit

Command:

```bash
npm run tickets -- resolution-audit --json
```

Repair command:

```bash
npm run tickets -- resolution-audit --repair-reopened-patterns --json
```

Read-only response:

```ts
type ResolutionAudit = {
  schemaVersion: 1;
  generatedAt: string;
  summary: {
    terminalPatternsWithActiveLinkedTickets: number;
    terminalPatternsWithReopenedLinkedTickets: number;
    terminalPatternsWithNonReopenedActiveLinkedTickets: number;
    activePatternsWithNoActiveLinkedTickets: number;
    activeTicketsWithResolutionRecords: number;
    reopenedTicketsWithResolutionHistory: number;
    activeNonReopenedTicketsWithResolutionRecords: number;
    resolvedTicketsNeedingGuardFollowup: number;
  };
  terminalPatternsWithActiveLinkedTickets: PatternWithActiveLinks[];
  terminalPatternsWithReopenedLinkedTickets: PatternWithReopenedLinks[];
  terminalPatternsWithNonReopenedActiveLinkedTickets: PatternWithActiveLinks[];
  activePatternsWithNoActiveLinkedTickets: PatternWithLinkedCount[];
  activeTicketsWithResolutionRecords: TicketWithResolutionHistory[];
  reopenedTicketsWithResolutionHistory: TicketWithResolutionHistory[];
  activeNonReopenedTicketsWithResolutionRecords: TicketWithResolutionHistory[];
  resolvedTicketsNeedingGuardFollowup: Ticket[];
};
```

Interpretation:

- `terminalPatternsWithReopenedLinkedTickets` is recurrence context. A linked Ticket recurred after a Pattern was terminal. These Patterns should normally be reopened for review.
- `terminalPatternsWithNonReopenedActiveLinkedTickets` is a workflow anomaly. It means a Pattern is terminal while linked Tickets are still active for reasons other than recurrence.
- `reopenedTicketsWithResolutionHistory` is expected history. Reopened Tickets should retain prior resolutions.
- `activeNonReopenedTicketsWithResolutionRecords` is a workflow anomaly.

With `--repair-reopened-patterns`, the response is:

```ts
type ResolutionAuditRepairEnvelope = {
  repair: {
    schemaVersion: 1;
    generatedAt: string;
    reopenedPatternCount: number;
    reopenedPatterns: Array<{
      pattern: Pattern;
      reopenedLinkedTickets: Ticket[];
    }>;
  };
  audit: ResolutionAudit;
};
```

The repair only reopens terminal Patterns that have reopened linked Tickets. It does not resolve Tickets, change guards, or alter non-reopened active anomalies.

## Guard Audit

Command:

```bash
npm run tickets -- guard-audit --json
npm run tickets -- guard-audit --status rotted --json
npm run tickets -- guard-audit --status warning --json
```

Response:

```ts
type GuardAudit = {
  schemaVersion: 1;
  generatedAt: string;
  entries: Array<{
    ticket: string;
    title: string;
    guardStatus: string;
    guardType: string;
    status: 'ok' | 'warning' | 'rotted';
    command: string | null;
    detectorKey: string | null;
    artifactRef: string | null;
    matchedSmokeTests: string[];
    findings: string[];
  }>;
  summary: {
    total: number;
    rotted: number;
    warnings: number;
    ok: number;
  };
};
```

Interpretation:

- `rotted` means the guard lacks an actionable target or points to a missing stable local artifact.
- `warning` means the guard may still be usable, but the command is not registered, the reference is weak, or a historical `tmp/` / processed-document evidence artifact is no longer present locally.
- `ok` means the guard maps cleanly to registered smoke, detector, CI, or artifact evidence.

## Knowledge Gaps

Command:

```bash
npm run tickets -- knowledge-gaps --json
npm run tickets -- knowledge-gaps --family reader_ingestion --source smoke --severity high --json
```

Response:

```ts
type KnowledgeGaps = {
  schemaVersion: 1;
  generatedAt: string;
  filters: {
    family: string | null;
    severity: string | null;
    source: string | null;
  };
  issues: Ticket[];
};
```

Use filters to turn the broad resolved-ticket knowledge backlog into focused cleanup passes.

## Extraction Notes

The public package should eventually rename public types from `Issue*` to `Ticket*`, but these semantics should survive:

- source-agnostic ticket clustering
- queue alias display
- recurrence-aware audit categories
- explicit repair operations
- guard cleanup status
- scoped knowledge enrichment
