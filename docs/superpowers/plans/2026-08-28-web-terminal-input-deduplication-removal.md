# Web Terminal Input Deduplication Removal Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove application-level duplicate filtering so repeated keyboard input and Backspace auto-repeat reach the PTY immediately while preserving the existing mobile touch-scroll escape guard.

**Architecture:** Move the remaining touch-scroll suppression decision into a small stateless Web terminal input-policy module. `TerminalPane` will call that predicate and otherwise forward every xterm `onData` payload through its existing direct-channel/RPC input path without retaining prior input or timestamps.

**Tech Stack:** TypeScript, React, xterm 6, Vitest 2, Next.js

## Global Constraints

- Treat xterm `onData` output as the authoritative terminal byte stream.
- Do not add timers, phrase comparison, composition listeners, or application-level IME state.
- Preserve virtual Ctrl mapping, touch-scroll navigation suppression, WebSocket input, and RPC fallback behavior.
- Do not refactor unrelated user changes in `TerminalPane.tsx`.

---

### Task 1: Stateless Touch-Scroll Input Policy

**Files:**
- Create: `packages/server/app/web/terminalInputPolicy.ts`
- Unit tests: `packages/server/app/web/terminalInputPolicy.test.ts`

**Interfaces:**
- Consumes: xterm `onData` payload as `data: string` and current touch-scroll state as `touchScrollActive: boolean`.
- Produces: `shouldSuppressTouchScrollInput(data: string, touchScrollActive: boolean): boolean`.

- [x] **Step 1: Create the stateless suppression predicate**

```ts
const TOUCH_SCROLL_ESCAPE_SEQUENCES = new Set(["\x1b[A", "\x1b[B", "\x1b[5~", "\x1b[6~"]);

export function shouldSuppressTouchScrollInput(data: string, touchScrollActive: boolean): boolean {
  return touchScrollActive && TOUCH_SCROLL_ESCAPE_SEQUENCES.has(data);
}
```

- [x] **Step 2: Add focused regression tests**

```ts
import { describe, expect, it } from "vitest";
import { shouldSuppressTouchScrollInput } from "./terminalInputPolicy";

describe("shouldSuppressTouchScrollInput", () => {
  it.each(["a", "l", "\x7f", "echo echo"])("allows repeated terminal data %j", (data) => {
    expect(shouldSuppressTouchScrollInput(data, false)).toBe(false);
    expect(shouldSuppressTouchScrollInput(data, false)).toBe(false);
    expect(shouldSuppressTouchScrollInput(data, true)).toBe(false);
    expect(shouldSuppressTouchScrollInput(data, true)).toBe(false);
  });

  it.each(["\x1b[A", "\x1b[B", "\x1b[5~", "\x1b[6~"])(
    "suppresses %j only during touch scrolling",
    (data) => {
      expect(shouldSuppressTouchScrollInput(data, true)).toBe(true);
      expect(shouldSuppressTouchScrollInput(data, false)).toBe(false);
    },
  );
});
```

### Task 2: TerminalPane Input Forwarding

**Files:**
- Modify: `packages/server/app/web/TerminalPane.tsx:1-75`
- Modify: `packages/server/app/web/TerminalPane.tsx:208-230`

**Interfaces:**
- Consumes: `shouldSuppressTouchScrollInput(data, touchScrollActiveRef.current)` from Task 1.
- Produces: an xterm `onData` handler that forwards every non-touch-scroll payload without content- or time-based deduplication.

- [x] **Step 1: Import the input-policy predicate**

```ts
import { shouldSuppressTouchScrollInput } from "./terminalInputPolicy";
```

- [x] **Step 2: Remove duplicate-input state**

Delete the `lastOutboundInput` ref. Keep `touchScrollActiveRef`, `ctrlArmed`, follow-output state, and all session/channel refs unchanged.

- [x] **Step 3: Replace inline suppression with the stateless policy**

```ts
term.onData((data) => {
  if (!state.connected) return;
  if (shouldSuppressTouchScrollInput(data, touchScrollActiveRef.current)) return;
  followOutputRef.current = true;
  // Preserve the existing scrolling, virtual Ctrl mapping, and sendInput code.
});
```

The handler must contain no `Date.now()`, previous-input comparison, or assignment of input text/timestamps.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run: `bunx vitest run packages/server/app/web/terminalInputPolicy.test.ts`
Expected: PASS

Run: `bunx tsc -p packages/server/tsconfig.json --noEmit`
Expected: PASS

Run: `NEXT_DIST_DIR=.next /opt/homebrew/opt/node@22/bin/node node_modules/next/dist/bin/next build` from `packages/server`
Expected: PASS

If a test or compilation check fails, fix the implementation or test and rerun the command until it passes. Report each command and result in the final response.
