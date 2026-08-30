# Mobile Web Chat Session State Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make mobile Web chat work over a plain HTTP LAN URL by restoring UUID support, binding optimistic messages to the target session, and rejecting stale history loads.

**Architecture:** Install a Web-only `crypto.randomUUID` compatibility shim before the shared desktop renderer is loaded, using `crypto.getRandomValues` to produce RFC 4122 v4 identifiers. Move typed-message session preparation into a small pure coordinator, then guard asynchronous session restoration with a monotonically increasing generation in `ChatView`.

**Tech Stack:** React 18, TypeScript, Zustand, Vite 5, Vitest 2, Next.js 14 custom server.

## Global Constraints

- Keep `/api/agent/run`, `/api/agent/stream`, and session persistence contracts unchanged.
- Do not change model configuration, authentication, tunnels, or mobile visual styling.
- Do not add dependencies or a new browser test framework.
- Preserve Electron behavior; the UUID compatibility installation runs only from `packages/webapp/src/main.tsx`.

---

### Task 1: Browser UUID Compatibility

**Files:**
- Create: `packages/webapp/src/infrastructure/browser-crypto.ts`
- Create: `packages/webapp/src/infrastructure/browser-crypto.test.ts`
- Modify: `packages/webapp/src/main.tsx`

**Interfaces:**
- Produces: `createUuidV4(cryptoLike: CryptoLike): string`
- Produces: `installBrowserCryptoCompatibility(cryptoLike?: CryptoLike): void`
- Consumes: browser `crypto.randomUUID` when available and `crypto.getRandomValues` otherwise.

- [ ] **Step 1: Add the UUID generator and installer**

Implement a local `CryptoLike` interface and preserve the native method when present. The fallback must set UUID version and variant bits before formatting:

```ts
export interface CryptoLike {
  randomUUID?: () => string;
  getRandomValues(array: Uint8Array): Uint8Array;
}

export function createUuidV4(cryptoLike: CryptoLike): string {
  if (typeof cryptoLike.randomUUID === "function") return cryptoLike.randomUUID();
  const bytes = cryptoLike.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  // Format 8-4-4-4-12 lowercase hexadecimal characters.
}

export function installBrowserCryptoCompatibility(
  cryptoLike: CryptoLike = globalThis.crypto,
): void {
  if (typeof cryptoLike.randomUUID === "function") return;
  Object.defineProperty(cryptoLike, "randomUUID", {
    configurable: true,
    value: () => createUuidV4(cryptoLike),
  });
}
```

- [ ] **Step 2: Install compatibility before shared UI boot**

In `packages/webapp/src/main.tsx`, call `installBrowserCryptoCompatibility()` before constructing `AgentHttpGateway` and before dynamically importing `@desktop/renderer/App`.

- [ ] **Step 3: Add focused UUID tests**

Cover these behaviors in `browser-crypto.test.ts`:

```ts
it("preserves native randomUUID when available", () => {
  const cryptoLike = { randomUUID: () => "native-id", getRandomValues: (bytes: Uint8Array) => bytes };
  expect(createUuidV4(cryptoLike)).toBe("native-id");
});

it("generates an RFC 4122 v4 UUID from getRandomValues", () => {
  const cryptoLike = { getRandomValues: (bytes: Uint8Array) => (bytes.fill(0), bytes) };
  expect(createUuidV4(cryptoLike)).toBe("00000000-0000-4000-8000-000000000000");
});

it("installs the fallback only when randomUUID is missing", () => {
  const cryptoLike = { getRandomValues: (bytes: Uint8Array) => (bytes.fill(0), bytes) };
  installBrowserCryptoCompatibility(cryptoLike);
  expect(cryptoLike.randomUUID?.()).toBe("00000000-0000-4000-8000-000000000000");
});
```

### Task 2: Typed Chat Session Coordination

**Files:**
- Create: `packages/desktop/renderer/lib/chat-command.ts`
- Create: `packages/desktop/renderer/lib/chat-command.test.ts`
- Modify: `packages/desktop/renderer/components/ChatView.tsx`

**Interfaces:**
- Produces: `prepareChatCommand(options: PrepareChatCommandOptions): Promise<string>`
- Consumes: session creation, synchronous session activation, explicit optimistic-message insertion, and optional parent selection callback.

- [ ] **Step 1: Add the typed-message coordinator**

```ts
export interface PrepareChatCommandOptions {
  text: string;
  projectId: string | null;
  sessionId: string | null;
  createSession: (title: string, projectId?: string) => Promise<{ id: string }>;
  activateSession: (sessionId: string) => void;
  showUserMessage: (text: string, sessionId: string) => void;
  onSessionCreated?: (sessionId: string) => void | Promise<void>;
}

export async function prepareChatCommand(options: PrepareChatCommandOptions): Promise<string> {
  const existingSessionId = options.sessionId?.trim() || null;
  const isNewSession = !existingSessionId;
  const target = existingSessionId
    ?? (await options.createSession(options.text.slice(0, 60) || "New Session", options.projectId || undefined)).id.trim();
  if (!target) throw new Error("创建会话失败：服务端未返回会话 ID");
  options.activateSession(target);
  options.showUserMessage(options.text, target);
  if (isNewSession) await options.onSessionCreated?.(target);
  return target;
}
```

- [ ] **Step 2: Use explicit session activation in normal send flow**

In `ChatView.handleSend`, replace the current optimistic add-before-create sequence with `prepareChatCommand`. The `activateSession` callback must synchronously assign `sessionIdRef.current`, call `setSessionId`, and set the running refs before `onSessionCreated`. The `showUserMessage` callback must call `addMessage(message, targetSessionId)` with the explicit target.

- [ ] **Step 3: Add coordinator order tests**

Test existing and new sessions. The new-session test must assert this exact order:

```text
create -> activate -> message -> selected
```

The existing-session test must assert that create and selected are skipped and the existing id is passed to both activate and message.

### Task 3: Stale Session Load Protection

**Files:**
- Modify: `packages/desktop/renderer/components/ChatView.tsx`

**Interfaces:**
- Consumes: `selectedSessionIdRef`, `sessionIdRef`, Zustand message buckets, and the existing `window.agentApi.getSession` response.
- Produces: only the latest selected-session load may update or clear visible messages.

- [ ] **Step 1: Add a session-load generation ref**

Create `sessionLoadGenerationRef`. At the beginning of the session-loading effect, increment it and capture the value. Define a local predicate that requires both the captured generation and target session id to remain current.

- [ ] **Step 2: Guard every asynchronous write**

Before `setMessages`, `setContextUsage`, `setSessionId`, and error cleanup, return when the load is stale. When activating a successfully restored session, assign `sessionIdRef.current` before `setSessionId`.

- [ ] **Step 3: Surface current-session restore failures**

Replace the silent catch with a scoped console error and visible error state. Only clear `targetSid` when the failed request is still current:

```ts
console.error("[chat] failed to restore session", { sessionId: targetSid, error });
clearMessages(targetSid);
setError(error instanceof Error ? error.message : "会话加载失败");
```

### Task 4: Build And Mobile Verification

**Files:**
- Generated: `packages/webapp/dist/**`

**Interfaces:**
- Consumes: the fixed WebApp bundle served by `packages/server/ws-server.mjs` at `/app/`.
- Produces: verified behavior at `http://192.168.0.104:3100/app/` in a `390 x 844` viewport.

- [ ] **Step 1: Build the WebApp bundle**

Run:

```bash
bun run --cwd packages/webapp build
```

- [ ] **Step 2: Verify the LAN browser flow**

Open `http://192.168.0.104:3100/app/`, emulate missing `crypto.randomUUID` before page boot, and confirm:

- persisted history renders instead of the empty-state illustration;
- entering a test message immediately renders its user bubble;
- Network records `GET /api/agent/stream?sessionId=...` before `POST /api/agent/run`;
- streamed assistant text renders and remains after completion;
- a reload restores the persisted conversation.

- [ ] **Step 3: Verify fast session switching**

Switch between two sessions while history is loading and confirm the final visible title and messages belong to the same session.

## Final Unit Test Verification

- [ ] **Main agent: run affected unit tests after development is complete**

Run:

```bash
bunx vitest run packages/webapp/src/infrastructure/browser-crypto.test.ts packages/desktop/renderer/lib/chat-command.test.ts packages/desktop/renderer/stores/agentStore.test.ts packages/desktop/renderer/lib/voice-command.test.ts
bun run --cwd packages/webapp typecheck
```

Expected: all focused tests pass and TypeScript exits with status 0. If a test fails, fix the implementation or test and rerun these commands until they pass.
