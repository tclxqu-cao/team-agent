# Message Artifact File Links Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render local Markdown file links in assistant messages as artifact links that reveal and open the matching file in the Web Console file tree.

**Architecture:** Extend the existing restricted Markdown tokenizer with an absolute local-file token. A shared Core postMessage contract carries clicks from the Web App iframe to the Web Console, which opens the files drawer and preview while `FileTree` lazily expands the target's ancestors and scrolls the selected row into view.

**Tech Stack:** React 18, TypeScript, Next.js 14, Vitest, Lucide React, same-origin `window.postMessage`.

## Global Constraints

- Preserve existing HTTP(S) Markdown link behavior.
- Accept absolute POSIX paths and optional trailing `:line`; reject relative paths and non-HTTP custom protocols.
- Use the existing gateway `fs:list` path policy and lazy-loading behavior.
- Do not add automatic artifact collection, file editing, custom URL schemes, or desktop Finder integration.
- Preserve all unrelated uncommitted work already present in the repository.

---

### Task 1: Parse and render local artifact links

**Files:**
- Modify: `packages/desktop/renderer/lib/markdown-links.ts`
- Modify: `packages/desktop/renderer/lib/markdown-links.test.ts`
- Create: `packages/desktop/renderer/lib/artifact-links.ts`
- Create: `packages/desktop/renderer/lib/artifact-links.test.ts`
- Modify: `packages/desktop/renderer/components/ChatView.tsx`
- Modify: `packages/desktop/renderer/components/ChatHistoryStyle.test.ts`
- Modify: `packages/desktop/renderer/styles/global.css`

**Interfaces:**
- Produces: `MarkdownLinkToken` variant `{ type: "artifact"; label: string; path: string; line?: number }`.
- Produces: `postWebArtifactOpen(path: string, context?: ArtifactBridgeWindow): boolean`.

- [x] **Step 1: Extend the tokenizer**

Parse `[label](/absolute/path)` and `[label](/absolute/path:120)` without changing HTTP(S) tokens. Strip the final numeric line suffix into `line`, leave relative and unsafe schemes as text, and preserve surrounding Chinese text.

- [x] **Step 2: Add the Web-shell sender**

Implement a browser-safe helper that returns `false` outside an iframe and otherwise posts `{ type: WEBAPP_ARTIFACT_OPEN_TYPE, requestId, path }` to `window.parent` using `window.location.origin`.

- [x] **Step 3: Render and style the artifact control**

In `renderRichInline`, render artifact tokens only in Web-shell mode as a button containing a Lucide file icon and the label. Keep the original Markdown text outside Web-shell mode. Add stable `.chat-message-artifact-link` focus, hover, wrapping, and icon styles.

- [x] **Step 4: Add focused tests**

Cover absolute paths, trailing line numbers, spaces, relative paths, dangerous protocols, sender source/origin payload, standalone no-op, and stable ChatView/CSS hooks.

### Task 2: Add the safe iframe artifact contract

**Files:**
- Create: `packages/core/src/domain/web-console/WebArtifactBridge.ts`
- Create: `packages/core/src/domain/web-console/WebArtifactBridge.test.ts`
- Modify: `packages/core/src/domain/web-console/index.ts`

**Interfaces:**
- Produces: `WEBAPP_ARTIFACT_OPEN_TYPE`.
- Produces: `WebArtifactOpenRequest { type; requestId; path }`.
- Produces: `parseWebArtifactOpenRequest(data)` and `readWebArtifactOpenRequest(event, expectedOrigin, expectedSource)`.

- [x] **Step 1: Define and export the contract**

Validate a positive safe-integer request ID and an absolute, non-empty path without NUL bytes.

- [x] **Step 2: Enforce frame provenance**

Return a request only when both event origin and event source match the Web Console's expected iframe.

- [x] **Step 3: Add focused contract tests**

Cover valid requests plus wrong origin, wrong source, relative paths, empty paths, NUL bytes, and invalid request IDs.

### Task 3: Reveal a requested path in FileTree

**Files:**
- Create: `packages/server/app/web/fileTreeReveal.ts`
- Create: `packages/server/app/web/fileTreeReveal.test.ts`
- Modify: `packages/server/app/web/FileTree.tsx`
- Modify: `packages/server/app/web/FileTree.test.ts`

**Interfaces:**
- Consumes: `{ path: string; requestId: number }` from the page.
- Produces: `revealRequest?: FileTreeRevealRequest | null` prop.
- Produces: pure helpers `parentDirectory(path)`, `isPathInsideRoot(path, root)`, and `ancestorDirectories(root, filePath)`.

- [x] **Step 1: Implement pure path helpers**

Normalize trailing slashes, determine the target parent, test root containment without prefix collisions, and return ordered ancestor directories from root to target parent.

- [x] **Step 2: Add the asynchronous reveal effect**

For each request, keep the current root when it contains the target; otherwise use the target parent as a temporary non-following root. Load and expand the root and each ancestor using existing `fetchDir`, mark the final file row with `data-tree-path`, and scroll the matching element into view after React paints.

- [x] **Step 3: Add focused reveal tests**

Cover nested ancestors, same-directory targets, prefix-collision roots, trailing slashes, the new prop/effect hook, selected row path data, and repeated request IDs.

### Task 4: Connect Web Console state and preview

**Files:**
- Modify: `packages/server/app/web/page.tsx`
- Modify: `packages/server/app/web/drawerLayout.test.ts`

**Interfaces:**
- Consumes: `readWebArtifactOpenRequest` and `FileTreeRevealRequest`.
- Produces: artifact click behavior that activates files, opens the drawer, sets preview, and passes the reveal request to `FileTree`.

- [x] **Step 1: Listen for artifact requests**

Add a same-origin/source-checked message listener beside the existing project listener. Store the full request so repeated clicks on the same path remain observable.

- [x] **Step 2: Drive the existing drawer and preview**

Set `drawerTab` to `files`, `drawerOpen` to `true`, and `previewPath` to the request path; pass the request to `FileTree`. Do not call `openFile`, because its phone behavior intentionally closes the drawer for manual file taps.

- [x] **Step 3: Add source-level page assertions**

Assert the secure request reader, state transitions, `revealRequest` prop, and existing manual `openFile` behavior coexist.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run:

```bash
bunx vitest run \
  packages/desktop/renderer/lib/markdown-links.test.ts \
  packages/desktop/renderer/lib/artifact-links.test.ts \
  packages/desktop/renderer/components/ChatHistoryStyle.test.ts \
  packages/core/src/domain/web-console/WebArtifactBridge.test.ts \
  packages/server/app/web/fileTreeReveal.test.ts \
  packages/server/app/web/FileTree.test.ts \
  packages/server/app/web/drawerLayout.test.ts
```

Expected: PASS. Then run Core, Desktop, WebApp, and Server TypeScript checks plus the WebApp build. Fix and rerun until all affected checks pass.
