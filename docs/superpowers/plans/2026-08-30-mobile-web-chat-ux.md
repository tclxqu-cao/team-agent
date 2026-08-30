# Mobile Web Chat UX Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Customer Agent's Web chat comfortable for one-handed phone use while preserving Electron and desktop Web behavior.

**Architecture:** Keep behavior in the shared renderer and expose only semantic class hooks from `App.tsx` and `ChatView.tsx`. Implement all breakpoint-specific layout in the WebApp stylesheet so the `data-web-shell` boundary prevents Electron regressions.

**Tech Stack:** React 18, TypeScript, Vite, CSS, Vitest, in-app Browser mobile viewport testing.

## Global Constraints

- Do not change API contracts, session lifecycle, persistence, model configuration, or message sending behavior.
- Do not alter the Electron layout or desktop Web breakpoints.
- Do not add dependencies, custom fonts, bottom navigation, or gestures.
- Mobile primary controls must be at least 42px in both dimensions.
- The layout must support 390 x 844 and safe-area insets without overlap.

---

### Task 1: Add Stable Mobile Styling Hooks

**Files:**
- Modify: `packages/desktop/renderer/App.tsx`
- Modify: `packages/desktop/renderer/components/ChatView.tsx`
- Modify: `packages/desktop/renderer/components/ContextUsageBar.tsx`

**Interfaces:**
- Consumes: existing `mobileDrawer`, `sidebarDrawerOpen`, `isUser`, and Web shell state.
- Produces: `app-shell`, `mobile-drawer-toggle`, `mobile-drawer-scrim`, `app-sidebar`, `app-sidebar-*`, `app-main`, `chat-message-row--user`, `chat-message-row--assistant`, `chat-message-bubble--user`, `chat-message-bubble--assistant`, and `chat-composer-hint` hooks.

- [x] **Step 1: Add app-shell and drawer class hooks**

Attach semantic classes without moving elements or changing handlers. Add `aria-expanded={sidebarDrawerOpen}` to the drawer toggle and render menu/close paths from the same SVG based on `sidebarDrawerOpen`.

- [x] **Step 2: Add role-specific message class hooks**

Compose message row and bubble classes from `isUser` so CSS can change widths without querying inline `flexDirection` styles.

- [x] **Step 3: Add a composer-hint class hook**

Label the existing keyboard hint so the Web mobile breakpoint can hide it while desktop retains it.

### Task 2: Implement The Mobile Web Layout

**Files:**
- Modify: `packages/webapp/src/presentation/web.css`
- Modify: `packages/webapp/src/presentation/browser-composer.css`

**Interfaces:**
- Consumes: semantic classes from Task 1 and existing renderer design tokens.
- Produces: a 52px mobile header, 88vw drawer, full-width assistant responses, compact user bubbles, 44px composer controls, and safe-area-aware spacing.

- [x] **Step 1: Define mobile Web typography and shell tokens**

Under `@media (max-width: 899px)`, use the native Chinese system stack and set mobile values for message width, spacing, and header height.

- [x] **Step 2: Tune the mobile drawer and touch targets**

Set the drawer width to `min(88vw, 348px)`, increase project/session row and icon-button hit areas to at least 42px, keep the active accent rail, and soften the scrim and shadow.

- [x] **Step 3: Tune header and conversation geometry**

Use a 42px drawer toggle, reserve title space, hide message avatars, assign 88% maximum width to user content and 100% to assistant content, and keep long code/tool output within the viewport.

- [x] **Step 4: Build the context-ribbon composer dock**

Keep the existing `ContextUsageBar` at the top of the composer, set the add/send buttons to 44px, give the input row a stable minimum height, hide the keyboard hint on mobile, and respect bottom safe-area insets.

### Task 3: Verify Behavior And Responsive Layout

**Files:**
- Verify: `packages/webapp/src/presentation/web.css`
- Verify: `packages/webapp/src/presentation/browser-composer.css`
- Verify: `packages/desktop/renderer/App.tsx`
- Verify: `packages/desktop/renderer/components/ChatView.tsx`

**Interfaces:**
- Consumes: the built WebApp at `/app/` and the existing HTTP agent gateway.
- Produces: browser evidence at mobile and desktop widths.

- [x] **Step 1: Build and typecheck**

Run `bun run --cwd packages/webapp typecheck` and `bun run --cwd packages/webapp build`; both commands must exit 0.

- [x] **Step 2: Verify 390 x 844 layout**

Check the closed chat, open drawer, long conversation, composer, and add menu. Assert no horizontal overflow, no overlapping controls, and at least 42px primary action dimensions.

- [x] **Step 3: Verify chat behavior**

Send `手机布局回归测试，请只回复 OK`, confirm `GET /api/agent/stream` occurs before `POST /api/agent/run` with the same session ID, wait for `OK`, reload, and verify both messages persist.

- [x] **Step 4: Verify desktop preservation**

Reset the viewport and confirm the standard sidebar remains visible, the drawer toggle is absent, and the composer and messages retain desktop geometry.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run: `bunx vitest run packages/webapp/src/infrastructure/browser-crypto.test.ts packages/desktop/renderer/lib/chat-command.test.ts packages/desktop/renderer/stores/agentStore.test.ts packages/desktop/renderer/lib/voice-command.test.ts`

Expected: 4 files and 16 tests pass. If a test fails, fix the implementation or test and rerun this command until it passes. Report the command and result in the final response.

### Task 4: Unify The Mobile Composer Surface

**Files:**
- Modify: `packages/desktop/renderer/components/ContextUsageBar.tsx`
- Modify: `packages/webapp/src/presentation/web.css`

**Interfaces:**
- Consumes: the existing `ContextUsageBar` view model and Web Shell mobile breakpoint.
- Produces: stable context label, meter, and summary hooks plus a single-surface mobile composer with no internal divider.

- [x] **Step 1: Add context-usage semantic hooks**

Add class names to the existing label, meter, and numeric summary elements without changing their data, click behavior, or desktop inline layout.

- [x] **Step 2: Merge the context rail into the composer shell**

Under the Web Shell mobile breakpoint, remove the ribbon border, reduce the meter to 4px, align both rows to a 12px horizontal rhythm, keep the input row at least 56px tall, and let the shell alone own background, radius, border, and focus state.

- [x] **Step 3: Verify responsive appearance**

At 390 x 844, assert the ribbon has no bottom border, the meter is 4px tall, the input row is at least 56px, and the shell has one border and no shadow. Reset to desktop width and confirm the shared renderer layout remains unchanged.

## Composer Unification Verification

- [x] **Main agent: run affected checks after development is complete**

Run: `bun run --cwd packages/webapp typecheck && bun run --cwd packages/webapp build && bunx vitest run packages/desktop/renderer/components/ContextUsageBar.test.ts`

Expected: typecheck and build exit 0, and the focused ContextUsageBar tests pass. Fix any failure and rerun until all checks pass.
