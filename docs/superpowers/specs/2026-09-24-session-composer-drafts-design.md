# WebApp Session Composer Drafts Design

## Problem

`ChatView` keeps the visible composer text and pending images in component state. The existing session draft synchronization runs only for native runtimes and persists only text, so switching sessions can leave the previous session's unsent text visible while dropping its pending images. Native queued messages can also return to the composer because their preserved draft is normally cleared by `run_admitted`, but directly queued messages do not emit that event.

## Design

- Use the existing unified session ID as the draft ownership key for every existing session, regardless of agent type.
- Reuse `session-draft.ts` and its localStorage-backed read, write, and clear operations for text.
- Store normalized image data URLs in a dedicated IndexedDB object store keyed by unified session ID. Do not put image data in localStorage.
- When the selected session changes, restore that session's saved text or an empty string before persisting further input.
- On session change, immediately clear visible pending images, then asynchronously restore the target session's image draft. A selection generation guard prevents a late read from an earlier session overwriting the current session.
- When text changes without a session change, persist it only under the currently viewed session ID.
- When pending images change without a session change, persist them only under the currently viewed session ID.
- When a message is accepted into the durable or local message queue, clear that session's text and image drafts immediately. The queued message remains visible only in the queue above the composer.
- If durable queue persistence fails, restore the submitted text and images to the composer and draft stores.
- Keep `pendingNativeSendPayloadRef` as the source for `SESSION_OCCUPIED` recovery so clearing an accepted draft does not lose failed-send recovery.
- Keep attachments, message routing, runtime selection, and new-session creation behavior unchanged.

## Failure Handling

Storage failures remain non-fatal. localStorage failure keeps the visible text usable. IndexedDB unavailability keeps pending images usable for the current view but cannot promise image recovery after switching or refreshing; failures must not erase a newer visible draft.

## Verification

- Add focused tests proving Customer Agent and native text and image drafts cannot cross-contaminate.
- Cover IndexedDB write/read/delete behavior, switching to a session without a draft, refresh restoration, and stale asynchronous read rejection.
- Verify successful durable and local queue admission clears only the accepted session draft while queue failure restores text and images.
- Retain `SESSION_OCCUPIED` recovery coverage.
- Run the affected renderer tests and the WebApp production build.
