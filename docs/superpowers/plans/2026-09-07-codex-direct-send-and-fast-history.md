# Codex Direct Send And Fast History Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let occupied Codex sessions attempt the original send before offering one-click fork recovery, and render long-session user/final messages before loading execution traces and tool-result bodies.

**Architecture:** The shared renderer treats process occupancy as advisory and stores a revision-scoped recovery payload that can target either the source or one created fork. Codex history paging gains `core` and `trace` views: core uses summary turns without hydration, trace returns bounded reasoning/tool metadata with lazy tool-result references, and a separate read-only method resolves one tool body on expansion.

**Tech Stack:** TypeScript, React 18, Zustand, Electron IPC, Next.js route handlers, Codex App Server JSON-RPC, Vitest, Node 22.

## Global Constraints

- `owned-externally` must not disable the Codex composer or expose a proactive fork action.
- Only structured `SESSION_OCCUPIED` may enter fork recovery; `SESSION_ALREADY_RUNNING` keeps its queue behavior.
- A successful fork must auto-send the preserved payload exactly once and later retries must reuse its fork ID.
- Core history must not hydrate full turns; trace arguments are capped at 2 KiB and reasoning summaries at 4 KiB per item.
- Tool-result bodies are absent from core and trace responses and load only when expanded.
- Unsupported Codex paging keeps the current readable `legacy-full` fallback.
- Do not change Claude Code, OpenCode, Customer Agent, archive, or delete semantics.

---

### Task 1: Occupied Send Recovery State

**Files:**
- Modify: `packages/desktop/renderer/lib/occupied-session-fork.ts`
- Modify: `packages/desktop/renderer/lib/occupied-session-fork.test.ts`
- Modify: `packages/desktop/renderer/components/ChatView.tsx`
- Modify: `packages/webapp/src/presentation/browser-composer.test.ts`

**Interfaces:**
- Consumes: existing `forkSession(id)`, `startRun(message, targetSessionId, agentIds)` and structured stream error codes.
- Produces: `OccupiedSendPayload`, `OccupiedSessionRecovery`, `createOccupiedSessionRecovery()`, and `markOccupiedRecoveryForked()` helpers used by `ChatView`.

- [ ] **Step 1: Define a complete recovery payload and deterministic transitions**

```ts
export interface OccupiedSendPayload {
  content: string;
  images?: string[];
  agentIds?: string[];
  agentName?: string;
}

export interface OccupiedSessionRecovery {
  token: string;
  sourceSessionId: string;
  forkSessionId?: string;
  payload: OccupiedSendPayload;
  sendAttempted: boolean;
}
```

Keep `canForkOccupiedCodexSession()` true only when the selected Codex/OpenCode session has a matching `SESSION_OCCUPIED` recovery error. Do not inspect `summary.occupancy` in that command predicate.

- [ ] **Step 2: Let advisory occupancy compose and preserve the failed payload**

In `ChatView`, calculate read-only state from compatibility only. Capture the exact normal-send payload by source session before starting the run. On `run_admitted`, clear it; on `SESSION_OCCUPIED`, create recovery state from that captured payload and restore the editable input without losing images or agent IDs.

- [ ] **Step 3: Fork once and send directly to the returned ID**

After `forkOccupiedCodexSession()` returns, register/select the summary, store its ID in recovery state, and call `startRun(recovery.payload, forked.id, recovery.payload.agentIds)` once. Clear recovery after admission. When automatic send fails after the fork exists, the retry action calls `startRun` with `forkSessionId` and does not call `forkSession` again.

- [ ] **Step 4: Cover advisory, occupied, and retry behavior**

Add tests that assert the composer is not disabled by `owned-externally`, proactive fork is absent, a matching `SESSION_OCCUPIED` enables recovery, and helper transitions preserve one token/fork ID without resetting `sendAttempted`.

### Task 2: Progressive History Domain Contract

**Files:**
- Modify: `packages/core/src/domain/session/entities.ts`
- Modify: `packages/core/src/domain/session/index.ts`
- Modify: `packages/core/src/domain/model/entities.ts`
- Modify: `packages/desktop/main/agent-runtime/types.ts`

**Interfaces:**
- Consumes: existing `SessionHistoryQuery`, `Message`, and `AgentRuntimeAdapter`.
- Produces: `SessionHistoryView`, `SessionToolResultRef`, `SessionToolResultBody`, query `view/revision` fields, `Message.toolResultRef`, and optional adapter `getSessionToolResult()`.

- [ ] **Step 1: Add the progressive history types**

```ts
export type SessionHistoryView = "core" | "trace";
export interface SessionToolResultRef {
  turnId: string;
  itemId: string;
  revision: string;
  byteSize: number;
  isError?: boolean;
}
export interface SessionToolResultBody extends SessionToolResultRef {
  content: string;
}
```

Extend `SessionHistoryQuery` with `view?: SessionHistoryView` and `revision?: string`, and `Message` with `toolResultRef?: SessionToolResultRef` for role `tool` rows.

- [ ] **Step 2: Add the adapter retrieval boundary**

```ts
getSessionToolResult?(
  nativeSessionId: string,
  ref: Pick<SessionToolResultRef, "turnId" | "itemId" | "revision">,
): Promise<SessionToolResultBody>;
```

Unsupported runtimes return `OPERATION_NOT_SUPPORTED` at the unified service boundary.

### Task 3: Codex Core, Trace, And Lazy Result Implementation

**Files:**
- Modify: `packages/desktop/main/agent-runtime/codex-runtime-adapter.ts`
- Modify: `packages/desktop/main/agent-runtime/codex-runtime-adapter.test.ts`
- Modify: `packages/desktop/main/agent-runtime/unified-session-service.ts`
- Modify: `packages/desktop/main/agent-runtime/unified-session-service.test.ts`
- Modify: `packages/desktop/main/agent-runtime/native-runtime-broker.ts`
- Modify: `packages/desktop/main/agent-runtime/native-runtime-broker.test.ts`

**Interfaces:**
- Consumes: Task 2 progressive types and existing summary/full turn caches.
- Produces: source-paged core/trace detail and revision-validated single-result reads.

- [ ] **Step 1: Return core pages without full hydration**

In `getSessionPaged()`, build the skeleton and range from `itemsView: "summary"`. For `view: "core"`, convert only selected summary turns and return before `hydrateTurnRange()`. Preserve history IDs, cursors, revision, occupancy, and broker projection behavior.

- [ ] **Step 2: Return bounded trace pages**

For `view: "trace"`, require the optional requested revision to equal the freshly computed skeleton revision, hydrate only the selected turn range, and convert the complete page while capping UTF-8 reasoning text at 4096 bytes and serialized tool arguments at 2048 bytes. Emit empty role `tool` messages with `toolResultRef` and never serialize result content.

- [ ] **Step 3: Resolve one tool result**

Implement `getSessionToolResult()` by recomputing the summary revision, rejecting mismatches with `STALE_SESSION_ANCHOR`, hydrating the requested turn if absent, finding the exact item ID inside that turn, converting its result, and returning only that content and metadata.

- [ ] **Step 4: Preserve legacy and broker behavior**

Keep a query without `view` on the existing full paged path. Pass new methods through unified service and broker without adding result bodies to history caches or retained projections.

- [ ] **Step 5: Test protocol calls and payload size boundaries**

Assert core requests never issue `itemsView: "full"`; trace requests contain tool rows but not a known 100 KiB result string; one lazy read returns that exact string; stale revisions fail; paging-method incompatibility still disables native paging and falls back through the service.

### Task 4: Electron And Web Transport

**Files:**
- Modify: `packages/desktop/main/index.ts`
- Modify: `packages/desktop/main/preload.ts`
- Modify: `packages/desktop/renderer/global.d.ts`
- Modify: `packages/server/lib/native-runtime-service.ts`
- Modify: `packages/server/app/api/sessions/[id]/route.ts`
- Create: `packages/server/app/api/sessions/[id]/tool-result/route.ts`
- Create: `packages/server/app/api/sessions/[id]/tool-result/route.test.ts`
- Modify: `packages/server/app/api/native-runtime.test.ts`
- Modify: `packages/webapp/src/infrastructure/http/agent-http-gateway.ts`
- Modify: `packages/webapp/src/infrastructure/http/agent-http-gateway.test.ts`

**Interfaces:**
- Consumes: Task 2 query and lazy-result contracts; Task 3 service methods.
- Produces: `agentApi.getSession(..., { view, revision })` and `agentApi.getSessionToolResult(id, ref)` on both Electron and Web.

- [ ] **Step 1: Carry view and revision through existing history GETs**

Parse `view=core|trace` and `revision` in the Next route, serialize them in `AgentHttpGateway.getSession()`, and widen Electron preload/IPC typings without changing existing callers.

- [ ] **Step 2: Add one read-only tool-result transport**

Electron adds `sessions:getToolResult`. Web adds `GET /api/sessions/:id/tool-result?turnId=...&itemId=...&revision=...`. Validate all three non-empty query fields before calling the native service, map stale revision to HTTP 409, and return `OPERATION_NOT_SUPPORTED` as 405.

- [ ] **Step 3: Test transport validation and serialization**

Assert the gateway percent-encodes IDs and includes all locator fields, route validation returns 400 without touching the service, success returns one body, and runtime error codes remain structured.

### Task 5: Renderer Core-First Merge And Expansion Loading

**Files:**
- Modify: `packages/desktop/renderer/lib/session-history.ts`
- Modify: `packages/desktop/renderer/lib/session-history.test.ts`
- Modify: `packages/desktop/renderer/lib/tool-call-status.ts`
- Modify: `packages/desktop/renderer/lib/tool-call-status.test.ts`
- Modify: `packages/desktop/renderer/stores/agentStore.ts`
- Modify: `packages/desktop/renderer/components/ToolCallCard.tsx`
- Modify: `packages/desktop/renderer/components/ChatView.tsx`
- Modify: `packages/desktop/renderer/lib/occupied-session-fork.test.ts`
- Modify: `packages/webapp/src/presentation/browser-composer.test.ts`

**Interfaces:**
- Consumes: Task 4 `getSession` progressive query and `getSessionToolResult` API.
- Produces: immediate core render, revision-guarded trace replacement, and per-result expansion loading.

- [ ] **Step 1: Restore lazy refs into tool calls**

Map persisted role `tool` rows with `toolResultRef` onto the matching `ChatMessage.toolCalls[]`. Treat a lazy ref as a completed tool result even before `result` content exists, preserving the ref when `updateToolResult()` later adds content.

- [ ] **Step 2: Load core then trace for every Codex history window**

Create one helper in `ChatView` that requests `{ ...query, view: "core" }`, commits that page immediately, then requests `{ ...query, view: "trace", revision: core.history.revision }`. Merge trace only when selected session, request generation, and core revision still match. Reuse the helper for initial, latest refresh, older/newer paging, latest return, and anchored query loads; non-Codex sessions keep one existing request.

- [ ] **Step 3: Fetch one body on expansion**

Pass `onLoadResult(ref)` from `ChatView` to tool cards. On first expansion, deduplicate by `sessionId + revision + turnId + itemId`, call `getSessionToolResult`, then update the matching store tool call. Cache the promise/body for the current session revision and clear the cache on session or revision change. Show an inline loading or retry state inside the expanded body without shifting the collapsed row.

- [ ] **Step 4: Test merge and UI loading behavior**

Assert core is requested before trace, core messages are committed before the trace promise resolves, stale trace is ignored, lazy refs report completion, concurrent expansion shares one request, and the full body appears only after expansion.

## Final Unit Test Verification

- [ ] **Main agent: run affected unit tests after development is complete**

Run:

```bash
PATH=/opt/homebrew/opt/node@22/bin:$PATH bunx vitest run \
  packages/desktop/main/agent-runtime/codex-runtime-adapter.test.ts \
  packages/desktop/main/agent-runtime/unified-session-service.test.ts \
  packages/desktop/main/agent-runtime/native-runtime-broker.test.ts \
  packages/desktop/renderer/lib/occupied-session-fork.test.ts \
  packages/desktop/renderer/lib/session-history.test.ts \
  packages/desktop/renderer/lib/tool-call-status.test.ts \
  packages/server/app/api/native-runtime.test.ts \
  packages/server/app/api/sessions/[id]/tool-result/route.test.ts \
  packages/webapp/src/infrastructure/http/agent-http-gateway.test.ts \
  packages/webapp/src/presentation/browser-composer.test.ts
PATH=/opt/homebrew/opt/node@22/bin:$PATH bun run typecheck:desktop
PATH=/opt/homebrew/opt/node@22/bin:$PATH bun run typecheck:webapp
git diff --check
```

Expected: all focused Vitest files pass, both type checks exit 0, and `git diff --check` reports no whitespace errors.
