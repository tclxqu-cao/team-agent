# Unified Execution Trace Rows Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render thinking and tool activity as compact, icon-led, expandable rows with adjacent actions grouped by type.

**Architecture:** Keep the existing message and runtime event contracts. Reuse `toolPhrase`, `toolFamily`, and adjacent grouping, while standardizing the renderer around the same disclosure geometry and Lucide icon vocabulary.

**Tech Stack:** React, TypeScript, Lucide React, CSS, Vitest.

## Global Constraints

- Preserve all existing tool arguments, results, file diffs, errors, and native subagent detail behind disclosure controls.
- Never expose private chain-of-thought; only render the existing public reasoning summary.
- Merge adjacent tools only when their human-readable action matches.
- Keep collapsed historical output unmounted for large-session performance.

---

### Task 1: Thinking Row

**Files:**
- Modify: `packages/desktop/renderer/components/AgentActivityIndicator.tsx`
- Modify: `packages/desktop/renderer/components/ReasoningSummary.tsx`
- Modify: `packages/desktop/renderer/components/ChatView.tsx`
- Unit tests: `packages/desktop/renderer/components/AgentActivityIndicator.test.ts`
- Unit tests: `packages/desktop/renderer/components/ReasoningSummary.test.tsx`

**Interfaces:**
- Consumes: existing public `ReasoningSummarySection[]` and `streaming` state.
- Produces: one brain-icon row that changes from transient `思考中` to expandable `思考` when summary content exists.

- [x] **Step 1: Add assertions for the brain icon and single-row status behavior**

Verify that both transient and durable reasoning render a Lucide `Brain` icon and that `ChatView` suppresses the transient row once summary content exists.

- [x] **Step 2: Implement the unified thinking row**

Use `Brain` as the leading icon, keep the summary button keyboard accessible, and retain safe Markdown rendering inside the expanded body.

### Task 2: Tool Activity Rows

**Files:**
- Modify: `packages/desktop/renderer/components/ToolCallCard.tsx`
- Modify: `packages/desktop/renderer/styles/global.css`
- Unit tests: `packages/desktop/renderer/components/ChatHistoryStyle.test.ts`
- Unit tests: `packages/desktop/renderer/lib/tool-call-groups.test.ts`

**Interfaces:**
- Consumes: `toolFamily(name)`, `toolPhrase(name)`, `toolPreview(name, args)`, and existing `ToolCallGroupItem` detail props.
- Produces: icon-led single and grouped disclosure rows for command, file, search, and generic actions.

- [x] **Step 1: Standardize tool icons and disclosure geometry**

Map tool families to Lucide icons, keep each row at stable height, and render status and chevron controls without framed cards in the shared history view.

- [x] **Step 2: Preserve expandable detail for single and grouped actions**

Keep existing command output, arguments, file contents, diffs, errors, progress, and subagent content available after expansion.

- [x] **Step 3: Preserve adjacent action grouping**

Continue using the action label as the grouping key so command, read, write/edit, and search sequences merge only when consecutive and semantically identical.

### Task 3: Responsive And Accessibility Polish

**Files:**
- Modify: `packages/desktop/renderer/styles/global.css`
- Unit tests: `packages/desktop/renderer/components/ChatHistoryStyle.test.ts`

**Interfaces:**
- Consumes: shared process row class hooks.
- Produces: truncation, focus, running, failure, expanded, mobile, and reduced-motion states.

- [x] **Step 1: Add stable responsive layout rules**

Ensure long commands and paths truncate in the collapsed row without moving the icon, count, status, or chevron.

- [x] **Step 2: Add accessible interaction states**

Retain `aria-expanded`, descriptive labels, visible keyboard focus, polite live status, and reduced-motion fallbacks.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run: `bun test packages/desktop/renderer/components/AgentActivityIndicator.test.ts packages/desktop/renderer/components/ReasoningSummary.test.tsx packages/desktop/renderer/lib/tool-call-groups.test.ts packages/desktop/renderer/components/ChatHistoryStyle.test.ts`

Expected: PASS

Then run the desktop TypeScript check and visually inspect the Web UI at desktop and 390px widths. Fix failures before reporting completion.
