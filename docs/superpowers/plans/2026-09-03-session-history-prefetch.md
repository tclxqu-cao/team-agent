# Session History Single-Page Prefetch Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prefetch exactly one older session-history page so upward scrolling can render cached history immediately or await the already-running request without issuing a duplicate.

**Architecture:** A renderer-only generic coordinator owns one `sessionId + cursor` Promise slot. Shared Electron/Web `ChatView` primes the slot after every rendered history page and consumes the same slot at the existing top threshold while retaining current scroll anchoring and error UI.

**Tech Stack:** TypeScript, React 18 hooks, Vitest, Electron renderer shared by the Vite Web application.

## Global Constraints

- Keep the existing `before + limit` session API unchanged.
- Keep `SESSION_HISTORY_PAGE_SIZE = 50` and the existing `scrollTop <= 240` render trigger.
- Cache at most one older page and never start two requests for the same `sessionId + cursor`.
- Preserve all unrelated dirty-worktree changes in `ChatView.tsx`.

---

### Task 1: Single-Page Prefetch Coordinator

**Files:**
- Create: `packages/desktop/renderer/lib/session-history-prefetch.ts`
- Unit tests: `packages/desktop/renderer/lib/session-history-prefetch.test.ts`

**Interfaces:**
- Consumes: a zero-argument `loader: () => Promise<T>` supplied by `ChatView`.
- Produces: `SinglePageHistoryPrefetch<T>` with `prefetch(sessionId: string, cursor: string, loader: () => Promise<T>): Promise<T>`, `consume(sessionId: string, cursor: string, loader: () => Promise<T>): Promise<T>`, and `invalidate(): void`.

- [x] **Step 1: Add the one-slot coordinator**

```ts
interface PrefetchSlot<T> {
  sessionId: string;
  cursor: string;
  promise: Promise<T>;
}

export class SinglePageHistoryPrefetch<T> {
  private slot: PrefetchSlot<T> | null = null;

  prefetch(sessionId: string, cursor: string, loader: () => Promise<T>): Promise<T> {
    return this.getOrStart(sessionId, cursor, loader).promise;
  }

  async consume(sessionId: string, cursor: string, loader: () => Promise<T>): Promise<T> {
    const slot = this.getOrStart(sessionId, cursor, loader);
    try {
      return await slot.promise;
    } finally {
      if (this.slot === slot) this.slot = null;
    }
  }

  invalidate(): void {
    this.slot = null;
  }
}
```

`getOrStart` must reuse an exact key match, replace a different key, and attach a rejection handler that clears only the slot belonging to that failed Promise. Replacing or invalidating a slot must make its late settlement harmless.

- [x] **Step 2: Cover mutual exclusion and invalidation**

```ts
it("shares an in-flight prefetch with foreground consumption", async () => {
  let resolve!: (value: string) => void;
  const pending = new Promise<string>((done) => { resolve = done; });
  const loader = vi.fn(() => pending);
  const cache = new SinglePageHistoryPrefetch<string>();
  void cache.prefetch("session-1", "cursor-1", loader);
  const consumed = cache.consume("session-1", "cursor-1", loader);
  expect(loader).toHaveBeenCalledTimes(1);
  resolve("page");
  await expect(consumed).resolves.toBe("page");
});
```

Also test resolved-cache reuse, foreground start when empty, one-slot replacement, explicit invalidation, and a new request after rejection.

### Task 2: Shared Chat History Integration

**Files:**
- Modify: `packages/desktop/renderer/components/ChatView.tsx:20-30`
- Modify: `packages/desktop/renderer/components/ChatView.tsx:479-496`
- Modify: `packages/desktop/renderer/components/ChatView.tsx:875-1064`
- Modify: `packages/desktop/renderer/components/ChatView.tsx:1141-1188`
- Unit tests: `packages/desktop/renderer/components/ChatHistoryStyle.test.ts`

**Interfaces:**
- Consumes: `SinglePageHistoryPrefetch<SessionHistoryDetail | null>` from Task 1 and `window.agentApi.getSession(id, { before, limit })`.
- Produces: immediate one-page prefetch after initial render and each successful prepend, with foreground loading consuming the shared request.

- [x] **Step 1: Create the coordinator and prefetch callback**

```ts
const historyPrefetchRef = useRef<SinglePageHistoryPrefetch<SessionHistoryDetail | null> | null>(null);
if (!historyPrefetchRef.current) {
  historyPrefetchRef.current = new SinglePageHistoryPrefetch<SessionHistoryDetail | null>();
}

const prefetchOlderHistory = useCallback((sessionId: string, cursor: string | null) => {
  if (!cursor || !window.agentApi) return;
  void historyPrefetchRef.current!
    .prefetch(sessionId, cursor, () => window.agentApi!.getSession(sessionId, {
      before: cursor,
      limit: SESSION_HISTORY_PAGE_SIZE,
    }) as Promise<SessionHistoryDetail | null>)
    .catch((error) => console.warn("[chat] failed to prefetch older history", { sessionId, error }));
}, []);
```

- [x] **Step 2: Prime and invalidate the slot at cursor ownership changes**

Invalidate before resetting a selected session's history state and when clearing selection. After the initial page assigns `historyCursorRef.current`, invoke `prefetchOlderHistory(targetSid, nextCursor)`. When `refreshLatestHistory` changes the still-unconsumed latest cursor, invalidate the old slot and prefetch the replacement cursor; do not disturb a cursor that has already advanced into older pages.

- [x] **Step 3: Consume the shared request and chain the next prefetch**

```ts
const detail = await historyPrefetchRef.current!.consume(
  targetSid,
  cursor,
  () => window.agentApi!.getSession(targetSid, {
    before: cursor,
    limit: SESSION_HISTORY_PAGE_SIZE,
  }) as Promise<SessionHistoryDetail | null>,
);
```

Keep the existing post-await session checks, scroll-height anchor capture, `nextAutoScrollRef = "skip"`, cursor update, prepend, delayed foreground indicator, and retry error behavior. Immediately call `prefetchOlderHistory(targetSid, nextCursor)` after advancing the cursor.

- [x] **Step 4: Extend the source contract test**

Assert that `ChatView` imports `SinglePageHistoryPrefetch`, calls `.prefetch(` after cursor assignment, and calls `.consume(` in `loadOlderHistory`, while retaining `scrollTop <= 240`, `before: cursor`, and the absolute-position page status.

### Task 3: Production Verification and Restart

**Files:**
- Read: `package.json`, `packages/desktop/package.json`, `packages/webapp/package.json`
- Read: `/Users/caoqu/.obsidian/wiki/skills/hot/customer-agent-webapp-release/SKILL.md`

**Interfaces:**
- Consumes: passing renderer tests and TypeScript checks from Tasks 1-2.
- Produces: rebuilt shared Web bundle and a healthy restarted `:3000` launchd service.

- [x] **Step 1: Build the affected applications**

Run Desktop and Web type-checks, then build the shared Web renderer used by the production `:3000` instance. Preserve the production Node 22 / `better-sqlite3` ABI boundary described by the release skill; renderer-only changes do not require rebuilding Next or switching the native module ABI.

- [x] **Step 2: Restart and verify production**

Follow `customer-agent-webapp-release` exactly: rebuild the necessary artifacts, restart the launchd-owned `:3000` process, and verify stable PID plus HTTP health endpoints and served-bundle markers.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run: `bun test packages/desktop/renderer/lib/session-history-prefetch.test.ts packages/desktop/renderer/lib/session-history.test.ts packages/desktop/renderer/components/ChatHistoryStyle.test.ts`

Expected: PASS

If a test fails, fix the implementation or test and rerun this command until it passes. Report the command and result in the final response.
