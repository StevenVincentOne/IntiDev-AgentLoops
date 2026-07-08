# Ticket Smoke Test Integration

Date: 2026-05-24
Status: Implemented initial registry and runner
Area: Tickets / smoke tests / agent verification

## Summary

Smoke tests are now registered in `config/smoke-tests.json` and can be run through the Ticket Ledger CLI:

```bash
npm run tickets:smoke:list
npm run tickets -- smoke agent-default --dry-run
npm run tickets -- smoke toc-rebuild
```

Registered runs create ticket events only when a command fails. Each failure uses the registry's stable `family`, `ticketKind`, `severity`, and subsystem metadata, so repeated smoke failures cluster instead of becoming unrelated one-off tickets.

Structured smoke reports can also create ticket events when a run succeeds but emits medium-or-higher `issueFindings`, `issues`, or `findings`. This is how Reader corpus upload reports bridge smoke-only quality defects into the same Ticket Ledger.

Manual app uploads now run a lightweight post-ingest quality scan after queued processing completes. This is not the full smoke suite. It reuses high-confidence, cheap smoke detector families for one processed document: markdown control characters, known junk artifact leaks, obvious markdown/rendering defects, object placeholder/comment defects, and ownership/tagging/page-partition audit findings when those artifacts were already produced by ingestion. Findings use smoke-compatible fingerprints so a later corpus smoke and the original manual upload can cluster on the same Ticket.

## Safety Gates

The smoke runner skips higher-risk entries by default:

- `requiresApi`: requires `--include-live`
- `mutatesDb`: requires `--include-mutating`
- `requiresDocker`: requires `--include-docker`
- `expensive`: requires `--include-expensive`

Use `--all` only for deliberate broad local or CI runs.

## Suites

- `agent-default`: cheap deterministic checks suitable for routine agent verification.
- `core`: typechecks, web build, and core deterministic Reader checks.
- `ingestion-core`: deterministic parser, tagging, region-contract, and markdown-emission checks.
- `ticket-regression`: code-level assertions for resolved ticket regressions.
- `reader-runtime`: live API Reader and delivery/retention smoke tests.
- `local-health`: local dev service checks.
- `corpus-upload`: live API corpus upload and strict Reader-contract polling.
- `ci`: CI-oriented gate composition.

## Recommended Agent Use

Before choosing a verification target:

```bash
npm run tickets:smoke:list
npm run tickets -- smoke <suite-or-test> --dry-run
```

After a fix:

```bash
npm run tickets -- smoke <smallest-relevant-suite-or-test>
```

For live upload/API checks:

```bash
npm run tickets -- smoke reader-runtime --include-live --include-mutating
npm run tickets -- smoke corpus-upload --include-live --include-mutating --include-expensive
```

For ad hoc commands that are not registered yet:

```bash
npm run tickets -- run --source smoke --family <stable_family> -- <command>
```

If an ad hoc command becomes useful more than once, add it to `config/smoke-tests.json` instead of repeatedly using a free-form family name.

## Manual Upload Post-Ingest Scan

The post-ingest scan runs from the document ingest queue worker after successful processing. It calls `scanAndTicketPostIngestIssuesForDocument(documentId)` and writes `source=ingestion` Ticket events with `context.sourceBridge = post-ingest-quality-scan` and `context.scanProfile = manual_upload_cheap`.

This scan is deliberately narrower than corpus smoke:

- It is per-document and synchronous with queue completion.
- It only tickets medium-or-higher high-confidence findings.
- It does not run expensive corpus, visual, or cross-document checks.
- It does not replace `npm run tickets -- smoke ...` for acceptance/regression gates.

Use full smoke when accepting a cohort, validating a root-cause fix, or checking defects that require broad artifacts, strict Reader export checks, or manual visual review. Use the post-ingest scan as an automatic early warning layer for new manual uploads.
