# Codex Native Session Archive Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Archive Codex threads through `thread/archive` and prevent deleted sessions from being restored by stale paginated WebApp state.

**Architecture:** Add an optional native archive capability to the runtime adapter boundary and implement it only for Codex. The Broker invokes that capability before persisting its defensive tombstone, while the renderer invalidates older requests and synchronously removes the deleted row from live and persisted workspace caches.

**Tech Stack:** TypeScript, Codex App Server JSON-RPC, Electron/React, Next.js gateway, Vitest, SQLite.

## Global Constraints

- Codex `thread/archive` receives only `{ threadId: nativeSessionId }`.
- Claude Code and OpenCode remain tombstone-only; Customer Agent remains permanently deleted.
- A failed Codex archive must not create a new Broker tombstone.
- Keep the existing `{ "status": "deleted" }` HTTP response shape.
- Do not add archived-session browsing, unarchive, permanent Codex deletion, or direct rollout-file mutation.
- Preserve unrelated later-page sessions during first-page refresh.

---

### Task 1: Codex Archive Capability

**Files:**
- Modify: `packages/desktop/main/agent-runtime/types.ts`
- Modify: `packages/desktop/main/agent-runtime/codex-runtime-adapter.ts`
- Unit tests: `packages/desktop/main/agent-runtime/codex-runtime-adapter.test.ts`

**Interfaces:**
- Consumes: `CodexAppServerClient.request(method, params)`.
- Produces: `AgentRuntimeAdapter.archiveSession?(nativeSessionId: string): Promise<void>` and `CodexRuntimeAdapter.archiveSession(nativeSessionId: string): Promise<void>`.

- [ ] **Step 1: Add the optional adapter capability**

Add this method beside the existing optional `delete` method:

```ts
archiveSession?(nativeSessionId: string): Promise<void>;
```

- [ ] **Step 2: Implement Codex native archive**

Add a focused adapter method that makes exactly one protocol request:

```ts
async archiveSession(nativeSessionId: string): Promise<void> {
  await this.client.request("thread/archive", { threadId: nativeSessionId });
}
```

- [ ] **Step 3: Cover the protocol request**

Create an adapter with a `vi.fn()` request client, call `archiveSession("thread-1")`, and assert:

```ts
expect(request).toHaveBeenCalledTimes(1);
expect(request).toHaveBeenCalledWith("thread/archive", { threadId: "thread-1" });
```

### Task 2: Unified Service And Broker Delete Strategy

**Files:**
- Modify: `packages/desktop/main/agent-runtime/unified-session-service.ts`
- Modify: `packages/desktop/main/agent-runtime/native-runtime-broker.ts`
- Unit tests: `packages/desktop/main/agent-runtime/unified-session-service.test.ts`
- Unit tests: `packages/desktop/main/agent-runtime/native-runtime-broker.test.ts`

**Interfaces:**
- Consumes: `AgentRuntimeAdapter.archiveSession?(nativeSessionId)` from Task 1 and the existing unified session ID decoder.
- Produces: `UnifiedSessionService.archive(id: string): Promise<void>` and a Broker `delete(sessionId)` that archives Codex before hiding it.

- [ ] **Step 1: Add unified archive dispatch**

Resolve the owning adapter, reject active sessions and unsupported adapters, invoke native archive, then invalidate all relevant caches:

```ts
async archive(id: string): Promise<void> {
  const { adapter, nativeSessionId } = this.resolveAdapter(id);
  if (this.activeSessionIds.has(id)) {
    throw new RuntimeSessionError("Session is currently running", "SESSION_OCCUPIED");
  }
  if (!adapter.archiveSession) {
    throw new RuntimeSessionError("This session cannot be archived", "OPERATION_NOT_SUPPORTED");
  }
  await adapter.archiveSession(nativeSessionId);
  this.invalidate(id);
}
```

- [ ] **Step 2: Split Broker preflight from tombstone mutation**

Add a state method that checks active-run occupancy without writing. Reuse it from `hideSession` so both Codex and non-Codex paths retain the same guard:

```ts
assertSessionCanHide(sessionId: string): void {
  if (this.activeRun(sessionId)) {
    throw new RuntimeSessionError("Session is currently running", "SESSION_OCCUPIED");
  }
}
```

- [ ] **Step 3: Route Codex deletion through native archive first**

Keep repeat deletion idempotent, reject occupied sessions before mutation, archive only Codex, then persist local cleanup:

```ts
async delete(sessionId: string): Promise<void> {
  if (this.state.isSessionHidden(sessionId)) return;
  this.state.assertSessionCanHide(sessionId);
  if (decodeNativeSessionId(sessionId).agentType === "codex") {
    await this.runtime.archive(sessionId);
  }
  this.state.hideSession(sessionId);
  this.pendingCreations.delete(sessionId);
  this.runtime.invalidate(sessionId);
}
```

- [ ] **Step 4: Test service archive dispatch and cache invalidation**

Extend the test adapter factory with `supportsArchive` and assert the native ID is passed to `archiveSession`. Also assert unsupported and active-session paths return `OPERATION_NOT_SUPPORTED` and `SESSION_OCCUPIED` respectively.

- [ ] **Step 5: Test Broker ordering and runtime isolation**

Extend `FakeNativeRuntime` with an `archive` spy/failure. Assert Codex deletion archives once before disappearing; an archive failure leaves `list()` unchanged and permits retry; repeated successful deletion is idempotent; Claude Code and OpenCode IDs do not call archive; the existing occupied deletion test still rejects before archive.

### Task 3: Explicit Pending Preservation

**Files:**
- Modify: `packages/desktop/renderer/lib/agent-workspace-cache.ts`
- Modify: `packages/desktop/renderer/lib/agent-workspace-cache.test.ts`
- Modify: `packages/desktop/renderer/App.tsx`

**Interfaces:**
- Consumes: an explicit `pendingSession` supplied by the create/fork callback.
- Produces: `preservePendingNativeSession(refreshed, pendingSession)` that cannot preserve an arbitrary selected stale row.

- [ ] **Step 1: Replace selection-based preservation**

Replace `preserveSelectedPendingNativeSession` with an explicit helper:

```ts
export function preservePendingNativeSession(
  refreshed: readonly UnifiedSessionSummary[],
  pendingSession?: UnifiedSessionSummary,
): UnifiedSessionSummary[] {
  if (!pendingSession || refreshed.some((session) => session.id === pendingSession.id)) {
    return [...refreshed];
  }
  return [pendingSession, ...refreshed];
}
```

- [ ] **Step 2: Update workspace load reconciliation**

Pass only `options.pendingSession` to the helper after normal page reconciliation. A missing selected session without an explicit pending summary must fall through to `applySidebarSelection(EMPTY_SIDEBAR_SELECTION)`.

- [ ] **Step 3: Update focused tests**

Assert an explicit native pending session is preserved, a duplicate is not added, and an absent pending argument cannot preserve a stale selected row.

### Task 4: Delete Race And Persistent Cache Cleanup

**Files:**
- Modify: `packages/desktop/renderer/App.tsx`
- Modify: `packages/desktop/renderer/lib/session-deletion.ts`
- Unit tests: `packages/desktop/renderer/lib/session-deletion.test.ts`
- Unit tests: `packages/desktop/renderer/components/SidebarReferenceStyle.test.ts`

**Interfaces:**
- Consumes: `removeSessionFromCollections` and the workspace cache structures.
- Produces: `removeSessionIdsFromWorkspacePartition(partition, removedIds)` for synchronous persistent-cache cleanup.

- [ ] **Step 1: Add workspace partition cache removal**

Remove deleted IDs from every cached workspace session page and clear a matching selected session:

```ts
export function removeSessionIdsFromWorkspacePartition(
  partition: AgentWorkspacePartition,
  removedIds: readonly string[],
): AgentWorkspacePartition {
  const removed = new Set(removedIds);
  return {
    ...partition,
    selectedSessionId: partition.selectedSessionId && removed.has(partition.selectedSessionId)
      ? null
      : partition.selectedSessionId,
    sessions: Object.fromEntries(Object.entries(partition.sessions).map(([id, page]) => [
      id,
      { ...page, data: page.data.filter((session) => !removed.has(session.id)) },
    ])),
  };
}
```

- [ ] **Step 2: Keep latest collection refs**

Add refs for `sessionsByProject` and `childSessionsByParent`, update them on render, and make `loadSessions` read these refs instead of captured state. This makes a post-delete refresh start from the already-pruned collection.

- [ ] **Step 3: Invalidate in-flight workspace responses on delete**

After DELETE succeeds and before changing list state, increment the request generation for the owning `${agentType}:${projectId}` key. Older responses will fail the existing request-ID equality check.

- [ ] **Step 4: Apply deletion synchronously across live and persisted state**

Compute `removeSessionFromCollections` from the refs, assign the new ref values before calling React setters, update the active agent partition in `workspaceCacheRef`, and call `writeAgentWorkspaceCache` immediately. Then clear selection if needed and start the authoritative refresh.

- [ ] **Step 5: Update confirmation copy**

Return this Codex-specific string before the generic external-runtime branch:

```ts
if (session.agentType === "codex") {
  return `确定归档 Codex 会话“${session.title}”并从 AgentRoam 中移除吗？可在 Codex 的已归档会话中恢复。`;
}
```

- [ ] **Step 6: Cover cache cleanup and UI contract**

Assert removal clears all cached copies and selected IDs without dropping cursors or unrelated rows. Update sidebar source-contract assertions to require request-generation invalidation, current refs, immediate persisted-cache removal, and the Codex archive wording.

### Task 5: API Compatibility And Diff Audit

**Files:**
- Verify: `packages/server/app/api/sessions/[id]/route.ts`
- Verify: all files modified in Tasks 1-4

**Interfaces:**
- Consumes: the existing server `DELETE /api/sessions/:id` delegation.
- Produces: unchanged HTTP success shape and a scoped implementation diff.

- [ ] **Step 1: Confirm the server route needs no response change**

Verify native deletion still delegates to `getNativeRuntimeService().delete(params.id)` and returns:

```ts
return NextResponse.json({ status: "deleted" });
```

- [ ] **Step 2: Audit the scoped diff**

Run `git diff --check` and inspect only the affected runtime and renderer source/test files. Preserve all pre-existing unrelated working-tree edits.

## Final Unit Test Verification

- [ ] **Main agent: run affected unit tests after development is complete**

Run:

```bash
source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && bunx vitest run \
  packages/desktop/main/agent-runtime/codex-runtime-adapter.test.ts \
  packages/desktop/main/agent-runtime/unified-session-service.test.ts \
  packages/desktop/main/agent-runtime/native-runtime-broker.test.ts \
  packages/desktop/renderer/lib/agent-workspace-cache.test.ts \
  packages/desktop/renderer/lib/session-deletion.test.ts \
  packages/desktop/renderer/components/SidebarReferenceStyle.test.ts
bunx tsc --noEmit -p packages/desktop/tsconfig.json
bunx tsc --noEmit -p packages/webapp/tsconfig.json
git diff --check
```

Expected: all focused tests pass, both TypeScript checks exit 0, and `git diff --check` prints no errors. If a test fails, fix the implementation or test and rerun this command until it passes. Report the command and result in the final response.

