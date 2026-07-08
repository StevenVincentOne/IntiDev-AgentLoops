# Struct-Tree Partition Fallback Telemetry And Resilience

Date: 2026-04-26
Status: Mostly mitigated; needs production verification
Area: Reader ingestion / PDF parser routing / ODL JSON+ partitioning

## Summary

Tagged PDFs routed to `odl_json_plus_ppdl_struct_tree` can fail the exclusion-stage page partition contract, then retry successfully with `odl_json_plus_ppdl`. The fallback keeps ingestion usable, but it currently costs a full second parser pass and should be made more resilient.

## Observed Case

- Document: `Claude_Mythos_Preview_System_Card_3_.pdf`
- Routed parser: `odl_json_plus_ppdl_struct_tree`
- Fallback parser: `odl_json_plus_ppdl`
- Failure class: invalid page partition contract caused by overlapping frozen struct-tree-derived regions.
- Representative reason:
  - `partition:footnote:p20:r3` overlapped `partition:heading:odl:p20:b4`
  - `partition:footnote:p20:r3` overlapped `partition:body_text:odl:p20:b1`
  - `partition:footnote:p20:r3` overlapped `partition:body_text:odl:p20:b0:split-body`

## Why This Matters

- The user-facing output can still be acceptable because baseline fallback succeeds.
- The fallback doubles expensive work on large reports: ODL parse, PP-DocLayout pass, partition failure, then another ODL parse and PP-DocLayout pass.
- Without explicit parser telemetry, production evaluation can misread the result as a struct-tree success when it was actually produced by the baseline parser.

## Current Mitigation

The ingestion layer now stores parser telemetry separately:

- `recommendedIngestParser`
- `requestedIngestParser`
- `effectiveIngestParser`
- `actualIngestParser`
- `ingestParserFallbacks`
- `ingestParserFallbackReason`

The legacy `ingestParser` field should reflect the actual parser that produced the final markdown.

The page partition layer now also prunes frozen footnote keep regions when they overlap higher-value frozen text keep regions (`heading`, `body_text`, or `list`) with no shared member origin. This addresses the observed Mythos-style failure class without falling back to the baseline parser, and `scripts/run-toc-structure-regression.ts` includes a synthetic overlapping-footnote regression.

The admin ingest-issues view now surfaces failed ingests and processed ingests with warnings, including parser fallback warnings, without requiring log-only inspection.

## Remaining Follow-Up

1. Reupload Mythos and confirm production no longer logs `struct_tree_exclusion_fallback_to_baseline` for the overlapping-footnote case.
2. If fallback remains necessary for other failure classes, preserve the failed struct-tree attempt artifacts for inspection.
3. If duplicate parser passes still happen after the partition fix, revisit parser artifact reuse. Do not keep this as active work unless production evidence shows remaining duplicate PP-DocLayout cost.

## Acceptance Criteria

- [x] Stored metadata clearly identifies requested/effective/actual parser and fallback reason.
- [x] The page partition layer prunes the observed overlapping-footnote keep geometry class before contract validation.
- [x] Regression coverage exists for the overlapping-footnote partition failure class.
- [x] The admin ingest issues view can surface parser fallback warnings without requiring log inspection.
- [ ] Mythos reupload confirms production no longer logs `struct_tree_exclusion_fallback_to_baseline` for the overlapping-footnote case.
