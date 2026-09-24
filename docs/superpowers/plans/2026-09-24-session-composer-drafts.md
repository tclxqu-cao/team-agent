# WebApp Session Composer Drafts Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep unsent composer text and images isolated and refresh-restorable for every WebApp session, while preventing accepted queued messages from returning to the composer.

**Architecture:** Keep synchronous text drafts in the existing localStorage boundary and add an IndexedDB repository for normalized image data URLs. A session image coordinator serializes persistence and rejects stale asynchronous restores; `ChatView` clears drafts when a queue accepts a message and restores the submitted payload only when durable queue persistence fails.

**Tech Stack:** React, TypeScript, localStorage, Vitest, Bun

## Global Constraints

- Reuse the existing unified session ID and `session-draft.ts` storage keys.
- Do not migrate existing text drafts or store image data in localStorage.
- Keep attachments, message routing, runtime selection, and new-session creation behavior unchanged.
- Preserve unrelated dirty-worktree changes.

---

### Task 1: Session Draft Sync Decision

**Files:**
- Modify: `packages/desktop/renderer/lib/session-draft.ts`
- Unit tests: `packages/desktop/renderer/lib/session-draft.test.ts`

**Interfaces:**
- Consumes: current draft owner session ID, viewed session ID, and visible input text
- Produces: `resolveSessionDraftAction(ownerSessionId, viewedSessionId, value): SessionDraftAction`

- [x] **Step 1: Add the pure action resolver**

Add a discriminated union and resolver:

```ts
export type SessionDraftAction =
  | { type: "inactive"; ownerSessionId: null }
  | { type: "restore"; ownerSessionId: string }
  | { type: "persist"; ownerSessionId: string; value: string };

export function resolveSessionDraftAction(
  ownerSessionId: string | null,
  viewedSessionId: string | null | undefined,
  value: string,
): SessionDraftAction {
  if (!viewedSessionId) return { type: "inactive", ownerSessionId: null };
  if (ownerSessionId !== viewedSessionId) {
    return { type: "restore", ownerSessionId: viewedSessionId };
  }
  return { type: "persist", ownerSessionId: viewedSessionId, value };
}
```

- [x] **Step 2: Add focused transition tests**

Cover first selection, Customer Agent to native switching, same-session persistence, and no selected session:

```ts
expect(resolveSessionDraftAction(null, "ca-session", "carried text"))
  .toEqual({ type: "restore", ownerSessionId: "ca-session" });
expect(resolveSessionDraftAction("ca-session", "runtime:codex:one", "ca draft"))
  .toEqual({ type: "restore", ownerSessionId: "runtime:codex:one" });
expect(resolveSessionDraftAction("ca-session", "ca-session", "current draft"))
  .toEqual({ type: "persist", ownerSessionId: "ca-session", value: "current draft" });
expect(resolveSessionDraftAction("ca-session", null, "current draft"))
  .toEqual({ type: "inactive", ownerSessionId: null });
```

### Task 2: ChatView Draft Synchronization

**Files:**
- Modify: `packages/desktop/renderer/components/ChatView.tsx:57`
- Modify: `packages/desktop/renderer/components/ChatView.tsx:955-972`

**Interfaces:**
- Consumes: `resolveSessionDraftAction(...)`, `readSessionDraft(...)`, `writeSessionDraft(...)`
- Produces: session-scoped visible composer text for Customer Agent and native sessions

- [x] **Step 1: Route the effect through the action resolver**

Import `resolveSessionDraftAction`, call it without an `isNativeRuntime` guard, update `draftSessionRef.current` from the returned owner, restore the target session on `restore`, and persist only on `persist`.

```ts
const action = resolveSessionDraftAction(draftSessionRef.current, viewSessionId, input);
draftSessionRef.current = action.ownerSessionId;
if (action.type === "inactive") return;
if (action.type === "restore") {
  const nativeDraftOwner = action.ownerSessionId.startsWith("runtime:");
  const recovery = nativeDraftOwner
    ? findOccupiedRecovery(occupiedRecoveriesRef.current, action.ownerSessionId)
    : undefined;
  setInput(recovery?.payload.content ?? readSessionDraft(action.ownerSessionId));
  if (nativeDraftOwner) setPendingImages(recovery?.payload.images ?? []);
  return;
}
```

- [x] **Step 2: Preserve native accepted-send recovery and persist the active session**

Keep the `preserveNativeDraftRef` empty-input guard before calling:

```ts
writeSessionDraft(action.ownerSessionId, action.value);
```

The effect dependency list becomes `[input, viewSessionId]`; no runtime-type dependency controls draft ownership.

### Task 3: IndexedDB Image Draft Repository

**Files:**
- Create: `packages/desktop/renderer/lib/session-image-draft.ts`
- Create: `packages/desktop/renderer/lib/session-image-draft.test.ts`

**Interfaces:**
- Produces: `SessionImageDraftRepository`, `IndexedDbSessionImageDraftRepository`, and `SessionImageDraftCoordinator`
- Consumes: browser `IDBFactory` and normalized image data URLs

- [x] **Step 1: Implement the IndexedDB repository**

Use database `agentroam-composer-drafts`, version `1`, and object store `session-image-drafts` keyed by `sessionId`. Serialize mutations so a restore started after a write observes that write.

```ts
export interface SessionImageDraftRepository {
  read(sessionId: string): Promise<string[]>;
  write(sessionId: string, images: string[]): Promise<void>;
  clear(sessionId: string): Promise<void>;
}

export class IndexedDbSessionImageDraftRepository implements SessionImageDraftRepository {
  constructor(factory?: IDBFactory | null);
  read(sessionId: string): Promise<string[]>;
  write(sessionId: string, images: string[]): Promise<void>;
  clear(sessionId: string): Promise<void>;
}
```

An unavailable IndexedDB factory returns an empty read and treats writes and clears as no-ops. Invalid stored records are normalized to an empty image list.

- [x] **Step 2: Add the stale-restore coordinator**

```ts
export class SessionImageDraftCoordinator {
  constructor(repository: SessionImageDraftRepository);
  restore(sessionId: string | null | undefined): Promise<{ sessionId: string; images: string[] } | null>;
  save(sessionId: string, images: string[]): Promise<void>;
  saveSelected(sessionId: string, images: string[]): Promise<void>;
  clear(sessionId: string): Promise<void>;
}
```

`restore()` increments a selection generation. It returns `null` when another selection starts before the read completes. `saveSelected()` writes only while its session remains selected; `save()` is unconditional for background failure recovery.

- [x] **Step 3: Add focused repository and coordinator tests**

Use an in-memory `SessionImageDraftRepository` and deferred reads to prove:

```ts
expect(await unavailable.read("session-a")).toEqual([]);
expect(await coordinator.restore("session-a")).toEqual({ sessionId: "session-a", images: [image] });
expect(await staleSessionAAfterSelectingB).toBeNull();
expect(await repository.read("session-b")).toEqual([]);
```

Also verify `saveSelected()` rejects cross-session writes and `clear()` deletes only the requested session.

### Task 4: ChatView Image Draft Restoration

**Files:**
- Modify: `packages/desktop/renderer/components/ChatView.tsx`

**Interfaces:**
- Consumes: `SessionImageDraftCoordinator`
- Produces: session-scoped pending-image restoration across switches and reloads

- [x] **Step 1: Create one coordinator for the ChatView lifecycle**

Initialize it once in a ref with `IndexedDbSessionImageDraftRepository`. Track the session currently restoring and a one-shot native-send preservation flag.

- [x] **Step 2: Restore images on session selection**

On the existing text `restore` action, clear visible pending images immediately, mark the target as restoring, and call:

```ts
void imageDraftCoordinator.restore(action.ownerSessionId).then((restored) => {
  if (!restored || draftSessionRef.current !== restored.sessionId) return;
  imageDraftRestoringSessionRef.current = null;
  const images = recovery?.payload.images ?? restored.images;
  setPendingImages(images);
  if (recovery) void imageDraftCoordinator.save(restored.sessionId, images);
});
```

Selecting no session invalidates any pending restore. A late read from a previous session never changes visible images.

- [x] **Step 3: Persist image changes for the active session**

Add an effect keyed by `pendingImages` and `viewSessionId`. Skip while that session is restoring and skip the one empty write used to preserve a native normal-send recovery draft; otherwise call `saveSelected()`.

- [x] **Step 4: Keep native send recovery complete**

On `run_admitted`, clear both text and image drafts. On `SESSION_OCCUPIED` or another recoverable native send error, persist and restore both the submitted text and submitted images, including when the failed session is in the background.

### Task 5: Queue Owns Accepted Messages

**Files:**
- Modify: `packages/desktop/renderer/components/ChatView.tsx`
- Modify: `packages/desktop/renderer/components/ChatComposerStyle.test.ts`

**Interfaces:**
- Consumes: current queue admission result and captured `{ content, images }` submission
- Produces: accepted messages visible only in the queue; failed submissions restored only to their owning session

- [x] **Step 1: Limit native draft preservation to normal sends**

Move the native text/image preservation flags from the common pre-branch block into the normal-send block. Goal and queued-message branches no longer preserve an accepted submission as an editable draft.

- [x] **Step 2: Transfer queued submissions out of the composer**

When the optimistic queued row takes ownership, clear the submitted draft before waiting for durable persistence:

```ts
clearSessionDraft(queuedSessionId);
void imageDraftCoordinator.clear(queuedSessionId);
```

The existing queued message remains in `messages` and renders in `.queued-message-list` above the composer. Durable success does not clear again, so a new draft typed while the request is pending cannot be deleted by a late success callback.

- [x] **Step 3: Restore only failed durable queue submissions**

When `enqueueSessionMessage()` rejects, remove the optimistic queued row, persist the captured text and images back to their owning session, and update visible composer state only if that session is still selected.

```ts
writeSessionDraft(queuedSessionId, finalMsg);
void imageDraftCoordinator.save(queuedSessionId, imagesToSend ?? []);
if ((selectedSessionIdRef.current || sessionIdRef.current) === queuedSessionId) {
  setInput(finalMsg);
  setPendingImages(imagesToSend ?? []);
}
```

- [x] **Step 4: Apply the same ownership rule to goal queue admission**

Successful goal admission clears the owning draft. Failed goal admission restores the captured text and images only to the session that attempted the goal.

- [x] **Step 5: Lock the queue contract with source tests**

Assert the queued-message branch clears drafts after acceptance, restores both fields on durable failure, and guards visible restoration by the current session ID. Retain the existing assertion that queued rows render above the input.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run: `bunx vitest run packages/desktop/renderer/lib/session-draft.test.ts packages/desktop/renderer/lib/session-image-draft.test.ts packages/desktop/renderer/lib/session-composer-routing.test.ts packages/desktop/renderer/lib/session-event-routing.test.ts packages/desktop/renderer/components/ChatComposerStyle.test.ts`

Expected: PASS

Run: `bun run --cwd packages/webapp build`

Expected: PASS

If a test or build fails, fix the implementation or test and rerun the command until it passes. Report the commands and results in the final response.
