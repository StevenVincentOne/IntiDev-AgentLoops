# Reader Legacy UCO and WebSocket Cleanup Ticket

Date: 2026-05-11
Status: Complete - archived 2026-05-19
Area: Reader web, local development, Inti AI compatibility removal

## Completion Summary

Archived on 2026-05-19 after removing the legacy UCO/WebSocket bridge from the
Reader runtime.

Implemented:

- Removed `web/src/contexts/SharedWebSocketContext.tsx` and its app wrapper.
- Removed `src/ws/IntiWsBridge.ts`, `initIntiWsBridge()`, and all
  `broadcastWsEvent()` call sites.
- Removed direct `ws` and `@types/ws` package dependencies.
- Removed Reader `document.load` sends and `agentic.*` subscriptions from
  `web/src/ReaderPage.tsx`.
- Removed read-aloud `agentic.reading_start`, `agentic.reading_line`, and
  `agentic.reading_end` sends from `web/src/voice/hooks/useTTSPlayback.ts`.
- Removed `agentic.note_added` subscription support from
  `web/src/components/reader/NotesPanel.tsx`.
- Replaced the legacy UCO active-document wrapper with
  `web/src/contexts/ReaderDocumentContext.tsx`, exporting
  `ReaderDocumentProvider` and `useReaderDocument`.
- Removed inactive `web/src/voice/stores/useVoiceRuntimeStore.ts` and
  Reader-side `uco.context_update` calls.
- Kept same-tab document delete fallback through the local
  `web/src/lib/readerDocumentEvents.ts` event emitted by `useDeleteDocument()`.

Rationale:

- Active document selection, restore, and fallback are now direct Reader
  concerns, not WebSocket round-trips.
- The document list already polls while documents are queued or processing, so
  ingest completion does not require `agentic.document_updated` push events.
- Bookmark and note mutations update their own local/query state.
- Read-aloud highlighting is driven by `useReadingPlaybackStore`, not
  WebSocket broadcasts.
- Keeping auth/session data out of WebSocket URLs and removing the bridge
  eliminates the `/api/inti-ws` reconnect loop and its local-dev proxy noise.

Verification:

- `npm run check:web`
- `npm run check`
- `npm run build:web`
- `git diff --check`
- Playwright screenshot smoke at `http://localhost:5173`

Historical notes below are retained for context. Any "Remaining" items in older
dated updates are superseded by this completion summary.

## 2026-05-13 Update

The production-facing symptom that prompted this ticket has been fixed: opening a document from the Reader Library no longer depends on `/api/inti-ws`.

Implemented:

- `web/src/uco/UCOProvider.tsx` now exposes `loadDocument(documentId)` and `clearDocument()`.
- `loadDocument(documentId)` persists the active document, immediately publishes a pending document summary, and hydrates metadata through `/api/documents/:id`.
- `web/src/ReaderPage.tsx` now calls `loadDocument()` directly for Library Open and `reader.pendingLoadDocumentId` flows.
- The legacy `document.load` WebSocket send remains as a secondary compatibility signal for now.
- `src/ws/IntiWsBridge.ts` accepts `http://localhost:5173` and `http://127.0.0.1:5173` as non-production allowed origins, reducing local Vite proxy brittleness.

Verified:

- `npm run check:web`
- `npm run check`
- `npm run restart:api:local`
- `npm run local:health`
- Browser smoke at `http://localhost:5173`: opened Library and switched from "Alliant 3 Governmentwide Acquisition Contract (GWAC) Master Contract" to "Consciousness Explosion"; the Reader title/content changed correctly, and reload restored "Consciousness Explosion".

Remaining:

- UCO and `SharedWebSocketProvider` are still present.
- `/api/inti-ws` and `agentic.*` event paths are still present.
- The client still sends a session-like value in the WebSocket URL.
- Upload, ingest, replace, delete, bookmark, note, and document update refresh paths still need a focused audit before removing the bridge.

Because the broader cleanup is not complete, this ticket should stay open rather than move to `docs/tickets/archive` yet.

## Summary

Inti Reader Lite still carries UCO and `/api/inti-ws` WebSocket compatibility code inherited from Inti AI. UCO does not belong in the Inti Reader product model, and the WebSocket bridge appears to be a legacy Inti AI integration surface rather than a required Reader Lite runtime dependency.

Do not remove it during the current architecture work. The current fork has accidental live coupling to UCO and the WebSocket bridge, especially around active document selection and restore behavior. Cleaning this up should be handled as a focused follow-up after the current architecture changes stabilize.

## Observed Local Dev Signal

When running the Reader UI at `http://localhost:5173`, the app loads, but the console shows repeated WebSocket connection failures:

```text
WebSocket connection to 'ws://localhost:5173/api/inti-ws?clientType=PWA&sessionId=...' failed
[SharedWS] Connection closed: 1006
[SharedWS] Reconnecting ...
```

The local Vite proxy has also shown WebSocket proxy errors such as `write EPIPE`.

The likely short-term cause is origin handling around the Vite proxy. The browser connects to `localhost:5173`; the proxy forwards to the API on `localhost:5100`; the backend WebSocket origin check compares the request origin against the backend host unless `INTI_WS_ALLOWED_ORIGINS` is configured. That makes the bridge brittle in local development.

This is separate from the earlier `401 Unauthorized` API errors seen when using the WSL IP address. Those were caused by loading the app through `http://172.30.230.166:5100`, which changes the browser origin and prevents the `localhost` auth cookie from being sent. The correct local Reader UI address is `http://localhost:5173`; `5100` is the API port, not the browser app.

Other console messages seen in the same session are lower priority:

- `contentscript.js` migration warning: browser extension noise.
- Vite connect messages and React DevTools prompt: expected in dev.
- `favicon.ico` 404: harmless polish issue.
- Kitten TTS download and ready logs: expected model initialization, though noisy and potentially heavy.
- Reader debug logs: development logging.
- Radix dialog `Description` warning: real accessibility warning, but unrelated to the WebSocket cleanup.
- `setTimeout` violation messages: likely from heavy client-side initialization and not directly tied to UCO.

## Current Coupling

Relevant files found during the read-only review:

- `src/ws/IntiWsBridge.ts`
  - Defines the `/api/inti-ws` compatibility bridge.
  - Handles client events such as `document.load` and `document.clear`.
  - Broadcasts server events through `broadcastWsEvent`.
- `src/index.ts`
  - Initializes `IntiWsBridge`.
- `src/routes/readerCompat.ts`
  - Broadcasts events such as `agentic.document_updated`, `document.deleted`, `agentic.bookmark_added`, and `agentic.note_added`.
- `src/services/DocumentIngestQueueExecutionService.ts`
  - Broadcasts document update events after ingest processing.
- `web/src/main.tsx`
  - Wraps the app with `SharedWebSocketProvider`.
- `web/src/contexts/SharedWebSocketContext.tsx`
  - Owns the browser WebSocket connection, reconnect loop, subscriptions, and send API.
  - Adds a session-like identifier to the WebSocket URL query string.
- `web/src/App.tsx`
  - Wraps Reader routes with `UCOProvider`.
- `web/src/uco/UCOProvider.tsx`
  - Maintains UCO document state.
  - Subscribes to WebSocket events such as `document.loaded`, `document.cleared`, `document.deleted`, and `agentic.cursor_update`.
- `web/src/ReaderPage.tsx`
  - Uses `useUCODocument` to derive the active document.
  - Sends `document.load` over the WebSocket when a document is opened.
  - Subscribes to legacy `agentic.*` events for cursor, bookmark, note, and document update behavior.
- `web/src/components/reader/NotesPanel.tsx`
  - Subscribes to `agentic.note_added`.
- `web/src/voice/hooks/useTTSPlayback.ts`
  - Sends `agentic.reading_start`, `agentic.reading_line`, and `agentic.reading_end` over the WebSocket.
  - Also updates local playback state through `useReadingPlaybackStore`, so the WebSocket send path appears secondary for Reader Lite.
- `web/src/voice/stores/useVoiceRuntimeStore.ts`
  - Contains WebSocket-oriented fields, but no current code was found setting the send/toggle connection handlers. This supports the conclusion that the Inti AI voice runtime integration is not active in Reader Lite.

## Risk

UCO and the WebSocket bridge are legacy concepts for this product, but deleting them first would be disruptive. Current document opening and restore flows appear to depend on this sequence:

1. Reader opens or restores a document.
2. Client sends `document.load` through `SharedWebSocketContext`.
3. Server bridge responds with `document.loaded`.
4. `UCOProvider` hydrates the active document.
5. `ReaderPage` reads that active document through `useUCODocument`.

If `/api/inti-ws` is removed before a Reader-owned active document path replaces this flow, selecting documents from the picker, restoring the last document, or reacting to document changes may regress.

There are also local-dev and security hygiene concerns:

- The WebSocket reconnect loop creates persistent console noise.
- Local proxy/origin behavior is fragile.
- A session-like identifier is placed in the WebSocket URL query string.
- Legacy `agentic.*` event names obscure which behavior is actually Reader Lite functionality.

## Recommendation

Defer cleanup until the current architecture work is complete, then remove UCO and the legacy WebSocket bridge in stages.

Proposed cleanup sequence:

1. Create a Reader-owned active document provider or hook.
   - Source active document from the route or URL query when present.
   - Restore from scoped local storage when no URL document is present.
   - Fall back to a recent document or welcome state.
   - Expose direct `setActiveDocument` behavior without WebSocket mediation.
2. Update document open and restore flows.
   - Change `DocumentPickerModal` and pending session load paths to set active document directly.
   - Stop sending `document.load` as the primary active document mechanism.
3. Replace WebSocket-driven UI refreshes.
   - Use React Query invalidation, mutation callbacks, or narrow polling for upload, ingest, replace, delete, metadata, bookmark, and note changes.
   - Keep live push only if a concrete Reader Lite multi-tab or collaborative requirement is identified.
4. Remove Reader dependencies on legacy `agentic.*` subscriptions.
   - Audit `agentic.cursor_update`, `agentic.bookmark_added`, `agentic.note_added`, and `agentic.document_updated`.
   - Replace each with direct Reader state or query invalidation.
5. Remove TTS WebSocket sends if no Reader Lite consumer exists.
   - Preserve local read-aloud behavior through `useReadingPlaybackStore`.
   - Drop `agentic.reading_start`, `agentic.reading_line`, and `agentic.reading_end` unless a current product requirement uses them.
6. Remove compatibility providers and server bridge.
   - Remove `SharedWebSocketProvider`.
   - Remove `UCOProvider` and `useUCODocument`.
   - Remove `IntiWsBridge` initialization.
   - Remove `broadcastWsEvent` call sites.
   - Remove or update compatibility smoke checks and docs that assume `/api/inti-ws`.
7. Update local development documentation.
   - Keep `http://localhost:5173` documented as the Reader UI address.
   - Keep `http://localhost:5100/health` documented as the API health endpoint.
   - Remove WebSocket troubleshooting once the bridge is gone.

Optional short-term mitigation before the cleanup:

- Configure `INTI_WS_ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173` for local development, or make the bridge reuse the existing CORS local origin defaults.
- Remove the client-generated session identifier from the WebSocket URL if the socket remains temporarily. Authentication already flows through cookies.

## Acceptance Criteria

- Reader opens a document from the picker without sending `document.load` over a WebSocket.
- Reloading `http://localhost:5173` restores the expected active document through URL, scoped local storage, or a documented fallback.
- Upload, ingest completion, replace, delete, metadata, bookmark, and note flows update the Reader UI without relying on `/api/inti-ws`.
- Read-aloud highlighting and playback state continue to work through local Reader state.
- The browser console no longer shows `/api/inti-ws` reconnect loops during normal local Reader use.
- No session-like identifier is placed in a WebSocket URL.
- `SharedWebSocketProvider`, `UCOProvider`, `IntiWsBridge`, and unused `agentic.*` event paths are removed or explicitly justified.
- Local dev docs and smoke tests are updated to match the post-cleanup architecture.
- Relevant checks pass, including `npm run check:web` and a focused Reader document-open regression test.
