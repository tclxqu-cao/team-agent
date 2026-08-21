# Thinking Status and Header Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace exposed internal thinking diagnostics with a status-only indicator while keeping tool cards visible, and move background/appearance controls into the conversation header.

**Architecture:** Add focused presentational components for agent activity and header actions, then compose them from `ChatView`. Keep window hiding and appearance state in `App`; pass callbacks into `ChatView`, including the clicked appearance button rectangle so the existing portal can anchor below the header control.

**Tech Stack:** React 18, TypeScript, Electron renderer, Vitest, `react-dom/server`, CSS design tokens.

## Global Constraints

- Never display raw `thinking` event messages such as `Iteration 3...` in the conversation.
- Preserve existing tool cards, including name, arguments, state, results, and expand/collapse behavior.
- Use the visible labels `思考中` and `工具执行中` only for activity status.
- Keep the header action order `隐藏后台`, `皮肤与布局`, `设置`.
- Do not add a tool dashboard or change agent execution behavior.
- Do not stage or commit unrelated dirty worktree files.
- Do not run `git-ai` in this project.

---

### Task 1: Status-Only Agent Activity

**Files:**
- Create: `packages/desktop/renderer/components/AgentActivityIndicator.tsx`
- Create: `packages/desktop/renderer/components/AgentActivityIndicator.test.tsx`
- Modify: `packages/desktop/renderer/components/ChatView.tsx`
- Modify: `packages/desktop/renderer/styles/global.css`

**Interfaces:**
- Consumes: `activity: "thinking" | "tools"` from `ChatView`'s existing activity state.
- Produces: `AgentActivityIndicator`, a status-only component that accepts no diagnostic message prop.

- [ ] **Step 1: Write the failing component test**

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import AgentActivityIndicator from "./AgentActivityIndicator";

describe("AgentActivityIndicator", () => {
  it("renders only the localized model activity label", () => {
    const html = renderToStaticMarkup(<AgentActivityIndicator activity="thinking" />);
    expect(html).toContain("思考中");
    expect(html).not.toContain("Iteration");
    expect(html).not.toContain("思考过程");
  });

  it("renders the tool activity label", () => {
    const html = renderToStaticMarkup(<AgentActivityIndicator activity="tools" />);
    expect(html).toContain("工具执行中");
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails because the component is missing**

Run: `bunx vitest run packages/desktop/renderer/components/AgentActivityIndicator.test.tsx`

Expected: FAIL resolving `./AgentActivityIndicator`.

- [ ] **Step 3: Implement the status-only component**

```tsx
export type AgentActivityPhase = "thinking" | "tools";

export default function AgentActivityIndicator({ activity }: { activity: AgentActivityPhase }) {
  const label = activity === "tools" ? "工具执行中" : "思考中";
  return (
    <div className="agent-activity-indicator" role="status" aria-live="polite">
      <span>{label}</span>
      <span className="agent-activity-dots" aria-hidden="true">
        {[0, 1, 2].map((index) => <span key={index} style={{ animationDelay: `${index * 0.16}s` }} />)}
      </span>
    </div>
  );
}
```

Add restrained token-based CSS for the inline label and 4px animated dots. In `ChatView`, remove `thinkingText`, every `setThinkingText` call, the bordered `思考过程` branch, and both duplicated dot implementations. Render `AgentActivityIndicator` in both existing activity locations with `activity={agentActivity === "tools" ? "tools" : "thinking"}`. Leave `AgentLoop` and tool-card rendering unchanged.

- [ ] **Step 4: Run the focused test and renderer type/build checks**

Run: `bunx vitest run packages/desktop/renderer/components/AgentActivityIndicator.test.tsx`

Expected: PASS, 2 tests.

Run: `bun run --cwd packages/desktop build`

Expected: Vite build and Electron TypeScript compile succeed.

- [ ] **Step 5: Commit the status presentation change**

```bash
git add packages/desktop/renderer/components/AgentActivityIndicator.tsx \
  packages/desktop/renderer/components/AgentActivityIndicator.test.tsx \
  packages/desktop/renderer/components/ChatView.tsx \
  packages/desktop/renderer/styles/global.css
git commit -m "fix(desktop): simplify agent activity status"
```

### Task 2: Top-Right Background and Appearance Controls

**Files:**
- Create: `packages/desktop/renderer/components/ChatHeaderActions.tsx`
- Create: `packages/desktop/renderer/components/ChatHeaderActions.test.tsx`
- Modify: `packages/desktop/renderer/components/ChatView.tsx`
- Modify: `packages/desktop/renderer/App.tsx`
- Modify: `packages/desktop/renderer/styles/global.css`

**Interfaces:**
- Consumes from `App`: `onHideToBackground(): void`, `onToggleAppearance(anchor: DOMRect): void`, `appearanceOpen: boolean`, the existing settings callback, and `settingsOpen`.
- Produces: an ordered title-bar action group and an appearance anchor rectangle used by the existing portal.

- [ ] **Step 1: Write the failing header action test**

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ChatHeaderActions from "./ChatHeaderActions";

describe("ChatHeaderActions", () => {
  it("renders global actions in the required order", () => {
    const html = renderToStaticMarkup(
      <ChatHeaderActions
        appearanceOpen={false}
        settingsOpen={false}
        onHideToBackground={() => {}}
        onToggleAppearance={() => {}}
        onOpenSettings={() => {}}
      />,
    );
    expect(html.indexOf('aria-label="隐藏后台"')).toBeLessThan(html.indexOf('aria-label="皮肤与布局"'));
    expect(html.indexOf('aria-label="皮肤与布局"')).toBeLessThan(html.indexOf('aria-label="设置"'));
  });

  it("marks the appearance action active while its panel is open", () => {
    const html = renderToStaticMarkup(
      <ChatHeaderActions
        appearanceOpen
        settingsOpen={false}
        onHideToBackground={() => {}}
        onToggleAppearance={() => {}}
        onOpenSettings={() => {}}
      />,
    );
    expect(html).toContain("is-active");
  });
});
```

- [ ] **Step 2: Run the test and verify it fails because the component is missing**

Run: `bunx vitest run packages/desktop/renderer/components/ChatHeaderActions.test.tsx`

Expected: FAIL resolving `./ChatHeaderActions`.

- [ ] **Step 3: Implement the header action group and connect it to `App`**

Create `ChatHeaderActions` with three stable 32px icon buttons. Each button must have matching `title` and `aria-label`; the background action uses a minimize/window icon, appearance uses the existing palette icon, and settings uses the existing gear icon. The appearance click handler calls:

```tsx
onClick={(event) => onToggleAppearance(event.currentTarget.getBoundingClientRect())}
```

Extend `ChatViewProps` with the new callbacks/state and render the component after the session title. In `App`, remove the sidebar utility toolbar and its obsolete CSS, pass the callbacks to `ChatView`, store `{ right, bottom }` from the button rectangle, and position the existing portal panel with a viewport-clamped right-aligned coordinate:

```ts
const panelLeft = Math.max(12, Math.min(appearanceAnchor.right - 320, window.innerWidth - 332));
const panelTop = Math.min(appearanceAnchor.bottom + 8, window.innerHeight - 420);
```

Close the appearance panel when settings opens and close settings when appearance opens so the two overlays cannot compete.

- [ ] **Step 4: Run focused tests and build**

Run: `bunx vitest run packages/desktop/renderer/components/AgentActivityIndicator.test.tsx packages/desktop/renderer/components/ChatHeaderActions.test.tsx`

Expected: PASS, 4 tests.

Run: `bun run --cwd packages/desktop build`

Expected: Vite build and Electron TypeScript compile succeed.

- [ ] **Step 5: Commit the header control move**

```bash
git add packages/desktop/renderer/components/ChatHeaderActions.tsx \
  packages/desktop/renderer/components/ChatHeaderActions.test.tsx \
  packages/desktop/renderer/components/ChatView.tsx \
  packages/desktop/renderer/App.tsx \
  packages/desktop/renderer/styles/global.css
git commit -m "style(desktop): move global actions to chat header"
```

### Task 3: Runtime and Visual Verification

**Files:**
- Modify only if verification reveals a scoped defect in the files from Tasks 1-2.

**Interfaces:**
- Consumes: built renderer and the existing LaunchServices desktop wrapper.
- Produces: runtime evidence for status, controls, layout, and voice-service readiness.

- [ ] **Step 1: Run the relevant renderer tests and desktop build together**

Run: `bunx vitest run packages/desktop/renderer/components/AgentActivityIndicator.test.tsx packages/desktop/renderer/components/ChatHeaderActions.test.tsx && bun run --cwd packages/desktop build`

Expected: all focused tests and build pass.

- [ ] **Step 2: Restart the desktop application through the existing LaunchServices wrapper**

Stop only the processes belonging to this worktree, then launch `/private/tmp/CustomerAgentVoiceLauncher.app` through `open`. Verify `http://127.0.0.1:5173` returns HTTP 200 and the Electron process points at this worktree.

- [ ] **Step 3: Inspect the UI with the project-required ego browser workflow**

Verify standard, focus, and narrow layouts. Confirm the header action order, tooltips, appearance panel placement, and the absence of the old sidebar utility row. Exercise a run that calls a tool and verify the visible sequence `思考中` -> `工具执行中` -> `思考中` -> cleared, while the completed tool card remains visible and no `Iteration N...` text appears.

- [ ] **Step 4: Verify voice readiness after restart**

Check the local voice health endpoint and runtime logs. Expected readiness: service, ASR, KWS, and TTS are available; report any independent TTS timeout separately rather than conflating it with the activity UI change.

- [ ] **Step 5: Review the final diff and commit any verification-only correction**

Run: `git diff --check` and `git status --short`.

If a correction was required, stage only the files from Tasks 1-2 and commit it with a scoped `fix(desktop): ...` message. Preserve all unrelated worktree changes.

### Task 4: Compact Layout Density Correction

**Files:**
- Modify: `packages/desktop/renderer/components/ChatView.tsx`
- Modify: `packages/desktop/renderer/styles/global.css`

**Interfaces:**
- Consumes: the existing `body.layout-compact` state applied by `App`.
- Produces: chat-scoped CSS density variables used by the existing inline layout styles.

- [x] **Step 1: Reproduce the standard/compact parity in the running renderer**

Confirmed the old compact mode changed only the root font size and message-card radius; inline component sizes remained effectively identical.

- [x] **Step 2: Replace hard-coded chat dimensions with scoped CSS variables**

Applied variables for conversation width, title height, message/input padding, turn and row gaps, avatar size, bubble padding/font/line height, and composer row padding.

- [x] **Step 3: Define materially different compact values while preserving standard values**

Standard remains `880px` wide with a `52px` header. Compact becomes `1040px` wide with a `44px` header, tighter padding and gaps, `26px` avatars, and `28px` composer icon buttons.

- [x] **Step 4: Verify computed dimensions and narrow viewport fit**

Ego-browser verification confirmed distinct standard/compact dimensions, zero appearance-panel anchor delta after layout changes, and no header/composer/panel overflow at `900x700`.
