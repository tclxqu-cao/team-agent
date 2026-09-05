# Query Navigation Rail Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a low-overhead right-edge navigator that lets WebApp and Electron users jump directly to any sent user query, including queries outside the currently loaded history page.

**Architecture:** Core owns compact query-index creation, revision-bound opaque anchors, and contiguous older/anchor/newer pagination. Server HTTP and Electron IPC expose matching contracts over bounded host-side caches, while the shared renderer owns the navigation rail and switches between latest and anchored history windows without changing the existing latest-window one-page prefetch sequence.

**Tech Stack:** TypeScript, React 18, Next.js route handlers, Electron IPC/context bridge, Vitest, existing Zustand message store and CSS tokens.

## Global Constraints

- Initial history paint must not wait for query-index loading.
- Query-index responses contain only message ID, ordinal, preview, page token, session ID, revision, and total count.
- Render at most 60 visual tick buckets while preserving access to every query ordinal.
- Keep the existing history page size of 50 and latest-window older-history prefetch depth of exactly one page.
- Pointer movement updates only rail state; touch handling is confined to the rail hit area; keyboard behavior uses a discrete slider contract.
- Anchored pages are contiguous and may grow only via their older and newer cursors; live latest data is never merged into a discontinuous anchored window.
- A stale anchor fails closed, refreshes the index, and retries selection at most once.
- WebApp and Electron use the same renderer component and domain types; only HTTP and IPC transports differ.

---

### Task 1: Core Query Index And Anchored Pagination

**Files:**
- Modify: `packages/core/src/domain/model/entities.ts`
- Modify: `packages/core/src/domain/session/entities.ts`
- Modify: `packages/core/src/domain/session/SessionHistory.ts`
- Modify: `packages/core/src/domain/session/index.ts`
- Create: `packages/core/src/domain/session/SessionQueryIndex.ts`
- Create: `packages/core/src/domain/session/SessionQueryIndex.test.ts`
- Modify: `packages/core/src/domain/session/SessionHistory.test.ts`

**Interfaces:**
- Consumes: normalized `Message[]`, `AgentEvent[]`, `SessionHistoryQuery`.
- Produces: `buildSessionQueryIndex(sessionId, messages)`, revision-bound `SessionQueryIndex`, `StaleSessionAnchorError`, and `paginateSessionHistory` responses with `olderCursor`, `newerCursor`, `kind`, and `revision`.

- [ ] **Step 1: Extend the shared history contracts**

Add optional `historyId` to `Message`; add `anchor` and `after` to `SessionHistoryQuery`; define `SessionQueryIndexEntry`, `SessionQueryIndex`, and enriched history-window fields while preserving `nextCursor` and `hasMore`.

- [ ] **Step 2: Implement compact indexing and opaque revision-bound tokens**

```ts
const index = buildSessionQueryIndex(sessionId, messages);
// index.entries[n] = { messageId, ordinal: n + 1, preview, pageToken }
```

Normalize whitespace, cap preview length, use an image-only fallback, exclude internal boundary messages, derive a deterministic lightweight revision, and encode the target visible-message offset in a token that rejects revision mismatches.

- [ ] **Step 3: Implement turn-aligned anchor and forward windows**

Support existing latest/backward paging unchanged, `anchor` for the target-containing window, and `after` for its contiguous newer neighbor. Decorate selected visible messages with the same stable `historyId` used by the index.

- [ ] **Step 4: Add focused domain tests**

Cover duplicate query text, blank/image/internal messages, stale anchors, target containment, non-overlapping bidirectional cursors, append-triggered revisions, and existing backward pagination compatibility.

### Task 2: Bounded Host Cache And Transport Contracts

**Files:**
- Create: `packages/core/src/domain/session/SessionQueryIndexCache.ts`
- Create: `packages/core/src/domain/session/SessionQueryIndexCache.test.ts`
- Modify: `packages/core/src/domain/session/index.ts`
- Modify: `packages/desktop/main/agent-runtime/types.ts`
- Modify: `packages/desktop/main/agent-runtime/unified-session-service.ts`
- Modify: `packages/desktop/main/agent-runtime/native-runtime-broker.ts`
- Modify: `packages/server/lib/native-runtime-service.ts`
- Create: `packages/server/app/api/sessions/[id]/query-index/route.ts`
- Create: `packages/server/app/api/sessions/[id]/query-index/route.test.ts`
- Modify: `packages/server/app/api/sessions/[id]/route.ts`

**Interfaces:**
- Consumes: complete normalized session details already cached by native runtime services.
- Produces: bounded revision-aware cache, `getQueryIndex(id)`, `GET /api/sessions/:id/query-index`, and anchor/after support on the existing detail route.

- [ ] **Step 1: Add the bounded revision-keyed LRU cache**

```ts
const cache = new SessionQueryIndexCache(24);
cache.getOrCreate(sessionId, messages);
```

Refresh an entry when its computed revision changes, promote hits, and evict the least recently used session without retaining full message arrays.

- [ ] **Step 2: Reuse complete native details for index extraction**

Add a query-index operation through unified runtime and broker boundaries so a post-paint request consumes the already warmed complete-detail cache instead of downloading or parsing history pages sequentially.

- [ ] **Step 3: Expose HTTP index and anchor contracts**

Parse `anchor`, `after`, `before`, and `limit`; return a deterministic stale-token error code/status and preserve old clients that send only `before`/`limit`.

- [ ] **Step 4: Add route and cache tests**

Verify Customer Agent/native parity, compact response shape, stale-token failure, cache hits/eviction, and unchanged page contents.

### Task 3: Electron And Web Gateway APIs

**Files:**
- Modify: `packages/desktop/main/index.ts`
- Modify: `packages/desktop/main/preload.ts`
- Modify: `packages/desktop/renderer/global.d.ts`
- Modify: `packages/webapp/src/infrastructure/http/agent-http-gateway.ts`
- Modify: `packages/webapp/src/infrastructure/http/agent-http-gateway.test.ts`

**Interfaces:**
- Consumes: host `getQueryIndex(id)` and extended `SessionHistoryQuery`.
- Produces: `window.agentApi.getSessionQueryIndex(id)` and `getSession(id, { anchor?, before?, after?, limit? })` on both surfaces.

- [ ] **Step 1: Register Electron IPC and preload methods**

Add `sessions:getQueryIndex`, pass anchor/after through `sessions:get`, and declare the exact shared return/query types in the renderer global boundary.

- [ ] **Step 2: Add the Web HTTP gateway method**

Request `/api/sessions/:id/query-index`; forward `anchor` and `after` without changing retry behavior for ordinary detail GETs.

- [ ] **Step 3: Add focused gateway and IPC contract tests**

Assert URL encoding, compact index parsing, and independent anchor requests.

### Task 4: Shared Query Navigation Rail

**Files:**
- Create: `packages/desktop/renderer/components/QueryNavigationRail.tsx`
- Create: `packages/desktop/renderer/components/QueryNavigationRail.test.tsx`
- Modify: `packages/desktop/renderer/styles/global.css`
- Modify: `packages/webapp/src/presentation/web.css`

**Interfaces:**
- Consumes: `entries`, active message ID, and `onActivate(entry)`.
- Produces: an accessible right-edge slider with no more than 60 tick buckets, hover/drag preview, touch-release activation, and keyboard selection.

- [ ] **Step 1: Implement bounded tick and position mapping helpers**

```ts
const index = Math.round(clamp01(pointerRatio) * (entries.length - 1));
const tickCount = Math.min(entries.length, 60);
```

Keep full query precision independent of rendered tick count.

- [ ] **Step 2: Implement pointer, touch, and keyboard behavior**

Use pointer capture, activate mouse clicks and touch releases, and support Arrow, Page Up/Down, Home/End, and Enter with slider ARIA metadata.

- [ ] **Step 3: Style the restrained edge affordance**

Use existing semantic color, type, focus, and surface tokens. Keep the idle rail faint, expand only its query ticks on hover/focus/drag, reserve 24 px pointer and 32 px touch hit areas, and constrain the three-line preview inside 320 px screens.

- [ ] **Step 4: Add component interaction tests**

Cover tick bounds, pointer mapping, touch release, keyboard activation, hidden state below two queries, and preview fallback.

### Task 5: Renderer History-Window State Machine

**Files:**
- Modify: `packages/desktop/renderer/lib/session-history.ts`
- Create: `packages/desktop/renderer/lib/query-navigation.ts`
- Create: `packages/desktop/renderer/lib/query-navigation.test.ts`
- Modify: `packages/desktop/renderer/components/ChatView.tsx`
- Modify: `packages/desktop/renderer/lib/session-history-prefetch.test.ts`

**Interfaces:**
- Consumes: `getSessionQueryIndex`, anchor/older/newer page contracts, existing `SinglePageHistoryPrefetch`.
- Produces: idle index warmup, latest/anchored window transitions, scroll-to-message, adjacent paging, latest-content affordance, and stale-response guards.

- [ ] **Step 1: Preserve durable history IDs during restoration**

Map `Message.historyId` into `ChatMessage.id` so index entries and rendered rows share stable identity; retain random IDs only for legacy responses.

- [ ] **Step 2: Load the query index after first paint**

Schedule the request with `requestIdleCallback` plus a short timeout fallback, cancel/generation-guard it on session switch, and never join it to initial page loading.

- [ ] **Step 3: Implement anchored selection and retry**

Scroll directly when the row already exists. Otherwise invalidate the old prefetch slot, request one anchor page, accept only matching session/generation/revision, retry once after a stale-token index refresh, then scroll after layout.

- [ ] **Step 4: Add bidirectional anchored paging**

Near the top consume the unchanged one-page older prefetch path from `olderCursor`; near the bottom request `after: newerCursor`, append without gaps, and update cursors without merging latest data.

- [ ] **Step 5: Isolate live updates and sending**

While anchored, mark newer content available rather than reconciling the latest page. The return control reloads latest and restores the original prefetch sequence; sending first returns to latest.

- [ ] **Step 6: Render stable row anchors and the rail**

Set `data-message-id` on message groups, mount `QueryNavigationRail` inside the message viewport, and show an icon-led compact return-to-latest control only in anchored mode.

- [ ] **Step 7: Add state/race tests**

Cover non-blocking warmup, loaded/unloaded selection, prefetch invalidation, stale response rejection, live-update isolation, return-to-latest, and session switching.

### Task 6: Verification And Production Release

**Files:**
- Verify only: affected packages and production runtime assets.

**Interfaces:**
- Consumes: completed implementation and project release skills.
- Produces: passing tests/typechecks/builds, responsive UI evidence, and a stable production process on port 3000.

- [ ] **Step 1: Run focused tests and static checks**

Run the Core history/index/cache, Server routes, native service/broker, gateway, renderer history/prefetch/navigation, rail, and existing browser composer tests. Run affected TypeScript checks and `git diff --check`; fix and rerun until green.

- [ ] **Step 2: Build all affected production targets**

Build Core, WebApp, Server with the required Node 22 ABI, and Electron desktop. Preserve unrelated generated worktree changes.

- [ ] **Step 3: Verify Web and desktop surfaces**

Use the required ego-browser workflow at desktop, `390x844`, and `320x700`; verify the shared renderer in Electron, interaction modes, direct anchor request, scroll target, prefetch continuity, return-to-latest, overflow, and composer access.

- [ ] **Step 4: Release and verify `:3000`**

Follow `production-readiness-check` and `customer-agent-webapp-release`: rebuild/restart the launchd-managed production instance, verify process stability and health endpoints, then confirm the live page serves the new bundle and behavior.

## Final Unit Test Verification

- [ ] **Main agent: run affected unit tests after development is complete**

Run: `bunx vitest run packages/core/src/domain/session/SessionHistory.test.ts packages/core/src/domain/session/SessionQueryIndex.test.ts packages/core/src/domain/session/SessionQueryIndexCache.test.ts packages/server/app/api/sessions/[id]/query-index/route.test.ts packages/webapp/src/infrastructure/http/agent-http-gateway.test.ts packages/desktop/renderer/lib/session-history.test.ts packages/desktop/renderer/lib/session-history-prefetch.test.ts packages/desktop/renderer/lib/query-navigation.test.ts packages/desktop/renderer/components/QueryNavigationRail.test.tsx`

Expected: PASS

If a test fails, fix the implementation or test and rerun this command until it passes. Report the command and result in the final response.
