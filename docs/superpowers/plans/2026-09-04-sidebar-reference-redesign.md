# AgentRoam Sidebar Reference Redesign Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the shared Desktop/Web AgentRoam sidebar from the latest Ardot reference while preserving native workspace ordering, Agent-partitioned caching, session sorting, lazy loading, and deletion semantics.

**Architecture:** Keep workspace and session behavior in `App.tsx` as the application-layer coordinator, and extract focused renderer components for official Agent artwork, compact session rows, and deletion confirmation. All new visuals consume renderer ViewModels and callbacks; no domain, Broker, gateway, or persistence contract changes.

**Tech Stack:** React 18, TypeScript, Vite, Vitest, Lucide React, shared CSS skin variables, ego-browser for production-like visual verification.

## Global Constraints

- The four Agent partitions remain Customer Agent, Codex, Claude Code, and OpenCode in that order.
- Workspace order comes only from the runtime-native order; the running-first session toggle never reorders workspaces.
- The running-first toggle defaults off and preserves `created` descending order within each status partition.
- Workspace/session cache, cursor, stale-while-revalidate, selection, expansion, and scroll state remain isolated per Agent.
- Directory rows retain the current folder icon and show no visible path.
- Session rows contain no second metadata line; they show only status dot, title, and necessary actions.
- External occupancy uses a `LockKeyhole` icon with accessible text instead of an “占用” badge.
- Official Agent glyph geometry is used, but all foreground/background/border colors come from the active skin.
- Pearl (`pearl`), sci-fi (`scifi`), and noir (`noir`) skins must avoid dark-on-dark and light-on-light text; normal text targets 4.5:1 contrast and non-text indicators target 3:1.
- Desktop and Web share the same renderer implementation; mobile remains bounded by `min(82vw, 320px)`.

---

### Task 1: Official Agent Icon System

**Files:**
- Create: `packages/desktop/renderer/components/AgentBrandIcon.tsx`
- Modify: `packages/desktop/renderer/components/AgentWorkspaceSwitcher.tsx`
- Modify: `packages/desktop/renderer/components/AgentWorkspaceSwitcher.test.tsx`
- Delete: `packages/desktop/renderer/components/RuntimeSessionMenu.tsx`

**Interfaces:**
- Consumes: `AgentType` from `packages/desktop/renderer/global.d.ts`.
- Produces: `AgentBrandIcon(props: { agentType: AgentType; size?: number; className?: string }): JSX.Element`.
- Produces: icon-only `AgentWorkspaceSwitcher` with unchanged `value`, `health`, and `onChange` props.

- [ ] **Step 1: Add the official icon component**

Implement a single component with one `viewBox` and SVG branch per Agent. Use the existing AgentRoam app mark and vendor the official Codex/OpenAI, Claude, and OpenCode glyph paths locally so the selector never depends on a remote request. Add concise source comments next to the path constants.

```tsx
interface AgentBrandIconProps {
  agentType: AgentType;
  size?: number;
  className?: string;
}

export default function AgentBrandIcon({ agentType, size = 16, className }: AgentBrandIconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      {renderAgentGlyph(agentType)}
    </svg>
  );
}
```

Use `currentColor` for strokes/fills. Do not embed official brand hex colors.

- [ ] **Step 2: Convert the Agent switcher to icon-only tabs**

Replace `shortLabel` with icon metadata and render four stable square tabs. Keep `aria-label`, `aria-selected`, tooltip text, availability status dot, and the current `onChange(agentType)` behavior.

```tsx
const AGENTS: Array<{ agentType: AgentType; label: string }> = [
  { agentType: "customer-agent", label: "Customer Agent" },
  { agentType: "codex", label: "Codex" },
  { agentType: "claude-code", label: "Claude Code" },
  { agentType: "opencode", label: "OpenCode" },
];
```

- [ ] **Step 3: Remove the obsolete runtime abbreviation menu**

Delete `RuntimeSessionMenu.tsx` after confirming `rg "RuntimeSessionMenu" packages/desktop/renderer` has no call site. This removes the remaining dead `CA/CX/CC/OC` abbreviations without changing any rendered flow.

- [ ] **Step 4: Update icon-switcher tests**

Assert stable Agent order, four SVG glyphs, no visible `CA/CX/CC/OC` text, active tab semantics, unavailable tooltip/status, and no disabled Agent tabs.

```tsx
expect(html).toContain('data-agent-icon="codex"');
expect(html).not.toMatch(/>CA<|>CX<|>CC<|>OC</);
expect(html).toContain('aria-selected="true"');
```

### Task 2: Compact Session Row and Deletion Confirmation

**Files:**
- Create: `packages/desktop/renderer/components/SidebarSessionRow.tsx`
- Create: `packages/desktop/renderer/components/SidebarDeleteConfirmation.tsx`
- Create: `packages/desktop/renderer/components/SidebarSessionRow.test.tsx`
- Create: `packages/desktop/renderer/components/SidebarDeleteConfirmation.test.tsx`
- Modify: `packages/desktop/renderer/App.tsx`

**Interfaces:**
- Consumes: `SidebarSessionVisualState` and `SIDEBAR_SESSION_STATUS_LABELS` from `lib/sidebar-session-status`.
- Produces: `SidebarSessionRow` with a renderer-only ViewModel and command callbacks.
- Produces: `SidebarDeleteConfirmation` with anchored desktop and centered mobile presentation.

- [ ] **Step 1: Define the session row ViewModel**

Keep domain/session objects private to `App.tsx`; pass only display data into the component.

```tsx
export interface SidebarSessionRowModel {
  id: string;
  title: string;
  visualState: SidebarSessionVisualState;
  occupiedExternally: boolean;
  canDelete: boolean;
  hasChildren: boolean;
  expanded: boolean;
  child: boolean;
}

interface SidebarSessionRowProps {
  session: SidebarSessionRowModel;
  active: boolean;
  onSelect(): void;
  onRequestDelete(anchor: DOMRect): void;
}
```

- [ ] **Step 2: Implement the one-line session row**

Render the semantic status dot first, a single ellipsized title, `LockKeyhole` only for external occupancy, the existing disclosure chevron when children exist, and a Lucide trash action when deletion is allowed. The button title exposes the full session title; no Agent label, timestamp, message count, or metadata sub-row is rendered.

```tsx
{session.occupiedExternally && (
  <span className="sidebar-session-lock" title="原客户端正在使用，只读" aria-label="原客户端正在使用，只读">
    <LockKeyhole size={13} aria-hidden="true" />
  </span>
)}
```

- [ ] **Step 3: Implement responsive deletion confirmation**

Render through `createPortal(document.body)`. On desktop, position the confirmation bubble beside the clicked trash button and clamp it to an 8px viewport inset. On narrow touch layouts, render a centered modal over a dimmed backdrop. Keep the copy from `sessionDeletionConfirmation(session)` and expose Cancel/Confirm buttons.

```tsx
export interface SidebarDeleteConfirmationProps {
  open: boolean;
  message: string;
  anchor: { top: number; left: number; width: number; height: number } | null;
  mobile: boolean;
  pending: boolean;
  onCancel(): void;
  onConfirm(): void;
}
```

- [ ] **Step 4: Replace `window.confirm` with explicit deletion state**

In `App.tsx`, store `{ session, anchor } | null`, open it from parent, child, and search-result rows, and move the destructive API call into `confirmDeleteSession()`. Close the confirmation before refreshing the owning project; disable both actions while the delete request is pending.

```tsx
const [sessionDeleteRequest, setSessionDeleteRequest] = useState<{
  session: Session;
  anchor: { top: number; left: number; width: number; height: number };
} | null>(null);
const [sessionDeletePending, setSessionDeletePending] = useState(false);
```

- [ ] **Step 5: Add focused component tests**

Verify status dot ordering, single-line content, `LockKeyhole` accessibility, title truncation class, child indentation class, delete callback anchor, desktop bubble copy, mobile modal role, pending disabled state, and cancel/confirm callbacks.

### Task 3: Sidebar Structure and Bottom Action

**Files:**
- Modify: `packages/desktop/renderer/App.tsx`
- Modify: `packages/desktop/renderer/components/SidebarReferenceStyle.test.ts`

**Interfaces:**
- Consumes: existing Agent/workspace/session state and handlers in `App.tsx`.
- Produces: the latest Ardot sidebar hierarchy without changing data-loading calls.

- [ ] **Step 1: Restructure the sidebar header**

Keep the brand row, place the icon-only `AgentWorkspaceSwitcher` beneath it, then add a field-shaped search trigger that opens the existing search overlay.

```tsx
<button type="button" className="sidebar-search-field" onClick={openSessionSearch}>
  <Search size={15} aria-hidden="true" />
  <span>搜索会话</span>
  <kbd>⌘ K</kbd>
</button>
```

Register the existing shortcut only if it already exists; otherwise render `Ctrl K`/`⌘ K` as a visual hint without adding a new global shortcut in this task.

- [ ] **Step 2: Align the directory toolbar with the reference**

Show “目录” and `projects.length` together. Preserve expand/collapse, running-first, and Customer Agent import commands in their current order and keep their current pressed-state semantics.

- [ ] **Step 3: Simplify directory rows**

Keep the current closed/open folder paths and invalid-directory warning glyph. Render only `project.name` as visible text, preserve the path only in the existing tooltip, and add a right-aligned session count from `sessionsByProject[project.id]?.length` after that project has loaded. Keep the per-directory new-session action.

- [ ] **Step 4: Replace inline session markup with `SidebarSessionRow`**

Map both parent and child sessions to `SidebarSessionRowModel`. Parent selection keeps the current child disclosure behavior; child selection keeps its current project/session selection. Compute child visual status with the same `getSidebarSessionVisualState` rule rather than using a generic sub-agent icon.

- [ ] **Step 5: Add the fixed bottom new-session action**

Render the button outside `app-sidebar-scroll`. It targets `selectedProjectId` with the current `activeAgent`; when no directory is selected, disable it and expose `title="请先选择目录"`.

```tsx
<button
  type="button"
  className="sidebar-new-session-primary"
  disabled={!selectedProjectId}
  title={selectedProjectId ? "新建会话" : "请先选择目录"}
  onClick={() => selectedProjectId && void handleNewRuntimeSession(selectedProjectId, activeAgent)}
>
  <Plus size={15} aria-hidden="true" />
  <span>新建会话</span>
</button>
```

- [ ] **Step 6: Preserve loading, empty, cached, and failure flows**

Keep existing `loadProjects`, `loadSessions`, cursor thresholds, retry callbacks, and stale cache messages. Replace inline spacing only; do not change request conditions or project/session arrays.

### Task 4: Skin-Aware Sidebar Styling

**Files:**
- Modify: `packages/desktop/renderer/styles/global.css`
- Modify: `packages/desktop/renderer/components/ChatHistoryStyle.test.ts`
- Modify: `packages/desktop/renderer/components/SidebarReferenceStyle.test.ts`

**Interfaces:**
- Consumes: current semantic skin tokens defined under `:root`, `[data-skin="scifi"]`, and `[data-skin="noir"]`.
- Produces: reference-aligned sidebar styles with no fixed foreground colors.

- [ ] **Step 1: Define stable sidebar control dimensions**

Use fixed tracks for the Agent icons, toolbar buttons, status dots, lock/disclosure icons, and bottom action. Keep cards at 8px radius or less and prevent hover/selection borders from changing measured size.

```css
.agent-workspace-switcher button {
  inline-size: 32px;
  block-size: 32px;
  flex: 0 0 32px;
}

.sidebar-session-row {
  min-block-size: 38px;
  border: 1px solid transparent;
  border-radius: 8px;
}
```

- [ ] **Step 2: Apply the reference hierarchy using existing tokens**

Style the brand, switcher strip, search field, directory toolbar, directory rows, session rows, empty/error states, confirmation surfaces, and bottom action only with `var(...)` or `color-mix(...)` over existing tokens. Official icons inherit `currentColor`.

- [ ] **Step 3: Make selected and status states readable in every skin**

Selected rows use `var(--control-active)` plus an inset border derived from `var(--accent)`. Normal titles use `var(--text-primary)` or `var(--text-secondary)` according to hierarchy. Lock icons use `var(--warning)` and errors use `var(--danger)`. Do not add `#000`, `#fff`, `black`, or `white` foregrounds in the sidebar section.

- [ ] **Step 4: Add responsive and reduced-motion rules**

At narrow widths, keep all text within the 320px drawer, hide nonessential shortcut hints before truncating titles, and center the destructive confirmation. Under `prefers-reduced-motion: reduce`, disable status blinking and sidebar transitions.

- [ ] **Step 5: Extend style-contract tests**

Assert icon/control dimensions, no runtime abbreviations, no visible directory description, no session metadata row, lock icon usage, selected border/background tokens, reduced-motion support, and absence of hard-coded sidebar foreground colors.

### Task 5: Integrated Regression Coverage

**Files:**
- Modify: `packages/desktop/renderer/components/SidebarReferenceStyle.test.ts`
- Modify: `packages/desktop/renderer/components/AgentWorkspaceSwitcher.test.tsx`
- Modify: `packages/desktop/renderer/lib/sidebar-session-sort.test.ts` only if existing assertions need preservation coverage.

**Interfaces:**
- Consumes: completed sidebar components and existing cache/sort helpers.
- Produces: regression tests for the requested design without weakening existing behavioral assertions.

- [ ] **Step 1: Update the reference-contract assertions**

Replace assertions tied to old inline rows and `window.confirm` with component/callback assertions. Keep all existing assertions for Agent-partitioned cache, native workspace order, lazy session loading, scroll pagination, selection stability, running-first behavior, and removal of runtime grouping.

- [ ] **Step 2: Add explicit content-removal assertions**

Assert that the sidebar session component does not render `sourceLabel`, `created`, `updated`, `messageCount`, or a metadata row. Assert that the project button renders `project.name` but not `project.description` as visible content.

- [ ] **Step 3: Add deletion and bottom-action assertions**

Assert that deletion uses `SidebarDeleteConfirmation`, `sessionDeletionConfirmation(session)`, and the existing `deleteSession` path. Assert that the bottom action is disabled without `selectedProjectId` and creates through `handleNewRuntimeSession(selectedProjectId, activeAgent)` when enabled.

## Final Unit Test Verification

- [ ] **Main agent: run affected unit tests after development is complete**

Run:

```bash
PATH=/opt/homebrew/opt/node@22/bin:$PATH bunx vitest run \
  packages/desktop/renderer/components/AgentWorkspaceSwitcher.test.tsx \
  packages/desktop/renderer/components/SidebarSessionRow.test.tsx \
  packages/desktop/renderer/components/SidebarDeleteConfirmation.test.tsx \
  packages/desktop/renderer/components/SidebarReferenceStyle.test.ts \
  packages/desktop/renderer/components/ChatHistoryStyle.test.ts \
  packages/desktop/renderer/lib/agent-workspace-cache.test.ts \
  packages/desktop/renderer/lib/sidebar-selection.test.ts \
  packages/desktop/renderer/lib/sidebar-session-sort.test.ts \
  packages/desktop/renderer/lib/sidebar-session-status.test.ts \
  packages/desktop/renderer/lib/session-deletion.test.ts
```

Expected: all selected Vitest files pass.

Then run:

```bash
PATH=/opt/homebrew/opt/node@22/bin:$PATH bun run --cwd packages/webapp typecheck
PATH=/opt/homebrew/opt/node@22/bin:$PATH bunx tsc -p packages/desktop/tsconfig.renderer.json --noEmit
PATH=/opt/homebrew/opt/node@22/bin:$PATH bun run --cwd packages/webapp build
```

Expected: all type checks and the WebApp production build pass.

Use ego-browser against an isolated Web server to verify desktop and 390x844 layouts in pearl, sci-fi, and noir skins. Inspect computed foreground/background colors for brand, search, directory, session, empty/error, confirmation, and bottom-action states; reject any unreadable pairing. Verify icon-only Agent switching, native directory order, lazy session expansion, running-first toggle, external lock icon, and responsive deletion confirmation before publishing to `:3000`.

If a test or visual assertion fails, fix the implementation or test and rerun the affected command until it passes. Report exact commands and results in the final response.
