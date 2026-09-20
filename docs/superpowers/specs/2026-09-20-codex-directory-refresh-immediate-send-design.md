# Codex Directory Refresh And Immediate Send Design

## Goal

The shared Electron and WebApp renderer must make a submitted user message visible before starting non-visual send work. Codex workspace expansion must also reconcile the latest native sessions while preserving Codex Desktop ordering and the existing running-first preference.

## Current Behavior

`ChatView.handleSend()` clears the composer and adds an optimistic user message, but then continues in the same browser task with sidebar-title updates, run-state updates, and native run admission. React can commit those updates as one batch, so the browser has no guaranteed paint opportunity between the click and the heavier conversation update. This affects every message even though no Codex response is awaited before the optimistic store write.

Codex discovery already asks the native runtime for sessions in descending update order. The renderer currently replaces that order with descending creation time, and the running-first helper also sorts by creation time before partitioning. Workspace expansion requests a refresh only for cached workspaces, so an uncached directory can open from a non-refreshing query.

## Considered Approaches

### Chosen: optimistic paint boundary

Insert the optimistic message and clear the composer first, then cross an explicit browser paint boundary before invoking sidebar-title updates and `startRun()`. This adds at most one frame before network admission while making the local action visible first. It keeps the existing message store, native reconciliation, image metadata, and error handling.

### Rejected: `flushSync` only

Forcing a React commit does not guarantee that the browser has painted before JavaScript continues. It can also make a large transcript's synchronous rendering more disruptive.

### Deferred: message-list virtualization

Memoized or virtualized rows can reduce long-session render cost, but they are a broader performance project. The current core-history window already bounds normal transcript size. This change should establish correct feedback ordering without replacing the history renderer.

## Send Data Flow

For an ordinary message in an existing session:

1. Capture the text, images, and selected agents.
2. Clear composer state and insert the optimistic user message in the target session.
3. Allow the browser to paint that state.
4. Update the optimistic sidebar title.
5. Mark the session running and call the existing Agent API.
6. Let native history and stream reconciliation replace or enrich the optimistic message as they do today.

The paint helper must be isolated and testable. It should resolve on the first task after an animation frame, allowing the frame to render before send work resumes. Environments without `requestAnimationFrame` use a zero-delay task fallback.

Goal messages and durable queued messages keep their existing persistence-first semantics because they represent queue admission, not an immediately started ordinary turn. Slash commands and scheduled-task commands remain unchanged.

## Workspace Refresh And Ordering

Expanding a real Codex workspace always requests one refreshed first page. Existing cached rows remain visible while that request is in flight. The derived `recent` workspace does not force a refresh because doing so would trigger a full catalog scan rather than a scoped directory reconciliation.

For Codex, the renderer preserves the order returned by the runtime adapter. Other runtimes retain their existing creation-time ordering. When `running sessions first` is enabled, the renderer uses a stable partition: running sessions move before idle sessions, while the relative order within both groups stays unchanged.

Pagination appends additional Codex pages in source order and continues deduplicating by session ID. A refreshed first page replaces the old first-page snapshot and invalidates the old continuation cursor using the existing workspace cache rules.

## Failure And Concurrency

Crossing the paint boundary does not change run ownership or error semantics. If admission fails, the existing error and occupied-session recovery paths continue to handle the optimistic payload. A session switch during the boundary does not retarget the send because the captured target session ID remains authoritative.

Workspace refresh failure keeps the cached rows and stale marker. Snapshot-generation guards continue preventing an older discovery response from overwriting a newer refresh.

## Validation

Focused tests will verify:

- ordinary send inserts the optimistic message before the paint boundary and does not call the run API until the boundary resolves;
- text, images, selected agents, and target session ID survive the boundary unchanged;
- Codex workspace expansion requests refresh for real workspaces but not the derived recent workspace;
- Codex source order is preserved when running-first is disabled;
- running-first is a stable partition that preserves source order inside each group;
- non-Codex ordering remains creation-time based.

The implementation gate is the focused renderer suite, Desktop and WebApp TypeScript checks, the relevant production build when practical, and `git diff --check`.

## Out Of Scope

This change does not alter Codex protocols, native session creation, durable queue admission, history pagination, message virtualization, or deployment of the WebApp service.
