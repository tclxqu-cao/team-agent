# WebApp Edge Tab Swipe Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restrict WebApp tab swipe recognition to the screen edges so message text remains selectable.

**Architecture:** Extend the pure gesture sample with viewport width and reject non-edge pointer starts before creating active state. The DOM bridge supplies `window.innerWidth`; existing move handling remains unchanged.

**Tech Stack:** TypeScript, Pointer Events, Vitest, Vite

## Global Constraints

- Edge width is exactly 24 CSS pixels on both sides.
- Do not change tab transition behavior after a gesture is accepted.
- Preserve existing interactive and vertical gesture exclusions.

---

### Task 1: Edge-Gated Tab Swipe

**Files:**
- Modify: `packages/webapp/src/presentation/parent-tab-swipe.ts`
- Unit tests: `packages/webapp/src/presentation/parent-tab-swipe.test.ts`

**Interfaces:**
- Consumes: `PointerSample.clientX` and `PointerSample.viewportWidth`
- Produces: edge-only activation through `createParentTabSwipeGesture`

- [x] **Step 1: Add viewport geometry to pointer samples**

Add `viewportWidth: number` and populate it from `window.innerWidth` in the browser bridge.

- [x] **Step 2: Reject starts outside the 24px edge zones**

Accept `clientX <= 24` or `clientX >= viewportWidth - 24`; leave `active` empty otherwise.

- [x] **Step 3: Expand focused gesture tests**

Cover left edge, right edge, exact boundaries, center rejection, interactive controls, vertical gestures, and cancellation.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run: `bun test packages/webapp/src/presentation/parent-tab-swipe.test.ts`

Expected: PASS

Run: `bun run --cwd packages/webapp build`

Expected: PASS
