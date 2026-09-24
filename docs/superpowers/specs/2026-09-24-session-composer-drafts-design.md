# WebApp Session Composer Drafts Design

## Problem

`ChatView` keeps the visible composer text in one React state value. The existing session draft synchronization runs only for native runtimes, so switching from a native session to Customer Agent, or between Customer Agent sessions, can leave the previous session's unsent text visible in the newly selected session.

## Design

- Use the existing unified session ID as the draft ownership key for every existing session, regardless of agent type.
- Reuse `session-draft.ts` and its localStorage-backed read, write, and clear operations; do not add a second draft store.
- When the selected session changes, restore that session's saved text or an empty string before persisting further input.
- When text changes without a session change, persist it only under the currently viewed session ID.
- When a message is accepted for sending, clear only that session's draft.
- Keep attachments, pending images, message routing, runtime selection, and new-session creation behavior unchanged.

## Failure Handling

Storage failures remain non-fatal. The composer continues to work with its visible React state, matching the current `session-draft.ts` behavior.

## Verification

- Add focused tests proving Customer Agent and native session drafts cannot cross-contaminate.
- Cover switching to a session without a draft and switching back to a session with an unsent draft.
- Verify sending clears only the accepted session draft.
- Run the affected renderer tests and the WebApp production build.
