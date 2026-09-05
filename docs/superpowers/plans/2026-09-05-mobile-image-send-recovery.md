# Mobile Image Send Recovery Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make mobile image sends small enough for Safari/Tailscale and prevent a lost admission response from being reported as a failed native run.

**Architecture:** Normalize supported still images in the browser before converting them to data URLs, while preserving GIFs and falling back to the original file when decoding or compression fails. Keep the existing SSE-first native run flow, but reconcile a transport-level POST failure against the native session snapshot so an already-admitted run continues instead of being closed and reported as `Load failed`.

**Tech Stack:** TypeScript, browser Canvas/Blob APIs, React, Vitest, EventSource, Next.js route handlers.

## Global Constraints

- Resize still images only when they exceed 2048 pixels on either edge or 2 MiB.
- Encode JPEG as JPEG and PNG/WebP as WebP at 0.85 quality; retain the original when the result is not smaller.
- Preserve GIF files unchanged so animation is not lost.
- Never retry `/api/agent/run` automatically after an ambiguous transport failure.
- Apply admission recovery only to native `runtime:` sessions.

---

### Task 1: Browser Image Normalization

**Files:**
- Create: `packages/desktop/renderer/lib/browser-image-normalization.ts`
- Unit tests: `packages/desktop/renderer/lib/browser-image-normalization.test.ts`

**Interfaces:**
- Consumes: browser `Blob`, `HTMLImageElement`, canvas, and object URL APIs.
- Produces: `normalizeComposerImage(file: File): Promise<Blob>`.

- [x] **Step 1: Implement threshold and output-selection helpers**

Create a focused module with exported constants for `2048`, `2 * 1024 * 1024`, and `0.85`. Decode still images, preserve aspect ratio, render to canvas, select JPEG/WebP output, and return the original file when compression fails or grows the payload.

- [x] **Step 2: Add focused unit tests**

Cover small-image bypass, GIF bypass, aspect-ratio sizing, compressed output selection, larger-output fallback, and decode/encode fallback.

### Task 2: Composer Integration

**Files:**
- Modify: `packages/desktop/renderer/components/ChatView.tsx`
- Modify: `packages/desktop/renderer/lib/composer-file-routing.test.ts`

**Interfaces:**
- Consumes: `normalizeComposerImage(file: File): Promise<Blob>`.
- Produces: existing `prepareComposerFiles()` image data URLs with reduced payloads.

- [x] **Step 1: Normalize before data URL conversion**

Update the file reader passed to `prepareComposerFiles()` so supported browser images are normalized before `FileReader.readAsDataURL()` runs. Preserve the existing unsupported and failed-image behavior.

- [x] **Step 2: Verify routing behavior**

Keep current supported MIME routing tests and assert that normalization failures still fall back to a readable original image.

### Task 3: Native Admission Recovery

**Files:**
- Modify: `packages/webapp/src/infrastructure/http/agent-http-gateway.ts`
- Modify: `packages/webapp/src/infrastructure/http/agent-http-gateway.test.ts`

**Interfaces:**
- Consumes: native session detail fields `status`, `snapshotRunId`, and `snapshotRevision`.
- Produces: recovery decision that preserves the current SSE/pending run only when a new native run is observable after a transport error.

- [x] **Step 1: Capture the pre-send native cursor**

Before POSTing, retain the prior native run ID/revision so reconciliation can distinguish a newly admitted run from stale state.

- [x] **Step 2: Reconcile ambiguous transport failures**

When native `/api/agent/run` rejects with Safari/network transport text, fetch the session snapshot once. If it is running and its run ID differs from the pre-send cursor, remember the new cursor, preserve the SSE and pending completion promise, and wait normally. Do not POST again.

- [x] **Step 3: Localize genuine network failures**

When reconciliation cannot prove admission, dispatch `网络连接中断，消息未确认发送，请重试` instead of raw `Load failed`, then use the existing cleanup path.

- [x] **Step 4: Add gateway regression tests**

Cover recovered admission, no automatic re-POST, unreconciled localized failure, and unchanged non-native behavior.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run: `bunx vitest run packages/desktop/renderer/lib/browser-image-normalization.test.ts packages/desktop/renderer/lib/composer-file-routing.test.ts packages/webapp/src/infrastructure/http/agent-http-gateway.test.ts`

Expected: PASS

Run: `bun run --cwd packages/webapp typecheck`

Expected: PASS
