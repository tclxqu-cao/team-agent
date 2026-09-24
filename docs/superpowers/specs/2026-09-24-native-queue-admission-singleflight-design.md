# Native Queue Admission Single-Flight Design

## Context

After a WebApp Codex turn is interrupted, native adapter cleanup and a concurrent
`getGoals()` reconciliation can both try to start the same promoted queue item.
One starter can admit the run while the other receives
`SESSION_ALREADY_RUNNING`. The current `startQueueItem()` catch path treats the
losing attempt as a real execution failure and marks the queue item failed even
though the competing attempt already started it.

The fix must preserve the existing per-session serialization contract without
changing renderer behavior or weakening protection against genuinely overlapping
runs.

## Requirements

- At most one `startRun()` call may be in flight for the same session and queue
  item.
- Concurrent callers for that item must share the same admission result.
- A real admission or runtime error must keep the existing failed-item behavior.
- Different sessions must remain independently runnable.
- A later queue item in the same session must not reuse an earlier item's
  admission promise.
- Existing ordinary-message and goal ordering must remain unchanged.

## Design

`NativeRuntimeBrokerHost` will own a private map keyed by session ID. Each value
records the queue item ID and the Promise for its current admission attempt.

`startQueueItem()` will use this map as a single-flight boundary:

1. Return without starting when the broker already has an authoritative active
   run for the session.
2. If the map contains the same queue item, return the existing Promise.
3. Otherwise create one admission Promise, store it before exposing it to other
   callers, and run the existing `startRun()` flow inside that Promise.
4. Preserve the current failure transition only for the owner admission Promise.
5. Remove the map entry in `finally` only when it still points to that Promise.

The key remains session-scoped because the broker permits only one active run per
session. Recording the item ID prevents a stale completed Promise from being
reused for a newly promoted item.

This design prevents the collision instead of special-casing
`SESSION_ALREADY_RUNNING` after it occurs. That error remains authoritative for
unrelated callers and genuine overlap.

## Data Flow

```text
terminal cleanup ─┐
                  ├─> startQueueItem(item) ─> single-flight entry ─> startRun()
getGoals() ───────┘             │
                                └─ concurrent caller awaits the same Promise
```

After admission, the existing `activeExecutions` map continues to own execution
cleanup. The new map covers only the narrower queue-admission window before
`activeExecutions` is observable.

## Error Handling

- The owner admission attempt logs and fails the queue item on genuine errors,
  matching current behavior.
- A joined caller does not run an additional catch/failure transition.
- Map cleanup uses identity checking so an older Promise cannot delete a newer
  item's entry.
- No error code is reclassified globally; `SESSION_ALREADY_RUNNING` continues to
  protect direct overlapping runs.

## Testing

Add a focused broker regression test that forces two concurrent
`startQueueItem()` paths for the same promoted item through the public behavior:

- interrupt an active run while adapter cleanup is delayed;
- enqueue one follow-up message;
- concurrently trigger queue reconciliation and release cleanup;
- assert the runtime receives the follow-up input exactly once;
- assert exactly one native run owns the queue item;
- assert the item is not recorded as failed;
- complete the run and verify the queue returns to empty.

Retain the existing delayed-cleanup regression test and run the full native
runtime broker test file. Also run the native-runtime TypeScript build or type
check and `git diff --check`.

## Non-Goals

- Changing WebApp composer or optimistic message rendering.
- Serializing runs across different sessions.
- Changing queue priority, ordering, persistence, or restart recovery.
- Hiding genuine `SESSION_ALREADY_RUNNING` errors from direct run requests.
