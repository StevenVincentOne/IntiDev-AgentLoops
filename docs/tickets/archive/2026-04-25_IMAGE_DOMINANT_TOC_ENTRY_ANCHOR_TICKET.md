# Image-Dominant ToC Entry Anchor Ticket

## Status

Done. Archived on 2026-05-09.

Current ToC-driven navigation tagging now synthesizes anchors from page/line evidence for unmatched main ToC entries, including image-only body regions. This no longer needs to remain in the active ticket list.

## Context

Some documents contain valid Table of Contents entries whose corresponding body section has no reliable extracted text heading. In the current cohort, `Consciousness Explosion` includes a ToC entry for `Desdemona's Dream Comic`, but the body content is largely page images and the extracted markdown does not expose a matching heading.

## Current behavior

- The ToC entry is preserved.
- No navigation anchor is created when there is no matching body heading.
- The image-heavy section remains part of the previous rendered section until the next detected nav boundary.

This is acceptable for now as long as Reader renders untagged continuation content instead of hiding it.

## Desired behavior

Add a later ToC/page-aware anchoring pass that can create a synthetic navigation anchor for a high-confidence unmatched ToC entry when:

- the entry is present in an authoritative visible ToC,
- the body has page markers or other positional evidence for the entry,
- no corresponding text heading was extracted,
- the target body region is image-heavy or otherwise low text,
- the synthetic anchor would not split ordinary prose incorrectly.

## Notes

This should be handled after the nav-independent rendering work, because the immediate correctness requirement is that untagged content remains visible. Synthetic anchors for image-dominant sections are a quality improvement, not a blocking ingestion fix.
