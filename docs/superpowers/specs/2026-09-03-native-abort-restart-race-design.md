# Native Abort Restart Race Design

## Problem

After a WebApp-owned Codex turn is interrupted, the broker persists the terminal
event before the adapter's async generator has completed its `finally` cleanup.
During that short interval the broker sees no active run, but the adapter still
has the session in `activeQueues` and `ownedThreads`.

An immediate second send can therefore be admitted by the broker and rejected by
the adapter as `SESSION_OCCUPIED`. The broker treats every such error as proof of
an external writer and changes the session to `owned-externally`, even though the
remaining owner is the WebApp's own Codex app-server.

## Decision

Track the actual `executeRun` promise per session inside `NativeRuntimeBrokerHost`.
When a persisted run is already terminal but its execution promise is still
settling, `startRun` waits for that promise before checking native occupancy and
admitting the next run. Duplicate sends while the persisted run is still active
continue to fail immediately through the existing broker admission lock.

Promise cleanup is identity-checked so an older run cannot delete the tracking
entry for a newer run. The adapter occupancy model and external writer detection
remain unchanged.

## Alternatives

- Use a distinct adapter error code for local cleanup overlap. This prevents the
  false external lock but still rejects the user's next message.
- Retry from the renderer after a delay. This leaves API and Desktop callers
  exposed and duplicates lifecycle policy in the presentation layer.

## Verification

Add a broker regression test whose runtime emits a terminal interruption and
then delays generator cleanup. Assert that an immediate second `startRun` waits,
does not invoke a second adapter run early, succeeds after cleanup, and never
projects `owned-externally`.

Run the focused native broker and Codex adapter tests, then rebuild and restart
the production WebApp on port 3000.
