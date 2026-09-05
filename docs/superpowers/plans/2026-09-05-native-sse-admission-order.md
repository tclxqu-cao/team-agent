# Native SSE Admission Order Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent iOS Safari connection-slot pressure from rejecting native Agent messages before the server can admit them.

**Architecture:** Native runtime sessions submit `/api/agent/run` first, then open EventSource from the pre-run persisted cursor without waiting for `onopen`. The native broker's retained event log replays any events emitted between admission and subscription; ordinary Customer Agent sessions retain the existing stream-first handshake because their event buffer has different lifecycle semantics.

**Tech Stack:** TypeScript, EventSource, persisted native runtime cursors, Vitest.

## Global Constraints

- Never automatically repeat `/api/agent/run`.
- Native streams must replay from the cursor captured before admission, or sequence zero when no cursor exists.
- Native run success must not depend on `EventSource.onopen` completing within eight seconds.
- Non-native Customer Agent runs must still open and confirm SSE before POSTing.

---

### Task 1: Split Native and Non-Native Run Ordering

**Files:**
- Modify: `packages/webapp/src/infrastructure/http/agent-http-gateway.ts`
- Unit tests: `packages/webapp/src/infrastructure/http/agent-http-gateway.test.ts`

**Interfaces:**
- Consumes: `NativeStreamCursor`, `/api/agent/run`, and persisted native SSE replay.
- Produces: `openStream(sessionId, cursor, { waitForOpen })` and native post-first run behavior.

- [x] **Step 1: Refactor EventSource setup**

Install message and terminal handlers synchronously when EventSource is created. Add a `waitForOpen` option which keeps the existing eight-second handshake for non-native sessions and returns immediately for native sessions while EventSource reconnects normally.

- [x] **Step 2: Change native run admission order**

Capture the old cursor, create the completion promise, POST the native run, dispatch its admission, then open the native stream from the captured cursor or `{ sequence: 0 }`. Keep the existing stream-first order for non-native sessions.

- [x] **Step 3: Preserve ambiguous-response recovery**

If the native POST response is lost after admission, reconcile the session using the existing recovery path, then open the stream from the old cursor before waiting for completion. Do not issue a second POST.

- [x] **Step 4: Add ordering and timeout regression tests**

Assert that native POST occurs before EventSource construction and does not require `onopen`, while a non-native run still waits for `onopen`. Retain the image transport recovery tests.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run: `bunx vitest run packages/webapp/src/infrastructure/http/agent-http-gateway.test.ts packages/webapp/src/presentation/browser-composer.test.ts packages/desktop/renderer/lib/browser-image-normalization.test.ts`

Expected: PASS

Run: `bun run --cwd packages/webapp typecheck && bun run --cwd packages/webapp build`

Expected: PASS
