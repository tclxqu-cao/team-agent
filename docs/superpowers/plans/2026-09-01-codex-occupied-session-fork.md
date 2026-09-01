# Codex Occupied Session Fork Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep externally owned Codex sessions read-only and let users explicitly continue from a persisted fork without seeing the raw active-writer protocol error.

**Architecture:** Treat Codex's open writer as authoritative while retaining Claude Code's current idle heuristic. Add a runtime-level fork capability and expose it through Electron IPC and Web HTTP, then let the shared `ChatView` create/select the fork and recover a failed message as an editable draft.

**Tech Stack:** TypeScript, Electron IPC, Next.js route handlers, React, Zustand, Codex App Server JSON-RPC, Vitest.

## Global Constraints

- Do not force-release, interrupt, unsubscribe, rename, archive, or delete the source Codex thread.
- Create a persisted `thread/fork` with no `lastTurnId`; never use an ephemeral fork.
- Require an explicit `以副本继续` action; never auto-fork or auto-start a turn.
- Restore failed text only as an editable draft after recovery fork success.
- Keep Claude Code's 120-second idle takeover behavior unchanged.
- Apply the same shared `ChatView` behavior to Electron and Web.
- Preserve all unrelated working-tree changes.

---

### Task 1: Runtime-Specific Occupancy Policy

**Files:**
- Modify: `packages/desktop/main/agent-runtime/native-processes.ts`
- Create: `packages/desktop/main/agent-runtime/native-processes.test.ts`
- Modify: `packages/desktop/main/agent-runtime/codex-runtime-adapter.ts`

**Interfaces:**
- Consumes: `listOpenSessionFiles(commandName, root, options)`.
- Produces: `idleAfterMs?: number | null`, where `null` disables the idle exemption and treats every externally open file as occupied.

- [ ] **Step 1: Add an explicit strict-open mode**

Change the option type and the mtime guard:

```ts
options: { excludePids?: Iterable<number>; idleAfterMs?: number | null } = {}

const idleAfterMs = options.idleAfterMs === undefined
  ? DEFAULT_IDLE_AFTER_MS
  : options.idleAfterMs;

if (idleAfterMs !== null) {
  const { mtimeMs } = statSync(file);
  if (Date.now() - mtimeMs > idleAfterMs) continue;
}
```

Keep vanished-file handling and PID exclusion unchanged.

- [ ] **Step 2: Make Codex occupancy strict**

Pass `idleAfterMs: null` in both Codex discovery and detail reads:

```ts
await listOpenSessionFiles("codex", this.sessionRoot, {
  excludePids: this.client.pid ? [this.client.pid] : [],
  idleAfterMs: null,
});
```

Do not change `ClaudeRuntimeAdapter` call sites.

- [ ] **Step 3: Add focused occupancy tests**

Mock `node:child_process` and `node:fs` so the test proves:

```ts
expect(await listOpenSessionFiles("codex", root, { idleAfterMs: null }))
  .toEqual(new Set([oldSessionPath]));
expect(await listOpenSessionFiles("claude", root, { idleAfterMs: 120_000 }))
  .toEqual(new Set());
expect(await listOpenSessionFiles("codex", root, {
  idleAfterMs: null,
  excludePids: [123],
})).toEqual(new Set());
```

Also cover a vanished file returning no occupancy.

### Task 2: Codex Fork Domain Capability

**Files:**
- Modify: `packages/desktop/main/agent-runtime/types.ts`
- Modify: `packages/desktop/main/agent-runtime/codex-runtime-adapter.ts`
- Modify: `packages/desktop/main/agent-runtime/codex-runtime-adapter.test.ts`
- Modify: `packages/desktop/main/agent-runtime/unified-session-service.ts`
- Modify: `packages/desktop/main/agent-runtime/unified-session-service.test.ts`
- Modify: `packages/server/lib/native-runtime-service.ts`
- Modify: `packages/server/lib/native-runtime-service.test.ts`

**Interfaces:**
- Produces: `AgentRuntimeAdapter.fork?(nativeSessionId: string): Promise<UnifiedSessionSummary>`.
- Produces: `UnifiedSessionService.fork(id: string): Promise<UnifiedSessionSummary>`.
- Produces: `NativeRuntimeService.fork(id: string): Promise<UnifiedSessionSummary>`.

- [ ] **Step 1: Extend the adapter and service contracts**

Add the optional method:

```ts
interface AgentRuntimeAdapter {
  fork?(nativeSessionId: string): Promise<UnifiedSessionSummary>;
}
```

Add `UnifiedSessionService.fork` with exact unsupported behavior:

```ts
async fork(id: string): Promise<UnifiedSessionSummary> {
  const { adapter, nativeSessionId } = this.resolveAdapter(id);
  if (!adapter.fork) {
    throw new RuntimeSessionError("This runtime does not support session forks", "OPERATION_NOT_SUPPORTED");
  }
  const forked = await adapter.fork(nativeSessionId);
  this.discoveryPromise = null;
  return forked;
}
```

- [ ] **Step 2: Implement the Codex App Server fork**

Read the source, create the persisted fork, and apply the copy title:

```ts
async fork(nativeSessionId: string): Promise<UnifiedSessionSummary> {
  const sourceResponse = await this.client.request<{ thread: CodexThread }>("thread/read", {
    threadId: nativeSessionId,
    includeTurns: false,
  });
  const response = await this.client.request<{ thread: CodexThread }>("thread/fork", {
    threadId: nativeSessionId,
  });
  const sourceTitle = (sourceResponse.thread.name || sourceResponse.thread.preview || "Codex session").trim();
  const title = `${sourceTitle}（副本）`;
  await this.client.request("thread/name/set", {
    threadId: response.thread.id,
    name: title,
  });
  return this.toSummary({ ...response.thread, name: title }, new Set());
}
```

Do not unsubscribe the fork and do not mutate `ownedThreads`; the subsequent run owns active state.

- [ ] **Step 3: Preserve Web pending discovery**

Add `NativeRuntimeService.fork` and insert the returned summary into `pendingCreations`, matching native session creation:

```ts
async fork(id: string): Promise<UnifiedSessionSummary> {
  if (!isNativeSessionId(id)) {
    throw new RuntimeSessionError(
      "Customer Agent sessions do not support native forks",
      "OPERATION_NOT_SUPPORTED",
    );
  }
  const forked = await this.runtime.fork(id);
  this.pendingCreations.set(forked.id, forked);
  return forked;
}
```

- [ ] **Step 4: Add runtime fork tests**

Use a fake Codex client that records requests and returns distinct source/fork threads. Assert the exact sequence includes:

```ts
expect(requests).toContainEqual({ method: "thread/fork", params: { threadId: "cx-source" } });
expect(requests).toContainEqual({
  method: "thread/name/set",
  params: { threadId: "cx-fork", name: "原会话（副本）" },
});
expect(result).toMatchObject({ nativeSessionId: "cx-fork", title: "原会话（副本）" });
```

Add unified-service coverage for Codex success, unsupported Claude rejection, and cache refresh. Add native-service coverage proving a fork remains visible until discovery returns it.

### Task 3: Electron And Web Fork Transports

**Files:**
- Modify: `packages/desktop/main/index.ts`
- Modify: `packages/desktop/main/preload.ts`
- Modify: `packages/desktop/renderer/global.d.ts`
- Create: `packages/server/app/api/sessions/[id]/fork/route.ts`
- Modify: `packages/server/app/api/native-runtime.test.ts`
- Modify: `packages/webapp/src/infrastructure/http/agent-http-gateway.ts`
- Modify: `packages/webapp/src/infrastructure/http/agent-http-gateway.test.ts`

**Interfaces:**
- Produces: `AgentApi.forkSession(id: string): Promise<UnifiedSessionSummary>`.
- Produces: `POST /api/sessions/:id/fork` returning HTTP 201 and a unified summary.

- [ ] **Step 1: Expose Electron IPC**

Register and preload the method:

```ts
ipcMain.handle("sessions:fork", async (_event, id: string) => unifiedSessions.fork(id));

forkSession: (id: string) => ipcRenderer.invoke("sessions:fork", id),
```

Add the exact signature to `AgentApi` in `global.d.ts`.

- [ ] **Step 2: Add the Web route**

Implement a dedicated POST handler:

```ts
export async function POST(
  _request: Request,
  { params }: { params: { id: string } },
) {
  try {
    const forked = await getNativeRuntimeService().fork(params.id);
    return NextResponse.json(forked, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal error" },
      { status: runtimeErrorStatus(error) },
    );
  }
}
```

Service-level runtime validation must reject Customer Agent and unsupported runtimes; the route does not duplicate adapter checks.

- [ ] **Step 3: Add the browser gateway method**

```ts
async forkSession(id: string): Promise<unknown> {
  return this.http.post(`/api/sessions/${encodeURIComponent(id)}/fork`, {});
}
```

- [ ] **Step 4: Preserve runtime error codes in run events**

In Electron and Web run catches, include `RuntimeSessionError.code`:

```ts
const code = err instanceof RuntimeSessionError ? err.code : undefined;
const event: AgentEvent = {
  type: "error",
  message: err instanceof Error ? err.message : "Native run failed",
  ...(code ? { code } : {}),
};
```

Keep already-yielded adapter error events unchanged.

- [ ] **Step 5: Add transport tests**

Extend native route mocks with `fork`, call the new POST handler, and assert status 201 plus the returned ID. Add an unsupported-runtime status test. Extend the HTTP gateway test with:

```ts
await expect(gateway.forkSession("runtime:codex:c291cmNl"))
  .resolves.toEqual(forkedSummary);
expect(http.post).toHaveBeenCalledWith(
  "/api/sessions/runtime%3Acodex%3Ac291cmNl/fork",
  {},
);
```

Update the thrown-run test to require `code: "SESSION_OCCUPIED"` on the terminal event.

### Task 4: Shared Occupied-Session Recovery UI

**Files:**
- Create: `packages/desktop/renderer/lib/occupied-session-fork.ts`
- Create: `packages/desktop/renderer/lib/occupied-session-fork.test.ts`
- Modify: `packages/desktop/renderer/components/ChatView.tsx`
- Modify: `packages/desktop/renderer/App.tsx`

**Interfaces:**
- Produces: `canForkOccupiedCodexSession(summary, errorCode): boolean`.
- Produces: `forkOccupiedCodexSession(options): Promise<UnifiedSessionSummary>`.
- Consumes: `AgentApi.forkSession(id)` and the existing `onSessionCreated`/`onSelectSession` callbacks.

- [ ] **Step 1: Add pure recovery helpers**

Create strict eligibility and orchestration helpers:

```ts
export function canForkOccupiedCodexSession(
  summary: UnifiedSessionSummary | undefined,
  errorCode?: string,
): boolean {
  return summary?.agentType === "codex"
    && (summary.occupancy === "owned-externally" || errorCode === "SESSION_OCCUPIED");
}

export async function forkOccupiedCodexSession(options: {
  sourceSessionId: string;
  forkSession: (id: string) => Promise<UnifiedSessionSummary>;
  activateSession: (id: string) => void;
  refreshAndSelect: (id: string) => void | Promise<void>;
}): Promise<UnifiedSessionSummary> {
  const forked = await options.forkSession(options.sourceSessionId);
  options.activateSession(forked.id);
  await options.refreshAndSelect(forked.id);
  return forked;
}
```

Only call activation callbacks after a successful fork so failures leave selection untouched.

- [ ] **Step 2: Track occupied recovery state in ChatView**

Add:

```ts
const [sessionErrorCode, setSessionErrorCode] = useState<string>();
const [occupiedDraft, setOccupiedDraft] = useState<string>();
const [isForkingSession, setIsForkingSession] = useState(false);
```

On an error event with `SESSION_OCCUPIED`, derive the latest failed user message for the event session, store its text, suppress the raw English error, disable composition, and show the recovery notice. Clear recovery state when the selected session changes or fork succeeds.

- [ ] **Step 3: Add the explicit fork action**

Use the pure helper in a guarded handler:

```ts
const handleForkOccupiedSession = async () => {
  if (!viewSessionId || !window.agentApi?.forkSession || isForkingSession) return;
  setIsForkingSession(true);
  try {
    await forkOccupiedCodexSession({
      sourceSessionId: viewSessionId,
      forkSession: (id) => window.agentApi!.forkSession(id),
      activateSession: (id) => {
        sessionIdRef.current = id;
        setSessionId(id);
      },
      refreshAndSelect: async (id) => {
        if (onSessionCreated) await onSessionCreated(id);
        else onSelectSession?.(id);
      },
    });
    if (occupiedDraft) setInput(occupiedDraft);
    setOccupiedDraft(undefined);
    setSessionErrorCode(undefined);
    setError(null);
  } catch (error) {
    setError(error instanceof Error ? error.message : "创建会话副本失败");
  } finally {
    setIsForkingSession(false);
  }
};
```

- [ ] **Step 4: Update the read-only notice**

Render the notice when external occupancy or occupied recovery is active. Show the copy `此会话仍由原客户端持有，可创建副本继续。` and a `以副本继续` button only for Codex. While pending, render `正在创建…` and disable the button. Keep non-Codex occupied sessions on the existing read-only message without the button.

Set `canCompose` to false while occupied recovery is active even if the stale summary still says `available`.

- [ ] **Step 5: Add helper and source-contract tests**

Test strict Codex-only eligibility, callback order, failure non-activation, and successful returned summary. Add a focused ChatView contract assertion proving the shared component contains the recovery button, pending label, `forkSession` call, `SESSION_OCCUPIED` branch, and failed-draft restoration.

### Task 5: Documentation Alignment And Diff Self-Check

**Files:**
- Modify: `docs/superpowers/specs/2026-09-01-codex-occupied-session-fork-design.md`
- Modify: `docs/superpowers/plans/2026-09-01-codex-occupied-session-fork.md`

**Interfaces:**
- Consumes: the implemented method names and final verified behavior.
- Produces: checked plan boxes and an authoritative design matching the code.

- [ ] **Step 1: Mark completed plan steps**

Change each implemented checkbox from `- [ ]` to `- [x]` only after its code exists.

- [ ] **Step 2: Verify docs against implementation**

Confirm the final code uses these exact contracts:

```ts
forkSession(id: string): Promise<UnifiedSessionSummary>
fork(id: string): Promise<UnifiedSessionSummary>
idleAfterMs: number | null
```

Update wording only where implementation evidence requires a correction; do not add unrelated project documentation.

- [ ] **Step 3: Inspect the scoped diff**

Run:

```bash
git diff --check
git diff -- packages/desktop/main/agent-runtime packages/desktop/main/index.ts packages/desktop/main/preload.ts packages/desktop/renderer packages/server/app/api packages/server/lib/native-runtime-service.ts packages/webapp/src docs/superpowers
```

Confirm no unrelated existing change was reverted or reformatted.

## Final Unit Test Verification

- [ ] **Main agent: run affected unit tests after development is complete**

Run:

```bash
bunx vitest run \
  packages/desktop/main/agent-runtime/native-processes.test.ts \
  packages/desktop/main/agent-runtime/codex-runtime-adapter.test.ts \
  packages/desktop/main/agent-runtime/unified-session-service.test.ts \
  packages/server/lib/native-runtime-service.test.ts \
  packages/server/app/api/native-runtime.test.ts \
  packages/webapp/src/infrastructure/http/agent-http-gateway.test.ts \
  packages/desktop/renderer/lib/occupied-session-fork.test.ts
bun run --cwd packages/webapp typecheck
bun run --cwd packages/desktop build
bun run --cwd packages/server build
```

Expected: all focused tests pass; Web typecheck, desktop build, and production server build complete successfully.

If a test fails, fix the implementation or test and rerun the failing command, then rerun the full focused test command until it passes. Report each command and result in the final response.
