# Codex Session Order And Refresh Stability Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep AgentRoam Webapp Codex sessions in the same `recency_at` order as Codex Desktop while preventing normal sidebar refreshes from restarting a healthy shared app-server transport.

**Architecture:** Treat the app-server response order as authoritative because the documented `thread/list` protocol supports `recency_at` but not the Codex Desktop UI's higher-level `priority` label. Expose the active app-server transport mode to the runtime adapter, reuse healthy shared connections for all data refreshes, and retain a bounded restart compatibility path only for standalone transports.

**Tech Stack:** TypeScript, Codex app-server JSON-RPC, WebSocket, Vitest, Bun.

## Global Constraints

- Do not read or mutate Codex SQLite state to derive sidebar order.
- Preserve the server's `recency_at` response order through native-runtime and renderer cache reconciliation.
- A healthy shared transport must not receive `SIGTERM` from normal 10-second or 15-second refresh polling.
- Standalone compatibility restarts must be rate-limited to one attempt per 30 seconds.
- Preserve the existing visible-workspace polling and status convergence behavior.

---

### Task 1: Expose Active Codex Transport Mode

**Files:**
- Modify: `packages/native-runtime/src/agent-runtime/codex-app-server-client.ts`
- Unit tests: `packages/native-runtime/src/agent-runtime/codex-app-server-client.test.ts`

**Interfaces:**
- Produces: `CodexAppServerClient.mode: CodexAppServerLaunchMode | null`
- Produces: mode becomes `shared` or `standalone` only after initialization succeeds and returns to `null` on stop or exit.

- [ ] **Step 1: Add active mode state and getter**

Track the successfully initialized launch attempt without exposing process internals.

- [ ] **Step 2: Clear mode on process loss and explicit stop**

Ensure the next request re-runs shared-first fallback selection.

- [ ] **Step 3: Add focused mode lifecycle tests**

Assert shared success, standalone fallback, and exit/reset behavior.

### Task 2: Separate Refresh From Reconnect

**Files:**
- Modify: `packages/native-runtime/src/agent-runtime/codex-runtime-adapter.ts`
- Unit tests: `packages/native-runtime/src/agent-runtime/codex-runtime-adapter.test.ts`

**Interfaces:**
- Consumes: `CodexDiscoveryClient.mode`
- Produces: `refreshDiscoveryConnection()` invalidates workspace caches, reuses shared/unknown transports, and rate-limits standalone restarts.

- [ ] **Step 1: Add transport mode and clock inputs to the discovery boundary**

Use a 30-second default standalone restart interval and an injectable clock for deterministic tests.

- [ ] **Step 2: Reuse shared transport during refresh**

Clear the workspace snapshot/maps, then issue fresh `project/list` or `thread/list` requests on the existing shared connection.

- [ ] **Step 3: Rate-limit standalone compatibility restarts**

Use single-flight restart plus the last-attempt timestamp so concurrent and repeated polling cannot create a restart storm.

- [ ] **Step 4: Update refresh tests**

Cover shared zero-restart behavior, standalone first refresh restart, repeated refresh suppression inside 30 seconds, and restart after the interval.

### Task 3: Lock Session Ordering To App-Server Order

**Files:**
- Unit tests: `packages/native-runtime/src/agent-runtime/codex-runtime-adapter.test.ts`
- Unit tests: `packages/desktop/renderer/lib/agent-workspace-cache.test.ts`

**Interfaces:**
- Consumes: `thread/list` with `sortKey: "recency_at"` and `sortDirection: "desc"`
- Produces: response and refreshed first-page order remain unchanged even when `updatedAt` values imply a different order.

- [ ] **Step 1: Add native-runtime response-order regression coverage**

Return test threads in authoritative recency order with deliberately conflicting `updatedAt` values and assert unchanged output order.

- [ ] **Step 2: Add cache reconciliation regression coverage**

Refresh an existing cached page with a different authoritative order and assert the fresh page order wins.

## Final Unit Test Verification

- [ ] **Main agent: run affected unit tests after development is complete**

Run: `bunx vitest run packages/native-runtime/src/agent-runtime/codex-app-server-client.test.ts packages/native-runtime/src/agent-runtime/codex-runtime-adapter.test.ts packages/desktop/renderer/lib/agent-workspace-cache.test.ts packages/desktop/renderer/lib/sidebar-session-sort.test.ts`

Expected: PASS

Then run: `bun run --cwd packages/native-runtime build`

Expected: PASS and `packages/native-runtime/dist/index.js` contains the shared-first transport plus refresh-without-shared-restart implementation.
