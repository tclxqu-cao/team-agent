# Sidebar Session Status Indicator Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make sidebar session dots communicate waiting-for-input, running, completed, and error states with the requested colors and blinking behavior.

**Architecture:** Add a pure visual-state mapper so status precedence is explicit and unit-testable. `App.tsx` derives pending input from unanswered `ask_user` messages, renders one semantic class, and shared CSS supplies color, animation, and reduced-motion behavior for Electron and Web.

**Tech Stack:** React 18, TypeScript, Zustand, CSS, Vitest.

## Global Constraints

- Waiting for input is red and blinking.
- Running without waiting for input is green and blinking.
- Completed or idle is blue and static.
- Failed or error is gray and blinking.
- Row selection must not override the semantic status color.
- `prefers-reduced-motion: reduce` must disable blinking.

---

### Task 1: Semantic Session Status Mapping

**Files:**
- Create: `packages/desktop/renderer/lib/sidebar-session-status.ts`
- Create: `packages/desktop/renderer/lib/sidebar-session-status.test.ts`

**Interfaces:**
- Consumes: session status string, effective running flag, and pending-input flag.
- Produces: `getSidebarSessionVisualState(input): "needs-input" | "running" | "completed" | "error"`.

- [ ] **Step 1: Implement the state mapper**

Error has highest priority. A running session with pending input maps to `needs-input`; other running sessions map to `running`; all remaining statuses map to `completed`.

- [ ] **Step 2: Add focused precedence tests**

Cover pending input, ordinary running, completed/idle, error aliases, and selection-independent state derivation.

### Task 2: Sidebar Rendering And Animation

**Files:**
- Modify: `packages/desktop/renderer/App.tsx`
- Modify: `packages/desktop/renderer/styles/global.css`
- Modify: `packages/desktop/renderer/components/SidebarReferenceStyle.test.ts`

**Interfaces:**
- Consumes: `getSidebarSessionVisualState` and `messagesBySession` from the Agent store.
- Produces: `.is-needs-input`, `.is-running`, `.is-completed`, and `.is-error` status classes.

- [ ] **Step 1: Derive pending input and render the semantic class**

Treat an unanswered `ask_user` message as pending input only while the session is effectively running. Keep selected-row styling separate from the status dot.

- [ ] **Step 2: Implement colors and blinking**

Use semantic theme variables, one soft blink keyframe for transient states, and a reduced-motion override that keeps the final color static.

- [ ] **Step 3: Update the sidebar style contract test**

Assert all semantic classes, the blink keyframe, and the reduced-motion rule are present.

## Final Unit Test Verification

- [ ] **Main agent: run affected unit tests after development is complete**

Run: `bunx vitest run packages/desktop/renderer/lib/sidebar-session-status.test.ts packages/desktop/renderer/components/SidebarReferenceStyle.test.ts`

Expected: both test files pass.

If a test fails, fix the implementation or test and rerun this command until it passes. Report the command and result in the final response.
