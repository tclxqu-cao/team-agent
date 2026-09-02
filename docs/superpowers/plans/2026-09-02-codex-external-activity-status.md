# Codex External Activity Status Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make externally owned Codex sessions report `running` only while their latest rollout turn is actually active, so every sidebar row blinks during execution and stops after completion or interruption.

**Architecture:** Add a focused rollout lifecycle reader that bootstraps from the newest JSONL lifecycle event and incrementally parses appended records. The Codex runtime adapter applies that signal only to externally owned rollout paths and continues to treat occupancy and execution status as independent dimensions.

**Tech Stack:** TypeScript, Node.js filesystem APIs, Codex rollout JSONL, Vitest.

## Global Constraints

- Preserve strict Codex writer-lock ownership and `canResume=false` while externally occupied.
- Do not infer running state from file ownership or mtime alone.
- Do not change Claude Code behavior or add Codex-specific renderer branches.
- Preserve unrelated working-tree changes.

---

### Task 1: Rollout Lifecycle Reader

**Files:**
- Create: `packages/desktop/main/agent-runtime/codex-rollout-activity.ts`
- Unit tests: `packages/desktop/main/agent-runtime/codex-rollout-activity.test.ts`

**Interfaces:**
- Consumes: absolute Codex rollout paths returned by `listOpenSessionFiles()`.
- Produces: `CodexRolloutActivityReader.read(path): Promise<"running" | "idle" | "unknown">`.

- [x] **Step 1: Implement structured lifecycle mapping**

Parse JSONL records and map `task_started` / `turn_started` to `running`; map `task_complete` / `turn_complete` / `turn_aborted` to `idle`; ignore every other record and malformed trailing data.

- [x] **Step 2: Implement reverse bootstrap and incremental reads**

Read backward in bounded chunks until the newest lifecycle record is found. Cache file identity, consumed size, partial trailing bytes, and activity; parse only appended bytes on subsequent calls and reset after truncation or replacement.

- [x] **Step 3: Add focused reader tests**

Cover active, completed, aborted, v2 aliases, malformed/incomplete lines, records spanning chunk boundaries, append transitions, truncation, replacement, and missing files.

### Task 2: Codex Adapter Projection

**Files:**
- Modify: `packages/desktop/main/agent-runtime/codex-runtime-adapter.ts`
- Unit tests: `packages/desktop/main/agent-runtime/codex-runtime-adapter.test.ts`

**Interfaces:**
- Consumes: rollout activity for externally open paths.
- Produces: unified `status=running` when native status, adapter ownership, or external rollout activity proves an active turn.

- [x] **Step 1: Read activity only for externally open rollout files**

Call the reader after `listOpenSessionFiles()` in both list and detail paths and pass the resulting active-path set into `toSummary()`.

- [x] **Step 2: Extend the pure status mapper**

Add an `externallyActive` boolean to `codexThreadStatusToSessionStatus()` while preserving existing precedence: owned/native/external activity proves `running`, then an unowned inactive `systemError` maps to `failed`.

- [x] **Step 3: Add adapter status regressions**

Verify external activity maps an otherwise idle native thread to `running`, while externally occupied completed threads remain `idle`.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run:

```bash
/opt/homebrew/opt/node@22/bin/node node_modules/vitest/vitest.mjs run \
  packages/desktop/main/agent-runtime/codex-rollout-activity.test.ts \
  packages/desktop/main/agent-runtime/codex-runtime-adapter.test.ts \
  packages/desktop/main/agent-runtime/native-runtime-broker.test.ts \
  packages/desktop/renderer/lib/sidebar-session-status.test.ts
bunx tsc --noEmit -p packages/desktop/tsconfig.json
```

Result: 4 files and 55 tests passed; the desktop TypeScript check and production build exited successfully. Node 22 was used for Vitest so the existing `better-sqlite3` ABI was not rebuilt for Bun.
