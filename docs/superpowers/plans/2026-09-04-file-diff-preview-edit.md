# File Diff Preview And Edit Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users open delivered or changed files, see Git-based added and removed lines when changes exist, see the full file otherwise, and edit and save text files from the preview header.

**Architecture:** Extend the authenticated WebSocket file service with a text inspection response and optimistic-concurrency save operation. Keep Git and filesystem work server-side, render the returned unified diff in the existing Web file preview, and reuse the existing same-origin artifact bridge for message and tool-file entry points.

**Tech Stack:** React 18, TypeScript, Next.js Web console, Node.js filesystem and child-process APIs, Vitest, Git unified diff.

## Global Constraints

- Preserve `HostPathPolicy` authorization for every read and write.
- Only text files up to 8 MiB are editable; binary media keeps its existing preview behavior.
- Saving must reject stale editor content when file size or mtime changed after loading.
- Relative tool paths resolve only against the selected session/project working directory.
- Existing user changes in the dirty worktree must remain intact.

---

### Task 1: Host Text Inspection And Save Service

**Files:**
- Create: `packages/server/lib/file-preview-service.mjs`
- Create: `packages/server/lib/file-preview-service.test.ts`
- Modify: `packages/server/ws-server.mjs`

**Interfaces:**
- Produces: `inspectTextFile(path)` returning current UTF-8 data, metadata, and Git diff state.
- Produces: `saveTextFile(path, content, expected)` returning new size and mtime or throwing `EFILECHANGED`.

- [x] **Step 1: Implement Git-aware text inspection**

Read an allowed regular file up to 8 MiB, locate its enclosing repository with `git rev-parse`, return `git diff HEAD` for tracked files, and synthesize an all-added patch for untracked files. Return no patch when the file is unchanged or outside Git.

- [x] **Step 2: Implement conflict-aware text saving**

Compare the current size and mtime with the load-time values, reject stale writes, preserve the existing file mode, and return updated metadata.

- [x] **Step 3: Expose authenticated RPC methods**

Add `fs:inspect-text` and `fs:write-text` handlers after applying `assertAllowed` to the requested path.

- [x] **Step 4: Add focused service tests**

Cover unchanged tracked content, modified line diff, untracked all-added diff, non-repository content, successful save, and stale-save rejection in temporary repositories.

### Task 2: Diff-First Editable Preview

**Files:**
- Create: `packages/server/app/web/fileDiff.ts`
- Create: `packages/server/app/web/fileDiff.test.ts`
- Modify: `packages/server/app/web/FilePreview.tsx`
- Modify: `packages/server/app/web/FilePreview.test.ts`

**Interfaces:**
- Consumes: `fs:inspect-text` and `fs:write-text` RPC responses from Task 1.
- Produces: `parseUnifiedDiff(patch)` with typed hunk, context, added, and removed rows.

- [x] **Step 1: Parse unified diff rows**

Parse hunk coordinates into stable old/new line numbers, count additions/removals, and keep only hunk content needed by the preview.

- [x] **Step 2: Render the default preview mode**

Show a structured diff table and change counts when the server returns a changed patch. Otherwise show the full current text with line numbers.

- [x] **Step 3: Add header edit and save controls**

Use icon buttons with accessible labels and tooltips. Edit opens a full-height monospace textarea; save calls `fs:write-text`, handles conflict errors in place, and refreshes the Git diff after success.

- [x] **Step 4: Preserve external-change and large-file behavior**

Do not overwrite an active draft when a watch event arrives. Keep the existing chunked read-only preview for text files larger than 8 MiB and preserve media/download behavior.

- [x] **Step 5: Add focused parser and component contract tests**

Cover line numbering, add/remove counts, empty patches, presence of edit/save controls, RPC names, and the stale-draft guard.

### Task 3: Clickable Changed-File Entries

**Files:**
- Modify: `packages/desktop/renderer/App.tsx`
- Modify: `packages/desktop/renderer/components/ChatView.tsx`
- Modify: `packages/desktop/renderer/components/ToolCallCard.tsx`
- Modify: `packages/desktop/renderer/components/ToolCallCard.test.tsx`
- Modify: `packages/desktop/renderer/styles/global.css`

**Interfaces:**
- Consumes: existing `postWebArtifactOpen(path)` and selected session/project working directory.
- Produces: preview icon actions for read/write/edit/apply-patch tool rows in the Web shell.

- [x] **Step 1: Pass the effective workspace path to tool cards**

Prefer the selected native session cwd, then the selected project's description path.

- [x] **Step 2: Resolve safe tool file paths**

Accept absolute host paths directly and resolve normalized relative paths under the effective workspace, rejecting control characters and parent traversal.

- [x] **Step 3: Add file preview actions**

Render an Eye icon action on single-file tool rows and explicit file buttons for multi-file patch calls. Post the resolved absolute path through the existing artifact bridge.

- [x] **Step 4: Add focused renderer tests**

Verify Web-shell file actions, relative path resolution, multi-file changes, and no preview action in Electron rendering.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run: `bunx vitest run packages/server/lib/file-preview-service.test.ts packages/server/app/web/fileDiff.test.ts packages/server/app/web/FilePreview.test.ts packages/desktop/renderer/components/ToolCallCard.test.tsx packages/core/src/domain/web-console/WebArtifactBridge.test.ts packages/desktop/renderer/lib/artifact-links.test.ts packages/server/app/web/drawerLayout.test.ts`

Expected: PASS

Then run: `bun run --cwd packages/server typecheck && bun run --cwd packages/desktop compile && bun run --cwd packages/webapp typecheck && bun run --cwd packages/webapp build`

Expected: PASS
