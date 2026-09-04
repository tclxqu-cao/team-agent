# Message Image Lightbox Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open every usable message image in a consistent full-screen viewer on Web and Electron.

**Architecture:** A focused `MessageImageLightbox` owns portal rendering, modal interaction, Escape handling, and body scroll locking. `ChatView` stores only the selected image and routes both optimistic and persisted message image clicks to the component.

**Tech Stack:** React, React DOM portals, TypeScript, Lucide React, CSS, Vitest

## Global Constraints

- Cover both `ChatMessage.images` and `Message.presentation.attachments[].dataUrl`.
- Keep unavailable attachment placeholders inert.
- Render through `document.body` to avoid Web shell clipping and stacking contexts.
- Support backdrop click, close button, and Escape without opening a new tab.
- Keep unrelated dirty-worktree changes intact.

---

### Task 1: Shared Lightbox

**Files:**
- Create: `packages/desktop/renderer/components/MessageImageLightbox.tsx`
- Modify: `packages/desktop/renderer/styles/global.css`
- Unit tests: `packages/desktop/renderer/components/MessageImageLightbox.test.ts`

**Interfaces:**
- Consumes: `{ image: { src: string; alt: string } | null, onClose: () => void }`
- Produces: a body-level modal image viewer with deterministic close behavior

- [x] **Step 1: Implement portal and lifecycle behavior**

Render nothing when `image` is null. Otherwise portal a `role="dialog"` backdrop to `document.body`, close only on backdrop self-click or the close button, listen for Escape, and restore the prior body overflow value on cleanup.

- [x] **Step 2: Add responsive lightbox styles**

Use fixed full-viewport bounds, safe-area padding, a high z-index, a dark translucent backdrop, and an un-cropped `object-fit: contain` image constrained by `100vw` and `100dvh`.

- [x] **Step 3: Add component tests**

Assert the portal contract includes the original `src` and alt text, Escape and backdrop close paths, and body overflow restoration.

### Task 2: Message Renderer Integration

**Files:**
- Modify: `packages/desktop/renderer/components/ChatView.tsx`
- Modify: `packages/desktop/renderer/components/ChatHistoryStyle.test.ts`

**Interfaces:**
- Consumes: `MessageImageLightbox` and both existing message image representations
- Produces: keyboard-accessible image buttons that set `{ src, alt }` and open the shared lightbox

- [x] **Step 1: Replace direct image window opens**

Wrap optimistic and persisted message images in semantic buttons. Both branches set the same selected-image state; remove the direct `window.open` calls.

- [x] **Step 2: Mount one lightbox per ChatView**

Render the shared component once near the top-level portal overlays and clear the selected image on close or session change.

- [x] **Step 3: Extend the ChatView contract test**

Assert both image branches call the shared opener and that `MessageImageLightbox` is mounted once.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run: `PATH=/opt/homebrew/opt/node@22/bin:$PATH bunx vitest run packages/desktop/renderer/components/MessageImageLightbox.test.ts packages/desktop/renderer/components/ChatHistoryStyle.test.ts packages/webapp/src/presentation/browser-composer.test.ts`

Expected: PASS

If a test fails, fix the implementation or test and rerun this command until it passes. Report the command and result in the final response.
