# Codex User Attachment History Display Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Normalize imported Codex attachment turns into the real user request, image previews, and an optional raw-content disclosure.

**Architecture:** `CodexRuntimeAdapter` owns Codex-specific parsing and local image loading. The shared message contract transports display-only presentation metadata, while the shared `ChatView` renders it without interpreting Codex protocol strings.

**Tech Stack:** TypeScript, Electron/Node filesystem APIs, React 18, Vitest, CSS.

## Global Constraints

- Preserve the original Codex source text whenever normalization changes visible content.
- Fail closed to the original message for unknown or malformed envelope formats.
- Cap each local image read at 20 MiB and do not expose its filesystem path in attachment metadata.
- Do not change existing `Message.images` model-input semantics.
- Do not change Customer Agent or Claude Code message behavior.

---

### Task 1: Shared Presentation Metadata

**Files:**
- Modify: `packages/core/src/domain/model/entities.ts`
- Modify: `packages/desktop/renderer/stores/agentStore.ts`
- Modify: `packages/desktop/renderer/components/ChatView.tsx`

**Interfaces:**
- Consumes: existing `Message` and `ChatMessage` history mapping.
- Produces: `MessagePresentation`, `MessageAttachment`, and renderer-compatible optional `presentation` fields.

- [x] **Step 1: Add typed display-only metadata**

Define a shared attachment record with `type: "image"`, `name`, optional `dataUrl`, and optional `unavailable`, plus a `MessagePresentation` record with optional `rawContent` and `attachments`.

- [x] **Step 2: Preserve presentation metadata during session restoration**

Extend the persisted message shape accepted by `ChatView` and copy `m.presentation` into each restored `ChatMessage`.

### Task 2: Codex User Turn Normalization

**Files:**
- Modify: `packages/desktop/main/agent-runtime/codex-runtime-adapter.ts`
- Create: `packages/desktop/main/agent-runtime/codex-runtime-adapter.test.ts`

**Interfaces:**
- Consumes: Codex `userMessage.content` text and `local_image` entries.
- Produces: `codexTurnsToMessages(turns): Promise<Message[]>` with normalized `content` and optional `presentation`.

- [x] **Step 1: Extract strict Codex attachment envelopes**

Add an exported pure helper that returns the request only when the files heading, safety sentence, and request heading occur in order and the request is non-empty. Otherwise return the original trimmed text without presentation metadata.

- [x] **Step 2: Load bounded local image previews**

Read supported image extensions with `node:fs/promises`, reject files over 20 MiB, convert successful reads to MIME-correct data URLs, and return unavailable records for all failures.

- [x] **Step 3: Make history conversion asynchronous**

Await user-message presentation assembly in source order and update `getSession` to await the conversion. Keep assistant and tool mapping behavior unchanged.

- [x] **Step 4: Cover normalization and attachment failure modes**

Test valid envelopes, plain text, malformed markers, empty requests, multiple text/image entries, successful preview conversion, and missing image behavior.

### Task 3: Shared User Bubble Presentation

**Files:**
- Modify: `packages/desktop/renderer/components/ChatView.tsx`
- Modify: `packages/desktop/renderer/styles/global.css`
- Modify: `packages/desktop/renderer/components/ChatHistoryStyle.test.ts`

**Interfaces:**
- Consumes: `ChatMessage.presentation` from Task 1.
- Produces: image thumbnails, unavailable attachment placeholders, and a collapsed raw-content disclosure.

- [x] **Step 1: Render structured attachment tiles**

Render presentation attachments after existing live-message images. Reuse thumbnail behavior for available data URLs and render a named placeholder for unavailable files.

- [x] **Step 2: Render bounded raw source disclosure**

Add a native `details` element labelled `查看原始内容`; render `rawContent` in a monospace block with a fixed maximum height and vertical scrolling.

- [x] **Step 3: Add stable style hooks and contract assertions**

Add classes for the attachment collection, unavailable tile, disclosure, and raw block. Assert those hooks and accessibility labels in the focused history style test.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run: `bunx vitest run packages/desktop/main/agent-runtime/codex-runtime-adapter.test.ts packages/desktop/renderer/components/ChatHistoryStyle.test.ts`
Expected: PASS

Run: `bun run --cwd packages/desktop build`
Expected: PASS

If a test fails, fix the implementation or test and rerun these commands until they pass. Report the commands and results in the final response.
