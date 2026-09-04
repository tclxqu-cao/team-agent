# Progressive Whole-File Preview Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the beginning of large text artifacts immediately, load the rest as the user scrolls, and stream media through browser-native HTTP loading with clear skin-aware progress feedback.

**Architecture:** Keep WebSocket RPC as the authorized control plane. Text uses bounded `fs:read` chunks and a renderer generation guard; media receives an opaque, expiring URL whose HTTP handler supports byte ranges after the path has passed `HostPathPolicy`. Git diff and editing remain on-demand operations and never gate the initial whole-file view.

**Tech Stack:** Next.js 14 custom Node HTTP server, WebSocket RPC, React 18, TypeScript, Node streams, Vitest, Lucide React.

## Global Constraints

- The primary preview is the complete file, not the Git change view.
- The first text chunk is at most the existing 256 KiB server limit.
- Unread text is fetched only when the bottom sentinel approaches the viewport; only one chunk request may be active.
- Media URLs contain opaque random tickets, not filesystem paths, and every open remains subject to `HostPathPolicy`.
- Keep the existing 8 MiB editing boundary and 256 MiB client-download boundary.
- Preserve the current diff, edit, watched-file, hex fallback, download, and theme behavior.
- Loading UI uses existing skin variables and adds no card, modal, or hard-coded dark surface.

---

### Task 1: Ticketed HTTP File Streaming

**Files:**
- Modify: `packages/server/lib/file-preview-service.mjs`
- Modify: `packages/server/lib/file-preview-service.test.ts`
- Modify: `packages/server/ws-server.mjs`
- Create: `packages/server/lib/file-preview-stream.test.ts`

**Interfaces:**
- Consumes: `HostPathPolicy` through `assertAllowed(path, userId)` in `ws-server.mjs`.
- Produces: `parsePreviewRange(header: string | undefined, size: number): { start: number; end: number } | null`, `servePreviewFile(request, response, filePath, mime)`, and RPC results `{ ticketId: string; url: string; size: number; mtime: number; mime: string }`.

- [x] **Step 1: Extract bounded preview stream primitives**

Add pure range parsing and a streaming responder to `file-preview-service.mjs`. Accept no range as a full response, support `bytes=start-end`, `bytes=start-`, and `bytes=-suffix`, reject multiple or unsatisfiable ranges with HTTP 416, and use `createReadStream` rather than `readFile`.

```js
export function parsePreviewRange(header, size) {
  if (!header) return null;
  // Return one inclusive byte interval or throw EINVALIDRANGE.
}

export async function servePreviewFile(req, res, filePath, mime) {
  // stat regular file, write 200/206 headers, and pipe only the selected range.
}
```

- [x] **Step 2: Add an in-memory preview ticket registry**

In `ws-server.mjs`, store cryptographically random tickets as `{ path, userId, lastAccessAt }`. Issue them only after `assertAllowed`, use a bounded idle expiry, refresh access on valid requests, and expose revocation.

```js
"fs:preview-open": async (msg, conn) => ({
  ticketId,
  url: `/api/web-console/file-preview/${ticketId}`,
  size: stat.size,
  mtime: stat.mtimeMs,
  mime: mimeFor(msg.path),
}),
"fs:preview-close": async (msg, conn) => revokeOwnedPreviewTicket(msg.ticketId, conn.principal.userId),
```

- [x] **Step 3: Route ticketed requests before Next.js**

Recognize `GET` and `HEAD` under `/api/web-console/file-preview/<ticket>`, resolve and revalidate the ticket path with `assertAllowed(ticket.path, ticket.userId)`, then call `servePreviewFile`. Return 404 for unknown/expired tickets, 405 for other methods, and prevent the request from falling through to Next.

- [x] **Step 4: Cover stream and authorization contracts**

Test full, bounded, open-ended, and suffix ranges; 416 responses; zero-byte files; MIME and cache headers; `HEAD`; expiry; ownership-aware revocation; directory rejection; and source-level evidence that both ticket issuance and HTTP serving call `assertAllowed`.

### Task 2: Progressive Text Preview State Machine

**Files:**
- Modify: `packages/server/app/web/FilePreview.tsx`
- Modify: `packages/server/app/web/FilePreview.test.ts`
- Modify: `packages/server/lib/file-preview-service.mjs`
- Modify: `packages/server/lib/file-preview-service.test.ts`
- Modify: `packages/server/ws-server.mjs`

**Interfaces:**
- Consumes: existing `fs:stat`, `fs:read`, `fs:watch`, `fs:inspect-text`, and `fs:write-text` RPCs.
- Produces: `TextPreviewPhase = "initial-loading" | "ready" | "loading-more" | "error"`, chunk segments, loaded-byte progress, and an `fs:inspect-text-status` RPC that reports diff availability without returning file contents.

- [x] **Step 1: Separate lightweight status from full inspection**

Add `inspectTextFileStatus(filePath)` to return `{ size, mtime, tooLarge, diffStatus }` without Base64 file data or a patch. Use bounded Git status commands. Keep `inspectTextFile` unchanged for explicit edit and diff requests.

```js
export async function inspectTextFileStatus(filePath) {
  return { size, mtime, tooLarge, diffStatus };
}
```

- [x] **Step 2: Replace whole-text startup with chunk state**

In `FilePreview.tsx`, replace the initial `fs:inspect-text` call with concurrent `fs:stat`, `fs:read`, and `fs:inspect-text-status`. Store decoded segments and loaded bytes. Use one `TextDecoder` with `{ stream: !eof }` for the active generation.

```ts
type TextPreviewPhase = "initial-loading" | "ready" | "loading-more" | "error";
const [textChunks, setTextChunks] = useState<string[]>([]);
const [loadedBytes, setLoadedBytes] = useState(0);
const generationRef = useRef(0);
```

- [x] **Step 3: Load subsequent chunks from a stable sentinel**

Attach an `IntersectionObserver` to a fixed-height footer within `.pv-body`, rooted to the preview scroller with a forward root margin. When visible and not at EOF, call the existing bounded `fs:read` once. Preserve loaded content on failure and expose retry in the same footer.

- [x] **Step 4: Make diff and editing explicit, on-demand loads**

Default every text preview to `view="file"`. Show the existing diff tab when lightweight status reports changed or untracked; invoke full inspection only when that tab is selected. When edit is selected, load the full editable file, validate UTF-8 and size, then create the draft. Do not replace the independently loaded file chunks merely because diff data arrived.

- [x] **Step 5: Invalidate stale work**

Increment the generation on path change, close, and watched-file restart. Check generation and target path after every awaited RPC. Ignore late data and errors. Reject non-EOF reads whose returned offset does not advance.

- [x] **Step 6: Add focused component and service tests**

Test first-chunk rendering before inspection status, multibyte UTF-8 split across chunks, near-bottom auto-load, one in-flight request, loaded-byte progress, EOF, incremental failure/retry, watched-file restart, late response rejection, on-demand diff, and on-demand edit.

### Task 3: Streaming Media And Loading Presentation

**Files:**
- Modify: `packages/server/app/web/FilePreview.tsx`
- Modify: `packages/server/app/web/FilePreview.test.ts`
- Modify: `packages/server/app/web/page.tsx` only if stable preview sizing needs a shared class.

**Interfaces:**
- Consumes: `fs:preview-open` and `fs:preview-close` from Task 1.
- Produces: media elements backed by the ticket URL, delayed initial loading presentation, and stable incremental progress feedback.

- [x] **Step 1: Replace Base64 media loading**

Use `fs:preview-open` for image, PDF, audio, and video kinds. Assign the returned URL directly to the native element. Revoke the previous ticket during retry, path switch, close, and unmount. Keep unsupported binary files on the existing bounded hexadecimal head read.

- [x] **Step 2: Wire native readiness and errors**

Images and PDF transition to ready on `load`; audio and video transition on `loadedmetadata`. Media failures preserve the header and show a retry action. A path switch removes the old element immediately so its browser request is aborted.

- [x] **Step 3: Add skin-aware loading feedback**

Delay the centered initial indicator by 120 ms to avoid tiny-file flashes. Use `LoaderCircle` with `tree-spin`, current accent/text variables, and a stable body region. Use a fixed-height bottom footer for text progress, `正在加载更多`, and retry so content does not shift.

- [x] **Step 4: Update UI contract tests**

Assert that media uses ticket URLs and native readiness events, `fs:dataurl` is absent from rich-media startup, initial and incremental loading labels exist, loading colors use CSS variables, and the existing theme/edit/download/external-change contracts remain present.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run:

```bash
PATH=/opt/homebrew/opt/node@22/bin:$PATH bunx vitest run packages/server/lib/file-preview-service.test.ts packages/server/lib/file-preview-stream.test.ts packages/server/app/web/FilePreview.test.ts
PATH=/opt/homebrew/opt/node@22/bin:$PATH bun run --cwd packages/server build
```

Expected: all focused tests pass and the production Server build completes.

If a test fails, fix the implementation or test and rerun these commands until they pass. Then publish to `:3000` with the repository release workflow and verify HTTP 200 for `/web`, `/app/`, `/api/agent/runtime-health`, and `/api/sessions` before browser validation.
