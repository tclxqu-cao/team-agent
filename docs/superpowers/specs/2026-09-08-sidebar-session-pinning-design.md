# Sidebar Session Pinning Design

## Goal

Add a persistent pin action beside the existing delete action on session rows. Pinned sessions move into a dedicated section above the `最近` workspace after refresh, without changing native runtime data or the existing parent/child hierarchy.

## Considered Approaches

1. Persist pinned session IDs in the existing renderer UI preference store. This works for Customer Agent and every native runtime session, requires no runtime-specific write API, and matches the approved per-client persistence scope. This is the selected approach.
2. Write a `pinned` flag into each session's metadata. This would share state where Customer Agent owns the session, but native Codex, Claude Code, and OpenCode sessions do not expose one uniform writable metadata contract.
3. Add a server-side pin registry and API. This could synchronize Desktop and Web clients, but adds storage, API, migration, and reconciliation work that is outside the approved local persistence scope.

## State And Ordering

Extend the persisted `agent-ui-prefs` store with a deduplicated `pinnedSessionIds` array and actions to pin, unpin, or toggle a session. The preference schema version advances so older saved preferences migrate with an empty pin list.

Add a stable pinned-first sorting helper for the search overlay. In the main sidebar, visible pinned root sessions are collected across loaded workspaces and rendered in a dedicated `置顶` section immediately before the workspace list. They are removed from their original workspace list while pinned. The pinned section and each unpinned workspace list use these priorities:

1. Pinned sessions before unpinned sessions.
2. Inside each partition, preserve the current mode: newest-created first by default, or running sessions first when the existing preference is enabled.
3. Preserve stable order when all compared keys are equal and never mutate cached session arrays.

The global search overlay uses the same pinned-first ordering. A text query still filters by title or working directory first, then places matching pinned sessions first.

Child sessions remain under their parent and keep their execution order. A pinned parent carries its existing child disclosure into the pinned section. Children do not expose a pin action because moving a child into the root pinned section would break the visible parent/child relationship.

## Interaction

`SidebarSessionRow` accepts pinned state and an optional pin callback. Root session rows render a Lucide pin icon immediately before the delete icon. Unpinned rows use the accessible label `置顶会话：<title>`; pinned rows use `取消置顶：<title>`, keep the icon visible, and apply the existing accent action color.

Pointer activation stops propagation so pinning does not select or expand the session. On touch layouts, the pin action remains visible alongside delete. Pinning updates the list immediately and survives reload through Zustand persistence.

Deleting a session also removes its ID from the persisted pin list. IDs for sessions removed outside AgentRoam are harmless and are ignored until the session is visible again.

## Failure Behavior

Pinning is a local synchronous preference update, so it does not depend on runtime availability and does not show a network failure state. Invalid or duplicate persisted values are normalized during migration and updates.

## Verification

- Unit-test pinned-first ordering, interaction with running-first mode, stable order, and input immutability.
- Unit-test UI preference migration and deduplication behavior.
- Render-test the pin/unpin icon states, accessible labels, action order, event isolation, and absence on child rows.
- Extend sidebar structure/style tests to cover the top-level pinned section, project rows, the search overlay, and touch visibility.
- Run focused renderer tests, Desktop/Web TypeScript checks, and the WebApp build.
- Use the required browser workflow to verify desktop-width and 390x844 layouts without action overlap.

## Out Of Scope

- Cross-device or Desktop/Web synchronization.
- Reordering projects or moving child sessions outside their parent.
- Publishing or restarting the production `:3000` service.
