# Steered Message Status Placement Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the successful steering indicator into the user message bubble as a compact green status icon.

**Architecture:** Keep `isSteered` and all queue/runtime behavior unchanged. Render the read-only steered state beside the existing send-state area inside the bubble, and remove the separate status pill below the bubble.

**Tech Stack:** React, TypeScript, Lucide React, Vitest source regressions

## Global Constraints

- Use the shared Codex-style history path for Desktop and WebApp.
- Keep queued-message badges and steering actions unchanged.
- Keep the copy control outside the bubble and visually distinct from status.
- Preserve `title="已引导"`, `aria-label="已引导"`, and `role="img"`.
- Do not change `isSteered` persistence, steering IPC, or runtime capability checks.

---

### Task 1: Render Steered Status Inside the Message Bubble

**Files:**
- Modify: `packages/desktop/renderer/components/ChatView.tsx`
- Unit tests: `packages/desktop/renderer/components/ChatHistoryStyle.test.ts`

**Interfaces:**
- Consumes: `ChatMessage.isSteered?: boolean`
- Produces: `.msg-steered-status` read-only icon inside `.chat-message-bubble`

- [x] **Step 1: Extend the existing user-message status row**

In `ChatView.tsx`, render the status row when either `chatMsg.sendState` or `chatMsg.isSteered` is present. Keep the existing pending dots and failed text. Add a green `CornerUpRight` icon for `isSteered` with the required tooltip and accessibility attributes.

```tsx
{isUser && (chatMsg.sendState || chatMsg.isSteered) && (
  <div className="msg-send-status">
    {chatMsg.sendState === "pending" && (
      <span className="msg-send-status__dots" aria-hidden="true">
        <span /><span /><span />
      </span>
    )}
    {chatMsg.sendState === "failed" && <span>发送失败</span>}
    {chatMsg.isSteered && (
      <span className="msg-steered-status" title="已引导" aria-label="已引导" role="img">
        <CornerUpRight size={13} strokeWidth={2} aria-hidden="true" />
      </span>
    )}
  </div>
)}
```

- [x] **Step 2: Remove the separate successful-steering pill**

Keep the `排队中` badge and `引导` button under queued messages. Remove only the `chatMsg.isSteered` branch that renders visible `已引导` text below the bubble.

- [x] **Step 3: Add focused source regression coverage**

Update `ChatHistoryStyle.test.ts` to verify that the steered indicator is rendered before the bubble closes, uses `CornerUpRight`, carries the required accessible label, and no longer renders the old visible `已引导` pill branch.

```ts
expect(messageBubble).toContain("chatMsg.isSteered");
expect(messageBubble).toContain('className="msg-steered-status"');
expect(messageBubble).toContain('<CornerUpRight size={13}');
expect(messageBubble).toContain('aria-label="已引导"');
expect(queueBadgeSection).not.toContain("{chatMsg.isSteered && (");
```

### Task 2: Style the Compact Status Icon

**Files:**
- Modify: `packages/desktop/renderer/styles/global.css`
- Unit tests: `packages/desktop/renderer/components/ChatHistoryStyle.test.ts`

**Interfaces:**
- Consumes: `.msg-steered-status`
- Produces: compact non-interactive success-colored icon aligned with pending send status

- [x] **Step 1: Add status icon styling**

Add a rule next to `.msg-send-status` that keeps the icon compact, non-interactive, and success colored.

```css
.msg-steered-status {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--success);
}
```

- [x] **Step 2: Assert the shared stylesheet contract**

Extend `ChatHistoryStyle.test.ts` to require the `.msg-steered-status` rule and `color: var(--success)`.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run:

```bash
PATH=/opt/homebrew/opt/node@22/bin:$PATH bunx vitest run packages/desktop/renderer/components/ChatHistoryStyle.test.ts packages/desktop/renderer/components/ChatComposerStyle.test.ts
PATH=/opt/homebrew/opt/node@22/bin:$PATH npm exec -- tsc -p packages/desktop/tsconfig.json --noEmit
git diff --check
```

Expected: both focused test files, Desktop TypeScript, and diff validation pass.

If a test fails, fix the implementation or test and rerun these commands until they pass. Report the commands and results in the final response.
