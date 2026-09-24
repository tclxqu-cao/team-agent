# In-Bubble Message Send Status Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the external user-message loading spinner with an in-bubble three-dot sending indicator while preserving the external copy action.

**Architecture:** Keep the existing `ChatMessage.sendState` lifecycle and move only its renderer into the shared user-message bubble. Use CSS-only dots with an explicit reduced-motion override, so Desktop and WebApp share the same accessible behavior without adding runtime state.

**Tech Stack:** React 18, TypeScript, CSS, Vitest

## Global Constraints

- The copy button remains outside the message bubble and stays usable for pending and failed messages.
- `run_admitted` and the first meaningful run event continue to clear `sendState`.
- Queue, steer, Agent thinking, and transport behavior remain unchanged.
- No new dependency is introduced.

---

### Task 1: Render Send Status Inside the User Bubble

**Files:**
- Modify: `packages/desktop/renderer/components/ChatView.tsx`

**Interfaces:**
- Consumes: `chatMsg.sendState?: "pending" | "failed"`
- Produces: `.msg-send-status`, `.msg-send-status__dots`, and three child dot spans inside `.chat-message-bubble--user`

- [x] **Step 1: Move the status renderer into the existing message bubble**

Place the user-only status block immediately before the bubble closes. Keep `role="status"` and the existing Chinese accessible labels.

```tsx
{isUser && chatMsg.sendState && (
  <div
    className={`msg-send-status is-${chatMsg.sendState}`}
    role="status"
    aria-label={chatMsg.sendState === "pending" ? "正在发送" : "发送失败"}
  >
    {chatMsg.sendState === "pending" ? (
      <span className="msg-send-status__dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
    ) : (
      <span>发送失败</span>
    )}
  </div>
)}
```

- [x] **Step 2: Remove the old external status renderer**

Delete the `msg-send-status__spinner` usage below `.msg-actions`. Do not remove the `LoaderCircle` import because history loading still uses it.

### Task 2: Style Stable Three-Dot Feedback

**Files:**
- Modify: `packages/desktop/renderer/styles/global.css`

**Interfaces:**
- Consumes: `.msg-send-status__dots` and its three child spans
- Produces: `msgSendDotPulse` animation and reduced-motion behavior

- [x] **Step 1: Keep the status right-aligned inside the bubble**

Use a fixed minimum height, a small top margin, and right alignment. Keep `.is-failed` colored with `var(--danger)`.

- [x] **Step 2: Replace the spinner animation with three sequenced dots**

```css
.msg-send-status__dots {
  display: inline-flex;
  width: 20px;
  height: 10px;
  align-items: center;
  justify-content: space-between;
}

.msg-send-status__dots > span {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: currentColor;
  animation: msgSendDotPulse 1s ease-in-out infinite;
}
```

Give the second and third dots `0.14s` and `0.28s` delays. Animate only opacity and `translateY`, and explicitly disable the animation under `prefers-reduced-motion: reduce`.

### Task 3: Protect the Shared Renderer Contract

**Files:**
- Modify: `packages/desktop/renderer/components/ChatHistoryStyle.test.ts`

**Interfaces:**
- Consumes: `ChatView.tsx` and `global.css` source strings
- Produces: Vitest assertions for renderer order and CSS contract

- [x] **Step 1: Add the in-bubble status assertions**

Assert that the send-status source appears before the completed-assistant footer, includes the three-dot markup and both accessible labels, and no longer references `msg-send-status__spinner`.

- [x] **Step 2: Preserve the copy action contract**

Assert that `actionPolicy.showCopy`, `copyTextToClipboard(msg.content)`, and `aria-label="复制内容"` remain present after moving the send status.

- [x] **Step 3: Add animation and lifecycle assertions**

Assert that CSS contains the dot animation, sequenced delays, and reduced-motion override. Assert that the meaningful-event list still includes `run_admitted` and `thinking` before calling `updatePendingSendState(eventSid)`.

### Task 4: Move Fork-Recovery Feedback Into the New Session

**Files:**
- Modify: `packages/desktop/renderer/components/ChatView.tsx`
- Unit tests: `packages/desktop/renderer/lib/occupied-session-fork.test.ts`

**Interfaces:**
- Consumes: `OccupiedSessionRecovery`, `occupiedRecoveryMessageId()`, and the existing per-session draft/image coordinators
- Produces: a pending fork message, no recovery banner in the fork session, and composer restoration after fork-send failure

- [x] **Step 1: Mark the recovered fork message pending**

Set `sendState: "pending"` when `addRecoveryMessage` inserts the user message into the fork. If the stable recovery message already exists, update that message back to `pending` instead of inserting a duplicate.

- [x] **Step 2: Hide the recovery banner in the selected fork**

Derive `showOccupiedRecoveryBanner` so the source session may show `正在创建…`, but `occupiedRecovery.forkSessionId === viewSessionId` never renders the banner above the new session composer.

- [x] **Step 3: Restore a failed fork send to the composer**

Add one helper that removes `occupiedRecoveryMessageId(recovery)` from the target session, writes the text and images to the session draft, restores the visible composer when that session is selected, and clears the occupied recovery. Call it for both immediate `run()` rejection and asynchronous native error events. Keep ordinary-send failure behavior unchanged.

- [x] **Step 4: Extend the focused fork contract test**

Assert that the fork message receives `sendState: "pending"`, the fork-session banner is suppressed, and failure recovery calls the shared composer-restoration helper.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run: `bunx vitest run packages/desktop/renderer/components/ChatHistoryStyle.test.ts packages/desktop/renderer/lib/queued-message-order.test.ts`

Also run: `bunx vitest run packages/desktop/renderer/lib/occupied-session-fork.test.ts`

Expected: PASS

Then run: `bunx tsc --noEmit -p packages/desktop/tsconfig.json`

Expected: PASS

If a test fails, fix the implementation or test and rerun these commands until they pass. Report the commands and results in the final response.
