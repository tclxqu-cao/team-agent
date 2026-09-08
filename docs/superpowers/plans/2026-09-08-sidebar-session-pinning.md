# Sidebar Session Pinning Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-client persistent session pin action that moves pinned root sessions into a section above the `最近` workspace.

**Architecture:** Store pinned session IDs in the existing persisted Zustand UI preferences. Collect visible pinned roots into a top-level section before the workspace list, remove them from their original workspace while pinned, and expose the action through the shared session-row component used by the pinned section, project list, and search overlay.

**Tech Stack:** React 18, TypeScript, Zustand persist, Lucide React, Vitest, Vite.

## Global Constraints

- Persist locally in `agent-ui-prefs`; do not add server or native-runtime APIs.
- Render a dedicated `置顶` section before the workspace list; each pinned root appears there instead of in its original workspace.
- Pinned and ordinary lists preserve the existing newest/running-first order.
- Keep child sessions under their parent and do not offer child pinning.
- Use the shared `SidebarSessionRow` in both project and search rendering paths.
- Do not publish or restart the production `:3000` service.

---

### Task 1: Persistent Pin State And Stable Ordering

**Files:**
- Modify: `packages/desktop/renderer/stores/uiStore.ts`
- Modify: `packages/desktop/renderer/stores/uiStore.test.ts`
- Modify: `packages/desktop/renderer/lib/sidebar-session-sort.ts`
- Modify: `packages/desktop/renderer/lib/sidebar-session-sort.test.ts`

**Interfaces:**
- Produces: `pinnedSessionIds: string[]`, `togglePinnedSession(id: string): void`, and `removePinnedSessions(ids: readonly string[]): void` on `UIState`.
- Produces: `sortPinnedSessionsFirst<T>(sessions: readonly T[], isPinned: (session: T) => boolean): T[]`.

- [x] **Step 1: Extend UI preferences with normalized pinned session IDs**

Add the persisted array and immutable actions. Increment the preferences version and normalize migrated values with a small exported helper so malformed or duplicate IDs cannot enter state.

```ts
export function normalizePinnedSessionIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is string => typeof id === "string" && id.length > 0))];
}
```

- [x] **Step 2: Add the stable pinned-first partition**

Reuse `stableSort` so the input array is not mutated and the existing order remains intact within pinned and unpinned partitions.

```ts
export function sortPinnedSessionsFirst<T>(sessions: readonly T[], isPinned: (session: T) => boolean): T[] {
  return stableSort(sessions, (left, right) => Number(isPinned(right)) - Number(isPinned(left)));
}
```

- [x] **Step 3: Cover migration, deduplication, ordering, composition, and immutability**

Test invalid persisted values, duplicate IDs, toggle/remove actions, pinned-before-running precedence, stable order, and unchanged input arrays.

### Task 2: Session Row Pin Interaction

**Files:**
- Modify: `packages/desktop/renderer/components/SidebarSessionRow.tsx`
- Modify: `packages/desktop/renderer/components/SidebarSessionRow.test.tsx`
- Modify: `packages/desktop/renderer/styles/global.css`
- Modify: `packages/desktop/renderer/components/SidebarReferenceStyle.test.ts`

**Interfaces:**
- Consumes: `session.pinned: boolean` and optional `onPin(): void`.
- Produces: an accessible pin/unpin icon button before the delete button.

- [x] **Step 1: Add the root-session pin action**

Render Lucide `Pin` before `Trash2`, stop click propagation, use `aria-pressed`, and switch accessible text between `置顶会话：<title>` and `取消置顶：<title>`.

```tsx
{onPin && !session.child && (
  <button type="button" onClick={(event) => { event.stopPropagation(); onPin(); }} aria-pressed={session.pinned}>
    <Pin aria-hidden="true" />
  </button>
)}
```

- [x] **Step 2: Keep the pinned action visible and geometrically stable**

Use the same `28px` action geometry as delete, keep pinned rows visible with the existing accent action class, and add the pin selector to the touch visibility rule.

- [x] **Step 3: Test action order and accessibility**

Render pinned, unpinned, and child rows; assert icon order, labels, pressed state, click isolation, child omission, and CSS source contracts.

### Task 3: Wire Pinning Into Both Session Lists

**Files:**
- Modify: `packages/desktop/renderer/App.tsx`
- Modify: `packages/desktop/renderer/components/SidebarReferenceStyle.test.ts`

**Interfaces:**
- Consumes: UI store pin state/actions and `sortPinnedSessionsFirst`.
- Produces: a top-level pinned section, unpinned project lists, and pinned-first search overlay results.

- [x] **Step 1: Read pin state and compose sidebar ordering**

Build a `Set` for membership. Collect pinned root sessions with their owning project IDs, render that collection before `projects.map`, and filter pinned roots from each project list.

```ts
const pinnedRootSessions = Object.entries(sessionsByProject)
  .flatMap(([projectId, sessions]) => sessions
    .filter((session) => pinnedSessionIdSet.has(session.id))
    .map((session) => ({ projectId, session })));
const projSessions = projectSessions.filter((session) => !pinnedSessionIdSet.has(session.id));
```

- [x] **Step 2: Reuse root rendering in pinned, project, and search paths**

Render pinned roots above the workspace list with their existing child disclosure, selection, pin, and delete behavior. Pass pin state and callbacks in project/search paths, and clear removed IDs after successful deletion.

- [x] **Step 3: Add source-contract coverage for all rendering paths**

Assert the pinned section occurs before `projects.map`, pinned roots are excluded from their original project lists, children do not expose pinning, search results use pinned-first ordering, and deletion clears pin IDs.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run: `PATH=/opt/homebrew/opt/node@22/bin:$PATH bunx vitest run packages/desktop/renderer/lib/sidebar-session-sort.test.ts packages/desktop/renderer/stores/uiStore.test.ts packages/desktop/renderer/components/SidebarSessionRow.test.tsx packages/desktop/renderer/components/SidebarReferenceStyle.test.ts`

Expected: PASS

Then run Desktop and Web type checks plus the WebApp build. If a check fails, fix the implementation or test and rerun until it passes.
