# AgentRoam Desktop File, Artifact, and Session Status Parity Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Electron the Web file workspace and artifact-preview experience while making visible Codex session status converge after completion.

**Architecture:** Put file-workspace contracts and session-activity rules in `@agent/core`, keep reusable React file-tree/preview components in the renderer source already shared by Electron and WebApp, and inject WebSocket or Electron IPC adapters at each composition root. Electron main owns filesystem authority through `HostPathPolicy`; the renderer never receives unrestricted Node access.

**Tech Stack:** TypeScript, React 18, Electron 44, Next.js 14, Vitest 2, Lucide React, Node 22.

## Global Constraints

- Use Node `>=22.22.0` for tests and builds.
- Preserve all unrelated dirty-worktree changes and stage no unrelated file.
- Do not call or modify the official Codex Desktop refresh mechanism.
- New Electron file-workspace code must not use the existing unrestricted `file:read` or `file:write` IPC handlers.
- Renderer components must not import Electron, Node filesystem APIs, WebSocket, or HTTP directly.
- Web behavior must remain compatible while Electron gains equivalent file browsing, preview, editing, diff, download/share, and artifact opening.
- Do not invent a terminal context in Electron; its History tab explains that terminal actions require the Web terminal.

---

### Task 1: File Workspace Contracts and Session Activity Domain Rules

**Files:**
- Create: `packages/core/src/domain/file-workspace/entities.ts`
- Create: `packages/core/src/domain/file-workspace/index.ts`
- Create: `packages/core/src/application/file-workspace/FileWorkspaceGateway.ts`
- Create: `packages/core/src/application/file-workspace/index.ts`
- Create: `packages/core/src/domain/session/SessionActivity.ts`
- Unit tests: `packages/core/src/domain/session/SessionActivity.test.ts`
- Modify: `packages/core/src/domain/session/index.ts`
- Modify: `packages/core/src/application/index.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: existing `Session.status` strings and file preview RPC response shapes.
- Produces: `FileWorkspaceEntry`, `FileWorkspaceEvent`, `FileWorkspaceMethod`, `FileWorkspaceGateway`, `projectSessionActivity()`, and `visibleWorkspaceIds()`.

- [x] **Step 1: Add environment-neutral file-workspace entities**

Define entries, chunks, text inspection, preview tickets, and structured request parameters. Keep paths as strings at this boundary; canonicalization belongs to infrastructure.

```ts
export interface FileWorkspaceEntry {
  name: string;
  dir: boolean;
  symlink: boolean;
  size: number;
  mtime: number;
}

export interface FileWorkspaceEvent {
  path: string;
  type?: string;
}

export type FileWorkspaceMethod =
  | "hello" | "fs:list" | "fs:read" | "fs:stat" | "fs:watch"
  | "fs:unwatch" | "fs:inspect-text" | "fs:inspect-text-status"
  | "fs:write-text" | "fs:preview-open" | "fs:preview-close";
```

- [x] **Step 2: Add the application port**

```ts
export interface FileWorkspaceGateway {
  request<T>(method: FileWorkspaceMethod, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  subscribe(type: "fs:event", listener: (event: FileWorkspaceEvent) => void): () => void;
}
```

- [x] **Step 3: Add pure session-activity projection rules**

```ts
export type SessionActivity = "needs-input" | "running" | "idle" | "stale" | "error";

export function projectSessionActivity(input: {
  authoritativeStatus: string;
  locallyRunning: boolean;
  needsInput: boolean;
  stale: boolean;
}): SessionActivity;

export function visibleWorkspaceIds(
  selectedProjectId: string | null,
  expandedProjectIds: Iterable<string>,
): string[];
```

Rules: errors win; a stale remote summary without a local run is `stale`; local running or authoritative running is `needs-input`/`running`; everything else is `idle`.

- [x] **Step 4: Test and export the contracts**

Cover status precedence, stale summaries, local active runs, selected/expanded de-duplication, and null selection. Export the new modules through Core entry points.

### Task 2: Shared File Tree and Preview Presentation

**Files:**
- Create: `packages/desktop/renderer/components/file-workspace/FileTree.tsx`
- Create: `packages/desktop/renderer/components/file-workspace/FilePreview.tsx`
- Create: `packages/desktop/renderer/components/file-workspace/fileDiff.ts`
- Create: `packages/desktop/renderer/components/file-workspace/fileTreeReveal.ts`
- Create: `packages/desktop/renderer/components/file-workspace/index.ts`
- Modify: `packages/server/app/web/FileTree.tsx`
- Modify: `packages/server/app/web/FilePreview.tsx`
- Modify: `packages/server/app/web/fileDiff.ts`
- Modify: `packages/server/app/web/fileTreeReveal.ts`
- Modify: `packages/server/app/web/page.tsx`
- Modify tests: `packages/server/app/web/FileTree.test.ts`, `packages/server/app/web/FilePreview.test.ts`, `packages/server/app/web/fileDiff.test.ts`, `packages/server/app/web/fileTreeReveal.test.ts`

**Interfaces:**
- Consumes: `FileWorkspaceGateway` from Task 1.
- Produces: shared `FileTree`, `FilePreview`, `FileTreeRevealRequest`, and diff/reveal helpers used by both Web and Electron.

- [x] **Step 1: Move pure helpers into the shared renderer module**

Preserve current function signatures for `parseUnifiedDiff`, `parentDirectory`, `isPathInsideRoot`, and `ancestorDirectories`. Leave compatibility re-exports in the old Server paths.

- [x] **Step 2: Move FileTree and replace transport props with the gateway port**

```ts
interface Props {
  gateway: FileWorkspaceGateway;
  onOpenFile: (path: string) => void;
  selectedPath: string | null;
  ready: boolean;
  cwd?: string | null;
  revealRequest?: FileTreeRevealRequest | null;
}
```

Map `rpc(type, params)` to `gateway.request(type, params)` and `onEvent("fs:event", fn)` to `gateway.subscribe("fs:event", fn)` without changing lazy loading, follow-cwd, filtering, reveal, or scroll behavior.

- [x] **Step 3: Move FilePreview and replace transport props with the gateway port**

Keep progressive text reads, Git diff, optimistic text save, ticketed media, browser preview, download, share, external-change handling, and current accessibility labels. The only behavioral change is dependency injection through `gateway`.

- [x] **Step 4: Keep Web imports stable through compatibility modules**

The Server path modules must re-export the shared implementation so existing Page imports and tests do not create a second implementation.

```ts
export { default } from "../../../desktop/renderer/components/file-workspace/FilePreview";
export * from "../../../desktop/renderer/components/file-workspace/FilePreview";
```

- [x] **Step 5: Inject a Web gateway in `page.tsx`**

Use `useMemo` to adapt existing `rpc` and `onEvent` functions to `FileWorkspaceGateway`; pass that object to shared tree/preview components. Preserve Web drawer state, history, and mobile behavior.

- [x] **Step 6: Point focused source-contract tests at the shared source**

Update tests that read component source text so they inspect the shared files while continuing to verify the same behavior.

### Task 3: Restricted Electron File Workspace Adapter

**Files:**
- Create: `packages/desktop/main/file-workspace-service.ts`
- Unit tests: `packages/desktop/main/file-workspace-service.test.ts`
- Modify: `packages/desktop/main/index.ts`
- Modify: `packages/desktop/main/preload.ts`
- Modify: `packages/desktop/renderer/global.d.ts`
- Create: `packages/desktop/renderer/lib/electron-file-workspace-gateway.ts`
- Unit tests: `packages/desktop/renderer/lib/electron-file-workspace-gateway.test.ts`
- Modify: `packages/desktop/package.json`

**Interfaces:**
- Consumes: `FileWorkspaceMethod`, `FileWorkspaceGateway`, `HostPathPolicy`, and the shared preview result shapes.
- Produces: `window.agentApi.fileWorkspaceRequest()`, `window.agentApi.onFileWorkspaceEvent()`, and an Electron renderer gateway.

- [x] **Step 1: Implement the main-process service around HostPathPolicy**

Construct allowed roots from `AGENT_WEB_ROOTS` with `homedir()` fallback. Every operation calls `policy.assertAllowed()` before filesystem access. Implement one-level directory listing, bounded chunk reads, stat, Git status/diff inspection, optimistic UTF-8 writes, preview tickets, and deduplicated `fs.watch` subscriptions.

```ts
export class DesktopFileWorkspaceService {
  constructor(options: { roots: string[]; emit: (event: FileWorkspaceEvent) => void });
  request(method: FileWorkspaceMethod, params?: Record<string, unknown>): Promise<unknown>;
  resolvePreviewTicket(ticketId: string): { path: string; mime: string; markdown: boolean } | null;
  close(): void;
}
```

Enforce maximum read chunks of 1 MiB, editable text of 8 MiB, preview ticket TTL of 10 minutes, and expected size/mtime checks on save.

- [x] **Step 2: Register the ticketed Electron preview protocol**

Register `agentroam-preview` before app readiness. Resolve only tickets issued by the service, honor byte ranges for media/PDF, return rendered Markdown HTML, and attach the same sandbox CSP semantics as Web previews. HTML artifacts remain script-capable only inside the sandboxed preview iframe.

- [x] **Step 3: Add trusted IPC handlers and preload methods**

```ts
fileWorkspaceRequest(method: FileWorkspaceMethod, params?: Record<string, unknown>): Promise<unknown>;
onFileWorkspaceEvent(callback: (event: FileWorkspaceEvent) => void): () => void;
```

Call `trustedServiceSender(event)` for every request. Do not route these methods through `file:read` or `file:write`.

- [x] **Step 4: Adapt Electron IPC to the shared renderer gateway**

Create one `FileWorkspaceGateway` whose request method delegates to `fileWorkspaceRequest` and whose subscription registers `onFileWorkspaceEvent` only for `fs:event`.

- [x] **Step 5: Test security and contract behavior**

Use temporary roots to cover list/read/stat, chunk limits, text inspection/save conflicts, outside-root paths, `..`, symlink escape, missing paths, ticket issue/revoke/expiry, and watcher cleanup. Test the renderer gateway mapping independently.

### Task 4: Electron File Drawer and Header Action

**Files:**
- Create: `packages/desktop/renderer/components/file-workspace/FileWorkspaceDrawer.tsx`
- Unit tests: `packages/desktop/renderer/components/file-workspace/FileWorkspaceDrawer.test.tsx`
- Modify: `packages/desktop/renderer/components/ChatHeaderActions.tsx`
- Modify: `packages/desktop/renderer/components/ChatHeaderActions.test.ts`
- Modify: `packages/desktop/renderer/components/ChatView.tsx`
- Modify: `packages/desktop/renderer/App.tsx`
- Modify: `packages/desktop/renderer/styles/global.css`

**Interfaces:**
- Consumes: shared FileTree/FilePreview and the Electron `FileWorkspaceGateway`.
- Produces: a desktop drawer controlled by `fileDrawerOpen`, `previewPath`, and `FileTreeRevealRequest` state in `App`.

- [x] **Step 1: Add the header action**

Add a Lucide `PanelRight` icon with `aria-label="我的文件"`, tooltip, active state, and `aria-expanded`. Render it only when `onToggleFiles` is provided and keep the existing action order stable.

- [x] **Step 2: Build the drawer component**

Render Files/History tabs, shared FileTree, and shared FilePreview. The Electron history tab displays that Web terminal history requires a terminal context instead of presenting chat history or executable controls.

- [x] **Step 3: Own drawer state in App**

Use the current selected workspace path as cwd, reset a selected file that no longer belongs to the newly selected project, and expose `openArtifact(path)` that opens the Files tab, increments a reveal request ID, selects the file, and opens preview.

- [x] **Step 4: Add stable responsive layout styles**

Desktop width uses chat + 300px tree + bounded preview; narrower windows overlay the drawer/preview over chat. Add no nested decorative cards and keep all icon buttons fixed-size.

- [x] **Step 5: Test header and drawer behavior**

Cover conditional action rendering, active state, Files/History switching, selected path, reveal request forwarding, preview close, and no-workspace empty state.

### Task 5: Unified Artifact Opening Across Chat Surfaces

**Files:**
- Modify: `packages/desktop/renderer/components/ChatView.tsx`
- Modify: `packages/desktop/renderer/components/ToolCallCard.tsx`
- Modify: `packages/desktop/renderer/components/CodexExecutionTrace.tsx`
- Modify tests: `packages/desktop/renderer/components/ChatHistoryStyle.test.ts`, `packages/desktop/renderer/components/ToolCallCard.test.tsx`, `packages/desktop/renderer/components/CodexExecutionTrace.test.tsx`
- Modify: `packages/desktop/renderer/lib/artifact-links.ts`
- Modify tests: `packages/desktop/renderer/lib/artifact-links.test.ts`

**Interfaces:**
- Consumes: `onOpenArtifact(path: string): void` from App.
- Produces: one callback-driven artifact-opening path for assistant Markdown, tool cards, file-change chips, and Codex traces.

- [x] **Step 1: Replace the Web-only branch in assistant Markdown rendering**

Add an optional artifact callback to `renderAssistantText` and thread it through inline/table rendering. Render a clickable artifact only when the callback exists; otherwise preserve raw text.

- [x] **Step 2: Replace `enableFilePreview` with an open callback**

Tool cards and execution traces derive preview paths when `onOpenArtifact` exists and invoke it for primary/file-row actions. Remove direct calls to `postWebArtifactOpen` from these components.

- [x] **Step 3: Route file-change summaries through the same callback**

The summary button renders in either Web or Electron whenever a valid resolved path and callback exist.

- [x] **Step 4: Compose environment-specific callbacks in App**

For Web shell, call the existing verified `postWebArtifactOpen`; for Electron, call the drawer controller from Task 4. Pass the resulting callback into ChatView.

- [x] **Step 5: Update focused tests**

Verify callback invocation and assert that component source no longer uses `isWebShell()` to gate file previews.

### Task 6: Visible Session Reconciliation and Stale Running State

**Files:**
- Modify: `packages/desktop/renderer/App.tsx`
- Modify: `packages/desktop/renderer/lib/sidebar-session-status.ts`
- Modify tests: `packages/desktop/renderer/lib/sidebar-session-status.test.ts`
- Create: `packages/desktop/renderer/lib/visible-session-refresh.test.ts`

**Interfaces:**
- Consumes: `projectSessionActivity()` and `visibleWorkspaceIds()` from Core.
- Produces: one polling/focus reconciliation path for selected and expanded projects.

- [x] **Step 1: Make sidebar visuals consume projected activity**

Extend the visual state to include `stale`; return a non-spinning stale indicator/label when a cached running summary cannot be confirmed. Preserve explicit failure/error precedence.

- [x] **Step 2: Prevent duplicate project session loads**

Before a background refresh, skip a project already in `loadingProjectIdsRef`. Keep explicit user retry able to start after the current request finishes.

- [x] **Step 3: Replace selected-only polling with visible-project polling**

Every 10 seconds while visible, refresh `visibleWorkspaceIds(selectedProjectId, expandedProjects)`. Skip invalid and currently loading projects. Add a `focus`/`visibilitychange` listener that runs the same reconciliation immediately.

- [x] **Step 4: Project running state from authority, local run, and staleness**

Use project error/stale flags to suppress stale remote-only spinners; never suppress the currently active local run. Existing completion callbacks continue refreshing the owner project immediately.

- [x] **Step 5: Test the spinner regression**

Cover an expanded non-selected workspace, an idle authoritative refresh, a failed stale refresh, a current local run, and selected/expanded de-duplication.

### Task 7: Compatibility, Build, and Rendered Acceptance

**Files:**
- Modify only files required by failures discovered during verification.

**Interfaces:**
- Consumes: all completed tasks.
- Produces: passing focused suites and verified Web/Electron behavior.

- [x] **Step 1: Run focused Core, Server, and Desktop tests**

Run the exact Vitest file set listed in Final Unit Test Verification and fix implementation or test regressions.

- [x] **Step 2: Run type checks and builds with Node 22**

Build Core, Server, Desktop, and WebApp. Scan output for TypeScript/Next/Vite errors rather than relying only on exit status.

- [x] **Step 3: Validate Web with ego-browser**

Open the local Web console and verify file drawer, artifact link reveal, text preview, rendered HTML/Markdown, and narrow viewport layout. Preserve screenshots for failures; do not claim acceptance from HTTP status alone.

- [x] **Step 4: Validate the actual Electron interaction**

Launch the current Electron build and verify the header icon, Files/History drawer, file reveal, interactive preview, edit/save, one outside-root rejection, and a completed Codex session losing its spinner.

### Task 8: Electron-Only Docked File Workspace Correction

**Files:**
- Modify: `packages/desktop/renderer/App.tsx`
- Modify: `packages/desktop/renderer/components/file-workspace/FileWorkspaceDrawer.tsx`
- Modify: `packages/desktop/renderer/components/file-workspace/FileWorkspaceDrawer.test.tsx`
- Modify: `packages/desktop/renderer/styles/global.css`
- Create: `packages/desktop/renderer/components/file-workspace/DesktopFileWorkspaceLayout.test.ts`
- Regression test: `packages/server/app/web/drawerLayout.test.ts`

**Interfaces:**
- Consumes: existing Electron-only `fileWorkspaceGateway`, `fileDrawerOpen`, and `filePreviewPath` composition state.
- Produces: an Electron-only two-column Dock layout whose closed state restores the chat surface to the full main width without changing WebApp layout selectors or state.

- [x] **Step 1: Mark the Electron composition root explicitly**

Add `file-workspace-capable` only when `fileWorkspaceGateway` exists. Keep Web shell output free of that class.

```tsx
const fileWorkspaceCapable = Boolean(fileWorkspaceGateway);
<main className={`app-main${fileWorkspaceCapable ? " file-workspace-capable" : ""}${fileDrawerOpen && fileWorkspaceCapable ? " file-workspace-open" : ""}${filePreviewPath && fileWorkspaceCapable ? " file-workspace-preview-open" : ""}`}>
```

- [x] **Step 2: Convert the Electron workspace from overlay to Dock Grid**

Scope all new rules beneath `.app-main.file-workspace-capable`. The closed state has one `minmax(0, 1fr)` column. The open state adds a bounded right column; the preview state may widen that column but must retain a nonzero chat column. Remove `position:absolute`, overlay shadow, and chat `margin-right` compensation from `.desktop-file-workspace`.

```css
.app-main.file-workspace-capable { display:grid; grid-template-columns:minmax(0, 1fr); }
.app-main.file-workspace-capable.file-workspace-open { grid-template-columns:minmax(0, 1fr) clamp(240px, 38%, 320px); }
.app-main.file-workspace-capable.file-workspace-preview-open { grid-template-columns:minmax(0, 1fr) min(65%, 820px); }
.app-main.file-workspace-capable > .app-chat-surface { min-width:0; width:100%; }
.app-main.file-workspace-capable > .desktop-file-workspace { position:relative; inset:auto; width:auto; min-width:0; box-shadow:none; }
```

At the existing narrow-desktop breakpoint, keep the right column docked and render only the preview column while a file is open; closing the preview restores the tree. Do not add or modify Server/WebApp `.workspace`, `.tree-col`, or `.preview-col` layout rules.

- [x] **Step 3: Keep an explicit close button in the Electron file header**

Retain the Lucide `X` button in `FileWorkspaceDrawer`, with `aria-label="关闭我的文件"`, and route it through `onClose`. Do not duplicate the current workspace path in this header; the editable location row and tree root remain the path surfaces. Add a render test that asserts the button exists, the duplicate header path is absent, and the entire workspace is not present when `open=false`.

- [x] **Step 4: Add desktop layout source-contract coverage**

The new test reads `App.tsx` and `global.css` and asserts:

```ts
expect(appSource).toContain("file-workspace-capable");
expect(cssSource).toContain(".app-main.file-workspace-capable");
expect(desktopWorkspaceRule).not.toContain("position: absolute");
expect(desktopWorkspaceRule).not.toContain("box-shadow:");
expect(cssSource).not.toMatch(/file-workspace-open \.app-chat-surface \{[^}]*margin-right/);
expect(cssSource).not.toContain(".workspace.show-tree");
```

The final assertion guards this Desktop stylesheet from taking ownership of WebApp drawer selectors; keep the existing Server `drawerLayout.test.ts` passing to prove the Web layout contract is unchanged.

- [x] **Step 5: Verify both environments**

Run the new Desktop tests plus `packages/server/app/web/drawerLayout.test.ts`, then build Desktop and WebApp with Node 22. In real Electron, measure that the open file workspace begins at the chat surface's right edge and that closing it makes the chat surface right edge equal the main layout right edge. In ego-browser, confirm the Web file drawer still opens and closes with its original desktop and narrow viewport behavior.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run:

```bash
bunx vitest run \
  packages/core/src/domain/session/SessionActivity.test.ts \
  packages/server/app/web/FileTree.test.ts \
  packages/server/app/web/FilePreview.test.ts \
  packages/server/app/web/fileDiff.test.ts \
  packages/server/app/web/fileTreeReveal.test.ts \
  packages/server/app/web/drawerLayout.test.ts \
  packages/desktop/main/file-workspace-service.test.ts \
  packages/desktop/renderer/lib/electron-file-workspace-gateway.test.ts \
  packages/desktop/renderer/components/file-workspace/DesktopFileWorkspaceLayout.test.ts \
  packages/desktop/renderer/components/file-workspace/FileWorkspaceDrawer.test.tsx \
  packages/desktop/renderer/components/ChatHeaderActions.test.ts \
  packages/desktop/renderer/components/ChatHistoryStyle.test.ts \
  packages/desktop/renderer/components/ToolCallCard.test.tsx \
  packages/desktop/renderer/components/CodexExecutionTrace.test.tsx \
  packages/desktop/renderer/lib/artifact-links.test.ts \
  packages/desktop/renderer/lib/sidebar-session-status.test.ts \
  packages/desktop/renderer/lib/visible-session-refresh.test.ts
```

Expected: PASS.

Then run:

```bash
bun run --cwd packages/core build
bun run --cwd packages/server build
bun run --cwd packages/desktop build
bun run --cwd packages/webapp build
```

Expected: all commands exit 0 with no build errors. If a test or build fails, fix the implementation or test and rerun until it passes. Report the exact commands and results in the final response.
