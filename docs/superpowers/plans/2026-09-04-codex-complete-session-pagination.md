# Codex Complete Session Pagination Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show every Codex session, including legacy and unassigned sessions, while loading each workspace in 20-row pages on scroll.

**Architecture:** `AgentWorkspaceIndexService` will add a synthetic Codex `最近` workspace and build one complete Codex session snapshot from `discoverSessions()`. It will classify each session by native project ID first and normalized longest workspace-root match second, then paginate each classified list with the existing opaque offset cursor. The renderer will honor workspace creation capability, request 20 rows per page, and retain every reconciled row without a hidden 300-session cap.

**Tech Stack:** TypeScript, React 18, Electron/Next native runtime broker, Codex app-server JSON-RPC, Vitest.

## Global Constraints

- Each workspace session request uses a page size of exactly 20.
- Twenty is a page size, not a total session limit.
- `最近` contains only Codex sessions that do not match a native project ID or any normalized native/imported workspace root.
- A native Codex project ID match takes precedence over path matching.
- Path matching must respect directory boundaries and choose the longest matching root.
- The synthetic `最近` workspace cannot create sessions.
- Preserve unrelated dirty-worktree changes.

---

### Task 1: Codex Workspace Classification And Pagination

**Files:**
- Modify: `packages/desktop/main/agent-runtime/types.ts`
- Modify: `packages/desktop/main/agent-runtime/agent-workspace-index.ts`
- Modify: `packages/desktop/main/agent-runtime/native-runtime-broker.ts`
- Unit tests: `packages/desktop/main/agent-runtime/agent-workspace-index.test.ts`
- Unit tests: `packages/desktop/main/agent-runtime/native-runtime-broker.test.ts`

**Interfaces:**
- Consumes: `AgentRuntimeAdapter.discoverSessions()`, native/imported `AgentWorkspace` rows, and `paginateByOffset()`.
- Produces: `CODEX_RECENT_WORKSPACE_ID`, `AgentWorkspace.canCreateSession`, and workspace-scoped Codex pages built from a classified complete snapshot.

- [x] **Step 1: Extend the workspace DTO with creation capability**

```ts
export interface AgentWorkspace {
  // Existing identity, roots, ordering, and source fields remain unchanged.
  canCreateSession?: boolean;
}
```

Treat an omitted value as `true`; set it to `false` only for the synthetic `最近` workspace.

- [x] **Step 2: Add the synthetic Codex workspace and classification helper**

```ts
export const CODEX_RECENT_WORKSPACE_ID = "codex:recent";

const recentWorkspace: AgentWorkspace = {
  agentType: "codex",
  workspaceId: CODEX_RECENT_WORKSPACE_ID,
  name: "最近",
  roots: [],
  order: -1,
  source: "derived",
  canCreateSession: false,
};
```

Classify a session by exact known `projectId`; otherwise normalize `cwd`, select the longest boundary-safe matching workspace root, and fall back to `CODEX_RECENT_WORKSPACE_ID`. Project the chosen workspace ID onto each summary so renderer selection and refresh remain stable.

- [x] **Step 3: Build and reuse a complete Codex session snapshot**

On the first Codex workspace-session request, call `discoverSessions()` once, deduplicate by unified session ID, sort by `updated` descending, classify against the full cached workspace catalog, and store the grouped snapshot. Reuse the snapshot for later cursor pages. Rebuild it on a first-page refresh or workspace invalidation, and retain existing stale-page fallback behavior if rebuilding fails.

- [x] **Step 4: Add focused classification and pagination tests**

```ts
expect(page1.data).toHaveLength(20);
expect(page2.data).toHaveLength(20);
expect(page3.data).toHaveLength(5);
expect(new Set([...page1.data, ...page2.data, ...page3.data].map((row) => row.id)).size).toBe(45);
```

Cover five project-ID plus two legacy-path sessions, longest nested-root selection, sibling-prefix rejection, imported-root assignment, unmatched `最近` assignment, stable ordering, and snapshot reuse across cursor pages.

- [x] **Step 5: Fill visible pages across hidden-session tombstones**

Continue fetching from the underlying opaque cursor until the requested number of visible rows is available or the source is exhausted. Preserve the final consumed cursor so a fully hidden source page cannot make the renderer stop before later sessions.

### Task 2: Renderer Paging And Synthetic Workspace Behavior

**Files:**
- Modify: `packages/desktop/renderer/global.d.ts`
- Modify: `packages/desktop/renderer/App.tsx`
- Modify: `packages/desktop/renderer/lib/agent-workspace-cache.ts`
- Unit tests: `packages/desktop/renderer/lib/agent-workspace-cache.test.ts`
- Unit tests: `packages/desktop/renderer/components/SidebarReferenceStyle.test.ts`

**Interfaces:**
- Consumes: `AgentWorkspace.canCreateSession` and existing workspace/session cursors.
- Produces: 20-row scroll requests, unlimited in-memory/cache reconciliation, and a non-creatable `最近` row.

- [x] **Step 1: Preserve `canCreateSession` through renderer mapping and cache parsing**

```ts
canCreateSession: workspace.canCreateSession,
```

Accept only boolean values from cached JSON. Missing values remain backward-compatible and mean session creation is allowed.

- [x] **Step 2: Request 20 rows and remove the 300-row truncation**

Change the session-page request in `loadSessions()` from `limit: 50` to `limit: 20`. Remove both `.slice(0, 300)` calls from session reconciliation/cache hydration so every fetched page remains reachable and a completed cursor cannot coexist with silently truncated cached data.

- [x] **Step 3: Make `最近` read-only in the sidebar**

Render a history icon for workspaces with `canCreateSession === false`, omit their row-level create button, and make the bottom create button use the same `请先选择目录` feedback when the selected workspace cannot create sessions. Keep disclosure, session selection, status, resume, and delete/hide behavior unchanged.

- [x] **Step 4: Update renderer contract tests**

Assert the 20-row request, absence of the cache cap, creation-capability round trip, history icon/read-only branch, retained scroll cursor loading, and unchanged behavior for ordinary workspaces.

### Task 3: Integration Verification And Plan Tracking

**Files:**
- Modify: `docs/superpowers/plans/2026-09-04-codex-complete-session-pagination.md`

**Interfaces:**
- Consumes: completed runtime and renderer changes from Tasks 1 and 2.
- Produces: checked-off plan status and verified delivery evidence.

- [x] **Step 1: Mark completed implementation steps**

Replace each completed task checkbox with `- [x]` only after its code and focused tests are present.

- [x] **Step 2: Check the final diff scope**

Run `git diff --check` and inspect `git status --short` to confirm only the plan, runtime index/types/tests, and renderer mapping/cache/tests were intentionally changed by this task.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run:

```bash
bunx vitest run \
  packages/desktop/main/agent-runtime/agent-workspace-index.test.ts \
  packages/desktop/main/agent-runtime/native-runtime-broker.test.ts \
  packages/desktop/main/agent-runtime/unified-session-service.test.ts \
  packages/desktop/main/agent-runtime/codex-runtime-adapter.test.ts \
  packages/desktop/renderer/lib/agent-workspace-cache.test.ts \
  packages/desktop/renderer/components/SidebarReferenceStyle.test.ts
bunx tsc -p packages/desktop/tsconfig.json --noEmit
```

Expected: all focused tests pass and the Desktop TypeScript check exits successfully.

If a test fails, fix the implementation or test and rerun these commands until they pass. Report the commands and results in the final response.
