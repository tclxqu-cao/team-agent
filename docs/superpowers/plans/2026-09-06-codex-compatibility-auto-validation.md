# Codex Compatibility Auto Validation Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically settle newly discovered Codex `checking` compatibility states without requiring a message send or session open.

**Architecture:** The disk catalog reports only new or changed probeable `checking` entries after its initial scan. `CodexSessionCompatibilityService` serializes and deduplicates background probes, classifies results through the existing compatibility rules, rejects stale results by file identity, and notifies `UnifiedSessionService` to invalidate discovery caches.

**Tech Stack:** TypeScript, Node.js, Vitest, Codex app-server adapter.

## Global Constraints

- Do not automatically probe cached historical entries during startup.
- Use one background compatibility probe at a time.
- Keep transient runtime unavailability as `checking`.
- Preserve sidebar status-dot behavior and the existing 10-second selected-session refresh.
- Do not add renderer polling or a new event channel.

---

### Task 1: Catalog Increment Notification

**Files:**
- Modify: `packages/desktop/main/agent-runtime/codex-session-disk-catalog.ts`
- Unit tests: `packages/desktop/main/agent-runtime/codex-session-disk-catalog.test.ts`

**Interfaces:**
- Consumes: parsed `CodexDiskSessionCatalogEntry` values from reconciliation.
- Produces: `onCheckingEntry?: (entry: CodexDiskSessionCatalogEntry) => void` option called for new or changed probeable checking entries after the initial scan.

- [x] **Step 1: Add the catalog callback option**

Add `onCheckingEntry` to `CodexSessionDiskCatalogOptions` and compare each changed parsed entry with the pre-scan cache.

- [x] **Step 2: Notify only eligible incremental entries**

After committing the next catalog snapshot, call the callback only when `hasCompletedScan` is true, `probeable` is true, and compatibility is `checking`.

- [x] **Step 3: Test startup exclusion and incremental notification**

Create a catalog fixture that performs a cold scan and a changed-file scan; assert no cold notification and exactly one notification carrying the changed file identity.

### Task 2: Background Compatibility Probe

**Files:**
- Modify: `packages/desktop/main/agent-runtime/codex-session-compatibility.ts`
- Unit tests: `packages/desktop/main/agent-runtime/codex-session-compatibility.test.ts`

**Interfaces:**
- Consumes: `onCheckingEntry` notifications and `AgentRuntimeAdapter.getSession(nativeSessionId)`.
- Produces: serialized background probes and optional `onCompatibilityChanged(): void` callback.

- [x] **Step 1: Register the catalog notification handler**

Allow the compatibility service to install the catalog callback during construction without probing repository entries loaded before `start()`.

- [x] **Step 2: Implement a deduplicated single-concurrency queue**

Queue by `nativeSessionId`, retain the latest entry identity, and process one adapter read at a time. Before writing a result, confirm the catalog still contains the same `canonicalPath`, `size`, and `mtimeNs`.

- [x] **Step 3: Reuse result classification safely**

Write `direct` on success, write `incompatible/CODEX_SESSION_DIRECT_READ_FAILED` on a definitive read failure, and retain `checking` for `RUNTIME_UNAVAILABLE`.

- [x] **Step 4: Test success, transient errors, incremental notification, and stale-result identity guards**

Use deferred adapter promises to assert serial execution and that a changed entry cannot receive an old probe result.

### Task 3: Discovery Cache Invalidation

**Files:**
- Modify: `packages/desktop/main/agent-runtime/unified-session-service.ts`
- Modify: `packages/desktop/main/agent-runtime/native-runtime-broker.ts`
- Unit tests: `packages/desktop/main/agent-runtime/unified-session-service.test.ts`

**Interfaces:**
- Consumes: compatibility service `onCompatibilityChanged` callback.
- Produces: invalidated global discovery and Codex workspace-index caches.

- [x] **Step 1: Add a compatibility-change invalidation method**

Clear `discoveryPromise` and invalidate the Codex workspace index without touching detail history caches.

- [x] **Step 2: Wire service construction to invalidation**

Connect the compatibility service callback after `UnifiedSessionService` construction, avoiding constructor cycles.

- [x] **Step 3: Test refreshed discovery after a compatibility update**

Assert a previously cached supplemental summary is rediscovered with its settled compatibility state.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run: `npx vitest run packages/desktop/main/agent-runtime/codex-session-disk-catalog.test.ts packages/desktop/main/agent-runtime/codex-session-compatibility.test.ts packages/desktop/main/agent-runtime/unified-session-service.test.ts packages/desktop/main/agent-runtime/native-runtime-broker.test.ts`

Expected: PASS

Run: `npx tsc --noEmit -p packages/desktop/tsconfig.json && npx tsc --noEmit -p packages/server/tsconfig.json && git diff --check`

Expected: PASS
