# Tool Row Trailing Alignment Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align file-row chevrons and trailing line counts with other tool rows.

**Architecture:** Change only the Codex-history CSS layout width of the separate disclosure control. Preserve its touch target through an absolutely positioned pseudo-element.

**Tech Stack:** React, CSS, Vitest, Vite

## Global Constraints

- Do not change tool behavior or labels.
- Preserve a 34px disclosure hit target.
- Keep filename truncation intact.

---

### Task 1: Align File Row Trailing Content

**Files:**
- Modify: `packages/desktop/renderer/styles/global.css`
- Unit tests: `packages/desktop/renderer/components/ToolCallCard.test.tsx`

**Interfaces:**
- Consumes: `.tool-call-shell__disclosure` and `.tool-call-shell__chevron`
- Produces: an 11px visual layout column with a 34px hit target

- [x] **Step 1: Add the Codex-history disclosure override**

Set width and flex basis to 11px, align content to the trailing edge, and position the control relatively.

- [x] **Step 2: Preserve the touch target**

Add a 34px-wide absolute pseudo-element anchored to the right edge.

- [x] **Step 3: Add CSS contract assertions**

Verify visual width, trailing alignment, and retained touch width.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run: `bun test packages/desktop/renderer/components/ToolCallCard.test.tsx packages/desktop/renderer/components/ChatHistoryStyle.test.ts`

Expected: PASS

Run: `bun run --cwd packages/webapp build`

Expected: PASS
