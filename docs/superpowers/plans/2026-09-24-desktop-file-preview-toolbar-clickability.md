# Desktop File Preview Toolbar Clickability Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore click handling for every Electron file-preview header button without removing the remaining header area from the window drag region.

**Architecture:** Keep the global 52px Electron drag surface unchanged. Mark only the shared preview header button style as `no-drag`, so every button using that style becomes interactive while browsers ignore the Electron-specific property.

**Tech Stack:** React 18, TypeScript, Electron CSS app regions, Vitest.

## Global Constraints

- Do not change the global Electron drag region.
- Preserve the WebApp file preview behavior and layout.
- Apply `no-drag` only to preview header buttons, not the complete preview header.
- Do not mix unrelated dirty worktree changes into this implementation.

---

### Task 1: Restore preview toolbar pointer handling

**Files:**
- Modify: `packages/desktop/renderer/components/file-workspace/FilePreview.tsx:918`
- Unit tests: `packages/desktop/renderer/components/file-workspace/DesktopFileWorkspaceLayout.test.ts`

**Interfaces:**
- Consumes: Electron's `-webkit-app-region` CSS behavior and the existing `HEADER_BUTTON_STYLES: React.CSSProperties` object.
- Produces: A shared header-button style whose rendered Electron region is `no-drag`.

- [x] **Step 1: Extend the existing layout contract fixture**

Read `FilePreview.tsx` as source in `DesktopFileWorkspaceLayout.test.ts`:

```ts
const filePreviewSource = readFileSync(new URL("./FilePreview.tsx", import.meta.url), "utf8");
```

- [x] **Step 2: Add the focused regression assertion**

Extract `HEADER_BUTTON_STYLES` and assert that it opts the buttons out of the draggable title-bar region:

```ts
it("keeps file preview header buttons outside the Electron drag region", () => {
  const headerButtonStyles = filePreviewSource.match(
    /const HEADER_BUTTON_STYLES: React\.CSSProperties = \{([\s\S]*?)\n\};/,
  )?.[1] ?? "";

  expect(headerButtonStyles).toMatch(/WebkitAppRegion:\s*"no-drag"/);
});
```

- [x] **Step 3: Mark every shared preview header button as interactive**

Add the Electron-only style to `HEADER_BUTTON_STYLES`:

```ts
const HEADER_BUTTON_STYLES: React.CSSProperties = {
  width: 28, height: 28, borderRadius: 7, border: "1px solid var(--ui-panel-input-border, #333)",
  display: "inline-flex", alignItems: "center", justifyContent: "center",
  background: "var(--ui-muted-surface, #1b1b22)", color: "var(--ui-muted-text, #ccc)", flexShrink: 0, cursor: "pointer",
  WebkitAppRegion: "no-drag",
};
```

This covers edit, cancel, save, download, share, preview, and close without changing the surrounding header.

- [x] **Step 4: Inspect the final diff**

Run `git diff --check` and confirm the diff contains only the planned source, test, and plan changes. Preserve all unrelated existing worktree modifications.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run: `bunx vitest run packages/desktop/renderer/components/file-workspace/DesktopFileWorkspaceLayout.test.ts packages/desktop/renderer/components/file-workspace/FileWorkspaceDrawer.test.tsx`

Expected: both files pass.

Run: `bun run --cwd packages/desktop compile`

Expected: Desktop TypeScript and preload compilation pass.

Then start the current Electron build and verify that edit, browser preview, close, download, and share each respond to a click rather than dragging the window. A platform-level unsupported share result is acceptable only when the UI shows its existing explicit error feedback.
