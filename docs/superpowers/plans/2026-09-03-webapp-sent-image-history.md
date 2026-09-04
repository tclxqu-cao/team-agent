# WebApp Sent Image History Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep user-sent images visible immediately and after history reload in Customer Agent and Codex WebApp sessions.

**Architecture:** Route images from both paste and the visible file picker into the same pending image payload before sending. Preserve optimistic image data while refreshed history has no usable persisted attachment, persist Customer Agent images as display-only message presentation data, and retain Codex local-image files under its durable runtime storage after an accepted turn.

**Tech Stack:** TypeScript, React, Zustand, Next.js, Codex app-server protocol, Vitest, SQLite session storage

## Global Constraints

- Do not persist Customer Agent images in semantic `Message.images` history.
- Do not replay images from older Customer Agent turns into later model requests.
- Keep existing JPEG, PNG, GIF, WebP validation and the 20 MB per-image limit for native runtimes.
- Preserve existing unavailable-image rendering for legacy Codex paths.
- Do not modify unrelated dirty-worktree files.

---

### Task 0: File Picker Image Routing

**Files:**
- Create: `packages/desktop/renderer/lib/composer-file-routing.ts`
- Create: `packages/desktop/renderer/lib/composer-file-routing.test.ts`
- Modify: `packages/desktop/renderer/components/ChatView.tsx`

**Interfaces:**
- Consumes: files selected by the shared `Attachment / image` input and an async Blob-to-Data-URL reader
- Produces: `prepareComposerFiles(files, readImage)` with successful image Data URLs, non-image attachments, unsupported images, and read failures

- [x] **Step 1: Add file routing tests**

Cover supported JPEG/PNG/GIF/WebP image MIME types, non-image files, unsupported image types, multiple images, and a rejected file read.

- [x] **Step 2: Route selected images into `pendingImages`**

Make `handleFileAttach` asynchronous. Keep non-image files in `attachedFiles`, convert supported images with the existing `blobToDataUrl`, append successful results to `pendingImages`, and report unsupported/read-failed images instead of silently showing them as inert file pills.

- [x] **Step 3: Guard send while image reads are pending**

Track the number of image batches being converted and include it in the send-button and `handleSend` admission condition. Multiple overlapping file selections must keep sending disabled until all conversions settle.

- [x] **Step 4: Keep native runtime image previews free of model-profile warnings**

Only show the configured-profile vision warning for Customer Agent sessions. Codex and Claude native runtimes negotiate image support through their adapters and do not require a WebApp model profile.

### Task 1: Optimistic Image Reconciliation

**Files:**
- Modify: `packages/desktop/renderer/lib/session-history.ts`
- Modify: `packages/desktop/renderer/components/ChatView.tsx`
- Unit tests: `packages/desktop/renderer/lib/session-history.test.ts`

**Interfaces:**
- Consumes: `ChatMessage.images`, `ChatMessage.presentation.attachments`
- Produces: `mergeRefreshedSessionHistory(current, refreshed): ChatMessage[]` that retains transient images until persisted image data is usable

- [x] **Step 1: Add failing reconciliation tests**

Add tests with a matching optimistic and refreshed user message:

```ts
const optimistic = { ...message("optimistic", "inspect"), images: ["data:image/png;base64,AAAA"] };
const withoutAttachment = message("refreshed", "inspect");
expect(mergeRefreshedSessionHistory([optimistic], [withoutAttachment])[0].images)
  .toEqual(optimistic.images);
```

Also assert that a refreshed message containing `presentation.attachments[0].dataUrl` replaces the transient `images` value.

- [x] **Step 2: Preserve transient images during stable history replacement**

When a refreshed message matches the prior semantic message, retain `previous.images` unless the refreshed message already has at least one attachment with a usable `dataUrl`:

```ts
const hasPersistedImage = message.presentation?.attachments?.some((attachment) => attachment.dataUrl);
return {
  ...message,
  id: previous.id,
  timestamp: previous.timestamp,
  images: hasPersistedImage ? undefined : message.images ?? previous.images,
};
```

- [x] **Step 3: Prevent duplicate optimistic and history attachment rendering**

In `ChatView.tsx`, render `presentation.attachments` only when `chatMsg.images` is empty. This gives the current optimistic image priority until reconciliation switches to the persisted attachment.

### Task 2: Customer Agent Display Attachment Persistence

**Files:**
- Modify: `packages/core/src/infrastructure/SQLiteDatabase.ts`
- Modify: `packages/core/src/infrastructure/SQLiteSessionStore.ts`
- Modify: `packages/server/app/api/agent-host.ts`
- Unit tests: `packages/server/app/api/agent-host.test.ts`

**Interfaces:**
- Consumes: `AgentHost.run(input: string, sessionId: string, images?: string[])`
- Produces: stored user `Message` with `presentation.attachments`, while current model input alone receives `images`

- [x] **Step 1: Add failing persistence and replay tests**

Run a turn with a valid PNG data URL and assert the stored user message is shaped as follows:

```ts
{
  role: "user",
  content: "inspect",
  presentation: {
    attachments: [{ type: "image", name: "image-1.png", dataUrl: pngDataUrl }],
  },
}
```

Then run a second text-only turn and assert the first historical user message sent to the capturing provider has no `images` property while the current first turn originally received the image.

- [x] **Step 2: Add SQLite presentation storage and build display-only attachments**

Add a nullable `messages.presentation` JSON column through an idempotent migration and preserve it in `SQLiteSessionStore`. Add a focused helper in `agent-host.ts` that accepts JPEG, PNG, GIF, and WebP data URL prefixes and returns deterministic names (`image-1.jpg`, `image-2.png`, and so on). Omit presentation metadata when there are no supported images.

- [x] **Step 3: Persist presentation data on the user message**

Change the pre-run `addMessage` call to store `{ role, content, presentation }`. Keep the existing `agent.run(input, sessionId, images)` call unchanged so only the active turn receives semantic image input.

### Task 3: Durable Codex Input Images

**Files:**
- Modify: `packages/desktop/main/agent-runtime/codex-runtime-adapter.ts`
- Unit tests: `packages/desktop/main/agent-runtime/codex-runtime-adapter.test.ts`

**Interfaces:**
- Consumes: `parseImageDataUrls(images)` and Codex `localImage` turn inputs
- Produces: durable files under `<CODEX_HOME>/agentroam-images/customer-agent-codex-images-*`

- [x] **Step 1: Update the accepted-turn test to require durable files**

Configure an isolated `imageStorageRoot`, capture the `localImage.path` values sent to `turn/start`, drain the run, and assert each path still contains the original bytes.

- [x] **Step 2: Add a rejected-start cleanup test**

Make `turn/start` reject after images are written, then assert the generated image directory is removed because no Codex history entry can reference it.

- [x] **Step 3: Replace temporary storage with durable storage semantics**

Rename the adapter option/property from `imageTempRoot` to `imageStorageRoot`, default it to `join(this.codexHome, "agentroam-images")`, create the root with mode `0o700`, and create per-turn directories beneath it. Track whether `turn/start` succeeded and remove the directory only when it did not.

- [x] **Step 4: Preserve existing history loading behavior**

Keep `loadCodexImageAttachment` unchanged so accepted paths restore as data URLs and missing legacy paths remain unavailable attachments.

### Task 4: Regression Verification

**Files:**
- Verify only: all files listed above

**Interfaces:**
- Consumes: completed Tasks 1-3
- Produces: tested WebApp image display behavior ready for release

- [x] **Step 1: Run focused tests**

Run the three affected Vitest files together and fix any failures without broadening scope.

- [x] **Step 2: Run type and production build checks**

Run root TypeScript checking and the WebApp production build used by the port 3000 service.

- [x] **Step 3: Rebuild, restart, and smoke test port 3000**

Use the project release procedure, then verify `/web`, runtime health, and sessions endpoints return HTTP 200.

Result: WebApp and server production builds passed. Root `tsc --noEmit` remains blocked by pre-existing dirty-worktree test typing errors outside this change. The service restarted under launchd with PID 47230; the user elected to perform endpoint/UI smoke testing.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run: `bunx vitest run packages/desktop/renderer/lib/session-history.test.ts packages/server/app/api/agent-host.test.ts packages/desktop/main/agent-runtime/codex-runtime-adapter.test.ts`

Expected: all tests PASS. If a test fails, fix the implementation or test and rerun this command until it passes. Report the command and result in the final response.
