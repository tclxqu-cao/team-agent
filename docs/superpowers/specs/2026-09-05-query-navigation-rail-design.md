# Query Navigation Rail Design

## Goal

Add a shared navigation rail to the WebApp and Electron desktop message viewport. The rail represents every sent user query in the current session. Pointer or touch movement previews a query, and selection opens the page containing that query and scrolls it into view.

The feature must not delay the initial conversation render, download every history page into either renderer, or regress the existing one-page-ahead preload for older history.

## Scope

This design applies to the WebApp and Electron desktop presentation of Customer Agent, Codex, Claude Code, and OpenCode sessions. Both surfaces use the same rail component and history-window state machine; only their HTTP and IPC transports differ.

Included:

- a compact right-edge query rail;
- asynchronous indexing of all sent user messages;
- direct anchored-page retrieval;
- mouse, touch, and keyboard selection;
- bidirectional paging after an anchored jump;
- an explicit return-to-latest action;
- cache invalidation and live-update isolation.

Not included:

- full-text query search;
- assistant-response or tool-call indexing;
- eager download of every history page;
- permanent on-disk index storage;
- general message-list virtualization;
- changes to either surface's header or message controls.

## User Experience

### Resting State

The rail sits inside the message viewport at the far right, separate from the native scrollbar and clear of the composer. It is not added beside the Settings button on either surface.

On pointer devices, the resting rail is a faint narrow affordance. Entering its interaction zone reveals the query ticks. Moving vertically selects the closest query and opens a floating preview beside the rail.

On touch devices, a small edge affordance remains visible because hover is unavailable. Touching the rail opens the preview; dragging changes the selected query; releasing jumps to it. Only the rail interaction zone uses `touch-action: none`, so ordinary message scrolling remains unchanged.

The preview contains the query ordinal and at most three lines of normalized user text. Image-only queries use a short fallback label. It never includes assistant text, tool results, image payloads, internal runtime markers, or queued messages that have not been admitted to history.

### Tick Density

Every query remains selectable, but the DOM never contains one element per query for very long sessions. The rail renders no more than 60 visual tick buckets plus one active marker. Pointer position maps to the complete ordered query index, so aggregated ticks do not reduce selection precision.

The rail height uses 6 CSS pixels per visible tick bucket on Electron. Web keeps its existing 1.2 density scale, yielding 7.2 CSS pixels per bucket before rounding. Both surfaces retain the 32 px minimum and 240 px maximum height, so short histories gain clearer separation without allowing long histories to dominate the viewport.

The selected query uses the longer high-contrast marker shown by the reference. The rail stays hidden when the session has fewer than two indexed user queries.

### Selection And Navigation

Selecting an already rendered query scrolls directly to its message row.

Selecting an unloaded query requests the indexed anchor page, replaces the visible history with that contiguous page window, then scrolls to the row carrying the matching message ID. The UI shows a compact return-to-latest control while an anchored window is active.

Scrolling near the top of an anchored window loads its older neighbor. Scrolling near the bottom loads its newer neighbor. Sending a new query first returns the conversation to the latest window, then follows the existing send flow.

## Lightweight Query Index

### Index Shape

The Web server exposes an HTTP endpoint for the current session's query index:

```text
GET /api/sessions/:id/query-index
```

The response contains only compact navigation data:

```ts
interface SessionQueryIndex {
  sessionId: string;
  revision: string;
  totalQueries: number;
  entries: Array<{
    messageId: string;
    ordinal: number;
    preview: string;
    pageToken: string;
  }>;
}
```

`preview` is whitespace-normalized and length-limited. `pageToken` is opaque to the client and identifies a turn-aligned page window containing the target query. The token includes enough revision identity for the server to reject a stale lookup rather than return the wrong location.

The index uses the same normalized, reconciled user/assistant timeline that history pagination uses. Repeated query text remains distinct because identity comes from ordered message IDs, not content matching.

### Asynchronous Warmup

The first latest-page request remains the critical path and returns as it does today. Once that request has produced the complete server-side session detail, the server records or refreshes the compact query index in a bounded in-memory LRU cache.

Electron exposes the same operation through a `sessions:getQueryIndex` IPC handler and preload method. Its existing `sessions:get` IPC query accepts the same opaque anchor token as the Web route. HTTP and IPC responses share the same domain types and validation rules.

After the first history paint, each renderer requests the query index during idle time. It cancels the request when the selected session changes. Renderers store only compact entries, not historical assistant or tool data.

For the current adapters this avoids a second conceptual full-history operation: Customer Agent, Codex, Claude Code, and OpenCode already form a complete unified message list before the shared route slices the latest history page. Index extraction piggybacks on that normalized list.

The Web server and Electron main process each keep their own bounded cache because they are separate hosts. Both use the same cache implementation and key entries by session identity plus a history revision fingerprint. A changed revision invalidates the cached index. Newly sent user messages may be appended optimistically to the renderer index, but the host revision remains authoritative.

## Anchored History Pages

The existing latest and older-page contract stays backward compatible:

```text
GET /api/sessions/:id?before=<cursor>&limit=50
```

An indexed jump adds an anchor request:

```text
GET /api/sessions/:id?anchor=<pageToken>&limit=50
```

An anchored response contains the complete turn around the selected user message and returns:

- `olderCursor` for the contiguous page above;
- `newerCursor` for the contiguous page below;
- `nextCursor` as the existing older-cursor compatibility field;
- a window kind of `anchored` rather than `latest`.

Page boundaries continue to expand to user-message turn boundaries. Tool results remain attached only to tool calls in the returned page. Cursor offsets are validated against the current normalized history, and invalid or stale anchor tokens fail closed.

The renderer never concatenates an anchored page directly with the latest page when pages between them are missing. It displays one contiguous window and adds adjacent pages only through the matching older or newer cursor.

## Existing Older-Page Prefetch Invariant

Normal latest-window behavior remains unchanged:

```text
latest page accepted
  -> prefetch its older cursor
  -> consume that exact cached page near the top
  -> prefetch the next older cursor
```

An indexed jump is isolated from that path:

```text
query selected
  -> invalidate the current prefetch slot
  -> fetch the anchor page independently
  -> accept only if session and index revision still match
  -> bind the unchanged older-page prefetcher to anchor.olderCursor
```

`SinglePageHistoryPrefetch` remains keyed by session ID and cursor. Its existing invalidation behavior means an in-flight stale request may finish at the transport layer, but its result cannot be consumed into the new window. The anchor request uses a separate request slot and never overwrites `historyCursorRef` before it is accepted.

Returning to latest performs the current latest-page request, resets anchored-window state, and resumes the original older-page preload sequence. The navigation feature must not increase the normal prefetch depth beyond one page.

## Live Updates And Races

Latest-window reconciliation continues unchanged while the user is browsing the latest page.

While an anchored window is active, session-change notifications do not merge a refreshed latest page into the visible window. They mark that newer content exists and expose the return-to-latest control. This prevents a non-contiguous history merge and preserves the selected scroll position.

Every index and page response is checked against:

- the selected session ID;
- the request generation;
- the query-index revision where applicable;
- the active history-window mode.

A stale anchor response is ignored. A server stale-token response refreshes the query index and retries the selection once. A second mismatch leaves the current conversation visible and allows another user attempt.

Session switching aborts outstanding index and anchor requests, clears the preview, invalidates the page prefetch slot, and restores the existing selected-session load behavior.

## Component Boundaries

The implementation should keep navigation mechanics out of the already large `ChatView` body:

- `SessionQueryIndex` domain helpers build compact entries and anchored page tokens from the normalized timeline.
- The Server session routes own HTTP index delivery, cache lookup, token validation, and anchored pagination.
- Electron main owns the matching IPC handlers and uses the same index, cache, and pagination helpers.
- The Web gateway and Electron preload expose matching query-index and anchor request methods through the existing `agentApi` boundary.
- `QueryNavigationRail` owns pointer, touch, keyboard, tick aggregation, and preview rendering.
- `ChatView` owns history-window state, request generations, page acceptance, and the final scroll-to-message action.

Rendered message groups receive a stable `data-message-id`. After an anchor page is committed, a layout effect finds the selected row inside `messagesScrollRef` and scrolls it into view without changing page scroll.

The rail is available on both surfaces when the query-index API method exists. A host that does not advertise the method keeps the current history UI without a disabled or misleading rail.

## Accessibility

The interaction zone is keyboard focusable and exposes a discrete slider contract with the current query ordinal and total. Arrow keys move one query, Page Up/Down move a larger step, Home/End select the first or latest query, and Enter activates the selected query.

The visible rail remains narrow, but its hit area is at least 24 CSS pixels on pointer layouts and 32 CSS pixels on touch layouts. Focus treatment uses the existing semantic accent and focus tokens. Preview text does not cover the rail or composer and remains within the mobile viewport.

## Error Handling

- Index warmup failure does not affect conversation loading. The rail stays unavailable and retries on the next session revision or explicit interaction.
- Anchor-page failure keeps the current window and selection visible.
- An index with no valid sent user messages hides the rail.
- A removed or compacted anchor returns a stale-token response; the client refreshes once instead of guessing by text.
- Older-page preload failures preserve the current retry behavior and cursor.
- Newer-page failures in anchored mode preserve the current anchored window and can be retried by scrolling again.

## Performance Constraints

- No query-index request blocks initial history paint.
- No assistant content, tool result, event payload, or image data appears in the query-index response.
- The rail renders at most 60 tick buckets regardless of query count.
- Pointer movement updates only rail selection and one preview, not the message collection.
- Index extraction is linear in the already normalized message list and cached by revision.
- Web server and Electron main query-index caches are bounded and evicted by the same LRU policy.
- The existing history page size and one-page older prefetch depth remain unchanged.

## Testing

### Domain And Server

- Index entries preserve duplicate query text as separate ordered IDs.
- Image-only, blank, internal, queued, and normal user messages follow the preview and inclusion rules.
- Every page token resolves to a turn-aligned page containing its target query.
- Anchored pages return correct older and newer cursors without gaps or overlap.
- Appending history invalidates the old revision and stale tokens.
- Customer Agent and all native runtime session routes return the same index contract.
- LRU eviction and cache-hit behavior do not change page contents.

### Renderer

- Initial history rendering completes without waiting for the index request.
- Pointer hover, click, drag, touch release, and keyboard activation select the intended query.
- More than 60 queries produce bounded tick DOM while every ordinal remains selectable.
- An already rendered query scrolls without a page request.
- An unloaded query uses one anchor request and scrolls after render.
- An indexed jump invalidates a previous in-flight prefetch and starts the older prefetch from the accepted anchor page.
- Returning to latest restores the existing latest-page and older-page preload sequence.
- Live refresh while anchored shows a latest-content affordance and does not merge discontinuous pages.
- Switching sessions prevents stale index, anchor, and prefetch responses from changing the new session.

### Surface Acceptance

Use the project-required browser workflow to verify desktop Web, `390x844`, and `320x700` layouts, and verify the shared renderer in an Electron desktop window. Confirm:

- the collapsed rail does not cover message actions, the native scrollbar, or the composer;
- hover and touch dragging show the correct preview and selected marker;
- releasing on an unloaded query performs a direct anchor request rather than sequential older-page requests;
- the target user row is visible after the page renders;
- normal upward scrolling still consumes the existing prefetched older page;
- returning to latest resumes live updates and keeps the composer usable;
- the page has no horizontal overflow or incoherent overlap.

Run focused Core pagination, Server route, Electron IPC/preload, Web gateway, renderer history/prefetch, and rail interaction tests, followed by affected TypeScript checks, WebApp and Electron production builds, and `git diff --check`.
