# Empty Older History Loading Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop repeated older-history loading when a session has no earlier messages without disrupting valid prefetch and pull-to-load pagination.

**Architecture:** Add a pure cursor-normalization helper beside the existing history paging utilities, then use it at the older-page response boundary in `ChatView`. Keep prefetch behavior driven by the normalized non-null cursor.

**Tech Stack:** TypeScript, React, Vitest

## Global Constraints

- Preserve the current single-page prefetch cache and pull gesture behavior.
- Stop only on explicit exhaustion or an empty page that repeats its request cursor.
- Preserve unrelated uncommitted changes in the shared files.

---

### Task 1: Older-History Cursor Normalization

**Files:**
- Modify: `packages/desktop/renderer/lib/session-history.ts`
- Unit tests: `packages/desktop/renderer/lib/session-history.test.ts`

**Interfaces:**
- Consumes: requested cursor, `SessionHistoryDetail`, restored visible message count
- Produces: `resolveOlderHistoryCursor(requestCursor, detail, restoredMessageCount): string | null`

- [ ] **Step 1: Add the pure cursor-normalization helper**

Return `null` for `hasMore: false`, a missing next cursor, or an empty response that repeats the requested cursor. Otherwise return the response cursor.

- [ ] **Step 2: Add focused unit tests**

Cover explicit exhaustion, repeated empty cursor, advanced empty cursor, and a populated page with a valid cursor.

### Task 2: Chat History Integration

**Files:**
- Modify: `packages/desktop/renderer/components/ChatView.tsx`
- Unit tests: `packages/desktop/renderer/components/ChatHistoryStyle.test.ts`

**Interfaces:**
- Consumes: `resolveOlderHistoryCursor` from Task 1
- Produces: a null `historyCursorRef` at the beginning of history, preventing repeat requests and prefetches

- [ ] **Step 1: Normalize the older-page response cursor**

Use the request cursor, response metadata, and restored message count before updating `historyCursorRef` and invoking `prefetchOlderHistory`.

- [ ] **Step 2: Assert the integration hook**

Extend the existing history-loading source test to confirm `ChatView` uses `resolveOlderHistoryCursor`.

## Final Unit Test Verification

- [ ] **Main agent: run affected unit tests after development is complete**

Run: `bunx vitest run packages/desktop/renderer/lib/session-history.test.ts packages/desktop/renderer/components/ChatHistoryStyle.test.ts`

Expected: PASS
