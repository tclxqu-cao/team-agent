# Codex Native Session Archive Design

## Goal

Deleting a Codex session from AgentRoam must archive the real Codex thread and remove it from the WebApp without allowing cached or in-flight workspace responses to restore a stale row. Claude Code and OpenCode keep their existing AgentRoam-only hide behavior because they do not share the Codex App Server archive contract.

## Current Failure

AgentRoam currently handles every external runtime delete by writing the unified session ID to `native_runtime_hidden_session`. The Codex rollout remains active in `~/.codex/sessions`.

The workspace renderer refreshes the first 20-session page after deletion. When the response has a `nextCursor`, `reconcileSessionPage` intentionally keeps cached later-page rows. The delete callback starts this refresh before React has committed the removal, so the refresh can merge the deleted row from its stale closure back into the list. Selecting or sending through that row then reaches the Broker tombstone guard and fails with `Native session not found`.

The observed session `01a06c16-e6af-7870-bada-2bce81c15a4c` demonstrates this split state: its Broker tombstone exists, the current server list excludes it, and its rollout remains in the active Codex sessions directory.

## Design Decision

Use the Codex App Server's stable `thread/archive` request for Codex deletes. A successful archive moves the persisted JSONL rollout into the archived sessions directory, excludes it from ordinary `thread/list` calls, and emits `thread/archived`. AgentRoam still records its local tombstone after native success as a defense against stale pages, old clients, and an external unarchive that was not initiated through AgentRoam.

The operation order is fixed:

1. Reject deletion while AgentRoam owns an active run.
2. Decode the unified ID and dispatch Codex sessions to native archive.
3. Call `thread/archive` with the native `threadId` and require a successful response.
4. Persist the AgentRoam tombstone and remove pending-session and goal state.
5. Invalidate unified discovery, workspace snapshots, and detail caches.
6. Return success only after the archive and local cleanup complete.

If native archive fails, AgentRoam does not create a new tombstone and leaves the row available for retry. Repeating a delete for an already tombstoned ID remains idempotent. Customer Agent sessions retain permanent local deletion. Claude Code and OpenCode retain the current tombstone-only behavior.

## Runtime Boundaries

`AgentRuntimeAdapter` gains an optional archive capability rather than overloading permanent delete. `CodexRuntimeAdapter.archiveSession(nativeSessionId)` sends:

```json
{ "method": "thread/archive", "params": { "threadId": "<native id>" } }
```

`UnifiedSessionService.archive(id)` resolves the adapter, returns `OPERATION_NOT_SUPPORTED` when absent, calls the capability, and invalidates detail, discovery, and workspace caches. The Broker chooses archive only for Codex and keeps the existing local-hide branch for other external runtimes.

The renderer confirmation copy for Codex becomes `归档到 Codex 并从 AgentRoam 移除`. Other external runtimes continue to say that the session is only hidden from AgentRoam.

## Renderer Race Prevention

Deletion must not depend on a render completing before refresh begins.

- After the DELETE response succeeds, increment the affected workspace request generation so every older in-flight response is ignored.
- Remove the target and descendants with functional state updates that receive the latest collections instead of using the delete callback's captured arrays.
- Clear the selected session and internal chat state synchronously when the selected row is removed.
- Remove the ID from the in-memory workspace partition and persisted workspace cache before starting another refresh.
- Suppress the known deleted ID while the post-delete refresh is running so a response that was produced before native invalidation cannot restore it.
- Preserve the existing later-page merge behavior for unrelated sessions; a first-page refresh must not discard valid pages merely to solve deletion.

The pending-native-session preservation used for newly forked sessions must apply only to an explicitly supplied pending summary. A selected native row that is absent from the authoritative response is not automatically assumed to be pending, because that rule also preserves deleted and archived sessions.

## Error Handling

- An active AgentRoam run continues to return `SESSION_OCCUPIED` before native mutation.
- Codex archive protocol failures preserve the native error and leave the session visible.
- A stale page attempting to read, fork, watch, or run an archived/tombstoned session continues to receive `SESSION_NOT_FOUND`.
- Successful deletion closes the confirmation UI, clears a matching selection, and shows the existing success notice.
- The API response may keep the current `{ "status": "deleted" }` shape for compatibility; the user-facing confirmation text carries the archive distinction.

## Validation

Automated coverage will verify:

- `CodexRuntimeAdapter` sends exactly one `thread/archive` request with the native thread ID.
- A Codex archive failure does not create a Broker tombstone.
- A successful Codex archive occurs before tombstone persistence and invalidates session/workspace caches.
- Claude Code and OpenCode deletion remain tombstone-only.
- Customer Agent deletion remains permanent.
- An in-flight pre-delete workspace response cannot restore the deleted row.
- A paginated first-page refresh preserves unrelated later-page rows while excluding the deleted ID.
- A missing selected native session is preserved only when supplied as an explicit pending creation/fork.
- The Codex confirmation copy describes native archive and other runtime copy describes local hiding.

Focused adapter, unified-service, Broker, renderer-cache, sidebar-contract, and server-route tests plus affected TypeScript checks and `git diff --check` form the implementation gate.

## Out Of Scope

This change does not add an archived-sessions browser, `thread/unarchive`, permanent Codex `thread/delete`, or native archive support for Claude Code and OpenCode. It does not modify Codex rollout files directly.

