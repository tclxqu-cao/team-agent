# Markdown Artifact Rendered Preview Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the file-preview eye button render Markdown as a responsive HTML document while preserving source, edit, diff, download, and share behavior.

**Architecture:** Add a server-only Markdown document renderer that escapes embedded HTML and wraps `marked` output in a standalone responsive page. Route only the primary Markdown ticket request through that renderer; keep ticketed relative assets and all other file types on the existing byte-stream path. The React preview iframe selects the rendered URL for Markdown the same way HTML already selects its relative-resource URL.

**Tech Stack:** Next.js 14, React 18, Node HTTP server, `marked@15.0.12`, Vitest, Bun workspace

## Global Constraints

- Render headings, paragraphs, lists, quotes, links, images, tables, task lists, and fenced code blocks.
- Treat embedded raw HTML as text; do not execute scripts, event handlers, or nested frames.
- Keep the rendered document in the existing isolated iframe and use a script-free CSP.
- Preserve ticket expiry, path authorization, relative-resource revalidation, and `no-store`/`nosniff` headers.
- Change only Markdown-family extensions; HTML, JSON, XML, CSV, source, configuration, log, image, PDF, download, share, edit, and diff behavior stay unchanged.
- Cap rendered Markdown at 8 MiB; oversized files retain progressive source viewing and show a clear rendered-preview error page.

---

### Task 1: Standalone Markdown document renderer

**Files:**
- Create: `packages/server/lib/markdown-preview.mjs`
- Create: `packages/server/lib/markdown-preview.test.ts`
- Modify: `packages/server/package.json`
- Modify: `bun.lock`

**Interfaces:**
- Consumes: UTF-8 Markdown source, display title, and a filesystem path.
- Produces: `isMarkdownPreviewPath(filePath: string): boolean`, `renderMarkdownPreviewDocument(source: string, options: { title: string }): string`, and `MAX_MARKDOWN_PREVIEW_BYTES`.

- [x] **Step 1: Add the direct server dependency**

Add the already workspace-locked parser version:

```json
"marked": "15.0.12"
```

Refresh `bun.lock` with the repository package manager so `@agent/server` owns the dependency directly.

- [x] **Step 2: Implement the renderer with raw HTML escaping**

Create a dedicated `Marked` instance with GFM enabled and a renderer override:

```js
const markdown = new Marked({
  gfm: true,
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
  },
});
```

Wrap the parsed body in a complete HTML document. Escape the document title, include UTF-8 and responsive viewport metadata, and add compact responsive CSS for typography, tables, task lists, images, blockquotes, inline code, and horizontally scrollable fenced code blocks. Do not add JavaScript.

- [x] **Step 3: Add renderer unit tests**

Cover the public contracts with assertions equivalent to:

```ts
expect(isMarkdownPreviewPath("README.MD")).toBe(true);
expect(isMarkdownPreviewPath("page.html")).toBe(false);
expect(rendered).toContain("<h1>Preview</h1>");
expect(rendered).toContain("<table>");
expect(rendered).toContain("<pre><code");
expect(rendered).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
expect(rendered).not.toContain("<script>");
```

Also assert title escaping, task-list output, relative image URLs, and responsive overflow CSS.

### Task 2: Ticketed Markdown HTTP response

**Files:**
- Modify: `packages/server/lib/file-preview-service.mjs`
- Modify: `packages/server/lib/file-preview-stream.test.ts`
- Modify: `packages/server/ws-server.mjs`
- Unit tests: `packages/server/lib/markdown-preview.test.ts`

**Interfaces:**
- Consumes: `isMarkdownPreviewPath`, `renderMarkdownPreviewDocument`, and `MAX_MARKDOWN_PREVIEW_BYTES` from Task 1.
- Produces: `serveMarkdownPreview(request, response, filePath): Promise<void>` with private no-store HTML headers and HEAD support.

- [x] **Step 1: Add a bounded Markdown response helper**

In `file-preview-service.mjs`, add a helper that resolves the canonical file, rejects directories, checks the 8 MiB cap, reads UTF-8 source, and emits the rendered document as `text/html; charset=utf-8`. Return the same document byte length for GET and HEAD and keep `cache-control: private, no-store` plus `x-content-type-options: nosniff`.

- [x] **Step 2: Route only the primary Markdown document through rendering**

In `serveTicketedFilePreview`, identify a primary-document request when the requested appended filename resolves to the ticket's primary Markdown path. Call `serveMarkdownPreview` with a script-free policy:

```js
const MARKDOWN_PREVIEW_CSP = [
  "sandbox allow-popups allow-forms",
  "default-src 'none'",
  "img-src 'self' data: https: http:",
  "media-src 'self' https: http:",
  "style-src 'unsafe-inline'",
].join("; ");
```

Keep relative assets on `servePreviewFile`; do not render a linked relative `.md` as the primary document unless it is itself opened through a new ticket.

- [x] **Step 3: Test response headers, HEAD, capacity, and raw asset fallback**

Extend server tests to verify GET/HEAD HTML length, `no-store`, `nosniff`, the script-free CSP wiring, oversized Markdown error handling, and unchanged range streaming for ordinary files.

### Task 3: Markdown iframe URL and user-facing label

**Files:**
- Modify: `packages/server/app/web/FilePreview.tsx`
- Modify: `packages/server/app/web/FilePreview.test.ts`

**Interfaces:**
- Consumes: ticket URL returned by `fs:preview-open` and the current file path.
- Produces: `isMarkdownPreviewPath(path: string): boolean` in the client module and a filename-appended iframe URL for HTML or Markdown.

- [x] **Step 1: Classify Markdown separately in the client**

Add a Markdown extension set and exported path predicate next to `isHtmlPreviewPath`. Derive `isMarkdown` and use `isRenderedDocument = isHtml || isMarkdown` for iframe URL construction.

- [x] **Step 2: Render Markdown through the document URL**

Change the iframe source to:

```tsx
src={isRenderedDocument
  ? `${mediaUrl}/${encodeURIComponent(fileName(path))}`
  : mediaUrl}
```

Set the eye-button tooltip to `预览 Markdown 排版效果` for Markdown while retaining the HTML and raw-file labels for other formats.

- [x] **Step 3: Replace the old raw-Markdown contract test**

Assert Markdown classification, filename-appended URL selection, rendered tooltip text, existing sandbox usage, and unchanged direct ticket URL for JSON/source previews.

### Task 4: Integration regression and release readiness

**Files:**
- Verify: `packages/server/app/web/FilePreview.tsx`
- Verify: `packages/server/ws-server.mjs`
- Verify: `packages/server/lib/markdown-preview.mjs`

**Interfaces:**
- Consumes: completed Tasks 1-3.
- Produces: a buildable Web console with isolated rendered Markdown preview.

- [x] **Step 1: Run focused tests**

Run:

```bash
bunx vitest run packages/server/lib/markdown-preview.test.ts packages/server/lib/file-preview-stream.test.ts packages/server/lib/file-preview-service.test.ts packages/server/app/web/FilePreview.test.ts
```

- [ ] **Step 2: Run type checks and production builds**

Run the repository's Server and WebApp TypeScript checks, then build WebApp and Server under Node 22 with the existing better-sqlite3 ABI 127 release workflow.

- [ ] **Step 3: Run browser acceptance after deployment**

On `:3000`, open a Markdown artifact from the eye control at desktop and `390x844`. Confirm rendered headings, table, code block, relative image, source-mode return, no horizontal page overflow, and no script execution. Recheck HTML and JSON eye previews.

## Final Unit Test Verification

- [ ] **Main agent: run affected unit tests after development is complete**

Run:

```bash
bunx vitest run packages/server/lib/markdown-preview.test.ts packages/server/lib/file-preview-stream.test.ts packages/server/lib/file-preview-service.test.ts packages/server/app/web/FilePreview.test.ts
```

Expected: PASS

If a test fails, fix the implementation or test and rerun this command until it passes. Report the command and result in the final response.
