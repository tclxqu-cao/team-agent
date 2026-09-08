# Codex Native Session Title Sync Design

## Goal

When AgentRoam creates a Codex session with the placeholder title `新会话`, the first non-empty message must update both AgentRoam's persisted display override and the native Codex thread name. Codex Desktop and AgentRoam should then show the same first-message title.

## Current Behavior

`CodexRuntimeAdapter.create` starts the native thread and immediately calls `thread/name/set` with `新会话`. The native runtime broker later consumes its one-time `auto_title_pending` marker and stores the first message in `native_runtime_session_title`, but this is only an AgentRoam display override. Codex Desktop reads the native thread `name`, so it continues to show `新会话`.

Existing unarchived Codex data confirms the split: 97 native threads have `name = 新会话`, while 74 of them already have a meaningful generated `title`.

## Considered Approaches

### 1. Synchronize through the Codex protocol after first-message admission

Add an optional rename capability to the runtime adapter boundary. When the broker atomically consumes the pending auto-title marker, it returns the consumed title to the broker host. For Codex sessions, the host calls `thread/name/set` through the adapter before starting the native turn.

This is the selected approach because it uses the owning runtime protocol, preserves the existing empty-session behavior, and changes only sessions that AgentRoam explicitly marked as awaiting their first title.

### 2. Stop setting `新会话` during Codex thread creation

Let Codex derive its own native title after the first turn. This avoids a rename call, but empty sessions lose the requested placeholder semantics and behavior depends on Codex's evolving automatic-title implementation.

### 3. Update the Codex SQLite database directly

This would immediately change Codex Desktop, but violates data ownership, bypasses app-server synchronization, and risks schema or cache corruption. It is rejected.

## Design

Extend `AgentRuntimeAdapter` with an optional `renameSession(nativeSessionId, title)` method and implement it only in `CodexRuntimeAdapter` using `thread/name/set`. Expose the operation through `UnifiedSessionService`, which resolves the unified session ID and invokes the owning adapter.

Change broker admission to return the run plus an optional consumed auto-title. The title is present only when the same SQLite transaction successfully changes `auto_title_pending` from `1` to `0`; historical placeholder sessions, empty input, explicit titles, and later messages therefore cannot trigger a native rename.

After successful admission and before turn execution, `NativeRuntimeBrokerHost.startRun` asks the runtime service to rename the Codex thread. Rename failure is best-effort: it must not roll back the local display title or prevent the user's message from running. Other native runtimes keep their current AgentRoam-only title behavior.

## Historical Data

Do not backfill existing `name = 新会话` records. Their pending marker has already been consumed or never existed, and deriving intent from historical messages could overwrite deliberate names. A separate, explicit migration can be designed later if required.

## Verification

- Adapter test: `renameSession` sends exactly one `thread/name/set` request with the native thread ID and first-message title.
- Broker test: a newly created Codex placeholder session renames the native thread once on the first non-empty input.
- Broker regression tests: empty input, later messages, historical placeholders, and rename failure do not rename repeatedly or block execution.
- Run the focused native runtime tests and Desktop TypeScript check.
- Production rollout requires a Server build and `:3000` restart because the broker and adapter run inside the server process; validate `/web`, runtime health, sessions, stable PID, and a newly created Codex session's native `threads.name`.
