# 2026-04-25 Singularity Visible ToC Repair Ticket

## Status

Active. Revised on 2026-05-09.

Keep this as a follow-up case for visible-ToC parser repair and authority validation. Do not delete.

Current code still reproduces the core failure: the visible-ToC detector accepts the malformed 8-entry Singularity block as detected, high-confidence flattened ToC output, including the fused `The Power of Ideas CHAPTER ONE The Six Epochs` entry. This ticket should stay active until that block is rejected/downgraded or repaired into broad-book coverage.

## Trigger Case

Source PDF:

- `docs/Reader/test-docs/pdf/ToC/No Outline/Kurzweil, Ray - The Singularity Is Near.pdf`

Production upload inspected:

- document id: `294`
- stored markdown: `document-blobs/294/markdown/processed.md`
- filename in logs: `Kurzweil_Ray_-_The_Singularity_Is_Near.pdf`
- pipeline: `odl_json_plus_ppdl`
- completion: `2026-04-25T21:26:04Z`

The source PDF is a calibre-generated, untagged, 920-page ebook conversion:

- `Creator: calibre 0.7.43`
- `Producer: calibre 0.7.43`
- `Tagged: no`
- `Pages: 920`

## Summary

This document has a visible `Contents` section, but the extracted text layer is degraded:

- some title lines are split across physical lines
- some page numbers appear on isolated lines
- some required line breaks collapse into running prose
- chapter labels can be separated from or fused into adjacent titles
- indented subtopic summaries appear between real ToC entries

The current preflight parser accepts the malformed block as a high-confidence visible ToC and emits only a partial 8-entry ToC ending around page 59. The raw source ToC actually continues through Chapter Nine, Epilogue, Resources, Appendix, Notes, and Index, so this is not a true "no usable ToC" case. It is a noisy text-layer ToC that needs a repair-oriented parser plus strict validation.

## Observed Production Result

The processed markdown contains this ToC block:

```text
Acknowledgments ... 18
Prologue ... 21
The Power of Ideas CHAPTER ONE The Six Epochs ... 24
The Intuitive Linear View Versus the Historical Exponential View ... 25
The Six Epochs ... 28
Chapter TWO. A Theory of Technology Evolution: The Law of Accelerating Returns ... 44
The Nature of Order. The Life Cycle of a Paradigm. Fractal Designs. Farsighted Evolution. The S-Curve of a Technology as Expressed in Its Life Cycle ... 56
The Life Cycle of a Technology. From Goat Skins to Downloads. Moore's Law and Beyond ... 59
```

Problems:

- It is partial for a 920-page book.
- It misses Chapter Three through Chapter Nine and all back matter.
- It fuses `The Power of Ideas` with `CHAPTER ONE The Six Epochs`.
- It accepts run-on subtopic prose as nav entries.
- It gives visible-ToC authority to a block that should have failed long-book coverage validation.
- Downstream nav tagging then anchors the bad entry as `SECTION: The Power of Ideas CHAPTER ONE The Six Epochs`.
- A duplicate `SECTION: Chapter TWO...` appears near the notes area, showing that ToC/body matching can also mis-anchor when the authoritative ToC is partial/corrupt.

Additional production observations that may deserve separate cleanup:

- The R2 prefix for doc `294` still contains stale source objects from older uploads (`DeepSeek_R1.pdf`, `This_Is_A_Test_Document.pdf`) alongside the current Singularity source. That suggests delete/reupload cleanup does not remove old source blobs for a document id/prefix.
- The processed markdown begins with an unrelated blockquoted `Summary` about artificial intelligence and human rights before the actual book front matter. This looks like catalog/metadata summary contamination entering the document body.

## Why This Should Be Deferred

This case is structurally different from the current cohort goal.

The current cohort is about improving normal no-outline PDFs where visible ToCs should be detected and used. Singularity is a degraded ebook-conversion case where the visible ToC is present but requires a layout-aware repair pass. Fixing it now risks overfitting the parser and weakening good-ToC behavior.

The right behavior for the current pipeline would be:

1. reject or downgrade the current 8-entry partial ToC as authoritative
2. fall back to body heading/nav heuristics for this document
3. later add a repair parser that can recover the full visible ToC only when validation passes

## Proposed Direction

Add a visible-ToC parser candidate specialized for degraded line-state ToCs.

The parser should preserve physical line information rather than flattening immediately:

- maintain a pending title buffer
- attach isolated page-number lines to the pending title
- treat `CHAPTER ONE`, `CHAPTER TWO`, etc. as structural prefixes for the next paged title
- drop or ignore indented sentence-list blocks after a real entry
- avoid fusing pre-chapter subtitles into the next chapter label unless the resulting title validates
- stop at terminal back matter such as `Index`

Then gate the repaired ToC with long-book validation:

- for long books, require coverage beyond the early pages, e.g. max numeric page label greater than a meaningful fraction of total pages or presence of back matter
- require multiple chapter labels when chapter labels are detected in source text
- reject embedded mid-title structural labels such as `The Power of Ideas CHAPTER ONE The Six Epochs`
- cap confidence for flattened parser results that lack coverage
- reject run-on entries with multiple sentence-like clauses unless they are clearly annotations and not nav nodes
- prefer sparse fallback nav over authoritative ToC poisoning when validation is weak

## Acceptance Criteria

- Singularity no longer accepts the 8-entry partial ToC as high-confidence `visible_toc` authority.
- A repaired parser can recover a broad ToC including later chapters and back matter, or the document cleanly falls back to non-ToC nav.
- No valid current ToC corpus document is downgraded because of a single weak signal; rejection requires combined evidence such as low coverage plus run-on/fused-entry defects.
- Regression coverage includes this source PDF or a reduced fixture representing:
  - isolated page-number lines
  - split chapter titles
  - embedded/fused chapter labels
  - indented subtopic prose
  - long-book coverage validation

## Implementation Notes

Likely touch points:

- `src/services/DocumentMetadataPreflightService.ts`
- `scripts/run-toc-structure-regression.ts`
- `scripts/run-pdf-toc-corpus-smoke.ts`

This should be implemented as an additional parser candidate and authority guardrail, not as a global text cleanup pass.
