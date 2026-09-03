# WebApp Abort Button State Design

## Problem

The stop action successfully interrupts the active turn, but the dedicated stop
button can remain visible or reappear. `ChatView` clears `runningSessionId`
optimistically, and that state change retriggers the selected-session history
load. A request that started before the interrupt can still return a stale
`status: running` detail and restore the local running state.

The stop button is independent from the send button. After interruption, the
stop button must disappear while the normal composer and send button remain
available for the next message.

## Decision

Treat selected-session loading as a response to session selection or an explicit
reload, not to local run-state transitions. Remove `runningSessionId` from that
effect's dependency list because the effect already reads the current store value
at the point where it decides whether optimistic messages should win.

When the user interrupts a turn, invalidate any selected-session load already in
flight before clearing the local running state. Its stale response must therefore
fail the existing load-generation check and cannot restore the stopped run.

The persistent broker remains authoritative when a session is freshly selected
or the page is refreshed. This preserves recovery of genuinely active native
runs while preventing a pre-interrupt response from reversing the user's latest
action.

## Alternatives

- Wait for the abort request before hiding the stop button. This gives delayed
  feedback and still leaves an older concurrent history request able to race.
- Keep a separate per-session `aborting` state until the server reports idle.
  This works but adds a second lifecycle state that must be cleared on failures,
  navigation, refresh, and the next run.

## Error Handling

The existing gateway continues to settle pending run promises even when the
abort request fails. The UI clears only the local presentation state; selecting
the session again or refreshing the page re-reads the broker and restores a run
if it is actually still active.

## Verification

- Add a regression assertion that selected-session loading does not depend on
  `runningSessionId`.
- Add a regression assertion that the interrupt handler invalidates an in-flight
  session load before clearing local running state.
- Run the focused renderer tests and WebApp type check/build.
- Verify in the WebApp that the dedicated stop button disappears immediately,
  the send button remains available, and an immediate next message starts after
  any short native cleanup finishes.
