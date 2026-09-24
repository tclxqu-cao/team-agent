# Queued Message Active Feedback Design

## Problem

When the durable server queue promotes a chat message from `queued` to `active`, the WebApp moves that message into history but does not show its pending spinner. A server-started successor run can also remain visually idle because it bypasses the renderer's local `startRun` entry point.

## Design

Treat the durable queue's active message as authoritative evidence that the successor run is awaiting or producing a response.

- `reconcileDurableQueuedMessages` sets `sendState: "pending"` when projecting an active message into chat history.
- `applySessionQueueState` starts the viewed session's thinking activity when `state.active.kind === "message"`.
- Queued items remain in the composer queue and do not receive `sendState`.
- Goal queue items do not create chat pending state or change chat activity.
- Existing meaningful run events clear the pending marker. Existing terminal events clear running and activity state.
- Session checks remain scoped to the currently viewed session so activity cannot leak across tabs.

## Error And Race Handling

Queue snapshots may arrive before `run_admitted`; showing pending from the active snapshot is intentional because the server has already claimed the item. If a meaningful event arrives first, the existing event handler clears pending. Later active snapshots may restore pending only while the item remains active; the terminal queue refresh removes active state after completion.

## Tests

- Assert that an active durable message is projected with `sendState: "pending"`.
- Assert that queued messages remain queued without a pending send state.
- Assert that applying an active message queue state begins thinking only for the viewed session.
- Run the focused renderer unit tests and WebApp build.

## Scope

This change only repairs visual lifecycle feedback. It does not change queue ordering, server admission, run execution, event persistence, or message content.
