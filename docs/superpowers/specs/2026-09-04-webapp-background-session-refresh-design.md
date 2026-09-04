# WebApp Background Session Refresh Design

## Goal

Keep the 15-second Codex workspace refresh so the sidebar receives new directories, sessions, and runtime status, while guaranteeing that a background refresh cannot blank, reload, or navigate away from the currently open conversation.

User-initiated directory selection remains a foreground operation and may show the existing `正在同步目录...` feedback.

## Current Failure

The periodic effect calls `loadProjects(..., { refresh: true })`. `loadProjects()` always sets the shared `workspaceLoading` flag, so a background request mounts and then removes the sidebar synchronization row. The same reconciliation path may also clear the current project and session when a refreshed page temporarily omits them.

The result is a visible flash and, under an incomplete or stale discovery response, a blank chat view even though the user did not change the selected session.

## Design Decision

Add an explicit `background` option to workspace refreshes.

- The 15-second timer uses `background: true`.
- Background refreshes update workspace and session summaries without setting the foreground `workspaceLoading` state.
- Background refreshes preserve the current `{ projectId, sessionId }` selection when the refreshed workspace page temporarily omits the selected project.
- User actions that open, retry, paginate, or explicitly refresh a directory keep foreground behavior and may show synchronization feedback.
- A definitive user-driven refresh may still clear an invalid selection when the selected project no longer exists.

This keeps polling live without coupling sidebar discovery to chat navigation state.

## Data Flow

```text
15-second timer
  -> loadProjects(refresh: true, background: true)
  -> reconcile cached sidebar data
  -> preserve active selection
  -> no visible loading row

directory click / retry
  -> loadProjects or loadSessions in foreground mode
  -> visible loading feedback remains allowed
  -> definitive missing targets may clear selection
```

## Error Handling

A failed background refresh keeps the existing directories, sessions, and active conversation visible. Existing stale/error reporting remains available, but the chat selection is not reset. Foreground failures keep the current retry behavior.

## Testing

Focused renderer tests must verify:

- the 15-second refresh passes `background: true`;
- background refresh does not enter the visible workspace loading state;
- a background response that omits the active project does not clear the active session;
- foreground refresh behavior still supports visible synchronization feedback and definitive selection cleanup;
- existing workspace pagination, session polling, and sidebar selection tests remain green.

Run the focused Vitest suites, Desktop renderer TypeScript check, WebApp TypeScript check, and `git diff --check`.

## Non-Goals

- Disabling periodic workspace/session discovery.
- Removing the running-session status-dot animation.
- Changing initial history loading or message-history pagination.
- Changing native session ownership, resume, archive, or deletion behavior.
