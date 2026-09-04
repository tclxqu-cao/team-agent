# WebApp Abort Button State Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the dedicated stop button hidden after interruption while leaving the independent send button immediately available.

**Architecture:** Reuse `ChatView`'s existing selected-session load generation as the stale-response boundary. A local running-state transition will no longer restart session loading, and the interrupt handler will invalidate any load that began before the user's stop action.

**Tech Stack:** React 18, TypeScript, Zustand, Vitest, Vite

## Global Constraints

- Preserve the stop button as a control separate from the send button.
- Preserve fresh-page and fresh-selection restoration of genuinely active native runs from the persistent broker.
- Preserve all unrelated dirty-worktree changes, including sent-image history and native broker lifecycle work.
- Do not add a second abort lifecycle state.

---

### Task 1: Selected-Session Load Boundary

**Files:**
- Modify: `packages/desktop/renderer/components/ChatView.tsx`
- Unit tests: `packages/desktop/renderer/components/ChatHistoryStyle.test.ts`

**Interfaces:**
- Consumes: `sessionLoadGenerationRef: MutableRefObject<number>` and Zustand `setRunningSession(id: string | null)`
- Produces: an interrupt handler that invalidates older session loads before clearing local running state

- [x] **Step 1: Inspect the selected-session effect and interrupt handler**

Read: `packages/desktop/renderer/components/ChatView.tsx`

Confirm: `loadSelectedSession` already captures `loadGeneration` and checks `isCurrentLoad()` before applying session detail, while `handleAbort` currently clears `runningSessionId` without invalidating that generation.

- [x] **Step 2: Stop run-state transitions from reloading selected history**

Remove `runningSessionId` from the selected-session effect dependency array. Keep the live-message decision reading the current Zustand state at response time:

```ts
const preferLive = liveMessages.length > 0
  && useAgentStore.getState().runningSessionId === targetSid;
```

This effect remains driven by `selectedSessionId`, `sessionReloadGeneration`, and its stable callbacks.

- [x] **Step 3: Invalidate in-flight history before clearing the stopped run**

Update the interrupt handler in this order:

```ts
const handleAbort = () => {
  abortRef.current = true;
  sessionLoadGenerationRef.current += 1;
  if (window.agentApi) {
    void window.agentApi.abort(viewSessionId || undefined);
  }
  runningSessionRef.current = null;
  setRunningSession(null);
  runningSubIdsRef.current.clear();
};
```

The generation increment makes every response started before the click fail the existing `isCurrentLoad()` guard.

- [x] **Step 4: Add regression assertions for the race boundary**

Extend `ChatHistoryStyle.test.ts` with a focused test that slices the selected-session effect and interrupt handler, then asserts:

```ts
expect(selectedSessionEffect).not.toMatch(/\[[^\]]*runningSessionId[^\]]*\]/);
expect(handleAbort).toMatch(
  /sessionLoadGenerationRef\.current \+= 1;[\s\S]*setRunningSession\(null\)/,
);
```

Also retain the existing contract assertions for `shouldRestoreLocalNativeRun(detail)` so fresh restoration remains covered.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run: `PATH=/opt/homebrew/opt/node@22/bin:$PATH bunx vitest run packages/desktop/renderer/components/ChatHistoryStyle.test.ts packages/webapp/src/presentation/browser-composer.test.ts`

Expected: PASS

Then run: `PATH=/opt/homebrew/opt/node@22/bin:$PATH bun run --cwd packages/webapp typecheck`

Expected: PASS

Then run: `PATH=/opt/homebrew/opt/node@22/bin:$PATH bun run --cwd packages/webapp build`

Expected: PASS

If a test, type check, or build fails, fix the implementation or test and rerun the failing command until it passes. Report all commands and results in the final response.
