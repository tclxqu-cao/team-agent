# WebApp Tab Swipe Bridge Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore horizontal tab switching when a swipe starts inside the built-in `/app/` iframe on `/web`.

**Architecture:** A WebApp-side gesture detector emits a narrow, versioned `postMessage` protocol for horizontal touch movement. The `/web` parent validates the source and origin, then feeds those messages into its existing tab-track animation and completion logic.

**Tech Stack:** React 18, TypeScript, Next.js 14, Vite 5, Vitest 2, Pointer Events, `window.postMessage`.

## Global Constraints

- Preserve vertical chat scrolling and all input, button, link, and content-editable interactions.
- Keep the existing 8px axis-classification threshold, 1.2 direction ratio, and 64px tab-switch threshold.
- Accept iframe messages only from the current origin and the built-in WebApp iframe window.
- Add no dependencies and do not change terminal protocol or session behavior.

---

### Task 1: WebApp Gesture Bridge

**Files:**
- Create: `packages/webapp/src/presentation/parent-tab-swipe.ts`
- Create: `packages/webapp/src/presentation/parent-tab-swipe.test.ts`
- Modify: `packages/webapp/src/main.tsx`
- Modify: `packages/webapp/src/presentation/web.css`

**Interfaces:**
- Produces: `installParentTabSwipeBridge(): () => void`
- Produces: versioned `agent-webapp:tab-swipe:v1` messages with `phase` and `deltaX`.
- Consumes: primary touch Pointer Events and `window.parent.postMessage`.

- [x] **Step 1: Implement gesture arbitration**

Track one primary touch pointer, ignore interactive start targets, classify after 8px, abandon vertical gestures, and emit horizontal `move`, `end`, and `cancel` messages.

- [x] **Step 2: Install the bridge at WebApp startup**

Call `installParentTabSwipeBridge()` before loading the shared renderer. The installer must no-op when `/app/` is opened outside an iframe.

- [x] **Step 3: Keep native scrolling vertical**

Apply `touch-action: pan-y` to the mobile WebApp main surface so vertical chat scrolling remains browser-native and horizontal pointer events remain observable.

- [x] **Step 4: Add focused unit tests**

Cover interactive-target exclusion, horizontal movement and completion, vertical cancellation, and pointer cancellation.

### Task 2: Parent Tab Track Integration

**Files:**
- Create: `packages/server/app/web/webappTabSwipe.ts`
- Create: `packages/server/app/web/webappTabSwipe.test.ts`
- Modify: `packages/server/app/web/page.tsx`

**Interfaces:**
- Produces: `parseWebappTabSwipeMessage(data: unknown): WebappTabSwipeMessage | null`.
- Consumes: same-origin message events whose source equals the built-in iframe window.

- [x] **Step 1: Add strict message parsing**

Accept only the exact message type, known phases, and finite horizontal deltas.

- [x] **Step 2: Connect the iframe to the existing swipe state**

Store the iframe ref, validate `origin` and `source`, map `move` to track delta, map `end` to `handleTabSwipeEnd`, and map `cancel` to `resetSwipe`.

- [x] **Step 3: Add parser tests**

Cover valid messages and reject wrong type, phase, missing delta, `NaN`, and infinite deltas.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run:

```bash
bunx vitest run packages/webapp/src/presentation/parent-tab-swipe.test.ts packages/server/app/web/webappTabSwipe.test.ts
bun run --cwd packages/webapp typecheck
bun run --cwd packages/webapp build
bun run --cwd packages/server build
```

Expected: focused tests pass, both typecheck/build commands exit with status 0, and the mobile `/web` first tab switches on a horizontal swipe without breaking vertical chat scrolling.
