# Codex Session Status Decoupling Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep externally owned Codex sessions read-only without marking idle conversations as actively generating.

**Architecture:** The Codex adapter maps native thread execution state into the unified session status independently from rollout-file ownership. The native runtime broker preserves that status unless it owns an active admitted run, keeping the renderer dependent only on the unified DDD contract.

**Tech Stack:** TypeScript, Codex App Server JSON-RPC, SQLite-backed native runtime broker, React, Vitest.

## Global Constraints

- Preserve strict Codex writer-lock ownership and the occupied-session fork flow.
- Do not re-enable the 120-second Codex mtime takeover heuristic.
- Do not change Claude Code occupancy behavior.
- Do not add Codex-specific renderer heuristics.
- Preserve all unrelated working-tree changes.

---

### Task 1: Codex Native Status Mapping

**Files:**
- Modify: `packages/desktop/main/agent-runtime/codex-runtime-adapter.ts`
- Unit tests: `packages/desktop/main/agent-runtime/codex-runtime-adapter.test.ts`

**Interfaces:**
- Consumes: `CodexThread.status.type` and the adapter's `ownedThreads` active-run set.
- Produces: `codexThreadStatusToSessionStatus(statusType: unknown, ownedByUs?: boolean): UnifiedSessionSummary["status"]`.

- [x] **Step 1: Add a pure native status mapper**

Implement an exported helper that returns `running` for an adapter-owned thread or native `active`, `failed` for `systemError`, and `idle` for every other native state.

```ts
export function codexThreadStatusToSessionStatus(
  statusType: unknown,
  ownedByUs = false,
): UnifiedSessionSummary["status"] {
  if (ownedByUs || statusType === "active") return "running";
  if (statusType === "systemError") return "failed";
  return "idle";
}
```

- [x] **Step 2: Decouple `toSummary()` from occupancy**

Replace `status: occupancy === "available" ? "idle" : "running"` with the helper using `thread.status?.type` and `ownedByUs`. Keep `occupancy` and `canResume` unchanged.

- [x] **Step 3: Add focused mapping tests**

Verify `idle`, `notLoaded`, and unknown values map to `idle`; `active` maps to `running`; `systemError` maps to `failed`; and `ownedByUs` overrides an idle native state to `running`.

### Task 2: Broker Status Projection

**Files:**
- Modify: `packages/desktop/main/agent-runtime/native-runtime-broker.ts`
- Unit tests: `packages/desktop/main/agent-runtime/native-runtime-broker.test.ts`

**Interfaces:**
- Consumes: adapter-provided `UnifiedSessionSummary.status` and `NativeRuntimeBrokerState.activeRun(sessionId)`.
- Produces: a broker-projected summary whose status is `running` only when an active broker run exists; otherwise it preserves the adapter status.

- [x] **Step 1: Preserve idle external summaries**

Change `applySummary()` to use `status: active ? "running" : summary.status` while retaining the lock-derived occupancy, permission policy, controller, and resume capability.

- [x] **Step 2: Make the broker test fixture model status independently**

Update the `summary()` helper to accept an explicit status independent from occupancy, and add a mutable `status` field to `FakeNativeRuntime` so list and detail fixtures expose both dimensions.

- [x] **Step 3: Add broker projection regressions**

Verify an externally occupied idle summary stays idle, an externally occupied running summary stays running, and an admitted broker run projects running plus `owned-by-customer-agent` even when the adapter initially reports idle.

### Task 3: Renderer Contract Regression

**Files:**
- Modify only if needed: `packages/desktop/renderer/components/ChatHistoryStyle.test.ts`

**Interfaces:**
- Consumes: the unified status produced by Tasks 1 and 2.
- Produces: a regression assertion that running-session rehydration remains status-driven and does not infer execution from `occupancy`.

- [x] **Step 1: Assert renderer responsibility boundaries**

Keep the existing assertions that external occupancy drives fallback history following while running-session rehydration uses `detail.status === "running"`. Add no occupancy-based activity inference.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run:

```bash
bunx vitest run \
  packages/desktop/main/agent-runtime/codex-runtime-adapter.test.ts \
  packages/desktop/main/agent-runtime/native-runtime-broker.test.ts \
  packages/desktop/renderer/components/ChatHistoryStyle.test.ts
bunx tsc --noEmit -p packages/desktop/tsconfig.json
```

Expected: all selected Vitest files pass and the desktop TypeScript check exits successfully.

If a test fails, fix the implementation or test and rerun these commands until they pass. Report the commands and results in the final response.
