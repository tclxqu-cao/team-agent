# Session Load Recovery Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover cleanly when the first history request after creating a Codex session copy is interrupted, while guaranteeing that the browser loads only the latest 50 visible messages and fetches older history on upward scroll.

**Architecture:** Keep the non-idempotent fork POST unchanged. Wrap only the initial session-detail GET in a small renderer utility that retries recognized transport failures with bounded backoff, then expose an explicit reload action if all attempts fail.

**Tech Stack:** TypeScript, React 18, Vitest.

## Global Constraints

- Never retry `forkSession`; one user action must create at most one copy.
- Retry only browser transport failures such as Safari `Load failed` and Chromium `Failed to fetch`.
- Preserve API errors and their existing messages without retrying.
- Initial copy detail requests must include `{ limit: 50 }`; older pages continue through the existing opaque cursor.
- Preserve all unrelated in-progress changes in `ChatView.tsx`.

---

### Task 1: Bounded Session History Retry

**Files:**
- Create: `packages/desktop/renderer/lib/session-load-recovery.ts`
- Create: `packages/desktop/renderer/lib/session-load-recovery.test.ts`
- Modify: `packages/desktop/renderer/components/ChatView.tsx`

**Interfaces:**
- Consumes: a zero-argument async session detail loader.
- Produces: `loadSessionWithRetry<T>()`, `isSessionTransportError()`, and `describeSessionLoadError()`.

- [x] **Step 1: Add the transport-error classifier and bounded retry utility**

Implement three attempts with short increasing delays. Accept an injected sleep function in tests so retry behavior is deterministic and fast.

- [x] **Step 2: Cover retry and no-retry behavior**

Test Safari and Chromium network messages, success after transient failures, final failure after the attempt limit, and immediate propagation of ordinary API errors. Keep a source-level contract test that the fork recovery path never calls `forkSession` during reload and initial history continues to request `limit: 50`.

- [x] **Step 3: Integrate initial session loading**

Use the utility only around `getSession(..., { limit: 50 })`. Track whether the visible error belongs to initial history loading and add a `重新加载` button that increments a reload generation without invoking `forkSession`.

- [x] **Step 4: Preserve stale-response protection**

Keep the existing session selection generation checks so delayed retries cannot write data into a newly selected session.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run: `bunx vitest run packages/desktop/renderer/lib/session-load-recovery.test.ts packages/desktop/renderer/lib/occupied-session-fork.test.ts packages/desktop/renderer/components/ChatHistoryStyle.test.ts`

Expected: PASS. Then run `bunx tsc --noEmit -p packages/desktop/tsconfig.json` and `bunx tsc --noEmit -p packages/webapp/tsconfig.json`.

Verified: 27 focused renderer tests passed; 14 web gateway/core pagination tests passed; 20 server native-runtime tests passed under Node 22; desktop and webapp type checks passed; the webapp production build passed.
