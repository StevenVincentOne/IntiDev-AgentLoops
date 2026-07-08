# Reader Persistent TTS Audio and Document Text Cache

Date: 2026-05-19
Status: Complete — archived 2026-05-19
Area: Reader web / persistence / offline-readiness / TTS

## Completion Summary

Archived on 2026-05-19 after implementing the bounded IndexedDB cache and
documenting the architecture.

Implemented:

- shared Reader persistent cache module at
  `web/src/lib/readerPersistentCache.ts`
- `documents` store for scoped document revisions, fetched markdown, and parsed
  navigation inputs
- `ttsAudio` store for scoped Kitten generated-audio buffers and sample rates
- memory-first, IndexedDB-second, generation-third Kitten audio lookup
- background write of successful Kitten generation results
- scope isolation for `user-<id>`, `guest`, and `public-share-<id>`
- document revision keys based on the fetched Reader markdown
- delete/replace/logout invalidation hooks
- optional/fail-open IndexedDB behavior
- documentation in
  `docs/Reader/architecture/READER_PERSISTENT_CACHE_ARCHITECTURE.md`
  and `docs/Reader/read-aloud/PERSISTENT_TTS_AUDIO_CACHE.md`

Important product decision:

- Reader remains server-authoritative. Cached document text/navigation is used
  only after the current API response confirms the matching markdown revision.
  Stale-first or offline-first rendering is intentionally not part of this
  ticket.

Verification completed before archive:

- `npm run check:web`
- `npm run build:web`
- Reader browser smoke at `http://localhost:5173`
- real Chromium IndexedDB smoke proving document/audio put, get, and clear
  behavior

## Summary

Add bounded persistent browser caches for:

- generated TTS audio for recently read/current document segments
- processed document text/render inputs for fast resume and smooth offline-ish
  rereads

This is separate from the bundle-size ticket. Reader text caching and TTS
prewarm are intentional product behavior; this ticket makes the useful cache
survive refreshes and, where safe, browser restarts.

## Product Goal

When a user returns to Reader, the last active document should open quickly and
Read Aloud should be able to resume without regenerating nearby audio that was
already produced in a prior page session.

When a user jumps around inside a document, cached text/render inputs should make
the page feel smooth while the app still treats the server as the source of
truth.

## Current State

Reviewed on 2026-05-19.

- `web/src/uco/UCOProvider.tsx` already persists the active document id in
  localStorage and hydrates the last/most recent document.
- `web/src/ReaderPage.tsx` keeps an in-memory `displayContentCacheRef` for
  normalized section/display content and clears it when the document/content
  changes.
- Reader document fetches currently use `cache: "no-store"` and no-cache headers.
  Keep that source-of-truth behavior while parser, replacement, and debugging
  workflows are active.
- `web/src/voice/hooks/useTTSPlayback.ts` warms Kitten TTS on idle, skips warmup
  for Save-Data/hidden-tab cases, and caches generated audio in memory with
  `KITTEN_AUDIO_CACHE_LIMIT = 48`.
- Generated TTS audio does not currently persist across a full reload or browser
  restart.

## Constraints

- Do not put mutable document/API responses into broad service-worker runtime
  caches.
- Keep network/server data authoritative.
- Never show stale processed text after document replacement, parser reruns, or
  backend fixes.
- Do not persist generated audio without a revision/hash key that proves it
  belongs to the exact text/settings currently being read.
- Respect browser storage pressure and private/incognito failure modes.
- Provide a clear cache-clear path on logout, document delete, document replace,
  and account switch.
- Avoid blocking first visual render on persistent-cache reads/writes.

## Recommended Storage

Use IndexedDB for app-managed persistence. It is better suited than localStorage
for larger values and safer than service-worker runtime caching for mutable
document data because the app can key and evict entries explicitly.

Suggested stores:

- `documents`
  - key: `{userScope}:{documentId}:{contentRevision}`
  - value: processed markdown/text, outline/nav inputs, metadata needed for fast
    display, `touchedAt`, and size estimate
- `ttsAudio`
  - key:
    `{userScope}:{documentId}:{contentRevision}:{chunkIndex}:{absoluteIndex}:{paraId}:{modelId}:{voiceId}:{rate}:{textHash}`
  - value: `Float32Array` audio buffer or transferable `ArrayBuffer`,
    `sampleRate`, duration estimate, `touchedAt`, and size estimate
- `cacheMeta`
  - user/account scope, version, quota counters, last eviction timestamp

`contentRevision` can be a server-provided processed timestamp/version when
available. If the API does not expose a stable content revision yet, use a hash
of the processed markdown/chunk content as a temporary key component.

## Implementation Plan

### Phase 1 — Cache Utility

Create a small Reader cache module around IndexedDB:

- open/version database
- get/put/delete helpers
- quota-aware LRU eviction
- best-effort behavior when IndexedDB is unavailable
- user/account scoping
- clear functions for logout, delete, replace, and manual debug reset

Keep this module framework-independent enough to unit test.

### Phase 2 — Persistent TTS Audio Cache

Integrate with `useTTSPlayback`:

- Before generating Kitten audio, check memory cache first, then IndexedDB.
- After generation, keep the current in-memory cache and write successful audio
  to IndexedDB in the background.
- Rehydrate nearby audio during the existing idle prefetch path.
- Invalidate when model, voice, rate, source text hash, document revision, or
  user scope changes.
- Maintain the existing Save-Data/hidden-tab guardrails.

### Phase 3 — Persistent Document Text Cache

Integrate with Reader document/chunk loading:

- Use cached processed text/render inputs as an immediate warm start only when
  the cached revision matches the current document revision.
- Continue fetching the authoritative server version.
- Replace the displayed content if the server revision differs.
- Store refreshed text/render inputs after successful fetch.
- Evict document cache entries on delete/replace and when quota limits are hit.

If no stable server revision is available, do not ship stale-first rendering.
Use the cache only after the network response confirms the content hash or add
the needed revision metadata first.

### Phase 4 — Observability and Controls

- Add debug logging behind a local flag for cache hit/miss/write/evict events.
- Add a manual clear path for persistent Reader cache, likely in Settings or a
  development-only console helper.
- Measure:
  - active document resume time
  - first Read Aloud latency after reload
  - cache size and eviction behavior
  - behavior after document replacement/delete

## Acceptance Criteria

- TTS generated audio for recently prefetched/read segments can be reused after a
  page reload when document revision and TTS settings match.
- Cached TTS audio is invalidated when document text, model, voice, rate, or
  user/account scope changes.
- Reader document text/render inputs can warm a returning session without
  showing stale content after replacement, parser rerun, or document delete.
- Server/network fetch remains authoritative.
- Cache writes do not block first visual render or active document hydration.
- Storage quota pressure triggers bounded LRU eviction instead of unbounded
  growth.
- Logout/account switch clears or isolates persistent Reader/TTS cache entries.
- Browser private mode or IndexedDB failure falls back to current in-memory
  behavior without breaking Reader or Read Aloud.
- Verification covers refresh, browser restart where practical, document
  replacement/delete, TTS setting changes, and Save-Data behavior.
