# Reader Web Bundle Size and Intentional Warm Cache Backlog

Date: 2026-05-09
Revised: 2026-05-19
Status: Done — triaged and superseded by persistent cache implementation ticket
Area: Reader web / frontend performance / Vite build / warm cache behavior

## Completion

Completed on 2026-05-19 as a triage and scope-decision ticket.

Decision:

- Do not treat Reader text/render caching or TTS warmup/prefetch as accidental
  bundle bloat.
- Preserve the intentional warm paths for last-document resume, smooth
  navigation, and fast Read Aloud startup.
- Do not resolve performance warnings by disabling TTS prewarm or Reader
  section/display caches.
- Move persistent generated TTS audio and document text caching into a separate
  implementation ticket:
  `docs/tickets/2026-05-19_READER_PERSISTENT_TTS_AUDIO_AND_DOCUMENT_TEXT_CACHE_TICKET.md`.

The Vite large chunk warning remains a known build signal, but there is no
current evidence of illegitimate service-worker precaching. Any future bundle
work should begin with a bundle analyzer report and target unrelated optional UI
or route-only code, not the Reader/TTS warm paths.

## Summary

The Reader web production build completes successfully, but Vite reports its
default large chunk warning. This remains a frontend performance backlog item,
but the scope is narrower than "lazy-load all heavy features."

Reader is expected to resume into the last active document, display document text
smoothly while the user scrolls/pages/skips around, and make Read Aloud feel
ready quickly. TTS prewarm and Reader text/render caching are intentional product
behavior and should not be removed as a bundle-size optimization.

The remaining work is to measure the initial app chunk and identify unrelated
optional code that is loaded before it is needed.

## Product Decisions

These behaviors are deliberate and should be preserved:

- The last active document should restore at the start of a session.
- The Reader should keep enough parsed/renderable text state to make section
  jumps, scrolling, paging, and TTS highlighting feel smooth.
- Kitten TTS should warm on idle when the active document is present, unless the
  browser indicates Save-Data or the tab is hidden.
- TTS audio for the active/nearby read-aloud segments should be prefetched so
  first playback and continuation are smooth.
- Large TTS model/runtime assets should not block first visual render or PWA
  install, but the app may intentionally fetch them soon after load.

Do not resolve this ticket by disabling Reader text caching, TTS engine warmup,
or current-section TTS audio prefetch.

## Observed Build Signal

Recent `npm run build:web` output included:

- Main hashed app bundle around `1.6 MB` minified and around `479 kB` gzip.
- `tts.worker` around `2.2 MB` minified.
- ONNX Runtime WASM asset around `21.6 MB` raw and around `5.1 MB` gzip.
- Vite warning: some chunks are larger than `500 kB` after minification.

Asset hashes change per build, so this ticket should track bundle roles and
sizes rather than specific hashed filenames.

## Current Cache and Prewarm Audit

Reviewed on 2026-05-19.

### Legitimate and intentional

- `web/vite.config.ts`
  - PWA precaches the app shell: JS, CSS, HTML, fonts, icons.
  - Explicitly excludes large TTS/AI runtime assets:
    - `**/tts.worker*.js`
    - `**/*.wasm`
    - `**/*.onnx`
  - Denies API navigation fallback for `/api/` so mutable document/API responses
    do not get hidden by a service-worker fallback.

- `web/src/uco/UCOProvider.tsx`
  - Persists the active document id in localStorage using
    `inti.reader.activeDocumentId.<scope>`.
  - Restores the last/most recent document by hydrating `/api/documents` and
    `/api/documents/:id`.
  - This supports the expected "open Reader and resume" behavior.

- `web/src/ReaderPage.tsx`
  - Keeps `displayContentCacheRef` for normalized section/display content.
  - Clears that cache when `documentId` or `processedMarkdown` changes.
  - This is legitimate in-session render caching for smooth navigation and
    should remain.
  - Direct Reader fetches use `cache: "no-store"` and no-cache headers. That is
    intentional for now because document content changes after upload,
    replacement, local restarts, and parser fixes.

- `web/src/voice/hooks/useTTSPlayback.ts`
  - Uses `requestIdleCallback`/timeout to warm Kitten TTS after load.
  - Skips warmup when Save-Data is enabled or the tab is hidden.
  - Caches generated Kitten audio in an in-memory LRU-style map limited by
    `KITTEN_AUDIO_CACHE_LIMIT = 48`.
  - Prefetch budget is model-aware:
    - mini: up to 16 segments / 2800 chars
    - micro: up to 10 segments / 1800 chars
    - other: up to 8 segments / 1400 chars
  - This is product-aligned and should be preserved.

- `web/src/lib/queryClient.ts` and `web/src/hooks/useDocuments.ts`
  - React Query keeps document lists/details in memory with explicit mutation
    invalidations.
  - Upload option/preflight paths avoid stale caching where it matters.
  - This is normal UI data caching, not accidental service-worker precaching.

### Legitimate future work, but not this ticket's main bundle cleanup

Generated TTS audio is not currently persisted across a full page reload or new
browser session; it is held in memory. If the product requirement becomes "resume
read-aloud instantly after refresh/tab close," create a separate feature ticket
for a bounded persistent generated-audio cache using IndexedDB or Cache Storage,
with keys that include:

- document id
- chunk/section identity
- paragraph/segment index
- model id
- voice id
- speed/rate
- text hash
- document content revision or processed timestamp

Similarly, persistent document-text caching could be useful for offline/fast
resume later, but it needs strong invalidation keyed by document revision. The
current `no-store` fetch policy is safer while parser, replacement, and
debugging workflows are still changing.

## Suspected Non-Reader Prewarm Bundle Targets

These are the better candidates for bundle analysis and possible lazy loading:

- `web/src/App.tsx` eagerly imports non-root routes such as `AdminPortal`,
  `SettingsPage`, `HelpPage`, `GuidePages`, and `MeetYourIntiPage`.
- `web/src/ReaderPage.tsx` eagerly imports `DocumentPickerModal`.
- `DocumentPickerModal` eagerly imports `DocumentUploadWizard`.
- `DocumentUploadWizard` eagerly imports every upload/import wizard step.
- `ReaderPage.tsx` eagerly imports edit-mode helper code and React Markdown /
  math rendering dependencies. Some of this may be required for first document
  render; measure before splitting.

Do not assume these are all bugs. The next step is a bundle analyzer report that
shows their actual contribution to the initial route.

## Current Priority

Not urgent unless users report slow initial load, startup responsiveness issues,
or web vitals show a regression. This is still a reasonable non-ingestion ticket
because it is isolated to the web frontend and build behavior.

## Proposed Follow-Up

1. Run a bundle analyzer against the web build and identify the largest modules
   in the initial app chunk.
2. Classify each large contributor as:
   - intentional Reader/TTS warm path,
   - required for first document render,
   - optional workflow that can be lazy-loaded,
   - route-only code that should be route-split.
3. Preserve TTS warmup and active-document text/render caching.
4. Lazy-load only clearly optional non-initial workflows where the analyzer
   supports the change:
   - admin/settings/help/guide/onboarding routes,
   - upload/import wizard internals,
   - large modal-only UI,
   - edit-mode-only code if it can be separated cleanly,
   - math rendering only if documents without math can avoid it without
     regressions.
5. Measure before/after:
   - initial JS transferred,
   - first visual Reader render,
   - active document resume time,
   - section jump/scroll responsiveness,
   - TTS warmup and first playback latency.

## Acceptance Criteria

- Bundle analyzer report identifies the top contributors to the initial app
  chunk.
- Intentional Reader text/render caching and TTS prewarm behavior remain enabled.
- Initial route no longer loads clearly optional non-Reader workflows before use,
  or the ticket documents why each large contributor is intentionally retained.
- `npm run build:web` either avoids the large chunk warning for the main app
  chunk or documents why remaining large chunks are expected.
- Reader open/resume, section navigation, Read Aloud, Edit mode, upload/import,
  and offline/PWA behavior do not regress.
- Performance measurements are recorded before and after any implementation
  change.
