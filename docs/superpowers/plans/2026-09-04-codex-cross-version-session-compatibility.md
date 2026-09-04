# Codex Cross-Version Session Compatibility Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep active Codex rollout sessions visible across producer versions, continue every session the selected App Server can read, and report a specific version incompatibility when it cannot.

**Architecture:** Add a broker-owned, SQLite-backed disk metadata catalog beside the existing Codex adapter. The workspace index merges only cached disk rows whose native IDs are absent from the unchanged App Server snapshot; opening a supplemental row performs one explicit probe through the unchanged `AgentRuntimeAdapter.getSession` path and either promotes it to direct use or fails closed with structured compatibility metadata.

**Tech Stack:** TypeScript, Node.js filesystem APIs, better-sqlite3 through `SQLiteDatabase`, Vitest, React/Electron IPC.

## Global Constraints

- Do not modify `CodexRuntimeAdapter.discoverSessions`, `listWorkspaceSessions`, `listWorkspaceSessionsByPath`, `getSession`, `thread/read` construction, turn conversion, pagination, or live-follow projection.
- Existing App Server summaries win every field collision and retain their serialized shape without a `compatibility` field.
- List requests never await an uncached disk scan and never read rollout bodies.
- Metadata reads stop at the first newline and at 256 KiB per changed file.
- Metadata-read concurrency is capped at `min(8, availableParallelism())`.
- An unchanged warm scan reads zero rollout-content bytes.
- Automatic scans debounce for 500 ms, repair every 60 seconds, and open a five-minute circuit breaker after three budget breaches.
- No migration rule is enabled without full-history fixtures plus App Server import, read-back, resume, and first-turn validation; unsupported sessions remain visible with a version incompatibility reason.

---

### Task 1: Compatibility Contract

**Files:**
- Modify: `packages/desktop/main/agent-runtime/types.ts`
- Modify: `packages/desktop/renderer/global.d.ts`
- Modify: `packages/desktop/renderer/App.tsx`

**Interfaces:**
- Produces: `SessionCompatibilityStatus`, `CodexCompatibilityReasonCode`, and `SessionCompatibility`; optional `UnifiedSessionSummary.compatibility` and `UnifiedSessionSummary.migratedFrom`.

- [x] **Step 1: Add the shared runtime contract**

```ts
export type SessionCompatibilityStatus = "checking" | "direct" | "migratable" | "incompatible";
export type CodexCompatibilityReasonCode =
  | "CODEX_SESSION_VERSION_UNSUPPORTED"
  | "CODEX_SESSION_SCHEMA_UNKNOWN"
  | "CODEX_SESSION_DIRECT_READ_FAILED"
  | "CODEX_SESSION_IMPORT_UNAVAILABLE"
  | "CODEX_SESSION_MIGRATION_FAILED"
  | "CODEX_SESSION_SOURCE_ACTIVE"
  | "CODEX_SESSION_ASSET_REQUIRED"
  | "CODEX_SESSION_RUNTIME_UNAVAILABLE";
```

- [x] **Step 2: Preserve backward-compatible summary serialization**

Add only optional fields. Existing App Server rows never receive either field.

### Task 2: Bounded Disk Metadata Catalog

**Files:**
- Create: `packages/desktop/main/agent-runtime/codex-session-disk-catalog.ts`
- Create: `packages/desktop/main/agent-runtime/codex-session-disk-catalog.test.ts`

**Interfaces:**
- Produces: `CodexDiskSessionCatalogEntry`, `CodexSessionCatalogRepository`, `CodexSessionDiskCatalog.snapshot()`, `scheduleReconciliation()`, `reconcile()`, `findByNativeSessionId()`, `updateCompatibility()`, and `dispose()`.
- Consumes: injectable `CodexSessionCatalogFileSystem.readMetadata(path, maxBytes)` so tests can assert exact rollout-content bytes.

- [x] **Step 1: Implement strict rollout metadata parsing**

Parse only the first JSONL record, require `session_meta`, recover a strict UUID from the filename when metadata is malformed, derive a stable diagnostic ID otherwise, and produce safe summaries without exposing the canonical source path.

- [x] **Step 2: Implement incremental scanning**

Canonicalize the configured sessions root, reject symlinks and escaping paths, stat candidates before reading, preserve unchanged cached decisions, and process changed files with a worker pool capped by `min(8, availableParallelism())`.

- [x] **Step 3: Implement scheduling and performance protection**

Return cached rows synchronously, debounce filesystem notifications by 500 ms, run a 60-second repair scan, yield between batches, track metadata bytes, and stop automatic scans for five minutes after three consecutive budget breaches.

- [x] **Step 4: Cover scanner boundaries**

Tests assert duplicate-free metadata rows, 256 KiB caps, zero warm content reads, changed-file-only reads, symlink rejection, isolated malformed files, and circuit-breaker behavior.

### Task 3: Adjacent Compatibility Service

**Files:**
- Create: `packages/desktop/main/agent-runtime/codex-session-compatibility.ts`
- Create: `packages/desktop/main/agent-runtime/codex-session-compatibility.test.ts`
- Modify: `packages/desktop/main/agent-runtime/agent-workspace-index.ts`
- Modify: `packages/desktop/main/agent-runtime/unified-session-service.ts`

**Interfaces:**
- Produces: `CodexSessionCompatibilityService.supplement(primary)`, `isSupplemental(nativeSessionId)`, `readSupplemental(nativeSessionId)`, and `dispose()`.
- Consumes: the existing `AgentRuntimeAdapter.getSession(nativeSessionId)` public operation without changing it.

- [x] **Step 1: Reconcile with App Server precedence**

Merge cached catalog rows by native ID after `adapter.discoverSessions()` returns. Keep primary ordering and fields byte-for-byte equivalent; append only missing rows and schedule, but never await, disk reconciliation.

- [x] **Step 2: Route supplemental reads outside the adapter**

For a strict native ID, call the existing `getSession` once. Return its result unchanged on success and persist `direct`; on failure persist `incompatible` and throw `RuntimeSessionError` with `CODEX_SESSION_VERSION_INCOMPATIBLE` plus producer and reader versions.

- [x] **Step 3: Protect frozen paths with tests**

Tests assert primary rows never enter the compatibility reader, a stalled scan does not delay primary discovery, duplicates are suppressed, and invalid catalog IDs never reach the adapter.

### Task 4: Broker-Owned Persistence And Wiring

**Files:**
- Modify: `packages/desktop/main/agent-runtime/native-runtime-broker.ts`
- Modify: `packages/desktop/main/agent-runtime/native-runtime-broker.test.ts`

**Interfaces:**
- Produces: broker SQLite implementation of `CodexSessionCatalogRepository` and passes it through `NativeRuntimeBrokerCallbacks` to the direct host runtime.
- Consumes: `CodexSessionCompatibilityService` in the host-only `UnifiedSessionService`; broker clients continue using the existing methods.

- [x] **Step 1: Add the catalog table and bounded transaction**

Store canonical path, file identity, safe metadata, compatibility decision, schema version, registry version, and reader version. Replace one scan generation in a single SQLite transaction and delete only catalog rows absent from that generation.

- [x] **Step 2: Construct the compatibility service only in the broker host**

Share the existing Codex adapter for explicit probes, start the disk catalog in the background, and dispose its watcher/timer with the unified runtime.

- [x] **Step 3: Verify persistence and existing broker behavior**

Restart a broker against the same directory and assert cached supplemental rows survive without changing hidden-session, pending-session, occupancy, or pagination behavior.

### Task 5: Compatibility Presentation

**Files:**
- Modify: `packages/desktop/renderer/App.tsx`
- Modify: `packages/desktop/renderer/components/SidebarSessionRow.tsx`
- Modify: `packages/desktop/renderer/components/ChatView.tsx`
- Modify: `packages/desktop/renderer/components/SidebarReferenceStyle.test.ts`

**Interfaces:**
- Consumes: optional `UnifiedSessionSummary.compatibility`.
- Produces: a compact sidebar status icon and a read-only compatibility notice with producer version, reader version, and safe reason.

- [x] **Step 1: Render supplemental state without changing ordinary rows**

Show a spinner icon for `checking` and an alert icon for `incompatible`; existing sessions render exactly as before.

- [x] **Step 2: Keep a successful explicit probe usable immediately**

While the selected supplemental row loads, disable composing. If the unchanged detail read succeeds, mark that selected ID locally direct so the ordinary send path is immediately available; if it fails, retain the precise compatibility error.

- [x] **Step 3: Cover both sidebar rendering paths**

Pass compatibility metadata in project rows, child rows, and search/recent rows, and assert both independent render sites remain covered.

### Task 6: Release Performance Benchmark

**Files:**
- Create: `packages/desktop/main/agent-runtime/codex-session-disk-catalog.bench.test.ts`

**Interfaces:**
- Consumes: the real `CodexSessionDiskCatalog` scanner with a generated sparse 1,000-file corpus.
- Produces: an opt-in `RUN_CODEX_COMPAT_BENCHMARK=1` release benchmark.

- [x] **Step 1: Measure cold, warm, and incremental scans**

Assert cold scan below 1 second on the reference Mac, warm unchanged metadata bytes equal zero, and a few changed files complete below 200 ms.

- [x] **Step 2: Measure event-loop responsiveness**

Use `monitorEventLoopDelay()` during the real scan and assert p99 remains below 50 ms. The benchmark is opt-in and does not allocate 4 GiB in routine unit runs.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run: `bunx vitest run packages/desktop/main/agent-runtime/codex-session-disk-catalog.test.ts packages/desktop/main/agent-runtime/codex-session-compatibility.test.ts packages/desktop/main/agent-runtime/agent-workspace-index.test.ts packages/desktop/main/agent-runtime/unified-session-service.test.ts packages/desktop/main/agent-runtime/native-runtime-broker.test.ts packages/desktop/renderer/components/SidebarReferenceStyle.test.ts`

Run: `bunx tsc -p packages/desktop/tsconfig.json --noEmit`

Expected: PASS

If a test fails, fix the implementation or test and rerun these commands until they pass. Report the commands and results in the final response.
