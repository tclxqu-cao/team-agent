# Unlimited Maximum Iterations Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `0` mean unlimited Customer Agent iterations while allowing the settings input to be cleared during editing and validating only on save.

**Architecture:** Use a string draft at the UI boundary, preserve validated non-negative integers through settings and HTTP adapters, and interpret `0` in the core loop. Existing positive iteration behavior remains unchanged.

**Tech Stack:** React, Zustand, TypeScript, Vitest, Bun, Vite

## Global Constraints

- `0` means unlimited only for the global Customer Agent run limit.
- Positive integers have no configured upper bound.
- Empty, negative, fractional, and non-numeric values fail at save.
- Existing unrelated worktree changes must remain untouched.

---

### Task 1: Settings Editor

**Files:**
- Modify: `packages/desktop/renderer/components/SettingsPanel.tsx`

**Interfaces:**
- Consumes: `maxIterations: number` and `setField(key, value)` from `useSettingsStore`.
- Produces: a validated non-negative integer stored only when the user saves.

- [ ] **Step 1: Add a string draft synchronized from loaded settings**
- [ ] **Step 2: Allow the number field to become empty and remove its maximum**
- [ ] **Step 3: Validate required, integer, and non-negative constraints in `handleSaveGeneral`**

### Task 2: Settings and Request Boundaries

**Files:**
- Modify: `packages/webapp/src/infrastructure/local/local-settings-repository.ts`
- Modify: `packages/webapp/src/infrastructure/local/local-settings-repository.test.ts`
- Modify: `packages/server/lib/shared-settings.ts`
- Modify: `packages/server/lib/shared-settings.test.ts`
- Modify: `packages/server/app/api/agent/run/run-options.ts`
- Modify: `packages/server/app/api/agent/run/run-options.test.ts`

**Interfaces:**
- Consumes: untrusted persisted and HTTP settings.
- Produces: non-negative integer `maxIterations`, preserving `0` and large positive values.

- [ ] **Step 1: Replace the `1..50` clamps with non-negative integer normalization**
- [ ] **Step 2: Preserve the context-window bounds unchanged**
- [ ] **Step 3: Add focused tests for `0`, large values, and invalid values**

### Task 3: Agent Loop Unlimited Semantics

**Files:**
- Modify: `packages/core/src/domain/agent/AgentLoop.ts`
- Modify: `packages/core/src/domain/agent/__tests__/AgentLoop.test.ts`

**Interfaces:**
- Consumes: `AgentLoopConfig.maxIterations`, where `0` means unlimited.
- Produces: normal loop execution until another terminal condition when unlimited.

- [ ] **Step 1: Introduce one limit predicate that returns false for `0`**
- [ ] **Step 2: Apply it to restore, loop continuation, and finalization transitions**
- [ ] **Step 3: Prove a `0` run can exceed the former boundary and still complete normally**

## Final Unit Test Verification

- [ ] **Main agent: run affected unit tests after development is complete**

Run: `bunx vitest run packages/webapp/src/infrastructure/local/local-settings-repository.test.ts packages/server/app/api/agent/run/run-options.test.ts packages/server/lib/shared-settings.test.ts packages/core/src/domain/agent/__tests__/AgentLoop.test.ts`

Expected: PASS

Then run desktop TypeScript checking and the WebApp production build. Fix any failure before reporting completion.
