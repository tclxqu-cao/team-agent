# WebApp Session Isolation Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Customer Agent events and sends from being attributed to a Codex session during session switches.

**Architecture:** Route stream mutations only through an explicit event session ID. Treat a selected session without a matching summary as unresolved and temporarily disable composition, while preserving active-agent fallback for genuinely new sessions.

**Tech Stack:** React, TypeScript, Zustand, Vitest, Bun

## Global Constraints

- Preserve unrelated dirty-worktree changes.
- Do not change persisted session history or visual styling.
- Keep new-session creation behavior unchanged.

---

### Task 1: Explicit Event Ownership

**Files:**
- Create: `packages/desktop/renderer/lib/session-event-routing.ts`
- Create: `packages/desktop/renderer/lib/session-event-routing.test.ts`
- Modify: `packages/desktop/renderer/components/ChatView.tsx`

**Interfaces:**
- Consumes: `StreamEvent._sid`
- Produces: `resolveSessionEventTarget(eventSessionId): string | null`

- [x] **Step 1: Add the routing helper**

Return a non-empty explicit session ID and return `null` for missing or blank IDs.

- [x] **Step 2: Route ChatView events only through the helper**

Drop unscoped events before any message, progress, context, or activity mutation.

- [x] **Step 3: Add focused unit tests**

Assert explicit ownership is preserved and missing/blank ownership is rejected.

### Task 2: Composer Session Resolution Guard

**Files:**
- Create: `packages/desktop/renderer/lib/session-composer-routing.ts`
- Create: `packages/desktop/renderer/lib/session-composer-routing.test.ts`
- Modify: `packages/desktop/renderer/components/ChatView.tsx`

**Interfaces:**
- Consumes: selected session ID, session summary, active agent type
- Produces: resolved composer agent type and readiness state

- [x] **Step 1: Add composer routing helper**

For a selected session, require a summary with the same ID. For a new session, use the active agent type.

- [x] **Step 2: Disable send while selected-session ownership is unresolved**

Keep input editable, but prevent Enter/send from creating or running against the wrong runtime.

- [x] **Step 3: Add focused unit tests**

Cover CA to Codex transition, matching summary, and new-session fallback.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run: `bun test packages/desktop/renderer/lib/session-event-routing.test.ts packages/desktop/renderer/lib/session-composer-routing.test.ts packages/desktop/renderer/stores/agentStore.test.ts`

Expected: PASS

Run: `bun run --cwd packages/webapp build`

Expected: PASS
