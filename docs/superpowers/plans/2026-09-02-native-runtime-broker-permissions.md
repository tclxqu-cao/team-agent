# Shared Native Runtime Broker And Recoverable Permissions Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Codex and Claude Code sessions share one local native runtime authority, expose durable per-session permission modes, and recover live native turns, approvals, drafts, and occupancy state across a Web refresh or Desktop handoff.

**Architecture:** A Unix-socket `NativeRuntimeBroker` owns the actual Codex and Claude adapters in whichever local AgentRoam process acquires the socket first. All other Web and Electron processes use the same JSON-RPC client, while SQLite records policy, run admission, replayable events, approval claims, terminal state, and authoritative occupancy revisions. Server routes and Electron IPC become thin broker clients for native sessions; Customer Agent remains on its existing local `AgentHost` path.

**Tech Stack:** TypeScript, Node.js Unix sockets, `better-sqlite3`, Next.js route handlers and SSE, Electron IPC, React/Zustand, Codex App Server, Claude Agent SDK, Vitest.

## Global Constraints

- Use `AGENT_NATIVE_RUNTIME_DIR` when set; otherwise store the private broker socket and SQLite state beneath `~/.agentroam/native-runtime` with owner-only permissions.
- Missing native-session policy records resolve to `full-access`, including sessions created from Web.
- An active run snapshots its permission mode; a setting change affects only later runs.
- Never auto-approve privileged commands, network access, external writes, or unknown Claude tools in either approval mode.
- A duplicate or externally occupied native send must fail before clearing existing replay events or the renderer draft.
- Terminal cleanup, approval cleanup, and lock cleanup must always be scoped to one unified session/run.
- Do not take over writer locks owned by official Codex Desktop or another external client; retain the existing fork path for those sessions.

---

### Task 1: Define Broker Protocol And Durable State

**Files:**
- Create: `packages/desktop/main/agent-runtime/native-runtime-broker.ts`
- Create: `packages/desktop/main/agent-runtime/native-runtime-broker.test.ts`
- Modify: `packages/desktop/main/agent-runtime/types.ts`

**Interfaces:**
- Produces `NativeRuntimeBrokerClient`, `NativeRuntimeBrokerHost`, `getNativeRuntimeBrokerClient(options)`, and `BrokerRunEvent` for both server and Electron callers.
- Produces `BrokerNativeRuntimePort` methods: `list`, `refresh`, `create`, `fork`, `get`, `run`, `subscribe`, `answerQuestion`, `abort`, `steer`, `setPermissionMode`, `handoff`, and `getSessionWatchPath`.
- Adds `permissionMode?: ToolPermissionMode`, `occupancyRevision?: number`, and `snapshotRevision?: number` to native session transport types.

- [ ] **Step 1: Inspect native session and SQLite conventions**

Read: `packages/desktop/main/agent-runtime/types.ts`, `packages/desktop/main/agent-runtime/unified-session-service.ts`, `packages/core/src/infrastructure/SQLiteDatabase.ts`, and their focused tests.

Confirm: a unified id remains the public key and `AgentEvent` is the serializable event contract used by both Web and Electron renderers.

- [ ] **Step 2: Implement durable broker tables and typed snapshot records**

Create tables for session policies, current runs, ordered events, pending approvals, terminal records, and lock revisions. Expose a transaction-backed admission API whose result is either a fresh `BrokerRunRecord` or a `RuntimeSessionError("SESSION_OCCUPIED")` without touching the existing run rows.

```ts
export interface BrokerRunRecord {
  sessionId: string;
  runId: string;
  agentType: Exclude<AgentType, "customer-agent">;
  nativeSessionId: string;
  permissionMode: ToolPermissionMode;
  nextSequence: number;
  status: "active" | "terminal";
}

export interface BrokerRunEvent {
  runId: string;
  sequence: number;
  event: AgentEvent;
}
```

Store the accepted input before native execution, assign monotonically increasing run-local sequence numbers, and retain terminal projection records for ten minutes.

- [ ] **Step 3: Implement private Unix-socket RPC and subscription delivery**

Use newline-delimited JSON request/response envelopes over a mode-`0600` Unix socket. The socket host is started only after an existing socket connection fails; a connecting process uses the established host rather than constructing native adapters. Each subscription receives persisted events newer than its requested sequence before live notifications.

```ts
type BrokerRequest = {
  id: string;
  method: BrokerMethod;
  params: Record<string, unknown>;
};

type BrokerResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: { message: string; code?: string } };
```

- [ ] **Step 4: Add focused durable-state and transport tests**

Test default policy resolution, atomic duplicate admission, replay after a new client connection, one-time approval claims, and stale active-run conversion into a terminal interruption event on host startup.

```ts
await expect(client.startRun(sessionId, "second input")).rejects.toMatchObject({
  code: "SESSION_OCCUPIED",
});
expect(await client.snapshot(sessionId)).toMatchObject({ runId, events: [firstEvent] });
```

### Task 2: Make Native Runtime Execution Broker-Owned

**Files:**
- Modify: `packages/desktop/main/agent-runtime/unified-session-service.ts`
- Modify: `packages/desktop/main/agent-runtime/types.ts`
- Modify: `packages/server/lib/native-runtime-service.ts`
- Modify: `packages/server/lib/native-runtime-service.test.ts`
- Modify: `packages/desktop/main/agent-runtime/unified-session-service.test.ts`

**Interfaces:**
- Consumes `NativeRuntimeBrokerClient` from Task 1 and existing adapter `AgentRuntimeAdapter` implementations.
- Produces `NativeRuntimeService.subscribe(id, afterSequence, listener)`, `setPermissionMode(id, mode)`, and `handoff(id, controller)` for routes and IPC.
- Extends native adapter `run(nativeSessionId, input, images, options)` with `RuntimeRunOptions { permissionMode: ToolPermissionMode }`.

- [ ] **Step 1: Separate broker-host adapters from broker-client adapters**

Keep `CodexRuntimeAdapter` and `ClaudeRuntimeAdapter` only behind `NativeRuntimeBrokerHost`. Add a broker client adapter/service for `codex` and `claude-code` that preserves existing unified IDs and forwards discovery, history, creation, run, steer, abort, answer, and fork calls through the socket.

```ts
export interface RuntimeRunOptions {
  permissionMode: ToolPermissionMode;
}

run(
  nativeSessionId: string,
  input: string,
  images?: string[],
  agentIds?: string[],
  agentName?: string,
  options?: RuntimeRunOptions,
): AsyncIterable<AgentEvent>;
```

- [ ] **Step 2: Persist policy and live projection while running**

At broker admission, load the selected policy using `full-access` as the default, save the user message/projection, and start the adapter turn only after the database transaction commits. Persist every text chunk, tool call, tool result, and ask-user event before broadcasting it.

```ts
const admission = state.admit({ sessionId, agentType, nativeSessionId, input, permissionMode });
void host.execute(admission, images);
return { runId: admission.runId, snapshotRevision: admission.nextSequence };
```

- [ ] **Step 3: Finalize only the affected run**

On `done`, `error`, explicit abort fallback, native host exit, or startup recovery, append a terminal event, mark only that run terminal, remove only its approvals, and advance only its lock revision. A resolved approval removes its own card but leaves the run active.

- [ ] **Step 4: Merge broker projection into native session detail**

Return normal native transcript history plus an idempotent active or retained-terminal projection and `snapshotRevision`. Compare projection message/tool identifiers with native transcript entries so a later transcript flush cannot duplicate the accepted user message or streamed assistant output.

- [ ] **Step 5: Add service-level tests**

Cover a user message plus streaming text/tool/approval snapshot, a `serverRequest/resolved` equivalent that preserves the run lock, terminal cleanup isolation across two sessions, and a host restart that interrupts only prior active rows.

### Task 3: Apply Real Per-Turn Permissions In Codex And Claude

**Files:**
- Modify: `packages/desktop/main/agent-runtime/codex-runtime-adapter.ts`
- Modify: `packages/desktop/main/agent-runtime/codex-runtime-adapter.test.ts`
- Modify: `packages/desktop/main/agent-runtime/claude-runtime-adapter.ts`
- Modify: `packages/desktop/main/agent-runtime/claude-runtime-adapter.test.ts`
- Modify: `packages/core/src/domain/tool/permissions.ts` only if an exported classifier is required

**Interfaces:**
- Consumes `RuntimeRunOptions.permissionMode` from Task 2.
- Produces `codexTurnPermissionOptions(mode, cwd)` and conservative `classifyClaudePermission(toolName, toolInput)` behavior.
- Produces approval cards with stable original request identifiers for legacy and v2 Codex server requests.

- [ ] **Step 1: Map all three Codex modes into `turn/start`**

Pass the mode snapshot to Codex App Server using these exact values:

```ts
const codexOptions = mode === "request-approval"
  ? { approvalPolicy: "onRequest", sandboxPolicy: { type: "readOnly" } }
  : mode === "auto-approval"
    ? { approvalPolicy: "onRequest", sandboxPolicy: { type: "workspaceWrite", writableRoots: [cwd], networkAccess: false } }
    : { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } };
```

- [ ] **Step 2: Support legacy and v2 Codex approval requests**

Keep `item/tool/requestUserInput`, command/file approval, `applyPatchApproval`, and `execCommandApproval`. Add `item/permissions/requestApproval`; record requested filesystem/network scope on the card and respond to allow-once/allow-session with only the requested subset and `turn`/`session` scope. Decline and cancel return no grant. Remove a card on `serverRequest/resolved` without ending the turn.

```ts
const questionId = `native:${runId}:${String(message.id)}`;
```

The broker supplies the run id so refresh recovery and duplicate response checking use the same stable id.

- [ ] **Step 3: Map Claude modes and classify unknown tools conservatively**

For `full-access`, use `permissionMode: "bypassPermissions"`, `allowDangerouslySkipPermissions: true`, and no permission callback. For the other modes use `permissionMode: "default"` plus the callback; request mode asks for every non-read operation and auto mode only bypasses the existing known-safe workspace classification. Unknown, malformed, network, external-write, or destructive inputs always produce an approval card.

- [ ] **Step 4: Add adapter tests**

Assert exact Codex start parameters for all three modes, no Claude callback in full access, approval callback for both other modes, conservative unknown-tool behavior, correct v2 subset reply, and legacy approval compatibility.

### Task 4: Route Native Calls, Replay, And Approval Recovery Through The Broker

**Files:**
- Modify: `packages/server/app/api/agent/run/route.ts`
- Modify: `packages/server/app/api/agent/stream/route.ts`
- Modify: `packages/server/app/api/agent/answer/route.ts`
- Modify: `packages/server/app/api/agent/abort/route.ts`
- Modify: `packages/server/app/api/agent/steer/route.ts`
- Modify: `packages/server/app/api/sessions/[id]/route.ts`
- Create: `packages/server/app/api/sessions/[id]/handoff/route.ts`
- Modify: `packages/server/app/api/native-runtime.test.ts`
- Modify: `packages/server/app/api/agent/stream/route.test.ts`

**Interfaces:**
- Consumes broker `startRun`, `snapshot`, `subscribe`, `answerQuestion`, `abort`, `steer`, `setPermissionMode`, and `handoff` methods.
- Produces native GET details with `permissionMode` and `snapshotRevision`, and SSE with broker event IDs in the form `<runId>:<sequence>`.

- [ ] **Step 1: Perform native run admission before any stream reset**

Replace the current `agentHost.resetExternalStream(sessionId)`-before-run flow. Await broker admission first; return HTTP 409 directly for `SESSION_OCCUPIED`, preserving the old events and the browser's unsent draft. Only after admission subscribe to the broker event stream and bridge newly emitted events to legacy consumers where needed.

```ts
const admission = await native.startRun(sessionId, body.input, body.images);
agentHost.resetExternalStream(sessionId);
void native.forwardRun(admission, (event) => agentHost.publishExternal(sessionId, event));
```

- [ ] **Step 2: Replay native broker events from the SSE route**

For native session IDs, subscribe directly to the broker using `Last-Event-ID` or the returned snapshot revision. Emit persisted events before live events and close only after that run's terminal event. Preserve the existing `AgentHost` SSE path for Customer Agent.

- [ ] **Step 3: Use broker ownership for answer, abort, steer, and handoff**

Answer claims the persisted card once, validates its active run, and forwards the result to the original app-server request. `/api/sessions/:id/handoff` changes only the logical controller to `desktop`; it never starts a second turn or releases a writer lock. Abort/steer and failures use the same session-scoped broker authority.

- [ ] **Step 4: Allow native permission PATCHes**

Delegate native `PATCH /api/sessions/:id` updates to broker policy storage and return the persisted mode. Keep Customer Agent's current SQLite metadata behavior unchanged.

- [ ] **Step 5: Add route tests**

Test 409-before-reset, refresh SSE replay of exactly one unresolved approval, duplicate answer rejection, native permission PATCH persistence, targeted handoff, and an app-server failure terminal event that releases no unrelated session.

### Task 5: Connect Electron To The Same Broker And Add Desktop Handoff

**Files:**
- Modify: `packages/desktop/main/index.ts`
- Modify: `packages/desktop/main/preload.ts`
- Modify: `packages/desktop/renderer/global.d.ts`
- Modify: `packages/desktop/main/agent-runtime/unified-session-service.test.ts`

**Interfaces:**
- Consumes the broker-backed native adapters from Task 2.
- Produces IPC handlers `sessions:setPermissionMode` for all runtime types and `sessions:handoff(id)` for native sessions.
- Produces preload methods `setSessionPermissionMode` and `handoffSession` with the same contracts as the server routes.

- [ ] **Step 1: Replace Electron's direct native adapter instances**

Keep `CustomerAgentRuntimeAdapter` local, but construct `Codex` and `Claude` through the shared broker client. The first local client can host the broker; subsequent Desktop or Web processes connect to its socket rather than launch another app-server child.

- [ ] **Step 2: Forward broker event metadata to Electron renderer**

Include `_sid`, `runId`, and `sequence` on native IPC events so renderer merging can reject replay duplicates. Subscribe a newly opened Desktop native session before rendering controls and request broker handoff only for that selected session.

- [ ] **Step 3: Implement native permission and handoff IPC**

Remove the native-session rejection in `sessions:setPermissionMode`; call the broker policy API. Add `sessions:handoff` that changes the controller to Desktop without invoking `thread/resume`, `thread/unsubscribe`, or any lock-release call.

- [ ] **Step 4: Add Electron-facing tests**

Verify native permission updates reach the broker, a Desktop handoff has no second adapter creation/run call, and a second active Web session remains owned and subscribable after a different session is handed off.

### Task 6: Preserve Renderer State Across Refresh And Expose Permission Controls

**Files:**
- Modify: `packages/webapp/src/infrastructure/http/agent-http-gateway.ts`
- Modify: `packages/webapp/src/infrastructure/http/agent-http-gateway.test.ts`
- Modify: `packages/desktop/renderer/stores/agentStore.ts`
- Modify: `packages/desktop/renderer/components/ChatView.tsx`
- Modify: `packages/desktop/renderer/global.d.ts`
- Add or modify: `packages/desktop/renderer/lib/session-history.ts`
- Add or modify: focused renderer tests beside the changed modules

**Interfaces:**
- Consumes `snapshotRevision`, broker `runId:sequence` SSE identity, and native `permissionMode` from Tasks 2-5.
- Produces session-scoped draft functions `getDraft(sessionId)`, `setDraft(sessionId, text)`, and `clearDraft(sessionId)` backed by browser storage.
- Produces a stable `mergeNativeSnapshot(current, snapshot, events)` helper that never empties an existing conversation while a fetch/retry fails.

- [ ] **Step 1: Store unsent text by session**

Persist text input under a namespaced browser-storage key per session. Restore it after refresh and clear it exactly once after a successful run admission; preserve it on HTTP 409, network errors, or a failed snapshot request.

```ts
const draftKey = (sessionId: string) => `agentroam:draft:${sessionId}`;
```

- [ ] **Step 2: Merge snapshots and SSE by stable identity**

Track `runId:sequence` and stable question/tool IDs. Apply a fetched detail before a subscription at `snapshotRevision`, then merge only later events. Do not call `setMessages([])` as an error fallback, and retain the last rendered projection while retrying.

- [ ] **Step 3: Show native permission selection**

Remove the native-session early return in `ChatView.handlePermissionModeChange`; use the returned session policy for Codex and Claude just as for Customer Agent. Disable only while saving and retain the visible mode snapshot through an active turn.

- [ ] **Step 4: Add Desktop handoff interaction**

When Desktop opens a broker-owned native session, expose an explicit `交接到 Desktop` action when the current controller is Web. Its action calls the IPC handoff endpoint and then subscribes to the existing event sequence and pending approval card; it does not erase messages or alter the current permission mode.

- [ ] **Step 5: Add renderer/gateway tests**

Test text-draft reload, 409 draft preservation, one approval card after a snapshot plus replay, no empty flash after failed refresh, and native permission menu updates.

### Task 7: Stabilize Occupancy Reporting And Verify The End-To-End Contract

**Files:**
- Modify: `packages/desktop/main/agent-runtime/native-runtime-broker.ts`
- Modify: `packages/desktop/main/agent-runtime/native-runtime-broker.test.ts`
- Modify: `packages/server/lib/native-runtime-service.test.ts`
- Modify: `packages/desktop/renderer/lib/occupied-session-fork.test.ts` only if response fields require an assertion update

**Interfaces:**
- Consumes raw adapter discovery occupancy and broker run/terminal events.
- Produces `occupancyRevision` and broker-authoritative `available | owned-by-customer-agent | owned-externally` summaries.

- [ ] **Step 1: Implement broker lock hysteresis**

Mark a successfully admitted run `owned-by-customer-agent` immediately. Mark explicit `SESSION_OCCUPIED` failures external immediately. For raw process discovery require two matching occupied samples at least five seconds apart; require two clean samples at least five seconds apart before releasing an external lock. Never downgrade an active broker run from a discovery poll.

```ts
if (run.status === "active") return ownedByBrokerLock(run);
if (observationMatchesPrevious && elapsedMs >= 5_000) transitionLock(nextState);
```

- [ ] **Step 2: Make revisions authoritative in all summaries**

Persist and increment one session lock revision per transition. Overlay that state on adapter discovery in list/get responses so Web and Electron accept only newer revisions and a raw stale process poll cannot oscillate the visible state.

- [ ] **Step 3: Add state-machine and cross-session tests**

Test alternating raw occupancy samples do not flicker a live broker lock; an external lock releases only after the two clean observations; app-server restart clears only affected rows; and a handoff preserves a pending approval in the target session while another Web session stays active.

## Final Unit Test Verification

- [ ] **Main agent: run affected unit tests after development is complete**

Run:

```bash
npm test -- --run \
  packages/desktop/main/agent-runtime/native-runtime-broker.test.ts \
  packages/desktop/main/agent-runtime/codex-runtime-adapter.test.ts \
  packages/desktop/main/agent-runtime/claude-runtime-adapter.test.ts \
  packages/desktop/main/agent-runtime/unified-session-service.test.ts \
  packages/server/lib/native-runtime-service.test.ts \
  packages/server/app/api/native-runtime.test.ts \
  packages/server/app/api/agent/stream/route.test.ts \
  packages/webapp/src/infrastructure/http/agent-http-gateway.test.ts
```

Expected: PASS.

- [ ] **Main agent: run affected type checks after tests pass**

Run:

```bash
npm run typecheck --workspace @agent/server
npm run typecheck --workspace @agent/desktop
npm run typecheck --workspace @agent/webapp
```

Expected: PASS.

If a test fails, fix the implementation or test and rerun the relevant command until it passes. Report the command and result in the final response.
