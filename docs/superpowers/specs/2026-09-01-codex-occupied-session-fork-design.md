# Codex Occupied Session Fork Design

## Goal

When a Codex conversation is still owned by another Codex client, AgentRoam must not present it as directly resumable and then expose `thread ... already has an active writer`. The conversation remains readable, and the user can explicitly create a persisted fork and continue from the copied history without changing the original thread.

The behavior must be identical in the Electron desktop app and the Web app because both render the shared `ChatView`.

## Current Failure

Codex uses a writer lock for each loaded thread. The current occupancy detector treats an open rollout file as idle after 120 seconds without an mtime update. That heuristic can mark a Codex Desktop thread as `available` even though Codex still holds its writer lock. AgentRoam then calls `thread/resume`, which correctly rejects the second writer.

OpenAI's App Server contract confirms that `thread/unsubscribe` only removes the current connection's subscription. A thread may remain loaded for a 30-minute no-subscriber grace period, and another client may keep it loaded longer. File-write inactivity is therefore not proof that a Codex writer has released ownership.

## User Experience

- A Codex session whose rollout is held by another Codex process remains `owned-externally`, even when the rollout mtime is old.
- Its history remains readable and the composer remains disabled.
- The existing read-only notice adds a primary `以副本继续` command for occupied Codex sessions only.
- Clicking the command shows an in-place loading state and prevents duplicate requests.
- On success, AgentRoam refreshes the session index, selects the new fork, loads its inherited history, and restores the normal composer. The original session stays unchanged and read-only.
- The fork title is `<原标题>（副本）`. Repeated forks are allowed only through separate explicit clicks.
- On failure, the original session remains selected and read-only. The notice shows a concise failure message and allows retry.
- If a stale session summary allows a send attempt but Codex returns `SESSION_OCCUPIED`, AgentRoam enters the same occupied recovery state from the structured error code instead of exposing the raw protocol error.
- When that recovery follows a failed send, AgentRoam restores the failed user text into the fork's composer without submitting it. The user can review or edit the text before sending.

The fork action never automatically starts a turn. A proactive fork opens with an empty composer; a recovery fork carries only the failed user text as an editable draft.

## Runtime Contract

Extend `AgentRuntimeAdapter` with an optional `fork(nativeSessionId)` operation returning a `UnifiedSessionSummary`. `UnifiedSessionService.fork(id)` resolves the unified ID, permits the operation only for adapters that implement it, and clears discovery caches after success. Unsupported runtimes return `OPERATION_NOT_SUPPORTED`.

`CodexRuntimeAdapter.fork` performs:

1. `thread/read` to obtain the current title and summary metadata without loading the source thread.
2. `thread/fork` with only `threadId`, producing a persisted fork that copies all stored history.
3. `thread/name/set` for the `<原标题>（副本）` title.
4. Conversion of the returned native thread to a unified session summary.

No `lastTurnId` is supplied. Per the App Server contract, if the source is currently mid-turn, Codex writes an interruption marker into the fork instead of representing a partial turn as complete. No attempt is made to interrupt, unsubscribe, unload, or modify the source thread.

## Occupancy Contract

`listOpenSessionFiles` must support runtime-specific idle handling:

- Codex calls disable the mtime idle exemption. An externally open rollout remains occupied until the owning process releases it.
- Claude Code retains the existing 120-second idle exemption because this change addresses Codex's explicit writer-lock contract and must not silently change Claude Code takeover behavior.
- Customer Agent's own app-server PID remains excluded from external occupancy detection.

The send path keeps its immediate occupancy recheck. This closes the race where another client acquires the writer after the sidebar's periodic refresh.

## Transport Boundaries

Electron adds `sessions:fork` IPC and exposes `forkSession(id)` through the preload `AgentApi` contract.

Web adds `POST /api/sessions/:id/fork`. The route delegates to `NativeRuntimeService.fork`, returns the created summary with HTTP 201, maps `SESSION_OCCUPIED` to 409 and unsupported runtimes to 405, and never handles Customer Agent sessions as native forks. `AgentHttpGateway.forkSession` exposes the same renderer contract.

The fork request is separate from `agent:run`; no streaming event or session-replacement event is added. `ChatView` receives the returned summary synchronously, asks `App` to refresh and select it through the existing session-selection callbacks, then lets the normal history-loading effect hydrate the fork.

## Error Handling And Concurrency

- `thread/fork` protocol errors retain their normalized runtime code and a user-facing message.
- The fork button is disabled while its request is pending, preventing double clicks from producing multiple forks.
- If the source disappears between display and click, `SESSION_NOT_FOUND` is shown without changing selection.
- If the fork succeeds but the session refresh fails, AgentRoam still selects the returned unified ID and retries discovery through the existing refresh path; the persisted fork is not deleted.
- `SESSION_OCCUPIED` events preserve their error code through desktop IPC and Web SSE so the renderer can replace the raw error with the occupied-session recovery state.
- Forking never enters `activeSessionIds`; only a subsequent turn on the new thread does.

## Testing

- `native-processes` tests prove old Codex files remain occupied when strict mode is enabled and old Claude files still become available under the 120-second rule.
- Codex adapter tests prove `thread/fork` uses the source ID, creates a persisted fork, applies the copy title, returns a new unified ID, and leaves the source untouched.
- Unified service tests cover supported Codex forks, unsupported runtime rejection, and discovery-cache invalidation.
- Electron preload/IPC contract tests cover `forkSession` routing.
- Server route and Web gateway tests cover the 201 response, runtime error status mapping, and returned summary.
- Shared renderer tests cover button visibility, loading suppression, successful refresh/selection, failure rollback, failed-text restoration, and `SESSION_OCCUPIED` recovery without the raw English writer error.
- Run the affected desktop, renderer, server, and Web type checks and focused Vitest suites.
- Perform one real Codex acceptance check with an externally held source thread: original stays read-only, fork appears as a new session, inherited history loads, and the first turn on the fork completes.

## Non-Goals

- Stealing or force-releasing another Codex client's writer lock.
- Sending a message into the original client through cross-process coordination.
- Automatically forking without an explicit user action.
- Merging forked turns back into the source thread.
- Changing Claude Code's current idle takeover policy.
- Deleting, archiving, or renaming the original session.
