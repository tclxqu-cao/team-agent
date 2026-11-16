# ZCode interruption and message refresh Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Keep newly sent messages visible across stale history responses and keep native runs alive when their Web client exits.

**Architecture:** Track historical confirmation separately from send admission, invalidate history requests when a local input is appended, and return the transcript to its latest messages on explicit send. The Web composition root starts a detached broker host through the existing socket protocol; clients never stop that host when they disconnect.

**Tech Stack:** TypeScript, React/Zustand, Node 22 child processes and Unix sockets, Vitest, Bun builds.

## Global Constraints

- Preserve existing dirty changes, native session IDs, native model discovery, approval callbacks, and persisted broker state.
- No automatic replay of an accepted input and no switching the live broker during an active run.
- No project docs edits, commits, pushes, npm release, or unrelated service restarts.
- The current agent turn is itself an active broker run; activate backend changes only after it and other runs finish.

### Task 1: Protect unconfirmed local inputs and reject old snapshots

**Files:** `packages/desktop/renderer/stores/agentStore.ts`, `components/ChatView.tsx`, `lib/session-history.ts`, new `lib/session-history-requests.ts`, and focused tests.

- [x] Add `awaitingHistory?: boolean` to local messages and set it when appending an ordinary user input. Clear it by replacing the message only after native history confirms that occurrence.
- [x] Extend the existing optimistic-tail predicate with `message.awaitingHistory` while keeping repeated-input occurrence matching.
- [x] Implement a request guard with `capture(sessionId): () => boolean` and `invalidate(sessionId): void`; guard both initial and periodic history callbacks.
- [x] On explicit send, invalidate earlier snapshots, set `nextAutoScrollRef.current = "instant"`, and request auto-follow before adding the bubble.
- [x] Cover admission followed by an old snapshot, fresh-history confirmation, repeated equal inputs, and independent request generations.

### Task 2: Start the broker outside the Web process

**Files:** `packages/native-runtime/src/agent-runtime/native-runtime-broker.ts`, new `detached-native-runtime-host.ts`, `index.ts`, `packages/server/lib/native-runtime-service.ts`, and focused tests.

- [x] Add optional `startHost(directory): Promise<void>` to broker options; use it after stale socket cleanup and before the existing in-process fallback.
- [x] Implement a detached Node bootstrap importing the built native-runtime module, creating the existing host/runtime with selected executable paths, and keeping logs in the broker directory.
- [x] Use a stable home working directory, detached stdio, readiness timeout, and existing socket ownership to handle concurrent startups. A losing process exits without modifying active runs.
- [x] Retain CLI resolution and real host PID diagnostics in the server composition root; use `startHost` instead of an inline runtime factory there.
- [x] Verify that client exit does not stop a streaming native run and a new client sees the same run finish.

### Task 3: Build and activate safely

- [x] Build native-runtime, Webapp, and the changed server bundle with Node 22; validate packaged bootstrap resolution.
- [x] Activate frontend static assets while retaining old hashed assets.
- [x] Prepare an external activation watcher that reads authoritative active broker rows and restarts only the Web gateway after all current runs finish; verify the broker socket belongs to a separate process.
- [x] Record exact applied and deferred states and capture the new regression evidence in wiki.

## Final Unit Test Verification

- [x] Main agent: run the affected frontend history/request/auto-follow tests, broker tests, detached-host tests, and native service tests after development is complete. Fix failures and rerun the affected command until passing.

Backend activation remains deferred until the current run terminates; inspect activation-status.json for the observed post-restart PID and original ZCode history verification. Browser execution is paused at Ego task space 47 by a notification permission prompt.
