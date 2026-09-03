# Session History Single-Page Prefetch Design

## Goal

Make upward history navigation feel immediate without changing the existing session pagination contract. After the latest history page renders, the client prefetches exactly one older page. Consuming that page immediately starts prefetching the next older page.

## Scope

- Apply to the shared `ChatView` used by Electron and Web.
- Keep the existing `before + limit` API and the 50-visible-message page size.
- Keep the existing top-240px render trigger, scroll anchoring, delayed loading indicator, and retry UI.
- Do not add cross-session or multi-page caching.

## Design

Introduce a small renderer-side single-page prefetch coordinator. Its cache slot is keyed by `sessionId + cursor` and contains the one shared request Promise plus its eventual page result.

The coordinator exposes three operations:

1. `prefetch(sessionId, cursor, loader)` starts a request only when the current slot does not already represent that page. It never starts a second request for the same page.
2. `consume(sessionId, cursor, loader)` returns the cached result, awaits the existing prefetch Promise, or starts the request itself when no valid slot exists.
3. `invalidate()` makes the current slot unusable. A late response may settle its Promise but cannot become valid for a later session or cursor.

`ChatView` performs the following flow:

1. Load and render the latest 50 messages.
2. Set the older-history cursor and immediately prefetch that page when a cursor exists.
3. When scrolling reaches the existing 240px threshold, consume the prefetched page. If prefetch is still running, foreground loading waits for the same Promise instead of sending another request.
4. Prepend the consumed page, preserve the scroll anchor, advance the cursor, then immediately prefetch the next older page.
5. Invalidate the slot when the selected session is cleared, switched, explicitly reloaded, or when a latest-history refresh changes the cursor that has not yet been consumed.

Only one older page is retained. Consuming or replacing the slot releases the previous result for garbage collection.

## Failure Behavior

Background prefetch failures are logged and do not display UI while the user is reading the current page. The failed slot is cleared so a later foreground consume can retry. If the user reaches the render threshold while that same request is in flight, `consume` awaits it; a failure then uses the existing older-history error and retry UI.

Session and cursor checks remain mandatory after every await. Stale results never update messages, cursors, loading state, or errors for a newly selected session.

## Verification

- Unit-test cache hits, shared in-flight requests, foreground fallback, one-slot replacement, invalidation, and retry after rejection.
- Extend the `ChatView` source contract test to assert initial/next-page prefetch and consumption through the coordinator.
- Run focused renderer tests and Desktop/Web TypeScript checks.
- Rebuild and restart the production `:3000` instance, then verify health and the served bundle.
