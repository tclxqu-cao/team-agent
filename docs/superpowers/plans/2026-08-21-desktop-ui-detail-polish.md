# Desktop UI Detail Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Polish borders, utility controls, active states, assistant output, and composer details without changing the desktop layout.

**Architecture:** Add a small shared CSS component-state layer, then replace local inline resting/hover styling in `App.tsx` and `ChatView.tsx` with semantic classes. Preserve all handlers, geometry, stores, and skin/layout behavior; verify through builds, tests, and real renderer screenshots.

**Tech Stack:** React 18, TypeScript, CSS custom properties, Vite, Electron 32, ego-browser.

## Global Constraints

- Preserve sidebar, conversation, composer, modal, and popover geometry.
- Do not add dependencies or change application data flow.
- Use one structural border per region; internal controls are borderless at rest.
- Preserve pearl, sci-fi, noir and standard, compact, focus modes.
- Keep keyboard focus visible and respect reduced motion.

---

### Task 1: Add the shared quiet-control state system

**Files:**
- Modify: `packages/desktop/renderer/styles/global.css`

**Interfaces:**
- Produces CSS classes: `.ui-icon-button`, `.ui-quiet-button`, `.sidebar-row`, `.sidebar-row-active`, `.composer-shell`, `.appearance-choice`, `.settings-tab`, and state modifiers.

- [ ] **Step 1: Add component-level tokens**

Add hairline, control-hover, control-active, focus-ring, and active-edge variables for all skins using existing color tokens.

- [ ] **Step 2: Add shared control classes**

Implement stable dimensions, borderless resting states, hover fills, active/open accent states, disabled behavior, and `:focus-visible` treatment without layout-shifting border changes.

- [ ] **Step 3: Add active-edge and shell classes**

Use a pseudo-element for the 2 px active edge so selected rows do not resize. Give the composer one border and one `:focus-within` ring.

- [ ] **Step 4: Reduce motion safely**

Add `@media (prefers-reduced-motion: reduce)` overrides for nonessential transitions and entrance animation.

---

### Task 2: Polish sidebar, settings, and appearance controls

**Files:**
- Modify: `packages/desktop/renderer/App.tsx`
- Modify: `packages/desktop/renderer/styles/global.css`

**Interfaces:**
- Consumes shared classes from Task 1.
- Preserves existing project, session, hide, appearance, import, settings, skin, layout, and voice handlers.

- [ ] **Step 1: Apply semantic row classes**

Move project/session selection visuals and action visibility to `.sidebar-row` classes. Preserve row heights and ellipsis.

- [ ] **Step 2: Unify sidebar utility controls**

Apply `.ui-quiet-button` to `隐藏后台` and `导入项目`, `.ui-icon-button` to appearance, and remove inline mouse-enter mutations.

- [ ] **Step 3: Polish settings modal controls**

Apply shared icon close styling and underline/edge-based `.settings-tab` states. Keep modal dimensions and tab content unchanged.

- [ ] **Step 4: Polish appearance choices**

Convert skin choices to borderless swatch rows with a selected check. Group layout choices in one segmented boundary and leave voice switches as functional toggles.

- [ ] **Step 5: Run TypeScript build checkpoint**

Run: `bun run --cwd packages/desktop build`

Expected: exit 0.

---

### Task 3: Polish assistant output and composer boundaries

**Files:**
- Modify: `packages/desktop/renderer/components/ChatView.tsx`
- Modify: `packages/desktop/renderer/styles/global.css`

**Interfaces:**
- Consumes `.message-card`, `.composer-shell`, and `.ui-icon-button` classes.
- Preserves send, attachment, dictation, image, model selection, TTS, context usage, and settings behavior.

- [ ] **Step 1: Quiet assistant message cards**

Remove lift-on-hover and persistent medium shadow. Keep a subtle surface/hairline and reveal actions on hover/focus-within.

- [ ] **Step 2: Apply composer shell states**

Replace the 1.5 px outline with the shared 1 px shell and focus-within ring. Keep all internal separators and content order.

- [ ] **Step 3: Unify composer icon controls**

Apply shared borderless icon-button states to attachments, dictation, images, and settings. Keep the enabled send button as the only solid accent action.

- [ ] **Step 4: Run renderer tests**

Run: `bunx vitest run packages/desktop/renderer`

Expected: all renderer tests pass.

---

### Task 4: Build and visually verify the real desktop renderer

**Files:**
- Verify: `packages/desktop/renderer/App.tsx`
- Verify: `packages/desktop/renderer/components/ChatView.tsx`
- Verify: `packages/desktop/renderer/styles/global.css`

**Interfaces:**
- Produces screenshot evidence across skins, layouts, and viewport widths.

- [ ] **Step 1: Run full desktop build and tests**

Run: `bun run --cwd packages/desktop build`

Run: `bunx vitest run packages/desktop/main packages/desktop/renderer`

Expected: exit 0 and all tests pass.

- [ ] **Step 2: Start through the LaunchServices wrapper**

Restart `/private/tmp/CustomerAgentVoiceLauncher.app` so Electron, Vite, microphone capture, and the voice sidecar share the correct lifecycle.

- [ ] **Step 3: Inspect standard pearl at desktop and narrow widths**

Use ego-browser against the renderer to capture sidebar controls, settings, appearance, message output, and composer. Verify no clipping, overlap, layout shift, or nested cards.

- [ ] **Step 4: Inspect all skins and layouts**

Switch pearl/scifi/noir and standard/compact/focus through the UI. Confirm contrast, active edges, popover containment, and focus states.

- [ ] **Step 5: Verify runtime health**

Run: `curl --fail --silent http://127.0.0.1:17863/health`

Expected JSON includes `"ready":true`, `"asr":true`, `"kws":true`, and `"tts":true`.

- [ ] **Step 6: Check final diff scope**

Run: `git diff --check`

Confirm unrelated `WebSearchTool`, `.next`, and `.agents` files remain untouched and unstaged.

- [ ] **Step 7: Commit UI implementation**

```bash
git add packages/desktop/renderer/App.tsx \
  packages/desktop/renderer/components/ChatView.tsx \
  packages/desktop/renderer/styles/global.css
git commit -m "style(desktop): polish workspace controls and boundaries"
```
