# PP-DocLayout Giant PDF Resilience Ticket

## Status

Active. Revised on 2026-05-09.

This is not blocking the current ToC/nav cohort work. The primary ODL path completed and produced usable markdown/nav for the trigger case, but the secondary layout service failed under giant-PDF load.

Current code has explicit cascade skip thresholds, but PP-DocLayout-S secondary layout can still be selected for large explicit ODL JSON+ routes and still sends the full PDF request. Secondary detector failures are tolerated, but the structured `secondary_done` stage still reports zero regions without durable failure classification or persisted secondary failure metadata.

## Trigger Case

Production upload:

- document id: `289`
- title: `Godel, Escher, Bach`
- source filename in logs: `Godel_Escher_Bach.pdf`
- stored markdown: `document-blobs/289/markdown/processed.md`
- parser: `odl_json_plus_ppdl`
- completion: `2026-04-26T01:21:22Z`

Source characteristics:

- PDF bytes: `23151550`
- pages: `801`
- extracted asset count: `167`
- ODL markdown length before plus pass: about `1.9M` chars

## Observed Behavior

ODL completed successfully:

```text
[odl] parse complete via streamed archive file="Godel_Escher_Bach.pdf" pages=801 markdownLen=1908189 elapsed=280508ms
```

The plus pipeline skipped cascade because of page count, then requested PP-DocLayout-S:

```text
stage=cascade_skipped {"reason":"page_count_too_large","pageCount":801}
[ppdoclayout-client] request start file="Godel_Escher_Bach.pdf" ... model="PP-DocLayout-S" timeoutMs=1800000
```

PP-DocLayout-S failed with a socket hangup:

```text
filename: 'Godel_Escher_Bach.pdf',
error: 'socket hang up'
stage=secondary_done {"secondaryDetector":"pp_doclayout_s","secondaryRegionCount":0,"cascadeRegionCount":0,"cascadeAvailable":false}
```

The pipeline continued using primary ODL regions:

```text
stage=partition_begin {"primaryRegionCount":463,"secondaryRegionCount":0,"cascadeRegionCount":0}
stage=complete {"renderedImageCount":166,"suppressedFigureCount":1}
[ingestion] done doc=289 title="Godel, Escher, Bach"
```

The final markdown was structurally good despite the secondary detector failure:

- 50 ToC entries
- 51 nav anchors
- full GEB/EGB chapter sequence
- Bibliography, Credits, Index, and Footnotes tagged as back matter

## Related Giant-PDF Case

`Consciousness_Explosion_-_Ebook_Comic_Book_v6.pdf` started as document id `290` during the same cohort run.

Observed:

- PDF bytes: `34489771`
- pages: `846`
- extracted asset count: `1459`
- cascade skipped with `reason="pdf_too_large"`
- PP-DocLayout-S completed successfully in about `264255ms`
- secondary region count: `943`
- rendered images: `643`
- suppressed figures: `796`

This document is image-heavy and shows the other side of the same resilience problem: giant-PDF secondary layout can succeed, but it is expensive enough that eligibility, chunking, and timeout policy should be explicit rather than incidental.

## Why This Matters

The fallback behavior is good enough for ingestion continuity, but the current failure mode is opaque and expensive:

- PP-DocLayout-S can spend multiple minutes before a socket-level failure.
- The logs show `secondary_done` with zero regions, but do not clearly classify the secondary detector as failed/degraded.
- Giant PDFs repeatedly send large payloads to a service that may not handle them reliably.
- When the secondary detector fails, quality depends entirely on primary ODL regions; GEB happened to be fine, but image-heavy or layout-dependent PDFs may not be.

## Proposed Direction

Add explicit resilience policy for giant PDF secondary layout:

- introduce page/byte/asset-count thresholds for PP-DocLayout-S eligibility
- skip secondary layout preemptively when a document exceeds known safe limits
- or split giant PDFs into bounded page windows before sending to PP-DocLayout-S
- classify socket hangups/timeouts as `secondary_detector_failed` in structured logs
- include failure reason and elapsed time in ingestion metadata
- keep primary ODL fallback as the continuity path
- avoid retrying the same giant request shape without a changed strategy

Narrow current scope to PP-DocLayout-S secondary eligibility/failure metadata. Cascade skip policy is already partially handled and should not be duplicated here except where it interacts with secondary layout reporting.

## Acceptance Criteria

- Giant PDFs no longer spend several minutes in PP-DocLayout-S before a raw `socket hang up` unless chunking/retry policy is active.
- Logs clearly distinguish:
  - secondary skipped by policy
  - secondary timed out
  - secondary socket failure
  - secondary completed with zero regions
- Ingestion metadata records the selected fallback path and secondary failure reason.
- GEB still completes with the same or better nav quality when secondary layout is skipped or fails.
- A regression or smoke scenario covers a giant-PDF secondary-detector failure and verifies that ingestion continues cleanly.

## Likely Touch Points

- `src/services/DocumentIngestionService.ts`
- PP-DocLayout client wrapper / timeout handling
- `src/services/DeterministicMarkdownPipelineService.ts` only if downstream policy needs metadata awareness
- ingestion logging/metadata persistence
- cohort smoke scripts for large PDF status reporting
