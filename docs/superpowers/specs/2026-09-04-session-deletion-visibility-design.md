# Session Deletion and Visibility Design

## Goal

Every session shown by AgentRoam has a delete action when deletion is safe. After deletion, the session disappears from the project list, global search, counts, and the active conversation view, and remains absent after refresh or process restart.

## User Experience

- Show the existing trash icon action for eligible parent and child sessions in project lists and other-local-session lists.
- Ask for confirmation before deletion. The copy must distinguish the behavior without exposing implementation details: Customer Agent sessions are permanently deleted; Codex, Claude Code, and OpenCode sessions are removed from AgentRoam while their native history remains available in the original client.
- Do not offer deletion while a session is running under AgentRoam control. This prevents an active task from continuing without a visible control surface. An externally owned native session may still be hidden because AgentRoam does not stop or modify that external process.
- When the selected session is deleted, clear the selected session and its todos, then show the normal empty conversation state.
- On success, remove the session immediately from all renderer collections and close the mobile drawer when appropriate. A background refresh confirms server state.
- On failure, keep the session visible and show the existing error notice.

## Deletion Semantics

### Customer Agent Sessions

Use the existing session-store deletion path. Messages and events are removed with the session. Deleting a parent follows the database's existing child-session cascade contract.

### Native Runtime Sessions

Deleting a Codex, Claude Code, or OpenCode session creates a persistent AgentRoam visibility tombstone keyed by the unified session ID. AgentRoam filters tombstoned sessions from discovery and refresh results but does not delete or modify native transcript files.

The tombstone lives in the native runtime broker SQLite database so desktop and Web clients sharing that broker observe the same result across refreshes and restarts. Pending-session and cached-detail state for that ID is invalidated when the tombstone is created.

The delete operation is idempotent. Deleting an already hidden native session succeeds. There is no restore UI in this scope.

## API and Application Flow

1. The shared renderer calls the existing `deleteSession(id)` gateway method.
2. `DELETE /api/sessions/:id` routes Customer Agent IDs to the existing session store and native IDs to the native runtime service.
3. The native runtime service asks the shared broker to hide the session persistently.
4. Session list and refresh operations exclude hidden IDs before project association and presentation.
5. The renderer removes the successful ID from project sessions, child-session groups, other-local sessions, and search results, then clears selection when needed.

Desktop IPC follows the same unified service operation so desktop and Web behavior stay aligned.

## Safety and Error Handling

- The backend rejects deletion of an actively running AgentRoam-owned session with a conflict response even if a stale client renders a delete button.
- Hiding an externally owned native session is allowed because it does not stop or mutate the external process.
- Unknown Customer Agent session IDs retain the current idempotent delete behavior. Unknown native IDs may still be tombstoned so they cannot reappear during a later discovery refresh.
- A database write failure returns an error and leaves the renderer state unchanged.

## Verification

- Broker tests prove tombstones survive service reconstruction, filter list/refresh results, and do not call native transcript deletion.
- Server route tests cover CA deletion, native hiding, idempotency, and active-session rejection.
- Renderer tests cover delete-button visibility, immediate removal from each list path, current-selection clearing, and failure rollback.
- Type-check the affected Core, Desktop, Server, and WebApp packages.
- Build the WebApp and verify the shared UI at desktop and mobile widths using the project-required browser workflow.

## Out of Scope

- Deleting Codex, Claude Code, or OpenCode transcript files.
- A recycle bin or restore-hidden-session screen.
- Bulk deletion or retention policies.
