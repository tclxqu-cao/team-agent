# Codex Steering And User Interruption Design

## Problem

AgentRoam already lets supported runtimes steer a queued message into an active run, but Codex is excluded from the capability table and `CodexRuntimeAdapter` does not expose its app-server steering operation. The installed Codex app-server protocol supports `turn/steer` with an active turn precondition, so Codex queue rows should use the existing steering workflow.

Stopping a Codex turn currently produces `Codex turn was interrupted.` as an ordinary runtime error. The renderer treats every ordinary native runtime error as a failed send, restores the submitted text into the composer, and leaves the red error visible. A user-requested stop should instead be a successful cancellation boundary while unexpected interruptions remain errors.

## Goals

- Allow a queued Codex message to be steered into the currently active Codex turn.
- Remove a durable queued message only after app-server accepts the steer request.
- Treat a user-requested Codex stop as cancellation: preserve the submitted chat message, keep the composer empty, and show no red error.
- Preserve error reporting and draft recovery for unexpected Codex interruptions and genuine run failures.

## Non-Goals

- Do not change queue ordering, automatic queue draining, editing, copying, or deletion.
- Do not enqueue a failed steer into a later turn.
- Do not infer steering support from shared versus standalone transport; both expose the same JSON-RPC contract after initialization.
- Do not hide all interrupted turns. Only a locally requested abort is cancellation.
- Do not change Claude Code, OpenCode, or Customer Agent steering behavior.

## Design

### Codex Steering

Add `steer(nativeSessionId, input)` to `CodexRuntimeAdapter`.

The method reads the current turn id from `activeTurnIds`. If there is no active turn or the input is blank, it returns `false`. Otherwise it calls:

```text
turn/steer {
  threadId: nativeSessionId,
  expectedTurnId: activeTurnId,
  input: [{ type: "text", text: input, text_elements: [] }]
}
```

It returns `true` only after the request succeeds. Protocol rejection propagates to the existing broker/UI error path, so `steerMessage` keeps the durable queue item and the user can retry or leave it for the next turn.

The renderer runtime capability table adds Codex to the runtimes supporting mid-turn steering. The existing queue action and `steerSessionMessage` flow are reused without a Codex-specific component branch.

### User-Requested Cancellation

`CodexRuntimeAdapter` tracks thread ids for which `abort()` has requested `turn/interrupt`. The marker is set only when an active turn exists and the interrupt request is issued.

When app-server reports that turn as interrupted:

- If the thread has a matching local abort marker, consume the marker and close the event queue with a normal terminal event rather than an error.
- If there is no local abort marker, preserve the current `NATIVE_PROTOCOL_ERROR` behavior.

The marker is cleared on every terminal path and in run cleanup so it cannot suppress an interruption from a later turn. A rejected `turn/interrupt` request also removes the marker before propagating the failure.

This keeps the renderer's existing failure recovery intact for real errors while preventing a user stop from restoring the already submitted message into the composer.

### Bounded Cancellation Confirmation

After app-server accepts `turn/interrupt`, the adapter starts a 30-second confirmation timer scoped to the exact thread and turn id. A matching terminal event clears the timer and remains authoritative.

If no matching terminal event arrives within 30 seconds, the adapter reads the thread from app-server and reconciles the exact turn instead of assuming cancellation succeeded:

- If the turn is terminal, normalize its real terminal state and finish the local run.
- If the turn is still active, issue one more `turn/interrupt` for the same turn id and continue waiting.
- If reconciliation fails transiently, keep the local run in its stopping state and retry within the overall deadline.

At 60 seconds without an authoritative terminal state, emit a dedicated recoverable `CANCEL_CONFIRMATION_TIMEOUT` error and close the local run stream. The renderer excludes this code from failed-send draft restoration: the submitted user message remains in history, the composer stays empty, and queued follow-up messages remain durable. The UI tells the user that stop confirmation timed out and allows another stop attempt or explicit session release. Codex remains the transcript authority, so content that completes after the local stream closes is recovered by the existing native-history refresh rather than discarded.

The timeout and reconciliation callbacks recheck both the active turn id and local interruption marker before acting. A terminal notification received at any point up to or after a reconciliation request remains authoritative for that turn. Timer handles are cleared on matching terminal events, rejected initial interrupt requests, and run cleanup.

### Event Semantics

User cancellation emits a normal `done` event with the latest available Codex agent text from the interrupted turn, if any. This lets existing renderer and broker terminal handling clear running state and continue normal queue policy without introducing a new cross-process event type.

An unexpected `turn/completed` status of `interrupted`, or a standalone interruption notification without a local abort marker, remains an error. The UI therefore continues to expose interruptions caused outside AgentRoam or by protocol/runtime failure.

## Error Handling

- No active Codex turn: `steer()` returns `false`; the queued message remains queued.
- Stale `expectedTurnId` or app-server rejection: the request rejects; the queued message remains queued and the existing UI reports the failure.
- Interrupt request rejection: cancellation state is rolled back and the error remains visible.
- Accepted interrupt without a terminal event: reconcile at 30 seconds, retry interruption when still active, and report a recoverable confirmation timeout at 60 seconds.
- Unexpected interruption: emit the existing protocol error and retain draft recovery behavior.

## Verification

- Adapter test: active Codex run sends the exact `turn/steer` request and returns `true`.
- Adapter test: steering without an active turn returns `false` and sends no request.
- Adapter test: a rejected steer propagates and does not terminate the active run.
- Adapter test: user-requested abort followed by interrupted completion emits normal completion without an error.
- Adapter test: an accepted abort without a terminal event triggers authoritative reconciliation after 30 seconds.
- Adapter test: an active reconciled turn receives one repeated interrupt and can still complete normally before 60 seconds.
- Adapter test: an authoritative terminal event received during reconciliation cancels timers and controls the final result.
- Adapter and renderer tests: the 60-second confirmation timeout is recoverable, never invokes failed-send draft restoration, and does not suppress later native-history reconciliation.
- Adapter test: unexpected interrupted completion still emits `NATIVE_PROTOCOL_ERROR`.
- Capability test: Codex reports mid-turn steering support while existing runtime values remain unchanged.
- Broker queue tests continue proving that durable queue rows are removed only after steering succeeds.
- Run focused tests, native-runtime build, desktop TypeScript checks, and diff validation.

## Acceptance Criteria

- A Codex queued-message row shows the existing steer action during an active run.
- Activating it sends the message to that exact active turn and removes the row only after acceptance.
- Pressing stop during a Codex run does not show `Codex turn was interrupted.` and does not restore the sent text into the composer.
- A stopped Codex run cannot remain active indefinitely when app-server omits its terminal notification, and no fixed timeout can silently discard a late response.
- An interruption not initiated by the current AgentRoam run remains visible as an error.
