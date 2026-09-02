# Unified Codex-Style Message History Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Customer Agent, Codex, and Claude Code the same Codex-style document history and two-level composer in Electron and Web.

**Architecture:** The shared `ChatView` root receives one presentation modifier that applies regardless of runtime. Shared document-lane, tool-row, and composer rules move into the renderer's global stylesheet; `ChatView` renders one composer markup path, while Web styles keep only shell, safe-area, and mobile behavior.

**Tech Stack:** React 18, TypeScript, CSS, Vitest, Vite, Electron 32.

## Global Constraints

- Desktop header, sidebar, runtime behavior, and persisted messages remain unchanged.
- The centered reading lane is at most `860px` wide.
- User bubbles are right-aligned and at most `min(78%, 680px)` wide.
- Tool summary rows remain expandable and have a compact `32px` collapsed height.
- Customer Agent, Codex, and Claude Code must use the same presentation path with no runtime-specific branch.
- Electron and Web must render the same multiline textarea and complete action toolbar.
- Attachment, image, voice, clipboard screenshot, context, model, effort/status, stop, and send controls remain available.

---

### Task 1: Shared Message History Presentation

**Files:**
- Modify: `packages/desktop/renderer/components/ChatView.tsx:1384-1730`
- Modify: `packages/desktop/renderer/styles/global.css:626-696`

**Interfaces:**
- Consumes: Existing `chat-message-*` and `tool-call-shell__*` semantic class names.
- Produces: Root modifier `chat-view--codex-history` and activity hook `chat-message-activity` used by shared CSS.

- [ ] **Step 1: Add stable shared presentation hooks**

Change the root and activity row to expose shared selectors without checking the runtime:

```tsx
<div className="chat-view chat-view--codex-history" ...>

<div className="chat-message-activity" style={{ display: "flex", marginBottom: 4 }}>
```

- [ ] **Step 2: Make long-message fading follow the document background**

Use a semantic CSS variable for the assistant fade endpoint:

```tsx
background: isUser
  ? "linear-gradient(transparent, rgba(232, 236, 254, 0.95))"
  : "linear-gradient(transparent, var(--chat-assistant-fade-end))"
```

- [ ] **Step 3: Add the shared Codex history rules**

Add scoped rules under `.chat-view--codex-history` that center `.chat-message-group`, hide avatars, zero the row gap, give assistant content and bubble full width, keep the user bubble width constraint, flatten `.message-card`, align `.chat-message-activity`, and flatten the tool shell while preserving the expandable body.

```css
.chat-view--codex-history {
  --chat-assistant-fade-end: var(--bg-deepest);
}
.chat-view--codex-history .chat-message-group {
  width: min(100%, 860px);
  margin-inline: auto;
}
.chat-view--codex-history .chat-message-avatar { display: none !important; }
.chat-view--codex-history .chat-message-content--assistant {
  width: 100%;
  max-width: 100% !important;
}
.chat-view--codex-history .tool-call-shell__header {
  min-height: 32px;
  background: transparent !important;
}
```

### Task 2: Web Deduplication And Style Contract Tests

**Files:**
- Modify: `packages/webapp/src/presentation/web.css:71-144`
- Modify: `packages/webapp/src/presentation/browser-composer.test.ts:42-62`
- Create: `packages/desktop/renderer/components/ChatHistoryStyle.test.ts`

**Interfaces:**
- Consumes: `chat-view--codex-history` and the shared global CSS rules from Task 1.
- Produces: Static style-contract coverage protecting both Electron and Web from presentation drift.

- [ ] **Step 1: Remove duplicate Web-only history rules**

Keep the Web-only `.chat-messages` background and safe-area padding, but delete the duplicated conversation-lane and tool-call blocks now owned by `global.css`.

- [ ] **Step 2: Add desktop shared-history coverage**

Create a Vitest file that reads `ChatView.tsx`, `global.css`, and `ToolCallCard.tsx`. Assert the root modifier exists, no runtime-specific condition selects it, the stable tool hooks remain, and the shared CSS contains the `860px`, avatar, assistant, user-bubble, `32px`, and transparent tool-shell contracts.

```ts
expect(chatView).toContain('className="chat-view chat-view--codex-history"');
expect(globalCss).toContain(".chat-view--codex-history .chat-message-avatar");
expect(globalCss).toContain("width: min(100%, 860px)");
expect(globalCss).toContain("max-width: min(78%, 680px) !important");
expect(globalCss).toContain("min-height: 32px");
```

- [ ] **Step 3: Update Web coverage to consume the shared contract**

Change the existing browser-composer test to assert `web.css` keeps its shell-only chat-area rule while the shared class and global stylesheet own document history styling.

### Task 3: Shared Two-Level Composer

**Files:**
- Modify: `packages/desktop/renderer/components/ChatView.tsx:2465-2937`
- Modify: `packages/desktop/renderer/styles/global.css:514-528`
- Modify: `packages/webapp/src/presentation/browser-composer.css:1-333`
- Modify: `packages/webapp/src/presentation/web.css:81-95`
- Create: `packages/desktop/renderer/components/ChatComposerStyle.test.ts`

**Interfaces:**
- Consumes: Existing Web textarea, toolbar, context, model, effort, stop, and send controls.
- Produces: One shared composer DOM path and global style contract consumed by Electron and Web.

- [ ] **Step 1: Remove Electron/Web composer markup branches**

Always render `web-native-composer-textarea` and `web-native-composer-toolbar`. Delete the Electron-only top context bar, provider pill row, single-line input, direct icon row, and legacy send/queue buttons. Add clipboard screenshot to the shared add menu and preserve the existing event handlers.

- [ ] **Step 2: Move common composer styling into the shared stylesheet**

Move the base `web-native-*` control rules from `browser-composer.css` to `global.css`. Add shared shell and column rules scoped by `.chat-view--codex-history`; leave only narrow-screen media overrides in the Web stylesheet.

- [ ] **Step 3: Add shared composer contract coverage**

Assert `ChatView` contains one textarea/toolbar path, does not contain the legacy single-line input or Web conditional, exposes the screenshot menu action, and `global.css` owns the control size, textarea, toolbar, context, model, effort, stop, and send rules.

### Task 4: Build, Restart, And Visual Acceptance

**Files:**
- Verify only; no additional source files.

**Interfaces:**
- Consumes: Built desktop renderer and the current Electron application session.
- Produces: A restarted desktop app with verified document history geometry.

- [ ] **Step 1: Build the affected applications**

Run the desktop build and Web build so the shared stylesheet is checked in both consumers:

```bash
bun run --cwd packages/desktop build
bun run --cwd packages/webapp build
```

- [ ] **Step 2: Restart Electron**

Close the existing Customer Agent Electron process through the normal application lifecycle, start the current checkout, and wait until the renderer is visible.

- [ ] **Step 3: Verify the desktop UI**

Inspect a conversation containing user text, assistant text, and tool calls. Confirm avatars are absent, assistant content and tool rows share the centered lane, user prompts remain right-aligned bubbles, collapsed tool rows are `32px`, expanded details remain accessible, the two-level composer matches in Electron and Web, and no horizontal overflow appears.

## Final Unit Test Verification

- [ ] **Main agent: run affected unit tests after development is complete**

Run:

```bash
bunx vitest run packages/desktop/renderer/components/ChatHistoryStyle.test.ts packages/desktop/renderer/components/ChatComposerStyle.test.ts packages/webapp/src/presentation/browser-composer.test.ts
```

Expected: PASS.

If a test fails, fix the implementation or test and rerun this command until it passes. Report the command and result in the final response.
