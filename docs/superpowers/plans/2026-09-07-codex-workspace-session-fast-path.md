# Codex Workspace Session Fast Path Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an ordinary Codex project show its first 20 sessions without waiting for a full 4.4 GB session-catalog discovery, while retaining legacy cwd sessions, compatibility supplements, and stable pagination after background reconciliation.

**Architecture:** Native Codex workspaces use the adapter's existing `thread/list(projectId)` page as the foreground response. The global classified catalog remains the source for the derived Recent workspace, imported workspaces, legacy cwd rows, and compatibility supplements; ordinary workspace requests start that catalog in the background and merge their fresh direct rows into it. Codex cursors are tagged by source so a request can continue the same native or catalog pagination mode even if background reconciliation finishes between pages.

**Tech Stack:** TypeScript, Codex app-server JSON-RPC, Vitest, Node 22

## Global Constraints

- Preserve existing native, imported, Recent, legacy cwd, compatibility, hidden-session, and pending-session behavior.
- Do not invalidate the Codex session catalog for an unchanged 15-second workspace refresh.
- Do not add dependencies or change public HTTP routes.
- Use `PATH=/opt/homebrew/opt/node@22/bin:$PATH` for tests and type checks.
- Do not modify or remove unrelated dirty worktree files.

---

### Task 1: Codex Cursor And Catalog Reconciliation

**Files:**
- Modify: `packages/desktop/main/agent-runtime/agent-workspace-index.ts`
- Unit tests: `packages/desktop/main/agent-runtime/agent-workspace-index.test.ts`

**Interfaces:**
- Consumes: `WorkspacePage<UnifiedSessionSummary>`, `paginateByOffset()`, adapter `listWorkspaceSessions()` and `discoverSessions()`.
- Produces: tagged opaque Codex native/catalog cursors and a merged `SessionCatalog` whose direct project rows override stale rows by session ID.

- [x] **Step 1: Add cursor helpers**

Add internal helpers that encode/decode `codex-native:` cursors and `codex-catalog:` offset cursors. Accept the previous untagged offset cursor as a legacy catalog cursor.

- [x] **Step 2: Track fresh direct pages**

Add a per-workspace map of directly fetched Codex summaries. Merge by session ID, prefer direct rows, sort by descending `updated`, and apply these rows whenever a background classified catalog completes.

- [x] **Step 3: Preserve stable pagination mode**

Return native-tagged cursors while the caller is paging the direct source and catalog-tagged cursors after catalog reconciliation. Never reinterpret a native cursor as an offset merely because the background catalog completed.

### Task 2: Native Workspace Foreground Fast Path

**Files:**
- Modify: `packages/desktop/main/agent-runtime/agent-workspace-index.ts`
- Unit tests: `packages/desktop/main/agent-runtime/agent-workspace-index.test.ts`

**Interfaces:**
- Consumes: workspace catalog entries with `source: "native"` and adapter `listWorkspaceSessions(workspaceId, query)`.
- Produces: `listCodexWorkspaceSessions()` behavior where native projects return the direct project page first, while Recent/imported workspaces retain classified-catalog behavior.

- [x] **Step 1: Route ordinary native workspaces directly**

Resolve the workspace from the existing workspace cache. For `source: "native"`, call the adapter with the requested limit, refresh flag, and decoded native cursor; wrap its next cursor before returning.

- [x] **Step 2: Reconcile an already available catalog**

When the classified catalog is already available, merge the direct page into that workspace and return the catalog page. For a catalog cursor, continue from the catalog without issuing a second native request.

- [x] **Step 3: Start full discovery without blocking first paint**

When no classified catalog exists, return the native page and start one coalesced background `getCodexSessionCatalog(adapter, false)` request. Catch background failures so a fast native page remains usable.

- [x] **Step 4: Keep global-only workspaces complete**

Continue awaiting the classified catalog for `codex:recent` and imported workspaces, because their membership depends on global path classification and compatibility supplementation.

### Task 3: Precise Cache Invalidation

**Files:**
- Modify: `packages/desktop/main/agent-runtime/agent-workspace-index.ts`
- Unit tests: `packages/desktop/main/agent-runtime/agent-workspace-index.test.ts`

**Interfaces:**
- Consumes: previous and refreshed `WorkspaceCatalog` values.
- Produces: a classification comparison based on workspace ID, source, and normalized roots.

- [x] **Step 1: Compare workspace classification inputs**

Ignore names, display order, timestamps, and watermark changes. Treat added/removed workspace IDs, source changes, or normalized root changes as classification changes.

- [x] **Step 2: Stop unconditional invalidation**

Replace the current `query.refresh && agentType === "codex"` unconditional `clearSessionCache()` with invalidation only when the classification inputs changed. Explicit runtime/session and compatibility invalidations remain unchanged.

- [x] **Step 3: Add regression coverage**

Prove that an unchanged workspace refresh does not cause a second `discoverSessions()` call, while a root or membership change does invalidate and rebuild the catalog.

### Task 4: Behavioral Regression Tests

**Files:**
- Modify: `packages/desktop/main/agent-runtime/agent-workspace-index.test.ts`

**Interfaces:**
- Consumes: the completed fast-path implementation.
- Produces: focused executable contracts for foreground latency behavior and reconciliation correctness.

- [x] **Step 1: Test non-blocking foreground behavior**

Hold `discoverSessions()` unresolved, resolve `listWorkspaceSessions()` immediately, and assert that the native workspace page returns before global discovery resolves.

- [x] **Step 2: Test background legacy and compatibility merging**

Resolve the background catalog with project-ID, legacy cwd, and supplemental rows, refresh the first page, and assert deduplication, ordering, and project assignment.

- [x] **Step 3: Test cursor continuity**

Assert that a native next cursor continues adapter pagination after the catalog becomes available, and that catalog pagination returns all rows once with tagged offset cursors.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run: `PATH=/opt/homebrew/opt/node@22/bin:$PATH bunx vitest run packages/desktop/main/agent-runtime/agent-workspace-index.test.ts packages/desktop/main/agent-runtime/native-runtime-broker.test.ts packages/desktop/main/agent-runtime/codex-runtime-adapter.test.ts`

Expected: PASS

Run: `PATH=/opt/homebrew/opt/node@22/bin:$PATH bunx tsc --noEmit -p packages/desktop/tsconfig.json`

Expected: PASS

If a test fails, fix the implementation or test and rerun these commands until they pass. Report the commands and results in the final response.
