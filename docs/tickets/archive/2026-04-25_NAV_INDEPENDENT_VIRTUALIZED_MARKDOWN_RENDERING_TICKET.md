# 2026-04-25 Nav-Independent Virtualized Markdown Rendering Ticket

## Status

Revised on 2026-05-09. Partially mitigated, still open as Reader architecture backlog.

Current Reader has a block-level virtualized Markdown renderer and an oversized-nav-segment continuation fallback. Those changes reduce the original failure severity, but tagged processed Markdown still renders from the selected navigation node's character range. Nav tags therefore still choose the visible document slice when tags exist.

Keep this ticket, but scope it to the remaining architecture work: continuous full-document block-stream rendering with navigation as anchors only.

## Summary

Reader rendering should not depend on navigation tags.

Documents can be:

- richly structured with reliable nav tags
- partially structured with sparse or imperfect nav tags
- flat prose with no reliable headings or nav tags
- user-edited, where nav tags may be added later in the editor

In every case, the full document text should remain visible and scrollable. Nav tags should provide anchors and section labels, not decide which text exists in the rendered view.

## Trigger Case

Production document:

- Singularity upload, doc id `294`
- source: `docs/Reader/test-docs/pdf/ToC/No Outline/Kurzweil, Ray - The Singularity Is Near.pdf`
- processed markdown contains the full book text
- Reader initially showed only small portions because sparse/bad nav tags created huge segments that hit the section render cap

Observed segment sizes before the stopgap Reader patch:

- `The Intuitive Linear View Versus the Historical Exponential View`: about 1.2M characters
- `Chapter TWO...`: about 302k characters

Those segments exceeded the current `MAX_RENDERABLE_SECTION_CHARS` cap, so valid markdown became unreachable through normal Reader rendering.

## Current Mitigations

`web/src/ReaderPage.tsx` now:

- expands oversized tag-nav segments by deriving continuation nodes from real markdown headings inside those segments,
- splits rendered Markdown into virtual blocks,
- renders a window of visible blocks for large Markdown content.

These are safety valves, not the final architecture:

- it protects documents with sparse/bad nav tags
- it keeps the existing section render cap
- it still treats nav nodes as primary render slices
- it virtualizes the selected rendered slice, not an independent full-document block stream

The long-term fix should make rendering independent from nav segmentation.

## Problem

The current Reader architecture conflates three separate concepts:

1. render units
2. navigation units
3. TTS/read-aloud units

When those are coupled, a nav failure becomes a rendering failure. This is especially risky while improving ToC parsing and nav tagging, because the Reader view can falsely suggest text is missing from ingestion output when the markdown is actually complete.

Flat documents are a normal expected class. They should render as continuous text even when there are no structure keys available for automatic nav tagging. Users can later insert nav tags manually in the editor.

## Proposed Direction

Move to nav-independent, block-level virtualized Markdown rendering.

Terminology:

- "virtualized rendering" or "windowed rendering": render only the visible content and a buffer around it
- "block-level": split markdown into stable display blocks rather than one giant React Markdown tree

The Reader should:

1. Parse processed markdown into a continuous block stream.
2. Render only visible blocks plus an overscan buffer.
3. Keep nav tags as optional anchors into the block stream.
4. Keep TTS ranges as independent selections over the same block stream.
5. Allow flat documents to render fully without inferred nav.

## Candidate Block Model

Use stable block boundaries such as:

- `<!-- PARA:N -->` paragraphs
- markdown headings
- page breaks
- image/object placeholders
- list blocks
- table blocks
- blockquote blocks
- code/math blocks

Each block should track:

- block id
- markdown start/end offsets
- source tag or type
- rendered height estimate / measured height
- paragraph id when available
- nav anchor ids that target this block

## Desired Reader Behavior

### Rich nav document

- Sidebar shows nav tree.
- Clicking nav scrolls to the corresponding block.
- Body rendering is still driven by the continuous block stream.

### Sparse/bad nav document

- Sidebar may be sparse or imperfect.
- Body still renders all text progressively.
- Bad nav can be evaluated without hiding unrelated text.

### Flat document

- Reader renders a continuous scrollable document.
- Sidebar may show a single "Document" node or no structure tree.
- Search, editor, bookmarks, and read-aloud still work over the block stream.

### User-edited nav

- Adding/removing nav tags updates anchors/sidebar.
- It does not change whether body blocks render.

## Acceptance Criteria

- A processed markdown document with no nav tags renders all text as continuous scrollable content.
- A processed markdown document with sparse nav tags still renders all text.
- No section-level character cap can hide valid markdown from the user.
- Existing nav/sidebar jumps still work for tagged documents.
- TTS selection can operate on nav ranges when present and block ranges when nav is absent.
- The Singularity doc id `294` class of failure is impossible: sparse nav cannot make late chapters invisible.
- A large flat markdown fixture can be loaded without rendering the entire document into the DOM at once.

## Implementation Phases

### Phase 1: Render Model Spike

- Build a markdown block splitter for processed markdown.
- Preserve source offsets and paragraph ids.
- Prototype a simple virtualized list for block rendering.

### Phase 2: Reader Integration

- Replace section-sliced display with block-stream display.
- Rewire nav clicks to scroll to block offsets.
- Keep current sidebar model initially.

### Phase 3: TTS and Editing

- Map TTS playback to block/paragraph ids instead of assuming nav segment visibility.
- Update editor segment operations to work against selected nav ranges or explicit block ranges.

### Phase 4: Cleanup

- Remove or substantially reduce `MAX_RENDERABLE_SECTION_CHARS`.
- Keep only defensive safeguards for pathological single blocks.
- Retire oversized-segment continuation fallback once block virtualization is stable.

## Likely Touch Points

- `web/src/ReaderPage.tsx`
- `web/src/lib/paragraphParser.ts`
- `src/shared/DocumentContract.ts`
- Reader edit-mode helpers
- TTS/read-aloud selection and highlight-follow code

## Notes

This is not an ingestion fix. Ingestion should still improve ToC parsing and nav tagging, but Reader display must be robust when ingestion cannot infer structure.
