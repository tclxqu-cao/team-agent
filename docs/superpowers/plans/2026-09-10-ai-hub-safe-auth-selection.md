# AI Hub Safe Authentication and Unified Selection Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AI Hub panes appear on first selection, remove browser fingerprint spoofing, safely redirect Google authentication, and replace the desktop sidebar/mode controls with the mobile-style composer multi-select picker.

**Architecture:** The main process retains requested pane bounds independently of view creation order and applies them when a `WebContentsView` becomes available. A pure navigation policy identifies Google Account URLs, while the renderer derives layout and broadcast recipients from one ordered selection state exposed through a composer listbox.

**Tech Stack:** Electron 44.3.0, React 18, TypeScript, Vitest, lucide-react

## Global Constraints

- Preserve `persist:aihub-<siteId>` sessions, sandboxing, context isolation, disabled Node integration, and media-only permissions.
- Do not spoof Chrome identity or copy browser cookies.
- Keep one to four selected sites; one site is full-width and multiple sites use the existing resizable split layout.
- Preserve existing multi-site broadcast behavior.
- Use ordinary Git only; do not use git-ai.

---

### Task 1: Retained Pane Layout

**Files:**
- Create: `packages/desktop/main/ai-hub/pane-layout-state.ts`
- Create: `packages/desktop/main/ai-hub/pane-layout-state.test.ts`
- Modify: `packages/desktop/main/ai-hub/manager.ts`

**Interfaces:**
- Consumes: renderer `HubPaneRect[]` sent through `hub:set-bounds`
- Produces: `HubPaneLayoutState.replace(panes)`, `HubPaneLayoutState.get(siteId)`, and `HubPaneLayoutState.ids()`

- [x] **Step 1: Add the pure retained-layout state**

Implement an ordered `Map<string, HubPaneRect>` replacement store that clones input rectangles and exposes read-only lookup/IDs.

- [x] **Step 2: Add ordering-focused unit tests**

Test bounds stored before a site exists, replacement after a view already exists, and clearing with an empty pane array.

- [x] **Step 3: Apply retained bounds in the manager**

Update `setBounds` to replace retained state before touching views. Add one bounds application helper and call it from both `setBounds` and `openSite`, so either IPC ordering attaches the view exactly once at the requested rectangle.

### Task 2: Safe Google Authentication Navigation

**Files:**
- Create: `packages/desktop/main/ai-hub/navigation-policy.ts`
- Create: `packages/desktop/main/ai-hub/navigation-policy.test.ts`
- Modify: `packages/desktop/main/ai-hub/manager.ts`
- Modify: `packages/desktop/renderer/global.d.ts`

**Interfaces:**
- Consumes: navigation URLs from `will-navigate` and `setWindowOpenHandler`
- Produces: `isGoogleAuthUrl(url: string): boolean` and `HubEvent.type = "google-auth-external"`

- [x] **Step 1: Implement exact Google authentication URL matching**

Accept only HTTPS URLs whose hostname is `accounts.google.com` or a subdomain of it. Reject HTTP, malformed URLs, and lookalike suffixes.

- [x] **Step 2: Remove all browser identity spoofing**

Delete the claimed Chrome version, custom User-Agent, client-hint request mutation, and `navigator.userAgentData` injection while retaining the permission handler.

- [x] **Step 3: Intercept Google authentication**

Cancel same-view and direct popup Google Account navigation, open the configured provider home page with `shell.openExternal`, emit `google-auth-external`, and log external-open failures without logging authentication query strings.

- [x] **Step 4: Add policy tests and update shared event types**

Cover valid Google Account hosts and invalid schemes/lookalike domains, and expose the dedicated event to the renderer.

### Task 3: Composer Site Picker and Automatic Layout

**Files:**
- Modify: `packages/desktop/renderer/components/AIHubView.tsx`
- Modify: `packages/desktop/renderer/components/AIHubView.test.tsx`

**Interfaces:**
- Consumes: `HubConfig.sites`, `google-auth-external`, existing hub IPC methods
- Produces: one ordered `selectedIds: string[]` used by `computePaneRects`, `hubOpenSite`, `hubSetBounds`, and `hubBroadcast`

- [x] **Step 1: Replace layout-specific state**

Remove `mode`, `activeId`, `compareIds`, and collapsed-bar state. Initialize `selectedIds` from the first configured site and enforce one-to-four selection in a single toggle callback.

- [x] **Step 2: Remove the sidebar and layout tabs**

Let the pane container occupy the full content width. Keep pane refresh and multi-pane close controls, and update empty-state text to reflect selection through the composer.

- [x] **Step 3: Add the mobile-style picker to the composer**

Use a `ChevronDown` icon button labeled `N 个 AI`, an upward multi-select listbox with selected indicators, click-outside/Escape dismissal, inline custom-site add form, and custom-site delete actions.

- [x] **Step 4: Handle authentication feedback**

Set the pane warning only from `google-auth-external`, clear it on a new load, and state that Google login opened in the system browser while email login remains the embedded option when available.

- [x] **Step 5: Update focused renderer tests**

Assert there is no site sidebar or layout tablist, the composer picker exists, selection is capped at four and cannot be empty, title text is not used for authentication detection, and broadcast uses `selectedIds`.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run: `bunx vitest run packages/desktop/main/ai-hub packages/desktop/renderer/lib/ai-hub-layout.test.ts packages/desktop/renderer/components/AIHubView.test.tsx`

Expected: PASS

Run: `bun run --cwd packages/desktop compile`

Expected: PASS

If a test fails, fix the implementation or test and rerun these commands until they pass. Report the commands and results in the final response.
