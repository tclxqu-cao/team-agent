# Agent Workspace Index Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a top-level Agent switcher whose independently cached workspace tree preserves each runtime's native names and order, lazily paginates sessions, and replaces the old Agent grouping feature.

**Architecture:** Runtime adapters translate native project/session APIs into a shared workspace domain contract. `AgentWorkspaceIndexService` owns per-Agent snapshots and pagination orchestration; the native broker exposes the same contract to Electron and Web. The renderer persists a versioned per-Agent stale-while-revalidate view state and renders one workspace tree at a time.

**Tech Stack:** TypeScript, React 18, Electron IPC, Next.js route handlers, JSON-RPC native runtime broker, Vitest, Zustand/localStorage.

## Global Constraints

- Follow DDD: native protocol parsing stays in adapters, cache/orchestration stays in the application service, and renderer code consumes unified domain DTOs.
- Only the active Agent's workspace index may load after a switch.
- Codex workspace name and order must follow `project.name` and `project.position` exactly.
- Session pages use a default limit of 50 and append without duplicates.
- Preserve the existing session sort control: off means `created` descending; on means running sessions first and `created` descending within each status bucket.
- Preserve the dirty worktree and do not alter unrelated changes.
- Remove the old `groupByBot` preference, button, grouped rendering, collapse state, and dedicated styles.

---

### Task 1: Workspace Domain Contract and Index Service

**Files:**
- Create: `packages/desktop/main/agent-runtime/agent-workspace-index.ts`
- Create: `packages/desktop/main/agent-runtime/agent-workspace-index.test.ts`
- Modify: `packages/desktop/main/agent-runtime/types.ts`
- Modify: `packages/desktop/main/agent-runtime/index.ts`

**Interfaces:**
- Consumes: existing `AgentType`, `UnifiedSessionSummary`, and `AgentRuntimeAdapter`.
- Produces: `AgentWorkspace`, `WorkspacePage<T>`, `WorkspaceQuery`, `WorkspaceSessionQuery`, and `AgentWorkspaceIndexService`.

- [ ] **Step 1: Define the workspace DTOs and optional adapter port**

```ts
export interface AgentWorkspace {
  agentType: AgentType;
  workspaceId: string;
  name: string;
  roots: string[];
  order: number;
  updatedAt?: string;
  source: "native" | "derived";
}

export interface WorkspacePage<T> {
  data: T[];
  nextCursor: string | null;
  watermark: string | null;
  stale?: boolean;
}
```

Add optional `listWorkspaces(query)` and `listWorkspaceSessions(workspaceId, query)` methods to `AgentRuntimeAdapter` so existing execution behavior remains backward compatible.

- [ ] **Step 2: Implement `AgentWorkspaceIndexService`**

Keep a per-Agent single-flight workspace request, preserve adapter order, validate limits/cursors, and delegate session pages only to the selected adapter. A missing workspace capability returns `OPERATION_NOT_SUPPORTED`; it must not call other adapters.

- [ ] **Step 3: Add focused domain tests**

Cover per-Agent isolation, concurrent request coalescing, adapter order preservation, session page delegation, invalid cursors, and stale cached fallback after a refresh failure.

### Task 2: Native Runtime Workspace Adapters

**Files:**
- Modify: `packages/desktop/main/agent-runtime/codex-runtime-adapter.ts`
- Modify: `packages/desktop/main/agent-runtime/codex-runtime-adapter.test.ts`
- Modify: `packages/desktop/main/agent-runtime/claude-runtime-adapter.ts`
- Modify: `packages/desktop/main/agent-runtime/claude-runtime-adapter.test.ts`
- Modify: `packages/desktop/main/agent-runtime/opencode-runtime-adapter.ts`
- Modify: `packages/desktop/main/agent-runtime/opencode-runtime-adapter.test.ts`
- Modify: `packages/desktop/main/agent-runtime/customer-agent-runtime-adapter.ts`

**Interfaces:**
- Consumes: workspace port types from Task 1 and each runtime's existing official API.
- Produces: native workspace pages and workspace-scoped session pages.

- [ ] **Step 1: Add Codex project mapping**

Call experimental `project/list` with its cursor and limit. Map `id`, `name`, ordered roots, `position`, and `updatedAt` without sorting. Extend `CodexThread` with optional `projectId` and add a workspace session query using `thread/list` with `projectId` when available and root `cwd` fallback for legacy unassigned threads.

- [ ] **Step 2: Invalidate Codex workspace cache on notifications**

Recognize `project/changed` in `handleNotification`, increment the workspace revision, and make the next workspace read authoritative. Protocol failure falls back to the last successful adapter snapshot and marks it stale.

- [ ] **Step 3: Add OpenCode workspaces**

Map `client.project.list()` in returned order using native project ID/worktree, then use `client.session.list({ query: { directory } })` for the selected workspace and slice with an opaque offset cursor.

- [ ] **Step 4: Add Claude Code derived workspaces**

Page `listSessions({ limit, offset })`, group by normalized `cwd`, keep first-seen order, and use an opaque offset cursor for workspace sessions. Use the normalized path digest as workspace ID and basename as the derived name.

- [ ] **Step 5: Add Customer Agent workspaces**

Map `IProjectStore.list()` to stable project workspaces and page summaries from the session store without changing project order.

- [ ] **Step 6: Add adapter tests**

Assert Codex rename keeps ID, `position` order is untouched, `project/changed` invalidates, legacy cwd sessions remain visible, and OpenCode/Claude pagination appends without duplicates.

### Task 3: Broker and Application Transport

**Files:**
- Modify: `packages/desktop/main/agent-runtime/native-runtime-broker.ts`
- Modify: `packages/desktop/main/agent-runtime/native-runtime-broker.test.ts`
- Modify: `packages/desktop/main/agent-runtime/unified-session-service.ts`
- Modify: `packages/desktop/main/agent-runtime/unified-session-service.test.ts`
- Modify: `packages/server/lib/native-runtime-service.ts`
- Modify: `packages/server/lib/native-runtime-service.test.ts`

**Interfaces:**
- Consumes: `AgentWorkspaceIndexService` and Task 1 DTOs.
- Produces: broker methods `listWorkspaces` and `listWorkspaceSessions` available through `NativeRuntimePort`.

- [ ] **Step 1: Wire the workspace index beside `UnifiedSessionService`**

Expose `listWorkspaces(agentType, query)` and `listWorkspaceSessions(agentType, workspaceId, query)` without changing detail/run methods.

- [ ] **Step 2: Extend broker request routing and client facade**

Add JSON-RPC broker method cases and strongly typed client calls. `BrokerRuntimeAdapter` forwards workspace methods for only its own `agentType`.

- [ ] **Step 3: Extend Web application service**

Add the same workspace methods to `NativeRuntimePort` and `NativeRuntimeService`, preserving pending native sessions in the first workspace page when their `cwd` matches the requested roots.

- [ ] **Step 4: Add broker/service tests**

Verify only the requested Agent adapter runs, cursor parameters survive the socket boundary, errors retain stale pages, and existing list/run behavior is unchanged.

### Task 4: Web and Electron APIs

**Files:**
- Create: `packages/server/app/api/agent-workspaces/route.ts`
- Create: `packages/server/app/api/agent-workspaces/[workspaceId]/sessions/route.ts`
- Create: `packages/server/app/api/agent-workspaces/route.test.ts`
- Modify: `packages/desktop/main/index.ts`
- Modify: `packages/desktop/main/preload.ts`
- Modify: `packages/desktop/renderer/global.d.ts`
- Modify: `packages/webapp/src/infrastructure/http/agent-http-gateway.ts`
- Modify: `packages/webapp/src/infrastructure/http/agent-http-gateway.test.ts`

**Interfaces:**
- Consumes: workspace methods from Task 3.
- Produces: `window.agentApi.listAgentWorkspaces` and `listAgentWorkspaceSessions` with matching HTTP endpoints.

- [ ] **Step 1: Implement read-only HTTP routes**

Validate `agentType`, `limit` in `1..200`, optional cursor, and workspace ID. Customer Agent reads host projects/sessions directly; native agents call `NativeRuntimeService`.

- [ ] **Step 2: Add Electron IPC/preload methods**

Register `workspaces:list` and `workspaces:listSessions` handlers and expose typed preload functions.

- [ ] **Step 3: Add Web gateway methods**

Build URLSearchParams for all optional pagination fields and return the shared page response. Extend `createSession` to forward an optional workspace root `cwd` for native sessions.

- [ ] **Step 4: Add transport tests**

Cover validation, URL encoding, Customer Agent order, native delegation, paging fields, and cwd forwarding.

### Task 5: Renderer Cache and Selection Domain

**Files:**
- Create: `packages/desktop/renderer/lib/agent-workspace-cache.ts`
- Create: `packages/desktop/renderer/lib/agent-workspace-cache.test.ts`
- Modify: `packages/desktop/renderer/lib/sidebar-selection.ts`
- Modify: `packages/desktop/renderer/lib/sidebar-selection.test.ts`

**Interfaces:**
- Consumes: `AgentWorkspace`, `WorkspacePage`, and `UnifiedSessionSummary` DTOs.
- Produces: versioned per-Agent localStorage serialization, immutable page merge helpers, and per-Agent selection/scroll restoration.

- [ ] **Step 1: Implement the v2 cache parser and serializer**

Reject malformed Agent/workspace entries independently, cap each cached session list at 300 summaries, and never throw when storage is unavailable.

- [ ] **Step 2: Implement immutable workspace/session reconciliation**

Merge workspaces by `workspaceId` while preserving incoming order; merge session pages by session ID; replace page one during background refresh without clearing later cached pages.

- [ ] **Step 3: Add cache tests**

Cover four-Agent isolation, rename/order reconciliation, cursor persistence, cache corruption, caps, and selection/scroll restoration.

### Task 6: Top-Level Agent Workspace Sidebar

**Files:**
- Create: `packages/desktop/renderer/components/AgentWorkspaceSwitcher.tsx`
- Create: `packages/desktop/renderer/components/AgentWorkspaceSwitcher.test.tsx`
- Modify: `packages/desktop/renderer/App.tsx`
- Modify: `packages/desktop/renderer/styles/global.css`
- Modify: `packages/desktop/renderer/components/SidebarReferenceStyle.test.ts`

**Interfaces:**
- Consumes: `window.agentApi` methods from Task 4 and cache helpers from Task 5.
- Produces: one active Agent tree with lazy workspace/session loading.

- [ ] **Step 1: Build the compact four-way segmented switcher**

Render Customer Agent, Codex, Claude Code, and OpenCode in stable order, expose selected/disabled states, preserve a fixed control height, and include tooltips/accessible labels.

- [ ] **Step 2: Replace project rendering with active-Agent workspaces**

On switch, synchronously restore that Agent cache, then call only `listAgentWorkspaces(activeAgent)`. Keep current chat visible until a new session is selected.

- [ ] **Step 3: Add lazy session pagination**

Workspace disclosure loads the first 50 rows; an IntersectionObserver sentinel requests the next cursor. Background page-one refresh reconciles in place and preserves scrollTop.

- [ ] **Step 4: Preserve existing session affordances**

Keep status dots, occupancy, delete/hide, child sessions, running-first option, search, create session, collapse-all, invalid-path display, mobile drawer behavior, and input blur semantics. Native create uses workspace root cwd; Customer Agent uses project ID.

- [ ] **Step 5: Remove the old grouping feature completely**

Delete the highlighted toolbar button, `BOT_GROUP_ORDER`, `collapsedBotGroups`, bot group rendering, grouped count conditions, runtime marks that only disambiguated mixed-Agent lists, and related CSS/test expectations.

- [ ] **Step 6: Add renderer tests**

Assert switch-before-load ordering, current-Agent-only requests, cache-first rendering, Codex order/name updates, session append, scroll preservation, and absence of `groupByBot`.

### Task 7: Preference Migration and Regression Cleanup

**Files:**
- Modify: `packages/desktop/renderer/stores/uiStore.ts`
- Modify: tests that reference `groupByBot` or the old mixed project tree.

**Interfaces:**
- Consumes: the new active-Agent cache from Task 5.
- Produces: a clean Zustand preference schema without obsolete grouping state.

- [ ] **Step 1: Remove `groupByBot` and bump the preference version**

The migration returns only supported preferences; persisted obsolete fields are discarded rather than copied through.

- [ ] **Step 2: Update affected assertions**

Replace string-based grouping expectations with top-level switcher and workspace lazy-load contracts while keeping unrelated appearance, deletion, and status tests unchanged.

### Task 8: Visual and Build Verification

**Files:**
- Verify only; no planned production source file.

**Interfaces:**
- Consumes: completed feature.
- Produces: build and visual evidence.

- [ ] **Step 1: Run type checks and production builds**

Use Node 22 for native dependencies, then run Desktop, Server, and WebApp checks/builds.

- [ ] **Step 2: Start an isolated Web dev instance**

Use an unused port and isolated `AGENT_DATA_DIR` plus `AGENT_NATIVE_RUNTIME_DIR` so the verification process cannot reuse the production broker.

- [ ] **Step 3: Verify through ego-browser**

At desktop and 390x844 viewports, confirm the switcher, cache-first switch, workspace expansion, session scrolling, no overlap, and removal of the grouping icon. Confirm a Codex rename/order fixture updates in place.

### Task 9: Cross-Agent Workspace Import

**Files:**
- Modify: `packages/desktop/main/agent-runtime/types.ts`
- Modify: `packages/desktop/main/agent-runtime/agent-workspace-index.ts`
- Modify: `packages/desktop/main/agent-runtime/native-runtime-broker.ts`
- Modify: `packages/desktop/main/agent-runtime/{codex,claude,opencode}-runtime-adapter.ts`
- Modify: `packages/desktop/main/index.ts`, `packages/desktop/main/preload.ts`, `packages/desktop/renderer/global.d.ts`
- Modify: `packages/server/lib/native-runtime-service.ts`, `packages/server/app/api/agent-workspaces/route.ts`
- Modify: `packages/webapp/src/infrastructure/http/agent-http-gateway.ts`
- Modify: `packages/desktop/renderer/App.tsx`
- Unit tests: matching workspace index, adapter, broker, server, gateway, and renderer tests

**Interfaces:**
- Produces: `ImportAgentWorkspaceResult`, `importWorkspace(agentType, path, name?)`, and `listWorkspaceSessionsByPath(cwd, query)`.
- Preserves: native workspace order, per-Agent isolation, lazy session loading, and existing session sort behavior.

- [ ] **Step 1: Add the imported-workspace domain contract and persistent registry**

Persist a normalized path once per Agent, derive a stable workspace ID, and return the existing native or imported workspace when the same path is imported again.

- [ ] **Step 2: Merge imported workspaces after native workspaces**

Keep adapter order untouched, append imports by creation order, and invalidate only the selected Agent's workspace cache after a new import.

- [ ] **Step 3: Load and create imported workspace sessions by cwd**

Adapters query sessions using the registered path. Project imported sessions back to the synthetic workspace ID. Codex `thread/start` receives `cwd` without the synthetic `projectId`.

- [ ] **Step 4: Expose import through Broker, Electron, Web, and Web gateway**

Add one import operation with identical result semantics across transports. Validate external-Agent input and return `400` for malformed payloads.

- [ ] **Step 5: Enable the existing import UI for all Agents**

Customer Agent retains its project creation path. External Agents call the new import operation; `existing: true` shows a page-level notice and selects/expands the existing workspace without inserting a duplicate.

- [ ] **Step 6: Verify focused behavior and production release**

Cover same-Agent deduplication, cross-Agent independence, native-root collision, appended ordering, cwd session loading, Codex create parameters, transport URLs, and the four visible import entry points before rebuilding and restarting `:3000`.

## Final Unit Test Verification

- [ ] **Main agent: run affected unit tests after development is complete**

Run:

```bash
PATH=/opt/homebrew/opt/node@22/bin:$PATH bunx vitest run \
  packages/desktop/main/agent-runtime/agent-workspace-index.test.ts \
  packages/desktop/main/agent-runtime/codex-runtime-adapter.test.ts \
  packages/desktop/main/agent-runtime/claude-runtime-adapter.test.ts \
  packages/desktop/main/agent-runtime/opencode-runtime-adapter.test.ts \
  packages/desktop/main/agent-runtime/native-runtime-broker.test.ts \
  packages/desktop/main/agent-runtime/unified-session-service.test.ts \
  packages/server/lib/native-runtime-service.test.ts \
  packages/server/app/api/agent-workspaces/route.test.ts \
  packages/webapp/src/infrastructure/http/agent-http-gateway.test.ts \
  packages/desktop/renderer/lib/agent-workspace-cache.test.ts \
  packages/desktop/renderer/lib/sidebar-selection.test.ts \
  packages/desktop/renderer/components/AgentWorkspaceSwitcher.test.tsx \
  packages/desktop/renderer/components/SidebarReferenceStyle.test.ts
```

Expected: PASS. If a test fails, fix the implementation or test and rerun this command until it passes.
