# Responsive Chat Lane Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, verify the affected builds and visual states before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Desktop and Web chat history, runtime status, and composer share one responsive content lane.

**Architecture:** Define the responsive lane on `.chat-view` and let every history carrier consume the same width. Keep Web shell responsible only for shell-specific spacing, while the shared renderer stylesheet owns Desktop/Web lane geometry.

**Tech Stack:** React, TypeScript, CSS, Vite, Electron, Next.js Web gateway

## Global Constraints

- Use 92% of the available chat surface at viewport widths of 900px or more.
- Use 100% of the available chat surface below 900px.
- Keep existing user-bubble percentage limits.
- Do not change message data, runtime state, scrolling, or composer behavior.
- Sidebar and file drawer changes must resize the lane naturally.

---

### Task 1: Shared Responsive Lane

**Files:**
- Modify: `packages/desktop/renderer/styles/global.css`

**Interfaces:**
- Consumes: `.chat-view`, `.chat-messages`, `.chat-input-area`, `.chat-message-group`, `.codex-execution-trace`, `.runtime-progress-row`, `.chat-message-activity`
- Produces: `--chat-lane-width`, the single shared width contract

- [x] **Step 1: Define the lane variable**

Set `--chat-lane-width: 92%` on `.chat-view` and override it to `100%` below 900px.

- [x] **Step 2: Apply the lane to viewport and composer**

Give `.chat-messages` and `.chat-input-area` the shared width with automatic horizontal margins.

- [x] **Step 3: Remove nested fixed-width caps**

Make message groups, execution traces, non-compact runtime progress rows, and fallback activity rows use `width: 100%` within the lane and remove independent `860px` caps.

- [x] **Step 4: Preserve intrinsic activity height**

Keep `.chat-message-activity` as a normal flow row with no flex growth and ensure it uses the same horizontal boundaries as messages.

### Task 2: Web Shell Integration

**Files:**
- Modify: `packages/webapp/src/presentation/web.css`

**Interfaces:**
- Consumes: shared `--chat-lane-width`
- Produces: Web-only padding and safe-area behavior without a second lane-width source

- [x] **Step 1: Remove the duplicate Web lane variable**

Delete `--web-chat-lane-width` declarations and the Web-only width assignment for `.chat-messages` and `.chat-input-area`.

- [x] **Step 2: Preserve Web spacing**

Keep safe-area padding, mobile scrollbar behavior, composer styling, and the 100% narrow layout inherited from the shared lane.

### Task 3: Build And Visual Verification

**Files:**
- No source changes expected

**Interfaces:**
- Consumes: built Desktop/Web renderer assets
- Produces: screenshot evidence for wide and narrow layouts

- [x] **Step 1: Build renderer assets**

Build the WebApp and Desktop renderer with the repository's current Node/Bun toolchain.

- [x] **Step 2: Publish the updated Web assets**

Use the customer-agent Web release procedure and preserve active-session boundaries.

- [ ] **Step 3: Inspect wide and narrow layouts**

Verify the chat lane at wide Desktop/Web widths and below 900px. Confirm messages, tools, reasoning, activity status, and composer share boundaries without horizontal overflow.

## Final Verification

- [ ] **Main agent: verify the production build and rendered layouts after development is complete**

Expected: Desktop and Web resize proportionally; `思考中` stays aligned; narrow layouts remain overflow-free.
